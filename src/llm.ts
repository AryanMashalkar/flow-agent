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
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
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

/**
 * Llama models on Groq sometimes write a tool call as text, like
 * <function=read_file>{"path":"a.js"}</function>, instead of a real tool call.
 * Turn those back into tool calls so they run instead of being shown to the user.
 */
export function salvageToolCalls(text: string | null): ToolCall[] | undefined {
  if (!text) return undefined;
  const calls: ToolCall[] = [];
  const re = /<function=([\w-]+)>?\s*(\{[\s\S]*?\})\s*<\/function>/g;
  for (const m of text.matchAll(re)) {
    try {
      JSON.parse(m[2]);
    } catch {
      continue;
    }
    calls.push({ id: `call_${Date.now()}_${calls.length}`, type: 'function', function: { name: m[1], arguments: m[2] } });
  }
  return calls.length ? calls : undefined;
}

/** The best general model, never a "lite" one. */
export function pickModel(ids: string[]): string | undefined {
  return rankModels(ids).find((id) => !/lite/i.test(id));
}

/** How many times one request waits out a rate limit before giving up. */
const RATE_LIMIT_WAITS = 4;

/** Statuses that mean "busy, try again", not "your request is wrong". */
const BUSY = new Set([429, 500, 502, 503, 504]);

/**
 * How long the provider asks us to wait, from a Retry-After header, Gemini's "retryDelay": "23s",
 * or Groq's "Please try again in 9.47s".
 */
export function retryAfterSeconds(headers: Headers, body: string): number | undefined {
  const header = Number(headers.get('retry-after'));
  if (header > 0) return Math.ceil(header);
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]));
  // Groq: "try again in 9.47s", "22m1.056s" or "1h2m3s".
  const g = body.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!g || !(g[1] || g[2] || g[3])) return undefined;
  return Math.ceil(Number(g[1] ?? 0) * 3600 + Number(g[2] ?? 0) * 60 + Number(g[3] ?? 0));
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

  /**
   * Gemini rejects a conversation whose tool calls carry no thought signature, which is every call
   * another model made before a switch to Gemini. Google's documented placeholder lets those through.
   * Other providers get the calls without Gemini's extra field.
   */
  forProvider(messages: ChatMessage[]): ChatMessage[] {
    const gemini = /generativelanguage\.googleapis\.com/.test(this.baseUrl);
    return messages.map((m) => {
      if (!m.tool_calls) return m;
      const tool_calls = m.tool_calls.map((c) => {
        const { extra_content, ...rest } = c as ToolCall & { extra_content?: { google?: { thought_signature?: string } } };
        if (!gemini) return rest;
        return extra_content?.google?.thought_signature ? c : { ...rest, extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } };
      });
      return { ...m, tool_calls };
    });
  }

  /** One request. A request that hangs past the timeout counts as busy (504), so it is retried. */
  private async post(model: string, messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<Response> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: this.headers,
        // Providers reject tool_choice without tools, so plain completions send neither.
        body: JSON.stringify(tools.length ? { model, messages: this.forProvider(messages), tools, tool_choice: 'auto' } : { model, messages: this.forProvider(messages) }),
      });
      if (res.ok) return res;
      // Error bodies are read once, here, into a fresh response, so the retry logic can read them
      // again. A body that can't be read (seen behind a proxy) counts as busy and is retried.
      let text: string;
      try {
        text = await res.text();
      } catch {
        return new Response(null, { status: 502 });
      }
      // Groq rejects a reply when the model writes a malformed tool call or unparsable output; a retry usually gets a good one.
      const status = res.status === 400 && /tool_use_failed|output_parse_failed/.test(text) ? 502 : res.status;
      return new Response(text, { status, headers: res.headers });
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
    let triedBackups = false;
    let retries = 0;
    let waits = 0;
    // A 429 can come back from any attempt, including a retry after a 5xx, so every reply goes
    // through the same checks.
    for (;;) {
      if (res.status === 429) {
        if (!triedBackups) {
          triedBackups = true;
          const backup = await this.tryBackups(messages, tools, signal);
          if (backup) return backup;
        }
        // Per-minute token limits (Groq's free tier allows 8000 a minute) clear quickly, so a long
        // task waits them out a few times instead of failing halfway through.
        const body = await res.text();
        const asked = retryAfterSeconds(res.headers, body) ?? this.rateLimitWaitS;
        // A daily quota resets in hours: waiting a minute won't help.
        if (asked > 120 || waits >= RATE_LIMIT_WAITS) return new Response(body, { status: 429 });
        const wait = Math.min(asked, 60);
        this.notice(`Free-tier limit reached for ${this.model}. Waiting ${wait}s before trying again (${++waits} of ${RATE_LIMIT_WAITS})…`);
        await sleep(wait * 1000, signal);
      } else if (BUSY.has(res.status)) {
        if (retries >= this.retryDelaysMs.length) {
          if (triedBackups) return res;
          triedBackups = true;
          return (await this.tryBackups(messages, tools, signal)) ?? res;
        }
        this.notice(`${this.model} is ${res.status === 504 ? 'slow' : 'busy'} (${res.status}). Retrying, ${retries + 1} of ${this.retryDelaysMs.length}…`);
        await sleep(this.retryDelaysMs[retries++], signal);
      } else {
        return res;
      }
      res = await this.post(this.model, messages, tools, signal);
    }
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
      const wait = retryAfterSeconds(res.headers, await res.text()) ?? 0;
      if (wait > 120) {
        throw new Error(`The daily free-tier limit for ${this.model} is used up. It frees up in about ${Math.ceil(wait / 60)} minutes. A second provider (LLM_BACKUP_PROVIDER in .env) keeps you going meanwhile.`);
      }
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
    // Some providers (Ollama) send the arguments as an object rather than a JSON string.
    const tool_calls = msg.tool_calls?.map((c, i) => ({
      ...c,
      type: 'function' as const,
      id: c.id || `call_${Date.now()}_${i}`,
      function: {
        name: c.function?.name ?? '',
        arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
      },
    }));
    const content = stripThoughts(msg.content ?? null) || null;
    if (tool_calls?.length) return { content, tool_calls };
    const salvaged = salvageToolCalls(content);
    return salvaged ? { content: null, tool_calls: salvaged } : { content };
  }
}

