# Where the hub is today

**Updated 2026-10-06, end of the session.** This page is the first thing a new session reads: what is live, what
changed last, what is being watched, what waits on Arun, and how to see the live hub. It is rewritten at the end of
every working session; the history behind every line is in `docs/STATE.md` (dated decisions) and `git log`.

## Live, on `main`

Everything in `docs/FEATURES.md` marked Live or Built is deployed. Both branches carry the same commits: the session
branch (`claude/gifted-sagan-ve2x4m` this time) is fast-forwarded into `main` after every push. Vercel deploys in
about two minutes.

The hub in one breath: client asks arrive from Google Chat (DM and the Drop space), mail (taskhub@ and the group
clientsuccess.team@ in To or Cc), client Slack channels and Google Meet notes; every item is sorted into task,
reminder, idea, rule or note; only a task is proposed, as a card in the feed thread addressed to a person, and only
their tap makes the Pulp card (To Do, assigned) and the PM Overview sheet row; every card on every department board is
mirrored so Claude can answer about all of them; the 10:00 India post names what each person has to do today.

## What changed on 2026-10-06 (this session)

**Mail through the group reaches the model again.** Vishnu saw that most mails copying `clientsuccess.team@`
(taskhub@ is a member, so it rides along in Cc) got nothing in the feed. `recent_messages` showed the hub had read all
62 of the week's mails but skipped 42 as `bulk_precedence` before any model call: Google Groups stamps the copy it
redistributes with mailing-list headers (Precedence: list, List-Id, List-Unsubscribe, Mailing-list), which the
newsletter rule took at face value; Gmail keeps one copy per Message-ID, so a mail sent straight to taskhub@ carried
them too whenever the group's copy landed first. The group-Cc path of 30 Sep had therefore never really run. Now
(`viaIntakeGroup` in `src/lib/filter/noise.ts`, FEATURES 1.8, STATE 2026-10-06):

- A mail whose To, Cc, Delivered-To, List-Id or Mailing-list names one of the hub's groups is never a newsletter.
  No-reply senders and auto-replies through the group are still skipped; a real newsletter copied to the group reaches
  the model and is quiet.
- The mail poll re-runs once the group mails dropped in the last three days (about 24, from 4 to 6 Oct), exactly as
  the 30 Sep fix re-ran the staff-outgoing drops: no-ask replies stay quiet, asks become tasks to confirm addressed to
  their senders. The 18 older drops (30 Sep to 3 Oct) are left as they are.

## What changed on 2026-10-05

**A meeting's client is set only with certainty; the past meetings are repaired by the hub.** Vishnu saw
"📝 Swathi / Vishnu · HC MedSpa · 4 Oct" in the feed for a call with The SKIN Firm's Swathi and Dr Naren. The
title and the attendee list named no client, so the Meet reader took the sorter's guess as the client and filed the
meeting, its two decisions and its idea under HC MedSpa. Now (`src/lib/meet-client.ts`, FEATURES 1.9):

