import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailoverLLM, llmFromEnv, OpenAICompatibleLLM, type ChatMessage, type ChatResult, type LLM } from '../src/llm.ts';

function stub(label: string, answer: () => ChatResult): LLM & { calls: number } {
  return {
    label,
    calls: 0,
    async chat() {
      this.calls++;
      return answer();
    },
  };
}

const signal = new AbortController().signal;

test('a failing main provider hands the request to the backup, which stays in charge', async () => {
  const main = stub('groq', () => {
    throw new Error('overloaded');
  });
  const backup = stub('gemini', () => ({ content: 'from backup' }));
  const llm = new FailoverLLM(main, backup);
  const notices: string[] = [];
  llm.onNotice = (t) => notices.push(t);

  assert.equal((await llm.chat([], [], signal)).content, 'from backup');
  assert.match(notices[0], /groq isn't answering, switching to gemini/);
  assert.equal(llm.label, 'gemini');

  await llm.chat([], [], signal);
  assert.equal(main.calls, 1, 'main is skipped while the backup is in charge');
  assert.equal(backup.calls, 2);
});

test('a barge-in is not treated as a provider failure', async () => {
  const ac = new AbortController();
  const main = stub('groq', () => {
    ac.abort();
    throw new Error('aborted');
  });
  const backup = stub('gemini', () => ({ content: 'x' }));
  await assert.rejects(new FailoverLLM(main, backup).chat([], [], ac.signal), /aborted/);
  assert.equal(backup.calls, 0);
});

test('llmFromEnv adds the backup provider only when one is set', () => {
  const env = { LLM_PROVIDER: 'groq', LLM_API_KEY: 'k' };
  assert.ok(!(llmFromEnv(env) instanceof FailoverLLM));
  const both = llmFromEnv({ ...env, LLM_BACKUP_PROVIDER: 'gemini', LLM_BACKUP_API_KEY: 'g' });
  assert.ok(both instanceof FailoverLLM);
  assert.throws(() => llmFromEnv({ ...env, LLM_BACKUP_PROVIDER: 'gemini' }), /LLM_BACKUP_API_KEY is missing/);
});

test('tool calls from another model get a placeholder thought signature for Gemini, and lose it elsewhere', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'Read a.js' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  ];
  const gemini = new OpenAICompatibleLLM('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.8-flash', 'k');
  const sig = (m: ChatMessage[]) => (m[1].tool_calls![0] as { extra_content?: { google: { thought_signature: string } } }).extra_content?.google.thought_signature;
  assert.equal(sig(gemini.forProvider(history)), 'skip_thought_signature_validator');
  const groq = new OpenAICompatibleLLM('https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 'k');
  assert.equal(sig(groq.forProvider(gemini.forProvider(history))), undefined);
});