/**
 * Two providers, each with its own free quota: when the main one fails even after its own
 * retries and backup models, the request goes to the other provider, which then stays in
 * charge for a few minutes.
 */
export class FailoverLLM implements LLM {
  private backupUntil = 0;
  private notify?: (text: string) => void;

  constructor(
    private main: LLM,
    private backup: LLM,
    private backupMs = 5 * 60_000,
  ) {}

  get label(): string {
    return Date.now() < this.backupUntil ? this.backup.label : this.main.label;
  }

  get onNotice(): ((text: string) => void) | undefined {
    return this.notify;
  }

  set onNotice(fn: ((text: string) => void) | undefined) {
    this.notify = fn;
    this.main.onNotice = fn;
    this.backup.onNotice = fn;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ChatResult> {
    if (Date.now() < this.backupUntil) return this.backup.chat(messages, tools, signal);
    try {
      return await this.main.chat(messages, tools, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const text = `${this.main.label} isn't answering, switching to ${this.backup.label}.`;
      console.log(`  ${text}`);
      this.notify?.(text);
      this.backupUntil = Date.now() + this.backupMs;
      return this.backup.chat(messages, tools, signal);
    }
  }
}

function providerFromEnv(provider: string, env: NodeJS.ProcessEnv, prefix: 'LLM' | 'LLM_BACKUP'): OpenAICompatibleLLM {
  const preset = PRESETS[provider];
  const baseUrl = env[`${prefix}_BASE_URL`] || preset?.baseUrl;
  const model = env[`${prefix}_MODEL`] || preset?.model;
  const key = env[`${prefix}_API_KEY`];
  if (!baseUrl || !model) {
    throw new Error(`Unknown ${prefix}_PROVIDER "${provider}". Set ${prefix}_BASE_URL and ${prefix}_MODEL for a custom provider.`);
  }
  if (!key && provider !== 'ollama') {
    throw new Error(`${prefix}_API_KEY is missing. Copy .env.example to .env and add a free ${provider} key${KEY_URLS[provider] ? ` from ${KEY_URLS[provider]}` : ''}.`);
  }
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 45_000;
  const fallbacks = prefix === 'LLM' ? (env.LLM_FALLBACK_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean) : [];
  return new OpenAICompatibleLLM(baseUrl, model, key, !env[`${prefix}_MODEL`], fallbacks, undefined, undefined, timeoutMs);
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LLM {
  const main = providerFromEnv((env.LLM_PROVIDER || 'gemini').toLowerCase(), env, 'LLM');
  const backupProvider = env.LLM_BACKUP_PROVIDER?.trim().toLowerCase();
  if (!backupProvider) return main;
  return new FailoverLLM(main, providerFromEnv(backupProvider, env, 'LLM_BACKUP'));
}