- A client is set from one of four facts: the call's title; an attendee's address; a client person the hub knows
  (members of the client's Slack workspace, senders of its Slack messages) named in the title, the Invited line or as
  a transcript speaker; or, for an internal call, only team members speaking plus the sorter's "MangoEyes".
- Otherwise the headline reads "client unclear", nothing is filed under any client, the action items are held, and a
  "Which client?" card in the thread names the hub's guess. The pick, or a typed name in the thread, files the
  meeting, its items, its ideas and its waiting action messages, rewrites the headline and queues the action items.
- The repair runs by itself inside the Meet poll, a dozen meetings per run, each once, silent in the feed (Vishnu:
  no feed message for the corrections): a certain fact that names another client re-files the meeting in the records
  and on its existing headline (Swathi / Vishnu → The SKIN Firm), nothing posted; a meeting whose client was only a
  guess is left as it is and noted in its check row (`guess: true`); a no-notes record is left. Nothing is deleted.

## Being watched (proofs that need real traffic)

- The repair (within an hour of the deploy): `meet_poll_last.processed` carries "client repair" lines;
  `meeting_detail` for "Swathi / Vishnu" reads The SKIN Firm and its thread headline too, with nothing new posted;
  settings `meet_client_repair` ends `done` with its counts (`asked` counts the unproven guesses left as they are).
  About a dozen past meetings are unproven guesses (the "Meeting started …" calls filed under Leicester MediSpa,
  The SKIN Firm and The Eye Doctor, "Nitin / Nishit Medispa", "Jaishri Malhotra / Vishnu", "Introduction Call");
  they keep their client until someone asks the hub to question them (a later decision).
- The next meeting whose title names nobody the hub knows: card in the thread, no client until the tap, action items
  after the tap.
- The group-mail fix (first poll after the deploy): `gmail_poll_last.outcomes` carries "N mail(s) … re-run";
  `recent_messages` (channel email, includeSkipped) shows no `bulk_precedence` newer than the deploy; the re-run mails
  end as `no_ask`, a proposal addressed to the sender, or a which-client card. Then the next client reply through the
  group with an ask gets its task-to-confirm line within two minutes. A burst of a few proposals for 4 to 6 Oct threads
  is expected right after the deploy; "No card" closes the ones already handled. **Passed 18:29 UTC**: four tasks to
  confirm and three which-client cards from the re-run, and the first new group mail after the deploy read as `no_ask`.
  The which-client cards came from mails naming no client whose senders are at hcmedspa.com and abelamedical.co.uk:
  the Config `email_domains` step below would have filed them.
- From 30 Sep, still open: Slack proposals @mentioning the tagged person; hand-made cards without a client label
  (`board_mirror_last.waitingLabel`).

## Waiting on Arun

- Archive one of the two "Finalise model for endolift training session" cards in Pulp (a duplicate made before the
  twin-title collapse; the hub cannot archive cards).
- Add a client label to the waiting hand-made cards (Video, Graphics); each gets its sheet row within five minutes.
- Config tab: delete the row "Lester Medispa"; add alias "HC Medi Spa" to HC MedSpa and "LMS" to Leicester MediSpa; fill `email_domains` for clients that mail from their own domain (HC MedSpa: hcmedspa.com; Abela: abelamedical.co.uk). Three "which client?" cards on 6 Oct came from this gap.
- Neon: pin compute to 0.25 CU.
- Google Group clientsuccess.team@: delivery to taskhub@ is confirmed by the week's 62 mails (6 Oct); nothing left to do.
- Pulp: the board read is capped at 1000 cards and accepts no paging; the fix is on Pulp's side.

## Awaiting Arun's go (proposed, not built)

- Feed links: the 🔁 repeat line's link text "open the card"; the morning list's "task to confirm" items linking to
  their feed thread. Proposed 2026-09-30, no answer yet.

## Known limits

- Pulp board read cap (above). Slack `files:read` only for the workspaces where it was granted. Chat has no bulk delete.
- The Drop space is read as arun@ (domain-wide delegation); a per-user sign-in is a later option.
- The hub cannot relabel a Pulp card: a card made from a meeting that is later re-filed keeps its old label, and the
  thread says how many.
- Model cost is about $3 for 30 days at the current volume (`hub_status.modelSpend30d`).

## How to see the live hub from a session

- The **Task_Hub MCP connector** is the window: `hub_status` (every poll's last run, queue errors, stuck messages with
  their `last_error`), `recent_messages` (with `includeSkipped` for reasons), `search_tasks` (proposals show as
  "Waiting for a decision"), `client_summary`, `daily_summary`, `meetings`, `meeting_detail`, `decisions`, `ideas`, `people`.
- `/api/health` is the same for a browser; `/api/meet-check`, `/api/sheet-check`, `/api/pulp-check` need the cron
  secret, which Arun holds and which never goes into the repository.
- A session cannot reach vercel.app, Arun's browser, Google Admin or the database directly. Live checks go through the
  MCP tools; settings on Google's or Pulp's side are Arun's, with the exact clicks written out for him.
- Never send test messages into the real spaces or client channels; real traffic proves the features (`docs/SOAK.md`).
- After a deploy that needs a live proof, schedule a check-in (the session's reminder tool) and report the result.

## Session habits that keep this true

At the end of every session: this page rewritten, `docs/STATE.md` given a dated entry per decision, `docs/FEATURES.md`
rows touched, `docs/SOAK.md` given the proof to watch, `CLAUDE.md` test count right, both branches pushed.
