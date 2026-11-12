# Where the hub is today

**Updated 2026-11-12, end of the second session of the day.** This page is the first thing a new session reads: what is live, what
changed last, what is being watched, what waits on Arun, and how to see the live hub. It is rewritten at the end of
every working session; the history behind every line is in `docs/STATE.md` (dated decisions) and `git log`.

## Live, on `main`

Everything in `docs/FEATURES.md` marked Live or Built is deployed once this branch is merged. Vercel project
`mangoeyes-task-hub` (pm-tasks.vercel.app) deploys `main`. The database is Neon project `delicate-king-60816111`
(lhr1, Launch). The app talks to it with the Neon HTTP driver (`@neondatabase/serverless`), one query at a time.

The hub in one breath: client asks arrive from Google Chat (DM and the Drop space), mail (taskhub@ and the group
clientsuccess.team@ in To or Cc), client Slack channels and Google Meet notes; every item is sorted into task,
reminder, idea, rule or note; only a task is proposed, as a card in the feed thread addressed to a person, and only
their tap makes the Pulp card (To Do, assigned) and the PM Overview sheet row; every card on every department board is
mirrored so Claude can answer about all of them; the 10:00 India post names what each person has to do today.

## What changed on 2026-11-12 (this session)

**A card made outside the feed closes its waiting ask** (feature 3.12, `src/lib/match.ts`; second session of the day).
The team sometimes makes the card straight in Pulp instead of tapping Create card. The hub mirrored that card but
never tied it to the ask, so the ask stayed "waiting" in the feed and in the 10:00 post (88 items that morning). Now:

- A hand-made card that the board read has just stored, for a client with an ask waiting, is compared with those asks
  by a queue job. The ask's id or link on the card, or the same title, is proof for free. Otherwise one small model
  call judges whether it is the same work, whatever the wording, on `claude-haiku-5-5` (`LLM_MODEL_MATCH`).
- Certain: the ask is closed and tied to the card; the proposal card becomes one line with **Not the same task**.
  Likely: a question with **Yes, same task** / **No, different**. Nothing else changes.
- The same look runs once when a proposal is stored, for a card the team made in the three days before.
- Cost was the condition. No schedule, no query on a quiet minute, 40 calls a day at most, the cheapest model.
  `hub_status.cardMatch` shows the 30-day cost and the catch-up.
- A one-time catch-up starts by itself on the first tick after the deploy: every ask waiting or expired since 22 Sep,
  five calls a minute, 300 at most, nothing new posted. Likely matches on waiting asks show in the next 10:00 post as
  "a card may already exist".

**The database can suspend when nobody is asking it anything.** November's Neon bill showed 0.25 CU every hour, about
$20, with scale to zero already on. The compute never got five quiet minutes. The cause was not a pool left open.
It was the schedules, and the health check, touching Postgres on every run:

