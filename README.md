# Flow Agent

**A coding agent you talk to, and talk over.** Dictate a feature with [Wispr Flow](https://wisprflow.ai). The agent explores your code, narrates what it's doing out loud, and if you change your mind mid-task ("stop, use Postgres not SQLite") it drops the in-flight step and re-plans on the spot.

Built for the WeMakeDevs × Wispr Flow **No Hands** hackathon.

## Quick start (Windows, macOS, Linux)

You need Node 20.12 or newer. You don't need a paid API key.

```bash
git clone https://github.com/AryanMashalkar/flow-agent
cd flow-agent
npm install
copy .env.example .env      # on macOS/Linux: cp .env.example .env
```

Get a **free** Gemini key at <https://aistudio.google.com/apikey> (no card needed) and put it in `.env` as `LLM_API_KEY`. Then:

```bash
npm start
```

Open <http://localhost:4242>, click the text box, hold your Wispr Flow key and speak.

To point the agent at another project, set `WORKSPACE` in `.env`, or run `npm link` once and then run `flow-agent` from inside any project folder.

### Model providers

Every provider is reached through the same OpenAI-compatible API, so switching is a single line in `.env`:

| `LLM_PROVIDER` | Cost | Notes |
|---|---|---|
| `gemini` (default) | Free tier | `gemini-2.5-flash` |
| `groq` | Free tier | `llama-3.3-70b-versatile` |
| `ollama` | Free, runs locally | No key needed. Pull a model first, for example `ollama pull qwen2.5-coder:7b` |
| anything else | – | Set `LLM_BASE_URL` and `LLM_MODEL` |

## How the voice loop works

- **Voice in:** Wispr Flow types your words into the command box. The app spots dictation (whole phrases arriving at once, not single key presses) and sends it automatically after a short pause, so you never touch the keyboard. Say just "stop" to halt the agent.
- **Barge-in:** anything you say while the agent is working is an interruption. The model request in flight is aborted, any tool calls it hadn't run yet are marked as skipped, and the loop restarts with your interruption added to the same conversation, so the agent re-plans instead of starting over.
- **Voice out:** the agent says one short sentence before each action, and the browser reads it aloud. As soon as you start dictating, it goes quiet.

## Development

```bash
npm test          # agent loop, barge-in, and tool sandbox tests (no API key needed)
npm run typecheck
```

## Roadmap

- [x] Day 1: voice loop, agent core, read-only file tools, barge-in
- [ ] Day 2: file edits and running tests
- [ ] Day 3: live plan view and smarter re-planning
- [ ] Day 4: git branches and PRs, plus meeting transcript input
- [ ] Day 5: dogfooding Flow Agent on itself, and polish
