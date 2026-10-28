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

/** Pull the JSON object out of a reply that may be wrapped in ```json fences or prose. */
export function parseTasks(reply: string): MeetingTask[] {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return a task list.');
  const data = JSON.parse(reply.slice(start, end + 1)) as { tasks?: unknown };
  const raw = Array.isArray(data.tasks) ? data.tasks : [];
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

export type MeetingCommand = { kind: 'one'; id: number } | { kind: 'all' };

/** "do task 2", "work on task three", "run all the code tasks" → what to run. Anything else is null. */
export function parseMeetingCommand(text: string): MeetingCommand | null {
  const t = text.toLowerCase().replace(/[.!?,]/g, ' ').trim();
  if (/\b(do|run|start|ship|work on)\b.*\ball\b.*\b(tasks|items)\b/.test(t)) return { kind: 'all' };
  const m = t.match(/\b(?:do|run|start|ship|work on)\s+(?:the\s+)?(?:(\w+)\s+(?:task|item)|(?:task|item)\s+(?:number\s+)?(\w+))\b/);
  const word = m?.[2] ?? m?.[1];
  if (!word) return null;
  const id = Number(word) || NUMBER_WORDS[word];
  return id ? { kind: 'one', id } : null;
}

export interface TaskRunner {
  submit(text: string): Promise<void>;
  /** Resolves once nothing is running or queued, barge-ins included. */
  whenIdle(): Promise<void>;
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
    const ids =
      cmd.kind === 'all'
        ? this.tasks.filter((t) => t.kind === 'code' && t.status === 'todo').map((t) => t.id)
        : this.tasks.some((t) => t.id === cmd.id && t.status !== 'running')
          ? [cmd.id]
          : [];
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
        await this.runner.submit(taskInstruction(task));
        // A barge-in during the task is part of the task: wait for it to finish too.
        await this.runner.whenIdle();
        // Stopped part-way: leave it on the list to run again.
        task.status = this.cancelled ? 'todo' : 'done';
        this.onUpdate(this);
      }
    } finally {
      this.draining = false;
    }
  }
}
