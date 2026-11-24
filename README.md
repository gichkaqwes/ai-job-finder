# AI Job Finder — job search + tailored CV bot

A Telegram bot I built for my own job search. It finds realistic AI / automation roles,
scores each one against my real experience with an LLM, and on one button press writes a
CV and cover letter tailored to that specific job — **in the language of the job posting**.

## What it does

1. **Collects jobs** every 6 hours from LinkedIn (guest search), Remotive, Himalayas, Jobicy and RemoteOK.
2. **Filters** by title (AI, automation, n8n, Zapier, LLM, agents…) and by location
   (drops roles that can't hire from the UK).
3. **Scores in two stages** to keep costs low:
   a cheap model (`gpt-4o-mini`) drops obvious misfits, a strong model gives the final 1–10 fit.
   Hard caps are enforced in code (e.g. on-site outside commuting range → max 3).
4. **Sends a card** to Telegram: fit score, why it fits, concerns, CV language, salary.
5. **📄 CV button:**
   - the bot compares the job's requirements with the profile and asks up to 3 short
     questions about anything missing (answers are saved and reused);
   - then it generates an ATS-friendly CV (max 2 pages) and a cover letter as JSON → HTML → PDF (Playwright).
6. **👎 button** — feedback is fed back into future scoring.
7. Paste any job link or job text — the bot scores it and offers a CV.

## Honesty rules

The CV writer may only use facts from `profile.json` and the user's own answers.
No invented employers, dates, certificates, metrics or integrations — when a number is
unknown, it describes the mechanism instead.

## Stack

Node.js · node-telegram-bot-api · OpenAI API · axios + cheerio · Playwright (PDF) · pm2

## Files

| File | Purpose |
|---|---|
| `bot.js` | Telegram UI, scheduling, scoring, CV flow |
| `sources.js` | Job sources, de-duplication, title/geo filters |
| `llm.js` | OpenAI wrapper with retries, cheap/strong models |
| `cv.js` | Gap questions, CV + cover letter generation, HTML template, PDF |
| `profile.example.json` | Template for the candidate profile |

## Run

```bash
npm install
npx playwright install chromium
cp profile.example.json profile.json   # fill in your facts
export TELEGRAM_TOKEN=...  OPENAI_API_KEY=...
node bot.js
```

Built with AI coding agents (Claude Code) — I design the logic and rules, review and test the results.
