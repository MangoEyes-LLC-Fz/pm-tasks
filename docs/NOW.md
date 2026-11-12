# Where the hub is today

**Updated 2026-11-12, end of the session.** This page is the first thing a new session reads: what is live, what
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
- **A card made outside the feed closes its waiting ask** (planned 2026-11-12, not built; Arun has a question first).
  Today a card made by hand in Pulp, or by any tool, is mirrored and gets its row, but the proposal for the same ask
  stays "waiting for a tap": it shows in the 10:00 post, the repeat line says "no card yet", and a later tap makes a
  second card. The plan adds no model call, no schedule, no table, and never opens Postgres on its own:
  (1) the check runs inside the board read only on the path that already writes to Postgres, when the boards'
  fingerprint changed and a new card was inserted or a card just got its client; one query per affected client
  compares those cards with that client's proposals waiting from the last 14 days; an unchanged board stays in the
  runtime cache as now. (2) The same check once when a proposal is stored, against that client's board cards of the
  last few days, for a card made before the hub proposed; the database is already open for that message.
  (3) Sure match (the card's description carries the ask's source link or request id, or the titles are
  near-identical): the hub closes the ask itself, links the card to it (`tasks.request_id`), replaces the proposal
  card with one line and the card link. (4) Likely match: one line in that thread with "Yes, same task" /
  "No, different"; asked once per pair, never decided alone. (5) Everything else: untouched, as today.
  Build notes: poke whatever `idle.ts` caches about proposals when one is closed this way; a card on a board capped
  at 1000 by Pulp may not be seen, and its ask then expires as today.

## Known limits

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
