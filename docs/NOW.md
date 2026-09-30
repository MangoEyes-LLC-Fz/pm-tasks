# Where the hub is today

**Updated 2026-09-30, end of the session.** This page is the first thing a new session reads: what is live, what
changed last, what is being watched, what waits on Arun, and how to see the live hub. It is rewritten at the end of
every working session; the history behind every line is in `docs/STATE.md` (dated decisions) and `git log`.

## Live, on `main`

Everything in `docs/FEATURES.md` marked Live or Built is deployed. Both branches carry the same commits:
`claude/mangowise-task-automation-3qnd3k` (development) is fast-forwarded into `main` after every push. Vercel deploys
in about two minutes. Last commit: `0d63c0f` (Meet notes read as each team member).

The hub in one breath: client asks arrive from Google Chat (DM and the Drop space), mail (taskhub@ and the group
clientsuccess.team@ in To or Cc), client Slack channels and Google Meet notes; every item is sorted into task,
reminder, idea, rule or note; only a task is proposed, as a card in the feed thread addressed to a person, and only
their tap makes the Pulp card (To Do, assigned) and the PM Overview sheet row; every card on every department board is
mirrored so Claude can answer about all of them; the 10:00 India post names what each person has to do today.

## What changed on 2026-09-30 (this session), newest first

1. **Meet notes without folder sharing.** The hub reads Drive as each team member (domain-wide delegation, scope
   `drive.readonly`, added by Arun in Google Admin). No folder is shared any more; `meet-check` lists whose Drives are
   read and whether each can be read. *Proven* the same evening: 38 docs found across the team. Addresses on the Pulp
   boards that are not Google accounts are set aside for a day and listed as skipped.
2. **Mail via the group.** clientsuccess.team@ counts as the hub; the mailbox search names To, Cc and delivered-to;
   a team member's mail is read like anyone's (the "staff outgoing" rule is retired); a mail with no ask is recorded and
   posts nothing; an unknown-client mail gets the "which client?" card only when it holds an ask. *Proof pending:* the
   next client thread with the group in Cc (see `docs/SOAK.md`, 30 Sep). *Arun's side:* the Google Group must deliver
   mail to its members and taskhub@ (an alias of arun@) must be a member.
3. **Client rules.** Off the Chat confirmation card; on the Pulp card at the bottom under "How <client> wants us to
   work (standing rules, not part of this task)". A clinic's own process is a note, not a rule. The eight HC MedSpa
   "rules" from Vishnu's 29 Sep mail are deleted by a one-time statement in `db/schema.sql`.
4. **Model answers outside an option list** (kind "explanation") no longer fail the message: every enum falls back to
   its safe value. Cause of one Slack message failing six times.
5. **Watchdog.** A client Slack message that died mid-run was never retried (its day-long reply-check jobs hid it).
   Fixed; a run that dies now writes `lastError` on the message, shown in `hub_status.stuckMessages`.
6. **Dead proposals leave within ten minutes** (expiry runs in the minute loop); a hub card still in any list named
   Staging is archived for the hub. The 10:00 post is meant to be short from 1 Oct. *Proof pending:* tomorrow's post.
7. **First morning after the audit:** board-mirror insert fixed (a comment inside the SQL text broke it), names from
   the team record, old-rule proposals expire, per-card poll no longer runs out of time.

Before that: 29 Sep the owner's audit (eight points: meeting follow-ups listed not proposed, proposals addressed to the
organiser or the tagged person, P1 only on explicit words with working-hours due, twin titles collapsed, overdue window
60 days, board-import completion dates, Staging cards archived, MangoEyes internal tasks like a client); 28 Sep rows
for hand-made cards and the PMs board like every board; 23 Sep cards from Claude at once and the board mirror.

## Being watched (proofs that need real traffic)

- Tomorrow's 10:00 India post: short, named people only, `eod_last.expired` counting the old-rule proposals closed.
- The Meet reader as each team member: proven 18:35 UTC (38 docs found, the backlog of the last three days read two per run). Seven Pulp board members have addresses that are not Google accounts; they show under `meet_poll_last.skipped`, retried daily, never an issue.
- The group-Cc mail path: a no-ask reply shows in `recent_messages` as `no_ask` with nothing in the feed.
- Slack proposals @mentioning the person the client tagged; meeting threads showing "Follow-ups, no card".
- Hand-made cards without a client label: 11 on the Video board, 2 on Graphics, waiting (`board_mirror_last.waitingLabel`).

## Waiting on Arun

- Archive one of the two "Finalise model for endolift training session" cards in Pulp (a duplicate made before the
  twin-title collapse; the hub cannot archive cards).
- Add a client label to the 13 waiting hand-made cards (Video, Graphics); each gets its sheet row within five minutes.
- Config tab: delete the row "Lester Medispa"; add alias "HC Medi Spa" to HC MedSpa and "LMS" to Leicester MediSpa.
- Neon: pin compute to 0.25 CU (the hub polls every minute, so the database never sleeps; the paid plan is right, the
  size is the only cost lever).
- Google Group clientsuccess.team@: confirm it delivers to members and that taskhub@/arun@ is a member.
- Pulp: the board read is capped at 1000 cards and accepts no paging (SEO, Writers, Dev, Video boards are capped);
  the fix is on Pulp's side (MangoEyes' own tool). Until then the oldest cards on those boards are not mirrored.

## Awaiting Arun's go (proposed, not built)

- Feed links: the 🔁 repeat line's link text "open the card"; the morning list's "task to confirm" items linking to
  their feed thread. Proposed 2026-09-30, no answer yet.

## Known limits

- Pulp board read cap (above). Slack `files:read` only for the workspaces where it was granted. Chat has no bulk delete.
- The Drop space is read as arun@ (domain-wide delegation); a per-user sign-in is a later option.
- Model cost is about $3 for 30 days at the current volume (`hub_status.modelSpend30d`).

## How to see the live hub from a session

- The **Task_Hub MCP connector** is the window: `hub_status` (every poll's last run, queue errors, stuck messages with
  their `last_error`), `recent_messages` (with `includeSkipped` for reasons), `search_tasks` (proposals show as
  "Waiting for a decision"), `client_summary`, `daily_summary`, `meetings`, `people`.
- `/api/health` is the same for a browser; `/api/meet-check`, `/api/sheet-check`, `/api/pulp-check` need the cron
  secret, which Arun holds and which never goes into the repository.
- A session cannot reach vercel.app, Arun's browser, Google Admin or the database directly. Live checks go through the
  MCP tools; settings on Google's or Pulp's side are Arun's, with the exact clicks written out for him.
- Never send test messages into the real spaces or client channels; real traffic proves the features (`docs/SOAK.md`).
- After a deploy that needs a live proof, schedule a check-in (the session's reminder tool) and report the result.

## Session habits that keep this true

At the end of every session: this page rewritten, `docs/STATE.md` given a dated entry per decision, `docs/FEATURES.md`
rows touched, `docs/SOAK.md` given the proof to watch, `CLAUDE.md` test count right, both branches pushed.
