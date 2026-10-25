// Provider-agnostic chat client. Every supported provider speaks the
// OpenAI-compatible /chat/completions dialect, so one client covers them all.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface LLM {
  readonly label: string;
  chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ChatResult>;
}

const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

export class OpenAICompatibleLLM implements LLM {
  readonly label: string;

  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string | undefined,
  ) {
    this.label = model;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, messages, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) {
      throw new Error(`Model API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const data = (await res.json()) as { choices: { message: ChatResult }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Model API returned no choices');
    // Some providers omit tool call ids; the tool replies need one to pair with.
    const tool_calls = msg.tool_calls?.map((c, i) => ({
      ...c,
      type: 'function' as const,
      id: c.id || `call_${Date.now()}_${i}`,
    }));
    return { content: msg.content ?? null, tool_calls: tool_calls?.length ? tool_calls : undefined };
  }
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LLM {
  const provider = (env.LLM_PROVIDER || 'gemini').toLowerCase();
  const preset = PRESETS[provider];
  const baseUrl = env.LLM_BASE_URL || preset?.baseUrl;
  const model = env.LLM_MODEL || preset?.model;
  if (!baseUrl || !model) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}". Set LLM_BASE_URL and LLM_MODEL for a custom provider.`);
  }
  if (!env.LLM_API_KEY && provider !== 'ollama') {
    throw new Error(`LLM_API_KEY is missing. Copy .env.example to .env and add a free ${provider} key.`);
  }
  return new OpenAICompatibleLLM(baseUrl, model, env.LLM_API_KEY);
}
