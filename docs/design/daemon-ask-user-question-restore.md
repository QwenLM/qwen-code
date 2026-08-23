# Daemon ask_user_question restore on load/resume

## Problem

`ask_user_question` HITL is in-memory. After a daemon restart, `session/load`
and `session/resume` currently close a trailing unanswered question as a
failed tool result (`orphan repair` + transcript `finalizeDangling`). The old
`requestId` is gone, so `POST /session/:id/permission/:requestId` cannot
complete it.

## Goal

When `--restore-ask-user-question` is on (default **off**) and a client
loads or resumes that session:

1. Do not synthesize a failed tool result for that trailing
   `ask_user_question`.
2. After load, re-issue `requestPermission` with a **new** `requestId`
   (timeout clock resets).
3. `GET /session/:id/status` again shows `isWaitingForUserQuestion` and
   `pendingInteractions`.
4. The existing permission vote route submits answers; the real function
   response is sent back to the model and the same turn continues.

Daemon boot does **not** scan or auto-resume waiting sessions.

## Why not `continueLastTurn`

Generic continue classifies a dangling `functionCall` as
`interrupted_turn` and synthesizes an **error** function response. Restoring
a question as a tool crash would lose the HITL. Restore is a separate
tracked prompt path. When the flag is on and the trailing question is
restorable, `continueLastTurn` declines (`accepted: false, interruption:
none`) instead of answering the restored question with a synthetic failure.

## Eligibility

All of the following must hold:

- Config switch is true.
- API history's last entry is a `model` turn.
- Every id'd `functionCall` in that turn is `ask_user_question`.
- Args parse as valid `AskUserQuestionParams`.
- No mixed dangling tools in that turn (e.g. bash + question) — the whole
  batch stays on orphan repair.
- The live session has no in-flight prompt (already waiting → do not
  restore twice).
- The load/resume request carries an attached client id — without one,
  nobody could answer the re-hung question (keepalive, boot rehydrate and
  sub-session resumes pass none).
- The session is not a fork created by `branchSession` in this call.

Main session only. Forks/subagents cannot run this tool.

## Switch

`--restore-ask-user-question` on `qwen serve` and on the ACP child
(`qwen --acp --restore-ask-user-question`). Default false. The child-side
flag is honored only in ACP mode: in the plain TUI nothing can re-hang the
question, and skipping load-time orphan repair would wedge the resumed
session. No settings.json key and no capability tag in v1.

## Runtime

1. `startChat` skips orphan repair **only** for the eligible AUQ call ids,
   and only when this load/resume will actually re-hang the question. A
   suppressed restore (no attached client, fork) repairs Gemini history in
   lockstep with replay finalization. The per-send inline repair pass always
   closes a dangling call: an ordinary prompt that beats the restore prompt
   must not send `model[functionCall] → user[text]` (Anthropic-compatible
   providers reject that shape). Restore itself sends the real
   functionResponse, so that pass is a no-op on the restore path.
2. Transcript replay `finalize()` skips those call ids so the UI stays
   in-progress. Skip ids come from live chat when it is initialized, otherwise
   from the transcript tail (cold bulk `historyReplay: 'response'` runs
   before `startChat`). Skip and re-hang stay in lockstep: when the daemon
   already knows it will decline (no attached client, fork restore), the
   child-bound request carries
   `qwen.daemon.suppressRestoreAskUserQuestion` and the child neither hints
   nor skips — the replay finalizes the question as failed. Read-only
   `qwen/session/loadUpdates` always finalizes; it never re-hangs.
3. Child load/resume `_meta` includes `qwen.daemon.restoreAskUserQuestion`
   when the argv switch is on and the session is eligible. The default-off
   path never calls the restore-only Session helper.
4. Bridge sees the hint **and** the daemon switch, then admits a tracked
   `sendPrompt` with that meta (same admission as continue). External
   `POST /prompt` cannot smuggle the meta. Admission additionally requires
   the entry to be idle at fire time (`promptActive`, `pendingPromptCount`
   and `goalTurnActive` are all clear); admission failures are logged and
   swallowed — restore is a best-effort side effect of a successful load.
5. `Session.prompt()` rebuilds the tool, `requestPermission`, then Submit
   writes the real function response and continues the model. Restore
   continuations skip file-history snapshots (they are not user turns).
   Pending worktree / recovered-agent notices are attached to the
   post-answer message and cleared only after that message lands. Cancel
   persists a decline (live decline handling). **Unattended** termination of
   a restored batch (`timeout`, `session_closed`, abort) persists nothing
   for the whole batch: the calls stay dangling in the transcript so a
   later load can re-hang them again.

`requestId` is not persisted across restarts.

## Out of scope

- Boot-time auto-resume of waiting sessions
- Restoring exec/edit or other non-AUQ permissions
- Restoring AUQ mixed with other dangling tools
- Changing generic `continueLastTurn` synthetic-failure semantics
- Persisting old `requestId` / permission audit ring
