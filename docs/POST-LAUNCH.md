# After go-live — what still proves itself, and what could come next

Current as of 2026-09-30. The live status page is `docs/NOW.md`; this page holds only what is not yet proven on real
traffic and the ideas that were deliberately left for later. None of the ideas is needed for the hub to run.

## Still to prove on real traffic (no work, just watch)

- A voice note longer than 10 minutes (the long path is built; the longest verified is 163 seconds).
- The Meet reader as each team member (built 2026-09-30): the next meeting from an organiser who never shared a folder.
- Mail with the group clientsuccess.team@ in Cc (built 2026-09-30): a no-ask reply stays out of the feed, an ask
  becomes a card to confirm for the sender.
- The 10:00 post after the expiry change (2026-09-30): short, named people only.

## Ideas left for later (none started)

- **Per-user sign-in for the Drop space** instead of domain-wide delegation as arun@.
- **Duplicate-send guard**: if people double-send in bursts, hold the second copy for a minute instead of a 🔁 line.
- **Weekly per-client digest** in the feed (or by mail to the client lead).
- **Platform alerts creating proposals by themselves**: ad disapproved, form down, site down.
- **Workspace Events API for Chat spaces** (push instead of the 20-second read), if Google's quota or latency ever matters.
- **Feed links** (proposed 2026-09-30, awaiting Arun): "open the card" on 🔁 lines; morning-list items linking to their thread.

## Decided against (kept so it is not asked again)

- A Staging list, client or internal boards, a Needs-scope gate: dropped 2026-09-15 and 2026-09-22; the proposal card
  in the feed is the inbox and one tap makes the card in To Do.
- Auto-moving cards or assigning without a person: never; only a person's tap creates or moves a card.
- Client rules on the confirmation card: removed 2026-09-30; they live at the bottom of the Pulp card only.
- The hub writing anything in a client's Slack (replies, reactions): never; the feed is the receipt.
