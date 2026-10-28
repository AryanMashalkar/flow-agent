# Try Flow Agent in 10 minutes

Thanks for testing! You need Node 20.12+, git, and [Wispr Flow](https://wisprflow.ai) (its free plan is enough).

## 1. Set up (3 minutes)

```bash
git clone https://github.com/AryanMashalkar/flow-agent
cd flow-agent
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
```

Get a free key at <https://console.groq.com/keys> (no card needed). In `.env` set:

```
LLM_PROVIDER=groq
LLM_API_KEY=<your Groq key>
```

Then run `npm run demo` and open <http://localhost:4242>.

## 2. Try these by voice (5 minutes)

Click the text box, hold your Wispr Flow key, speak, and let go. **Try not to touch the keyboard at all.** The "keys typed" counter keeps score.

1. "Add a due date to todos and sort them soonest first."
2. While it's working, talk over it: "Stop. Overdue ones go first, then the rest by created time, and add a test."
3. When it asks "Want me to open a pull request?", say "yes".
4. Click **Meeting…**, choose `docs/sample-meeting.txt`, then say "do task 2".
5. Say "recap", then click **Save image**.

## 3. Send back (2 minutes)

Please send the recap image and answers to these:

1. What worked better by voice than it would have by typing?
2. Where did it get stuck or do the wrong thing?
3. On a scale of 1 to 10, how likely would you be to use this on your own project?
4. One sentence we can quote (with your name and role, or anonymously).
