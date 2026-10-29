import type { LLM } from './llm.ts';

export interface MeetingTask {
  id: number;
  title: string;
  detail: string;
  owner?: string;
  /** Only code tasks are handed to the agent; the rest are listed for people. */
  kind: 'code' | 'other';
  status: 'todo' | 'running' | 'done';
}

const MAX_TRANSCRIPT = 30_000;

const EXTRACT_PROMPT = `You turn a meeting transcript into a list of action items.
Return ONLY JSON, no prose, in this shape:
{"tasks":[{"title":"short imperative title","detail":"what exactly to do, with any names, numbers or decisions from the meeting","owner":"person's name or empty","kind":"code"}]}
Rules:
- kind is "code" when the task is a change to this software project (a feature, bug fix, test, refactor or docs in the repo). Otherwise "other".
- Only include things someone agreed to do. Skip chit-chat and ideas that were rejected.
- If a later part of the meeting changed a decision, use the final decision.
- At most 10 tasks.`;

/** Every balanced {...} or [...] in the text, outermost first, so prose around the JSON doesn't matter. */
function jsonCandidates(text: string): unknown[] {
  const found: unknown[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        if (--depth === 0) {
          try {
            found.push(JSON.parse(text.slice(start, i + 1)));
            start = i;
          } catch {
            // Not JSON; try the next opening bracket.
          }
          break;
        }
      }
    }
  }
  return found;
}

/** Pull the task list out of a reply that may be wrapped in ```json fences or prose. */
export function parseTasks(reply: string): MeetingTask[] {
  const data = jsonCandidates(reply).find(
    (d) => Array.isArray(d) || (d !== null && typeof d === 'object' && Array.isArray((d as { tasks?: unknown }).tasks)),
  );
  if (data === undefined) throw new Error('The model did not return a task list.');
  const raw = (Array.isArray(data) ? data : (data as { tasks: unknown[] }).tasks) as unknown[];
  return raw
    .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
    .filter((t) => typeof t.title === 'string' && t.title.trim())
    .slice(0, 10)
    .map((t, i) => ({
      id: i + 1,
      title: String(t.title).trim().slice(0, 120),
      detail: String(t.detail ?? '').trim().slice(0, 800),
      ...(typeof t.owner === 'string' && t.owner.trim() ? { owner: t.owner.trim() } : {}),
      kind: t.kind === 'other' ? 'other' : 'code',
      status: 'todo',
    }));
}

export async function extractTasks(llm: LLM, transcript: string, signal: AbortSignal): Promise<MeetingTask[]> {
  const text = transcript.length > MAX_TRANSCRIPT ? transcript.slice(-MAX_TRANSCRIPT) : transcript;
  const reply = await llm.chat(
    [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: `Transcript:\n"""\n${text}\n"""` },
    ],
    [],
    signal,
  );
  return parseTasks(reply.content ?? '');
}

/** The instruction the agent gets for one meeting task. */
export function taskInstruction(task: MeetingTask): string {
  return [
    `Meeting task ${task.id}: ${task.title}.`,
    task.detail,
    'Work on a new branch, make the change, run the tests, commit, and open a pull request.',
  ]
    .filter(Boolean)
    .join('\n');
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

export type MeetingCommand = { kind: 'one'; id: number } | { kind: 'some'; ids: number[] } | { kind: 'all' };

const VERB = String.raw`(?:do|run|start|ship|work on|go ahead with|take|pick up|handle|tackle)`;
const NUM = String.raw`(?:\d+|${Object.keys(NUMBER_WORDS).join('|')})`;
const toId = (w: string) => Number(w) || NUMBER_WORDS[w];

/** "do task 2", "work on task three", "do tasks 1 and 3", "run all the code tasks" → what to run. Anything else is null. */
export function parseMeetingCommand(text: string): MeetingCommand | null {
  const t = text.toLowerCase().replace(/[.!?,#]/g, ' ').replace(/\s+/g, ' ').trim();
  if (new RegExp(String.raw`\b${VERB}\b.*\ball\b.*\b(tasks|items)\b`).test(t)) return { kind: 'all' };
  const many = t.match(new RegExp(String.raw`\b${VERB}\s+(?:the\s+)?(?:tasks|items)\s+((?:number\s+)?${NUM}(?:\s+(?:and|&|plus)?\s*${NUM})+)\b`));
  if (many) {
    const ids = [...new Set(many[1].split(/\s+/).map(toId).filter(Boolean))];
    if (ids.length) return { kind: 'some', ids };
  }
  const m = t.match(new RegExp(String.raw`\b${VERB}\s+(?:the\s+)?(?:(\w+)\s+(?:task|item)|(?:task|item)\s+(?:number\s+)?(\w+))\b`));
  const id = toId(m?.[2] ?? m?.[1] ?? '');
  return id ? { kind: 'one', id } : null;
}

export interface TaskRunner {
  submit(text: string): Promise<void>;
  /** Resolves once nothing is running or queued, barge-ins included. */
  whenIdle(): Promise<void>;
  /** True when the last task ended in an error (for example the model's rate limit), not a summary. */
  readonly failed?: boolean;
}

/** Meeting tasks and a queue that hands code tasks to the agent one at a time. */
export class MeetingBoard {
  tasks: MeetingTask[] = [];
  name = '';
  private queue: number[] = [];
  private draining = false;
  private cancelled = false;

  constructor(
    private llm: LLM,
    private runner: TaskRunner,
    private onUpdate: (board: MeetingBoard) => void,
    /** Runs before each task, for example to start it from the default branch. */
    private beforeTask: (task: MeetingTask) => Promise<void> = async () => {},
  ) {}

  async load(name: string, transcript: string, signal: AbortSignal): Promise<MeetingTask[]> {
    this.cancel();
    this.tasks = await extractTasks(this.llm, transcript, signal);
    this.name = name;
    this.onUpdate(this);
    return this.tasks;
  }

  /** Queue tasks by id; "all" means every code task not yet done. Returns the ids queued. */
  run(cmd: MeetingCommand): number[] {
    const wanted = cmd.kind === 'one' ? [cmd.id] : cmd.kind === 'some' ? cmd.ids : [];
    const ids =
      cmd.kind === 'all'
        ? this.tasks.filter((t) => t.kind === 'code' && t.status === 'todo').map((t) => t.id)
        : wanted.filter((id) => this.tasks.some((t) => t.id === id && t.status !== 'running'));
    this.queue.push(...ids.filter((id) => !this.queue.includes(id)));
    if (!this.draining) void this.drain();
    return ids;
  }

  /** Forget queued tasks (the user said stop). */
  cancel(): void {
    this.queue = [];
    this.cancelled = true;
  }

  /** Forget the meeting entirely, for a new session. */
  clear(): void {
    this.cancel();
    this.tasks = [];
    this.name = '';
    this.onUpdate(this);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length) {
        const task = this.tasks.find((t) => t.id === this.queue[0]);
        this.queue.shift();
        if (!task) continue;
        await this.runner.whenIdle();
        this.cancelled = false;
        task.status = 'running';
        this.onUpdate(this);
        await this.beforeTask(task);
        await this.runner.submit(taskInstruction(task));
        // A barge-in during the task is part of the task: wait for it to finish too.
        await this.runner.whenIdle();
        // Stopped part-way or failed: leave it on the list to run again.
        task.status = this.cancelled || this.runner.failed ? 'todo' : 'done';
        this.onUpdate(this);
      }
    } finally {
      this.draining = false;
    }
  }
}
