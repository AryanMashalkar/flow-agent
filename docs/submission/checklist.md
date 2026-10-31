# Submission checklist (deadline 31 Oct 2026, 11:59pm IST)

## Already done
- [x] App built: voice loop, barge-in re-planning, edits and tests, git and PRs, meeting transcripts
- [x] One-command demo: `npm run demo`
- [x] README with architecture diagram, quick start and screenshots
- [x] Write-up draft: `docs/submission/writeup.md`
- [x] Video script: `docs/submission/video-script.md`
- [x] CI on Linux and Windows, MIT license
- [x] No-install replay site (`public/` deployed by `.github/workflows/pages.yml`) with two real recorded runs
- [x] Dictation log: `logs/dictation.jsonl` written as you work, `npm run dictation-log` makes `docs/dictation-log.md`
- [x] Stress test re-run against the real model: `docs/stress-test.md`

## Your part
0. [ ] Turn on the replay site, once: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then **Actions → Replay site → Run workflow**. Check https://aryanmashalkar.github.io/flow-agent/ plays.
1. [ ] `git pull` on main, then `npm install`.
2. [ ] Optional but strongly recommended: create an empty GitHub repo (e.g. `todo-app-demo`) and set `DEMO_REPO=https://github.com/<you>/todo-app-demo` in `.env`, so the video shows a real PR. Also add `GITHUB_TOKEN` (fine-grained, that repo only, "Pull requests: read and write").
3. [ ] Rehearse once with `npm run demo` and the script. Restart `npm run demo` between takes.
4. [ ] Record the video, 2:00 or less. Upload (YouTube unlisted or Loom) and paste the link into `writeup.md`.
4b. [ ] After recording, click **Save as replay** in the sidebar. Put the file in `public/replays/` as `voice-take.json`, add it at the top of `public/replays/index.json` with the title "Dictated with Wispr Flow (keys typed: N)", and commit. That's a real voiced session judges can replay.
4c. [ ] Run `npm run dictation-log`, read `docs/dictation-log.md` (delete any line you don't want public), and commit it.
4d. [ ] Fill every `[YOU: ...]` in `writeup.md` with your own story and numbers.
5. [ ] Make the README GIF from the barge-in segment (command in the video script) and commit it.
6. [ ] Get your **Wispr Flow usage card** from the Wispr Flow app (your stats / share card) and save the image.
7. [ ] Submit on the hackathon page: project link (the GitHub repo), video link, Wispr usage card, write-up.
8. [ ] Post on X/LinkedIn with the video, tagging Wispr Flow and WeMakeDevs, with the hackathon's hashtag.

## Sanity checks before submitting
- [ ] Repo is public, README renders, the CI badge is green.
- [ ] `.env` is not committed (it's in `.gitignore`); no API key in any screenshot or the video.
- [ ] The video has audio of the agent speaking and of you dictating.
