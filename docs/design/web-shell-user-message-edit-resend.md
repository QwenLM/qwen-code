# Web Shell user message editing and resending

[English](web-shell-user-message-edit-resend.md) | [简体中文](web-shell-user-message-edit-resend.zh-CN.md)

## Problem and scope

The latest ordinary user message can be edited inline. Opening or cancelling
an edit must not change history. Confirming an edit replaces that turn without
rewinding workspace files. Background notifications are not user turns.

The initial implementation could send an old edit into a newly selected session,
rewind before a host rejected submission, lose attachments, or erase the new
message when the rewind event arrived late. IME confirmation could also submit.

## Design

Use the existing send preparation and session ownership checks. A private
`beforeAdmission` callback runs after `prepareSubmit`, `onSubmitBefore`, and
session resolution, but before optimistic rendering or prompt admission. Editing
uses it to resolve attachment contents, validate the original latest message,
fetch the matching rewind snapshot, rewind, and wait for the transcript event.
The existing preparation state excludes other local submissions during this work.
Recheck session ownership after each asynchronous operation. Changing session,
workspace, or reloading invalidates the operation.

Only `onAdmitted` marks success. A rejected preflight leaves the original message
and inline draft intact. After rewind, definite admission or attachment-upload
failures attach the prepared payload to the existing failed-message retry action.
Retry reuses that user block rather than appending another; the independent composer
draft and attachments stay untouched. Read the failed block after sending settles,
since attachment failures may create it asynchronously.
Unknown admission outcomes use the existing recovery UI instead of automatic retry.
A two-second rewind synchronization timeout stops sending and blocks writes until
the event arrives or the session is reloaded. A lost rewind response uses the
same block. Keep the replacement payload with the pending rewind, separately from
the composer. Once synchronization arrives, create one recoverable replacement row
and offer retry without automatically sending. Session ownership changes cancel
pending recovery. A failed send's local user block must not re-arm the rewind block.

Read referenced attachments before rewinding; reuse inline image bytes and local
file data where available. Resend images and files through the normal upload
path. Missing attachment contents fail before rewind. Rebase surviving reference
annotations with the composer's existing text-change mapping. The inline editor
also supports attachment-only messages. IME-owned Enter and Escape are ignored
when either `isComposing` or `keyCode === 229` is set.

Keep the existing host override: a host returning `true` from
`onUserMessageEditRequest` owns editing. Historical transcript views remain
read-only. No new daemon route, persistence format, dependency, or file rollback
behavior is introduced. Conversation-only rewind removes discarded snapshot
positions so subsequent edits resolve the correct turn.

## Constraints and risks

Rewind and prompt admission are separate daemon operations; they are not atomic.
A network or admission failure after rewind can leave the old turn removed from
the active branch. Preserve the replacement draft and report the failure.
Session changes intentionally cancel work rather than restoring old text into a
new session. Reference annotations overlapped by an edit lose their old binding,
matching the existing composer mapping.

## Validation and acceptance

Use the previous review's controlled failing cases and focused regression tests:

- Delayed snapshot/rewind plus session switching never sends to the new session.
- Host preflight rejection performs no rewind and reports no admission.
- Successful admission follows rewind synchronization; normal composer drafts survive.
- Timeout retains the edit separately and blocks writes; late sync exposes retry without sending.
- Failed replacements retry in place, keep composer drafts untouched, and remain editable after success.
- Both background notifications and their replies survive editing a later turn.
- Inline and referenced attachments, including attachment-only prompts, are retained;
  unavailable attachments leave history unchanged.
- IME confirmation and cancellation keys do not submit or discard the draft.

Run package tests, build, typecheck, bundle, lint, and formatting. Automated
component/reducer checks use isolated data; do not overwrite the user's real
session to validate failure paths. Detailed plans and results live in
`.qwen/e2e-tests/`.
