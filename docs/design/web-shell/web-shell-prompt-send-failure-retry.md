# Web Shell Prompt Send Failure Retry

## Goal

Make a prompt transport failure visible on the user message that failed to
send, and let the user retry it without creating a duplicate message.

## Behavior

- Only failures before daemon admission are shown as send failures. Errors
  after admission continue to use the existing turn-error retry UI.
- The failed user message shows an inline "Failed to send" label and a retry
  icon directly below its bubble.
- Retrying sends the original text, images, and input annotations without
  appending another optimistic user message.
- The failure indicator is removed as soon as the retry starts.
- The global processing indicator stays hidden until the daemon admits the
  retry, then starts timing from the retry attempt rather than the original
  failed message.
- If an admitted retry later becomes a turn error, retrying from the existing
  turn-error UI also starts a new timer for that retry attempt.
- If the retry also fails before admission, the indicator returns.
- As soon as a newer user message is sent, the previous message no longer
  offers retry.
- Session changes or transcript reconciliation remove failure state whose
  message is no longer present.
- The first prompt in a lazily created session uses the allocated session ID
  even before the connection render catches up.

## Scope

The state remains local to the Web Shell UI and is keyed by both the owning
session and the exact optimistic user message ID captured when it is appended.
Failures settling after a session change are ignored. The daemon transcript
schema and SDK store remain unchanged.
