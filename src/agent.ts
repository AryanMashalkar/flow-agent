import { EventEmitter } from 'node:events';
import type { ChatMessage, LLM } from './llm.ts';
import type { FileChange, Tool } from './tools.ts';

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
  | { type: 'status'; running: boolean };

const SYSTEM_PROMPT = `You are Flow Agent, a voice-native coding agent. The user talks to you by voice and hears your replies read aloud.

Rules:
- Before every tool call, write ONE short spoken sentence (under 15 words) saying what you are about to do. No markdown, no code in that sentence.
- Be autonomous: explore the workspace with your tools instead of asking questions you could answer yourself.
- To change code, read the file first, then use edit_file with a snippet copied exactly from it. Use write_file only for new files.
- After changing code, run the project's tests with run_command (find the test command in package.json, pyproject.toml, Makefile or similar). If they fail, read the error, fix it, and run them again. After three failed attempts, stop and explain what is failing.
- Keep changes small and focused on what the user asked for.
- The user may interrupt you mid-task. An interruption overrides the earlier instruction: drop work that no longer fits, re-plan out loud in one sentence, and continue.
- When finished, give a short spoken summary (one to three sentences). Put any file paths or code after the summary.`;

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

  constructor(private opts: AgentOptions) {
    super();
    this.tools = new Map(opts.tools.map((t) => [t.spec.function.name, t]));
    this.maxSteps = opts.maxSteps ?? 25;
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
      this.history.push({
        role: 'user',
        content: interrupt ? `[The user interrupted you mid-task] ${text}\nAdjust your plan to this and continue.` : text,
      });
      // A newer instruction is already queued behind this one: record this one and let that run.
      if (gen !== this.generation) return;
      return this.loop();
    });
    return this.running;
  }

  /** Stop the current task without giving a new instruction. */
  async stop(): Promise<void> {
    if (!this.busy) return;
    this.generation++;
    this.controller?.abort();
    await this.running;
    this.history.push({ role: 'user', content: '[The user said stop. Wait for the next instruction.]' });
    this.send({ type: 'stopped' });
  }

  private async loop(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    this.send({ type: 'status', running: true });
    try {
      for (let step = 0; step < this.maxSteps; step++) {
        let reply;
        try {
          reply = await this.opts.llm.chat(this.history, [...this.tools.values()].map((t) => t.spec), signal);
        } catch (err) {
          if (signal.aborted) return;
          throw err;
        }
        if (signal.aborted) return;
        this.history.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });

        if (!reply.tool_calls) {
          this.send({ type: 'done', text: reply.content ?? '' });
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
      this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.controller === controller) this.controller = null;
      this.send({ type: 'status', running: false });
    }
  }

  private async runTool(name: string, rawArgs: string, signal: AbortSignal): Promise<string> {
    const tool = this.tools.get(name);
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return `Error: arguments were not valid JSON: ${rawArgs}`;
    }
    this.send({ type: 'tool', name, args });
    if (!tool) {
      this.send({ type: 'tool_result', name, ok: false, preview: 'unknown tool' });
      return `Error: unknown tool "${name}"`;
    }
    try {
      const out = await tool.run(args, {
        signal,
        onFileChange: (c) => this.send({ type: 'file_changed', ...c }),
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
