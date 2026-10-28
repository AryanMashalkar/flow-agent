import type { ToolSpec } from './llm.ts';

export type StepStatus = 'pending' | 'active' | 'done' | 'dropped';

export interface PlanStep {
  text: string;
  status: StepStatus;
}

export interface Plan {
  version: number;
  steps: PlanStep[];
  /** True when this plan was rewritten because the user barged in. */
  replanned: boolean;
  /** The interruption that caused the re-plan, if any. */
  reason?: string;
}

export const PLAN_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'update_plan',
    description:
      'Show the user your plan as a short checklist. Call it at the start of every task, whenever a step finishes, and right after an interruption. Always send the whole list.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Every step, in order. Two to seven steps of a few words each.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The step, in a few words.' },
              status: {
                type: 'string',
                enum: ['pending', 'active', 'done', 'dropped'],
                description: 'dropped = no longer needed because the user changed their mind.',
              },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
};

const STATUSES = new Set<StepStatus>(['pending', 'active', 'done', 'dropped']);

/** Turn whatever the model sent into a clean list of steps. */
export function parseSteps(args: Record<string, unknown>): PlanStep[] {
  const raw = Array.isArray(args.steps) ? args.steps : [];
  const steps = raw
    .map((s): PlanStep | null => {
      if (typeof s === 'string') return { text: s.trim(), status: 'pending' };
      if (!s || typeof s !== 'object') return null;
      const { text, status } = s as { text?: unknown; status?: unknown };
      if (typeof text !== 'string' || !text.trim()) return null;
      const st = String(status ?? 'pending').toLowerCase() as StepStatus;
      return { text: text.trim().slice(0, 120), status: STATUSES.has(st) ? st : 'pending' };
    })
    .filter((s): s is PlanStep => s !== null)
    .slice(0, 12);
  if (!steps.length) throw new Error('steps must be a non-empty list of { text, status }');
  return steps;
}

/** The plan as plain text, for reminding the model where it was when the user interrupts. */
export function describePlan(plan: Plan | null): string {
  if (!plan) return '';
  return plan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join('\n');
}
