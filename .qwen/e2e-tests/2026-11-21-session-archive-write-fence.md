# Verify archive fencing with two daemons

## Setup

- Use a temporary Qwen home and one shared workspace; do not use a real account's
  active sessions. Start two `qwen serve` instances on separate local ports with
  that same home and workspace. Leave `experimental.sessionWriterLease` at its
  default so the ordinary recorder path is exercised.
- Use a deterministic local model if available. Create two conversations in A
  and generate at least two transcript records in each. Keep both recorders
  loaded. Save the first conversation's active JSONL and title sidecar bytes.

## Baseline and assertions

1. In B, call `POST /sessions/archive` for the first conversation. Verify
   success and compare the archived files with the saved bytes.
2. In A, trigger a title write for the same loaded session (for example, enable
   delayed title generation in the fixture, release it after archive, and wait
   for persistence). A baseline build may recreate an active JSONL containing a
   single title whose parent is in the archived log. On the updated build, both
   active files must remain absent, and the archive bytes must not change.
3. Repeat without a stale write between archive and `POST /sessions/unarchive`.
   The previous recorder must still be unable to write. Load the restored
   session using a fresh recorder; a new prompt/title must build on the old
   history and must not produce a history-gap banner.
4. Confirm the second conversation can still accept a prompt and persist it.
   Confirm archiving and restoring an idle conversation with no other recorder
   still works.
5. For an active conversation, hold its archive fence for about 900 ms without
   changing the transcript. Submit a prompt while the lock is held, release
   the lock, then submit another prompt. Both records should be persisted in
   order, with the first as the second record's parent.
6. Stop the recorder and remove the title sidecar from that test conversation.
   Hold the archive fence while resuming it and submitting a new prompt, then
   release the fence after about 900 ms. The new prompt should persist and
   the original first prompt should supply the list title.

The committed core test exercises real storage and a controlled append/archive
race. A source-based independent subprocess check reproduced the baseline and
verified the corrected storage behavior; it does not substitute for exercising
the daemon HTTP and Web Shell paths above.
