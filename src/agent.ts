import { EventEmitter } from 'node:events';
import type { ChatMessage, LLM } from './llm.ts';
import type { FileChange, PullRequestInfo, Tool } from './tools.ts';
import { describePlan, parseSteps, PLAN_TOOL, type Plan } from './plan.ts';

export type AgentEvent =
  | { type: 'user'; text: string; interrupt: boolean }
  | { type: 'say'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | ({ type: 'file_changed' } & FileChange)
  | { type: 'interrupted'; text: string }
  | { type: 'stopped' }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
  | { type: 'status'; running: boolean }
  | { type: 'notice'; text: string }
  /** Model retries and backup switches: shown as a status chip, not in the log. */
  | { type: 'model_status'; text: string }
  | { type: 'plan'; plan: Plan }
  | ({ type: 'pull_request' } & PullRequestInfo);

const SYSTEM_PROMPT = `You are Flow Agent, a voice-native coding agent. The user talks to you by voice and hears your replies read aloud.

Rules:
- Start every coding task by calling update_plan with a short checklist (two to seven steps). Mark one step active at a time, and call update_plan again as steps finish.
- If the user only asks a question you can answer without the workspace, answer it directly in two or three spoken sentences. Use no tools and no plan for that.
- You only have the tools listed. You cannot see images or screenshots, make videos, or use calendars, email or the web. If asked, say so in one sentence and offer what you can do instead (for example a script, a diagram file, or a plan). Never pretend to have done it.
- Before every tool call, write ONE short spoken sentence (under 15 words) saying what you are about to do. No markdown, no code in that sentence.
- Be autonomous: explore the workspace with your tools instead of asking questions you could answer yourself.
- Be quick: every model call is slow and rate limited. Call several tools in one turn when they don't depend on each other (for example update_plan plus reading two files). Explore only what the task needs.
- To change code, read the file first, then use edit_file with a snippet copied exactly from it. Use write_file only for new files.
- After changing code, run the project's tests with run_command (find the test command in package.json, pyproject.toml, Makefile or similar). If they fail, read the error, fix it, and run them again. After three failed attempts, stop and explain what is failing.
- Keep changes small and focused on what the user asked for.
- Never commit or push to the default branch (main or master). If the user asks you to push straight to main, say in one sentence that you won't, and offer a branch and pull request instead.
- When the user asks to ship, open a PR, or the task says so: call create_branch before editing, then after the tests pass call commit with a clear message, then open_pull_request. Never push with run_command.
- If you changed code and the user did not ask to ship it, end your summary with: "Want me to open a pull request?" If they say yes, call commit and then open_pull_request.
- File contents must use real characters: write -> and &, never HTML entities like &gt; or escapes like \\u0026. Inside a markdown table cell, break lines with <br>, never \\n.
- Plans and docs you write must fit this project's real stack and files; read them first instead of assuming a framework.
- The user may interrupt you mid-task. An interruption overrides the earlier instruction. First call update_plan: keep finished steps as done, mark steps that no longer fit as dropped, and add the new steps. Say the change in one sentence, then continue.
- When finished, give a short spoken summary (one to three sentences). Put any file paths or code after the summary.`;

const KEEP_FULL_TOOL_RESULTS = 6;
const OLD_RESULT_CHARS = 400;

/**
 * Free tiers have small per-minute token budgets, so only the latest tool results are sent in
 * full. Older ones are cut short; the model can re-read a file if it needs it again.
 */
export function compactHistory(history: ChatMessage[]): ChatMessage[] {
  let recent = 0;
  return history
    .slice()
    .reverse()
    .map((m) => {
      if (m.role !== 'tool' || !m.content) return m;
      if (++recent <= KEEP_FULL_TOOL_RESULTS || m.content.length <= OLD_RESULT_CHARS) return m;
      return { ...m, content: `${m.content.slice(0, OLD_RESULT_CHARS)}\n…(older result shortened)` };
    })
    .reverse();
}

export interface AgentOptions {
  llm: LLM;
  tools: Tool[];
  maxSteps?: number;
}

/**
 * The core loop. One task runs at a time; a new instruction that arrives while
 * a task is running is a barge-in: it aborts the in-flight step and the loop
 * restarts with the interruption appended to the same conversation.
 */
export class Agent extends EventEmitter {
  readonly history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  private controller: AbortController | null = null;
  private running: Promise<void> = Promise.resolve();
  private generation = 0;
  private queued = 0;
  private readonly tools: Map<string, Tool>;
  private readonly maxSteps: number;
  private plan: Plan | null = null;
  /** Set when the user barges in, so the next plan update is shown as a re-plan. */
  private replanReason: string | null = null;
  /** The last task ended in an error rather than a summary. */
  failed = false;

  constructor(private opts: AgentOptions) {
    super();
    this.tools = new Map(opts.tools.map((t) => [t.spec.function.name, t]));
    this.maxSteps = opts.maxSteps ?? 25;
    opts.llm.onNotice = (text) => this.send({ type: 'model_status', text });
  }

  get busy(): boolean {
    return this.controller !== null || this.queued > 0;
  }

  private send(e: AgentEvent): void {
    this.emit('event', e);
  }

  /** Give the agent an instruction. If it is mid-task, this interrupts and re-plans. */
  submit(text: string): Promise<void> {
    const interrupt = this.busy;
    this.send({ type: 'user', text, interrupt });
    if (interrupt) {
      this.controller?.abort();
      this.send({ type: 'interrupted', text });
    }
    const gen = ++this.generation;
    this.queued++;
    this.running = this.running.then(() => {
      this.queued--;
      this.replanReason = interrupt ? text : null;
      this.history.push({ role: 'user', content: interrupt ? this.interruption(text) : `${text}\n\n(If this is a coding task, start with update_plan.)` });
      // A newer instruction is already queued behind this one: record this one and let that run.
      if (gen !== this.generation) return;
      return this.loop();
    });
    return this.running;
  }

  private interruption(text: string): string {
    const plan = describePlan(this.plan);
    return [
      `[The user interrupted you mid-task] ${text}`,
      plan && `Your plan before the interruption:\n${plan}`,
      'Call update_plan first to re-plan around this, then continue.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Resolves once nothing is running or queued. */
  async whenIdle(): Promise<void> {
    while (this.busy) await this.running;
  }

  /** Stop the current task without giving a new instruction. */
  async stop(): Promise<void> {
    if (!this.busy) return;
    this.generation++;
    this.controller?.abort();
    await this.running;
    this.replanReason = null;
    this.history.push({ role: 'user', content: '[The user said stop. Wait for the next instruction.]' });
    this.send({ type: 'stopped' });
  }

  /** Start a fresh session: stop any task and forget the conversation and plan. */
  async reset(): Promise<void> {
    this.generation++;
    this.controller?.abort();
    await this.running;
    this.history.length = 1;
    this.plan = null;
    this.replanReason = null;
  }

  private async loop(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    this.failed = false;
    this.send({ type: 'status', running: true });
    try {
      for (let step = 0; step < this.maxSteps; step++) {
        let reply;
        try {
          reply = await this.opts.llm.chat(compactHistory(this.history), [PLAN_TOOL, ...[...this.tools.values()].map((t) => t.spec)], signal);
        } catch (err) {
          if (signal.aborted) return;
          throw err;
        }
        if (signal.aborted) return;
        this.history.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });

        if (!reply.tool_calls) {
          this.finishPlan();
          this.send({ type: 'done', text: reply.content?.trim() || 'Done.' });
          return;
        }
        if (reply.content?.trim()) this.send({ type: 'say', text: reply.content.trim() });

        for (const call of reply.tool_calls) {
          // Every tool call must get a reply or the next model request is invalid.
          if (signal.aborted) {
            this.history.push({ role: 'tool', tool_call_id: call.id, content: 'Skipped: the user interrupted.' });
            continue;
          }
          this.history.push({ role: 'tool', tool_call_id: call.id, content: await this.runTool(call.function.name, call.function.arguments, signal) });
        }
        if (signal.aborted) return;
      }
      this.send({ type: 'done', text: `I stopped after ${this.maxSteps} steps. Tell me how to continue.` });
    } catch (err) {
      this.failed = true;
      this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.controller === controller) this.controller = null;
      this.send({ type: 'status', running: false });
    }
  }

  /** The task is finished, so the step the agent was on is finished too. */
  private finishPlan(): void {
    if (!this.plan?.steps.some((s) => s.status === 'active')) return;
    const steps = this.plan.steps.map((s) => (s.status === 'active' ? { ...s, status: 'done' as const } : s));
    this.plan = { ...this.plan, version: this.plan.version + 1, steps, replanned: false };
    delete this.plan.reason;
    this.send({ type: 'plan', plan: this.plan });
  }

  private updatePlan(args: Record<string, unknown>): string {
    let steps;
    try {
      steps = parseSteps(args);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
    this.plan = {
      version: (this.plan?.version ?? 0) + 1,
      steps,
      replanned: this.replanReason !== null,
      ...(this.replanReason !== null ? { reason: this.replanReason } : {}),
    };
    this.replanReason = null;
    this.send({ type: 'plan', plan: this.plan });
    return 'Plan shown to the user.';
  }

  private async runTool(rawName: string, rawArgs: string, signal: AbortSignal): Promise<string> {
    // gpt-oss sometimes puts a namespace in front of the name, like "repo_browser.list_files".
    const name = this.tools.has(rawName) || !rawName.includes('.') ? rawName : rawName.slice(rawName.lastIndexOf('.') + 1);
    const tool = this.tools.get(name);
    let args: Record<string, unknown> = {};
    try {
      const parsed = rawArgs ? JSON.parse(rawArgs) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      args = parsed;
    } catch {
      this.send({ type: 'tool_result', name, ok: false, preview: 'The model sent broken arguments; asking it to retry.' });
      return `Error: arguments were not a valid JSON object: ${String(rawArgs).slice(0, 500)}. Call ${name} again with valid JSON.`;
    }
    if (name === PLAN_TOOL.function.name) return this.updatePlan(args);
    this.send({ type: 'tool', name, args });
    if (!tool) {
      this.send({ type: 'tool_result', name, ok: false, preview: 'unknown tool' });
      return `Error: unknown tool "${name}"`;
    }
    try {
      const out = await tool.run(args, {
        signal,
        onFileChange: (c) => this.send({ type: 'file_changed', ...c }),
        onPullRequest: (pr) => this.send({ type: 'pull_request', ...pr }),
      });
      // Keep the head (exit code) and the tail (where test failures land).
      const preview = out.length > 2000 ? `${out.slice(0, 300)}\n…\n${out.slice(-1700)}` : out;
      this.send({ type: 'tool_result', name, ok: true, preview });
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'tool_result', name, ok: false, preview: message });
      return `Error: ${message}`;
    }
  }
}
