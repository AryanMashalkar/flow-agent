# Flow Agent: a coding agent you talk to, and talk over

**Track:** Builders · **Repo:** https://github.com/AryanMashalkar/flow-agent · **Demo:** <VIDEO LINK>

## The problem

Voice coding tools today are dictation bolted onto a chat box. You speak, then you wait, then you read. If the agent heads the wrong way, you reach for the keyboard to stop it. Real collaboration doesn't work like that: when you pair with someone, you interrupt them.

## What Flow Agent does

Flow Agent is an autonomous dev agent that you drive entirely with Wispr Flow.

- **Speak a task.** It plans out loud, shows the plan as a live checklist, reads and edits your code, runs your tests and fixes them until they pass, narrating each step in one short sentence.
- **Talk over it.** Say "stop, overdue ones go first" mid-task and the agent drops the in-flight step, kills the running command, and re-plans. The plan panel strikes out the dropped steps and flashes in the new ones, with a banner quoting what you said.
- **Ship by voice.** "Commit this and open a PR" puts the work on its own branch, pushes it and opens the pull request. It never touches main and never force-pushes.
- **Meetings in, PRs out.** Drop in a meeting transcript. Flow Agent pulls out the action items, separates code tasks from people tasks, and "do task 2" turns one into a pull request.
- **Metrics on screen:** words dictated, keys typed, instructions, barge-ins, files changed, commands run, re-plans and PRs opened. Say "recap" for a shareable session card; a voice-only session shows 0 keys typed.
- **Voice both ways:** the agent narrates in a natural voice and asks before shipping ("Want me to open a pull request?"), and you answer by voice.

## How Wispr Flow is used

Wispr Flow is the only input. The UI detects dictation (whole phrases arriving at once) and auto-sends after a short pause, so there is no Enter key in the loop. Interruptions are just more dictation, and spoken "stop" halts the agent. Meeting transcripts can come from Wispr Notetaker. The project itself was built by voice through Wispr Flow.

## How it's built

- Node 22 + TypeScript, a WebSocket server and a plain browser UI. One command to run (`npm run demo`).
- Free models only: Gemini by default, with Groq and Ollama as one-line switches. The client survives free-tier limits with retries, same-family backup models, and Retry-After handling.
- Barge-in is real cancellation, not a UI trick: an `AbortController` cancels the model request, any running command's process tree is killed, unrun tool calls are answered as skipped, and the interruption plus the current plan goes into the same conversation so the agent re-plans instead of starting over.
- Safety rails: file access is sandboxed to the workspace, destructive commands are refused, and all git runs without a shell.
- 39 automated tests (agent loop, barge-in, git, meetings, providers), CI on Linux and Windows.

## What's next

Streaming voice replies, a VS Code panel, and letting the agent ask clarifying questions back by voice.
