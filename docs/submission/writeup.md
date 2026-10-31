# Flow Agent: a coding agent you talk to, and talk over

**Track:** Builders · **Repo:** https://github.com/AryanMashalkar/flow-agent
**Watch it now, no install:** https://aryanmashalkar.github.io/flow-agent/ (real recorded sessions, played back in the real UI)
**Demo video:** <VIDEO LINK>

<!--
  soham: fill every [YOU: ...] below in your own words, then delete these brackets.
  Real numbers beat adjectives. If you don't know a number, leave the sentence out rather than guess.
-->

## The problem, from my own desk

[YOU: 2 to 4 sentences. A real moment when a coding agent went the wrong way and you had to stop it. What were you building, what did it do wrong, what did you have to do to stop it (Esc, Ctrl+C, retype the whole prompt)?]

[YOU: one number from your own week, for example "I run about N agent tasks a day and restart roughly N of them because I changed my mind", or "typing a 60-word instruction takes me about N seconds; dictating it with Wispr takes N".]

Voice coding tools today are dictation bolted onto a chat box. You speak, then you wait, then you read. If the agent heads the wrong way, you reach for the keyboard to stop it. When you pair with a person, you just interrupt them. Flow Agent lets you do that with an agent.

## What Flow Agent does

Flow Agent is an autonomous dev agent that you drive entirely with Wispr Flow.

- **Speak a task.** It plans out loud, shows the plan as a live checklist, reads and edits your code, runs your tests and fixes them until they pass, narrating each step in one short sentence.
- **Talk over it.** Say "stop, use priority levels instead" mid-task and the agent drops the in-flight step, kills any running command, and re-plans. The plan panel strikes out the dropped steps and flashes in the new ones, with a banner quoting what you said. In the recorded run on the replay site, the in-flight step was cancelled 2 ms after the interruption arrived, and the new plan was on screen 1.1 s later.
- **Ship by voice.** "Commit this and open a PR" puts the work on its own branch, pushes it and opens the pull request. It never touches main and never force-pushes, and if it claims a PR it didn't actually open, it is sent back to fix that.
- **Meetings in, PRs out.** Drop in a meeting transcript (Wispr Notetaker or anything else). Flow Agent pulls out the action items, separates code tasks from people tasks, and "do task 2" turns one into a branch and pull request.
- **Proof it was voice:** words dictated, keys typed, barge-ins and re-plans are counted live. Every instruction is logged with whether Wispr Flow dictated it or it was typed (`npm run dictation-log`), and "recap" draws a shareable card. A voice-only session shows 0 keys typed.

## How Wispr Flow is used

Wispr Flow is the only input. The UI detects Wispr's whole-phrase inserts and auto-sends after a 1.2 s pause, so there is no Enter key in the loop. Interruptions are just more dictation, and a spoken "stop" halts the agent. This only works because Wispr is fast and accurate enough to talk over a running agent; with typing you would stop it first.

[YOU: paste your Wispr Flow usage card numbers here, for example words dictated this week, and link `docs/dictation-log.md` once you've generated it from your own sessions.]

## How it's built

- Node 22 + TypeScript, a WebSocket server and a plain browser UI. One command to run (`npm run demo`).
- Free models only: Groq (gpt-oss-120b) or Gemini, with Ollama as a local option. The client survives free-tier limits with retries, same-provider backup models, Retry-After handling and a second provider as backup.
- Barge-in is real cancellation, not a UI trick: an `AbortController` cancels the model request, any running command's process tree is killed, unrun tool calls are answered as skipped, and the interruption plus the current plan goes into the same conversation so the agent re-plans instead of starting over.
- Safety rails: file access is sandboxed to the workspace, destructive commands and pushes to main are refused, and all git runs without a shell.
- 65 automated tests, CI on Linux and Windows. A 26-prompt stress test against the real model is in [`docs/stress-test.md`](../stress-test.md), failures included: 21 pass, 2 partial, 2 fixed but not yet re-run.

## What's next

Pulling meeting notes straight from Wispr's MCP server instead of a pasted transcript, streaming voice replies, and a VS Code panel.
