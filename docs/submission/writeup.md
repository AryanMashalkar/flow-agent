# Flow Agent: a coding agent you talk to, and talk over

**Track:** Builders · **Repo:** https://github.com/AryanMashalkar/flow-agent
**Watch it now, no install:** https://aryanmashalkar.github.io/flow-agent/ (real recorded sessions, played back in the real UI)
**Demo video:** <VIDEO LINK>

## The problem, from my own desk

When I work with an AI coding agent, I usually re-prompt it several times on one task, because the answer often doesn't match what I meant until the second or third try. Part of that is the idea itself: some concepts are hard to put into a short typed prompt, and typing out a long explanation is slow and tiring. The worse part is the waiting. I have to sit through the whole response before I can tell whether it's right, and only then can I correct it.

Flow Agent fixes both. I explain the idea by speaking it with Wispr Flow, which is easier than typing it. The moment I see the plan heading the wrong way, I just talk over it, and it drops what it was doing and re-plans. I don't wait for a wrong answer to finish.

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

My Wispr Flow usage card ([screenshot](wispr-usage-card.png)): **107 words per minute, top 2% of Flow users**, 104 words dictated on desktop, 7 fixes made by Flow (2 words corrected, 5 dictionary fixes), and a 2-day streak (77 words on 28 Oct, 27 on 29 Oct).

The app logs every instruction it receives. In my recorded session on 31 Oct, all 9 instructions (66 words) were dictated with Wispr Flow and none were typed, and 3 of them were barge-ins spoken while the agent was working. The full log is in [`docs/dictation-log.md`](../dictation-log.md), Wispr's mishearings included.

The narration in the demo video is an AI voice (ElevenLabs). The agent footage is from real recorded runs on Groq.

## How it's built

- Node 22 + TypeScript, a WebSocket server and a plain browser UI. One command to run (`npm run demo`).
- Free models only: Groq (gpt-oss-120b) or Gemini, with Ollama as a local option. The client survives free-tier limits with retries, same-provider backup models, Retry-After handling and a second provider as backup.
- Barge-in is real cancellation, not a UI trick: an `AbortController` cancels the model request, any running command's process tree is killed, unrun tool calls are answered as skipped, and the interruption plus the current plan goes into the same conversation so the agent re-plans instead of starting over.
- Safety rails: file access is sandboxed to the workspace, destructive commands and pushes to main are refused, and all git runs without a shell.
- 65 automated tests, CI on Linux and Windows. A 26-prompt stress test against the real model is in [`docs/stress-test.md`](../stress-test.md), failures included: 21 pass, 2 partial, 2 fixed but not yet re-run.

## What's next

Pulling meeting notes straight from Wispr's MCP server instead of a pasted transcript, streaming voice replies, and a VS Code panel.
