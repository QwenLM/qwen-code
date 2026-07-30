# GitHub Channel Publication Contract

## Goal

Make GitHub-channel replies safe to publish automatically and traceable after the fact. The channel publishes only the agent's final response through the adapter; intermediate reasoning, tool output, and streaming chunks never become GitHub comments.

## Contract

- The GitHub adapter disables block streaming, so each accepted inbound event produces at most one final response-delivery attempt.
- Final delivery uses the active prompt's issue/PR thread rather than a potentially stale shared-session target.
- Channel instructions tell the agent not to use `gh` or the GitHub API to create comments or reviews. The adapter owns public delivery.
- A final response whose trimmed content is only the `<no-reply/>` sentinel is intentionally suppressed. Whitespace, case, a space before `/>`, and a single wrapping code fence are normalized; any other content is published unchanged.
- Suppression and publication are recorded in a local append-only JSONL audit file at `~/.qwen/channels/<channel>-github-audit.jsonl`. Records contain time, channel, session, source message, thread, outcome, GitHub comment identity/URL when present, and a SHA-256 plus character count of the reply. They never contain reply text, credentials, or a GitHub token.
- Audit writes are best effort. An audit failure is logged without changing the publication result. An ambiguous GitHub API failure remains a delivery failure and is not retried; definite rate-limit no-write responses may use the existing retry backoff.

## Flow

1. The GitHub adapter dispatches an accepted event into `ChannelBase`.
2. The active prompt keeps the inbound message and issue/PR thread available until final delivery finishes.
3. The agent returns one final response.
4. The adapter either suppresses the exact sentinel or creates one issue comment.
5. The adapter appends a publication audit record. The terminal task lifecycle remains owned by `ChannelBase`.

## Non-goals

- This does not create a durable outbox, retry failed publication, status comments, or response streaming. Those are separate parts of issue #8012.
- The instruction against direct `gh`/API publication is an operational boundary for the agent, not sandbox enforcement. Enforcing tool-level GitHub write restrictions belongs to the runtime permission model.

## Verification

Focused GitHub adapter tests cover sentinel suppression, normal final-comment delivery, audit fields without reply text, and non-blocking audit write failures. Existing routing and delivery tests remain unchanged.
