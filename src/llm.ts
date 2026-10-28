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
  /** Called with short status updates (retrying, switching models) for the UI. */
  onNotice?: (text: string) => void;
  chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ChatResult>;
}

const KEY_URLS: Record<string, string> = {
  groq: 'https://console.groq.com/keys',
  gemini: 'https://aistudio.google.com/apikey',
};

const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

const SKIP_MODELS = /(embed|image|tts|audio|live|vision|guard|preview|exp|nano|whisper|compound)/i;

/** Rank chat models newest first, preferring full "flash" models over "lite" ones. */
export function rankModels(ids: string[], family?: string): string[] {
  const usable = ids.map((id) => id.replace(/^models\//, '')).filter((id) => !SKIP_MODELS.test(id));
  const sameFamily = (id: string) => (family && modelFamily(id) === family ? 10_000 : 0);
  const version = (id: string) => Number(id.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const score = (id: string) => sameFamily(id) + (/lite/i.test(id) ? 0 : 1000) + version(id) * 10 + (/flash/i.test(id) ? 1 : 0);
  return usable.sort((a, b) => score(b) - score(a));
}

/** "gemini-3.8-flash" → "gemini". Backups from the same family behave most alike. */
export function modelFamily(id: string): string {
  return id.replace(/^models\//, '').split(/[-_:]/)[0].toLowerCase();
}

/** Some models put their private reasoning in the reply; it must not be shown or read aloud. */
export function stripThoughts(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/<(thought|think|thinking)>[\s\S]*?<\/\1>/gi, '')
    .replace(/^\s*<(thought|think|thinking)>[\s\S]*$/i, '')
    .trim();
}

/** The best general model, never a "lite" one. */
export function pickModel(ids: string[]): string | undefined {
  return rankModels(ids).find((id) => !/lite/i.test(id));
}

/** Statuses that mean "busy, try again", not "your request is wrong". */
const BUSY = new Set([429, 500, 502, 503, 504]);

/** How long the provider asks us to wait, from a Retry-After header or Gemini's "retryDelay": "23s". */
export function retryAfterSeconds(headers: Headers, body: string): number | undefined {
  const header = Number(headers.get('retry-after'));
  if (header > 0) return Math.ceil(header);
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1])) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

export class OpenAICompatibleLLM implements LLM {
  private model: string;
  onNotice?: (text: string) => void;
  /** While the main model is overloaded, use a backup until this time, then try the main one again. */
  private backupUntil = 0;

  constructor(
    private baseUrl: string,
    private primary: string,
    private apiKey: string | undefined,
    /** When the model was not chosen by the user, swap to the newest available one if it is retired. */
    private autoModel = false,
    /** Models to switch to when the current one stays busy. Discovered from the provider when empty. */
    private fallbacks: string[] = [],
    private retryDelaysMs = [1000, 2000, 4000],
    private backupMs = 10 * 60_000,
    private timeoutMs = 45_000,
    /** How long to wait after a 429 when the provider doesn't say. */
    private rateLimitWaitS = 20,
  ) {
    this.model = primary;
  }

  get label(): string {
    return this.model;
  }

  private get headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/models`, { headers: this.headers });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  private async newestModel(): Promise<string | undefined> {
    return pickModel(await this.listModels());
  }

  private notice(text: string): void {
    console.log(`  ${text}`);
    this.onNotice?.(text);
  }

  /** One request. A request that hangs past the timeout counts as busy (504), so it is retried. */
  private async post(model: string, messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<Response> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: this.headers,
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
      });
      if (res.status !== 400) return res;
      // Groq rejects a reply when the model writes a malformed tool call; a retry usually gets a good one.
      const text = await res.text();
      return new Response(text, { status: text.includes('tool_use_failed') ? 502 : 400 });
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return new Response(null, { status: 504 });
      }
      throw err;
    }
  }

  /** Try each backup model once. Backups that don't exist for this key are forgotten. */
  private async tryBackups(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<Response | null> {
    if (!this.fallbacks.length) this.fallbacks = rankModels(await this.listModels(), modelFamily(this.primary)).slice(0, 4);
    for (const backup of this.fallbacks.filter((m) => m !== this.model)) {
      this.notice(`Trying backup model ${backup}…`);
      const attempt = await this.post(backup, messages, tools, signal);
      if (attempt.ok) {
        this.notice(`Using ${backup} for the next few minutes while ${this.model} is busy.`);
        this.model = backup;
        this.backupUntil = Date.now() + this.backupMs;
        return attempt;
      }
      if (attempt.status === 404 || attempt.status === 400) this.fallbacks = this.fallbacks.filter((m) => m !== backup);
    }
    return null;
  }

  /**
   * Free tiers fail in two ways. 429 means this model's quota is used up: retrying it right away
   * only burns more quota, so try backups (each model has its own quota), then wait as long as the
   * provider asks. 5xx means the model is overloaded: retry with backoff, then try backups.
   */
  private async send(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<Response> {
    if (this.model !== this.primary && Date.now() > this.backupUntil) this.model = this.primary;
    let res = await this.post(this.model, messages, tools, signal);

    if (res.status === 429) {
      const body = await res.text();
      const backup = await this.tryBackups(messages, tools, signal);
      if (backup) return backup;
      const wait = Math.min(retryAfterSeconds(res.headers, body) ?? this.rateLimitWaitS, 60);
      this.notice(`Free-tier limit reached for ${this.model}. Waiting ${wait}s before trying again…`);
      await sleep(wait * 1000, signal);
      res = await this.post(this.model, messages, tools, signal);
      if (res.status !== 429) return res;
      return new Response(body, { status: 429 });
    }

    for (const [i, delay] of this.retryDelaysMs.entries()) {
      if (!BUSY.has(res.status) || res.status === 429) return res;
      this.notice(`${this.model} is ${res.status === 504 ? 'slow' : 'busy'} (${res.status}). Retrying, ${i + 1} of ${this.retryDelaysMs.length}…`);
      await sleep(delay, signal);
      res = await this.post(this.model, messages, tools, signal);
    }
    if (!BUSY.has(res.status)) return res;
    return (await this.tryBackups(messages, tools, signal)) ?? res;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ChatResult> {
    const res = await this.send(messages, tools, signal);
    if (res.status === 404 && this.autoModel) {
      this.autoModel = false;
      const next = await this.newestModel();
      if (next && next !== this.model) {
        this.notice(`${this.model} is unavailable, switching to ${next}.`);
        this.model = this.primary = next;
        return this.chat(messages, tools, signal);
      }
    }
    if (res.status === 429) {
      throw new Error('The free-tier limit for this key is used up for now. Wait a minute and try again. Shorter tasks use fewer requests.');
    }
    if (BUSY.has(res.status)) {
      throw new Error(`The model is overloaded right now (${res.status}) and no backup model answered. Wait a minute and try again.`);
    }
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
    return { content: stripThoughts(msg.content ?? null) || null, tool_calls: tool_calls?.length ? tool_calls : undefined };
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
    throw new Error(`LLM_API_KEY is missing. Copy .env.example to .env and add a free ${provider} key${KEY_URLS[provider] ? ` from ${KEY_URLS[provider]}` : ''}.`);
  }
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 45_000;
  const fallbacks = (env.LLM_FALLBACK_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  return new OpenAICompatibleLLM(baseUrl, model, env.LLM_API_KEY, !env.LLM_MODEL, fallbacks, undefined, undefined, timeoutMs);
}
