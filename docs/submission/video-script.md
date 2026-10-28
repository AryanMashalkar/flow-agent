# Demo video script (target 1:50, hard limit 2:00)

**Before recording**
- `npm run demo` (fresh workspace every run). Browser at http://localhost:4242, zoomed to 110 to 125% so the plan panel and metrics read on a phone.
- "Speak replies" on. Record the screen **with system audio and your mic**.
- Have `docs/sample-meeting.txt` ready in a file picker.
- Use Groq for recording (`LLM_PROVIDER=groq` in `.env`): it's much faster than Gemini's free tier. Do one warm-up run off camera.
- Don't touch the keyboard during the take: the **keys typed** counter is part of the story and should stay at 0.
- Show the Wispr Flow hotkey on screen if you can (keystroke overlay or just say it).

| Time | On screen | You say |
|---|---|---|
| 0:00–0:10 | Title card or the empty UI | "This is Flow Agent. It's a coding agent I drive only with my voice, through Wispr Flow, and I can talk over it." |
| 0:10–0:35 | Dictate the task. Plan appears, agent narrates, reads files. | *(dictated)* "Add a due date to todos and sort them soonest first." |
| 0:35–0:55 | **The climax.** While it's editing, barge in. Banner flashes, steps strike out, new steps flash in. Point at the re-plans and barge-ins counters. | *(dictated, over the agent)* "Stop. Overdue ones go first, then the rest by created time, and add a test for it." Then to camera: "I didn't press anything. It dropped what it was doing and re-planned." |
| 0:55–1:15 | Tests run, green badge, diff visible. | *(dictated)* "Commit this and open a PR." Show the PR link. |
| 1:15–1:45 | Meeting… → pick sample-meeting.txt → task list appears with owners and "for people" tasks greyed out. | *(dictated)* "Do task 2" (the login crash). Show the branch/PR result. "A standup transcript went in, and a pull request came out." |
| 1:45–1:55 | *(dictated)* "Recap." The recap card appears and the agent reads it out: 0 keys typed. | "Every word here was spoken. Zero keys typed, free models, open source." |
| 1:55–2:00 | Repo URL | "Flow Agent. Link below." |

**If you run long:** cut the meeting segment to just "do task 2" and the PR link. Keep the barge-in, it's the moment that wins.

**Fallback if the model is slow on camera:** record the segments separately and cut the waiting. The counters keep their values between segments as long as you don't restart the server.

**Making the README GIF from your recording** (needs ffmpeg), using the barge-in segment:

```bash
ffmpeg -ss 00:00:35 -t 12 -i demo.mp4 -vf "fps=10,scale=960:-1:flags=lanczos" -loop 0 docs/demo.gif
```

Then put `![Flow Agent demo](docs/demo.gif)` at the top of the README.

**Optional 10-second stopwatch beat (strong for the Wispr judges), right after the intro:** show a timer while typing the same long instruction (about 45 seconds), then cut to speaking it with Wispr (about 8 seconds). Say: "That's why this is voice-first."