- `/api/tick`, every minute, read and wrote even when nothing had changed (schema hash, every client row, the queue,
  every due Pulp card's `pulp_checked_at`, reminders, the morning-post flag, `tick_last`).
- `/api/inbox-tick`, every minute, three times, wrote `chat_inbox_last` even when the Drop space had nothing new.
- `/api/meet-tick`, every five minutes, read cursors and wrote `meet_poll_last` before it knew if a notes doc was new.
- `/api/health`, which the uptime monitor calls, ran several queries on every ping.

The crons still fire on the same schedules. Drop is still read every 20 seconds, mail every minute, Pulp on the same
rotation, a reminder at the minute it is due, the 10:00 post at 10:00. What they remember between runs (the next
job, the next reminder, board fingerprints, the card lists, the poll heartbeats) is kept in the Vercel Runtime Cache,
not in Neon (`src/lib/idle.ts`). Postgres is opened only when a row changed, a job or a reminder is due, the morning
post is due, or six hours have passed since an empty queue was confirmed. `/api/health` does not open it.
`/api/health?deep=1` does. If the runtime cache is missing, the tick JSON says `idleCache: "off"` and every check
hits Postgres as before.

## Being watched (proofs that need real traffic)

- The card match (3.12). The catch-up is proven: it finished 17 minutes after the deploy (18:41 to 18:58 UTC), read 701
  asks in 76 calls for $0.04 on `claude-haiku-5-5`, tied 32 asks to their hand-made cards (12 that were still waiting,
  20 that had expired) and marked 9 waiting asks "a card may already exist". All 32 pairs were read by hand in
  `hub_status.cardMatch.catchUp.pairs` and look right; one is soft (an expired "weekly SEO report for Dr Tanov" tied
  to the Week 45 update card). No queue errors. Still to see on real traffic: the first hand-made card for a client
  with an ask waiting turning that ask's proposal card into the "already has a card in Pulp" line, or a question,
  within about six minutes; the 13 Nov 10:00 post shorter by the 12 closed asks, with the 9 marked items carrying a
  card link; a quiet hour still showing the compute suspended.
- After this deploys, a quiet hour (no mail, no Drop message, no Slack event, no reminder due) should show the Neon
  compute suspended, not 0.25 CU. The tick log should say `idleCache: "on"`. `/api/health` should be `ok: true` with
  `db.touched: false`.
- A real Drop message, a real mail, a real Slack event, and a reminder whose time has come should still reach the
  feed on the old schedules. `hub_status` should show poll times from the last few minutes.
- From 6 Oct, still open until this deploy is the thing being watched: the group-mail fix passed that day. The
  meeting-client repair should already read `done` in `meet_client_repair`; the Meet poll now stops asking after it
  has seen that.

## Waiting on Arun

- Neon console: leave scale to zero on. A fixed size of 0.25 CU is fine; it does not by itself keep the compute awake.
  Do not add a keep-alive, and do not point the uptime monitor at `/api/health?deep=1`. No other console change.
- After a quiet night, confirm the compute spent most of it suspended. If the tick JSON says `idleCache: "off"`, the
  runtime cache was not available to the cron and the skip did not engage.
- Archive one of the two "Finalise model for endolift training session" cards in Pulp (a duplicate made before the
  twin-title collapse; the hub cannot archive cards).
- Add a client label to the waiting hand-made cards (Video, Graphics); each gets its sheet row within five minutes.
- Config tab: delete the row "Lester Medispa"; add alias "HC Medi Spa" to HC MedSpa and "LMS" to Leicester MediSpa;
  fill `email_domains` for clients that mail from their own domain (HC MedSpa: hcmedspa.com; Abela: abelamedical.co.uk).
- Pulp: the board read is capped at 1000 cards and accepts no paging; the fix is on Pulp's side.

## Awaiting Arun's go (proposed, not built)

- Feed links: the repeat line's link text "open the card"; the morning list's "task to confirm" items linking to
  their feed thread. Proposed 2026-09-30, no answer yet.

## Known limits

- The card match sees only cards the board read sees: a card on a board Pulp caps at 1000 may be missed, and its ask
  then expires after five working days as before. A sheet row typed by hand with no Pulp card is not matched.
- A card with almost nothing written on it ("fix page") cannot be judged: the hub asks, or leaves it.
- Pulp board read cap (above). Slack `files:read` only for the workspaces where it was granted. Chat has no bulk delete.
- The Drop space is read as arun@ (domain-wide delegation); a per-user sign-in is a later option.
- The hub cannot relabel a Pulp card: a card made from a meeting that is later re-filed keeps its old label, and the
  thread says how many.
- A proposal closes when its five working days are up (the minute loop notices then, and the 10:00 post still closes
  them). It is no longer swept every ten minutes.
- An empty queue is confirmed against Postgres every six hours, so a cache write that failed cannot hide a job longer
  than that. A job whose poke was saved is still run at its time.
- If more than 2000 open hub cards or sheet cards are being watched, the quiet Pulp path turns itself off and the
  minute poll hits Postgres as before.
- Model cost is about $3 for 30 days at the current volume (`hub_status.modelSpend30d`).

## How to see the live hub from a session

- The **Task_Hub MCP connector** is the window: `hub_status` (every poll's last run, queue errors, stuck messages with
  their `last_error`), `recent_messages` (with `includeSkipped` for reasons), `search_tasks` (proposals show as
  "Waiting for a decision"), `client_summary`, `daily_summary`, `meetings`, `meeting_detail`, `decisions`, `ideas`, `people`.
  Poll times in `hub_status` prefer the runtime-cache heartbeat when it is newer than the database row.
- `/api/health` is the uptime view and does not open Postgres. `/api/health?deep=1` is the database view.
  `/api/meet-check`, `/api/sheet-check`, `/api/pulp-check` need the cron secret, which Arun holds and which never goes
  into the repository.
- A session cannot reach vercel.app, Arun's browser, Google Admin or the database directly. Live checks go through the
  MCP tools; settings on Google's or Pulp's side are Arun's, with the exact clicks written out for him.
- Never send test messages into the real spaces or client channels; real traffic proves the features (`docs/SOAK.md`).

## Session habits that keep this true

At the end of every session: this page rewritten, `docs/STATE.md` given a dated entry per decision, `docs/FEATURES.md`
rows touched, `docs/SOAK.md` given the proof to watch, `CLAUDE.md` test count right, both branches pushed.
