---
name: wavebrain
description: Use after any action that changes something outside this conversation (deploys, pushes, merges, releases, published posts, emails or messages sent, payments, database or config changes). Records it in WaveBrain with log_action.
---

# Log your work to WaveBrain

WaveBrain is the user's audit log of what their agents did. Keep it complete and readable.

**After every action that changes something outside the conversation, call the WaveBrain `log_action` tool once.** That includes:
- deploying, releasing, publishing a package or app build
- git push, opening or merging a pull request
- sending an email, message or post; publishing content
- payments, refunds, subscriptions, invoices
- database writes or migrations; changing env vars, secrets or config in a live system
- creating, deleting or changing anything in a third-party service

Don't log reading, searching, planning, or local edits that weren't shipped anywhere.

How to write the entry:
- `title`: one short past-tense sentence a teammate would understand, e.g. "Deployed the new pricing page to production".
- `details`: what changed, why, and the result, including anything that failed or is unfinished. Don't repeat the title.
- `status`: `failure` if it didn't work, `pending` if it's waiting on someone.
- Never include secrets, passwords, one-time codes, API keys or full card/account numbers.
- `agent`: your tool's name, the same every time (e.g. "claude-code"). If the user runs several bots on the same tool, use "<tool>-<bot or profile name>", e.g. "hermes-seo-manager", so each bot shows up separately, and pass the bot's display name as `bot` (e.g. "Head of SEO").
- For a multi-step task, call `start_session` first, pass its `session_id` to each `log_action`, and call `end_session` when done.

A WaveBrain hook also records high-stakes commands automatically as a safety net. When you log the action yourself, your entry replaces the automatic one, so a clear `log_action` is always better.
