# MangoEyes Task Hub — read this first

The hub is live (go-live 2026-09-15). It turns client asks from Google Chat (DM and the "Task Hub Drop" space),
email (taskhub@mangoeyesagency.com), client Slack channels and Google Meet notes into Pulp cards and PM Overview
sheet rows, posts one line per message in the "Task Hub Feed" space, and answers questions over MCP from the
team's Claude accounts. Developed on branch `claude/mangowise-task-automation-3qnd3k`, merged into `main` when finished
(Vercel project `pm-tasks`, https://pm-tasks.vercel.app, deploys `main` once Arun switches the Production Branch). Nothing runs locally; the sandbox cannot reach vercel.app.

## Where everything is (reading order)

0. `docs/NOW.md` — where the hub is today: what is live, what changed last, what is being watched, what waits on Arun.
   Rewritten at the end of every session. Read it first; it is the handover.
1. `docs/ARCHITECTURE.md` — the whole infrastructure and concept, end to end, as it runs today.
2. `docs/STATE.md` — every decision with its date, IDs, the Google/Slack/Pulp facts, environment variable names, useful commands.
3. `docs/FEATURES.md` — the register: every feature, how it works, status (Live / Built / Dropped), endpoints, code map. `tests/features.test.ts` fails when a module or endpoint is missing from it.
4. `docs/SOAK.md` — the live checks and what passed, with the progress line under block A.
5. `docs/OPS.md` — operations for Arun: health, new client, Slack install, MCP keys, pause, clean-start commands, costs.
6. `docs/GUIDE.md` — one page per role for the team. `docs/TEAM-BRIEF.md` — the team message. `docs/POST-LAUNCH.md` — what still proves itself, ideas left for later, and what was decided against.
7. `docs/MCP.md` — connecting Claude, the tools, from/to dates.
8. `PLAN.md` — the original design rationale (older; STATE.md wins where they differ).

## Working rules (from Arun)

- Nothing built may exist only in code: add a row to `docs/FEATURES.md`, note the decision in `docs/STATE.md`, keep `docs/SOAK.md` current.
- Every bug is fixed at the root and its siblings checked; the same thing must not happen twice.
- Do not build before the doubt is cleared and Arun says go. Ask one crisp question, no loops.
- The feed is one line per message; everything else goes in that line's thread. A headline says only what the thread is about (client, what happened, source): no titles, words, links, names or counts. That applies to every feed line, present and future.
- A client is set only with full clarity; near-misses are suggestions the sender confirms.
- Writes from Claude ask who is asking (label "Anuj via Claude-Arun"); reads ask nothing.
- Every item is one of five kinds: task, reminder, idea, rule, note. Only a task is proposed, and only a person's tap makes the card (Create card → To Do, assigned; Remind me instead; No card). No Staging list, no client or internal boards, no Needs scope list.
- Every line the hub writes says who it is for and what to do, in the team's words; the action is spelled out on the button.
- Speed: replies as instant as possible (Drop space read every 20 s; client picks re-run inline).
- Commit messages end with the Co-Authored-By and Claude-Session lines; no model identifiers in code or docs.
- Every push goes to both branches: push the development branch, then fast-forward `main` and push it.
- Never send test messages into the real Chat spaces or client Slack channels; real traffic proves a feature (SOAK.md).
- The cron secret and every other secret live only in Vercel; a curl command with the secret is given to Arun in chat, never written into the repository.
- A session cannot reach vercel.app, Arun's browser, Google Admin, Pulp's settings or the database; the Task_Hub MCP tools are the window, and anything on Google's or Pulp's side is Arun's step, written out click by click.
- At the end of a session: rewrite `docs/NOW.md`, add the dated STATE entries, update the FEATURES rows and the SOAK proof, fix the test count below, push both branches. A new session, in any tool, must find nothing unknown.

## Observing the live hub from a session

The Task_Hub MCP connector (tools `hub_status`, `recent_messages`, `search_tasks`, `daily_summary`, …) is the window
into the live database. `hub_status` shows every poll's last run, queue errors and stuck messages. `/api/health` is the
same for a browser.

## Checks before pushing

`npx tsc --noEmit` and `npx vitest run` (167 tests). Vercel deploys the branch in about two minutes.
