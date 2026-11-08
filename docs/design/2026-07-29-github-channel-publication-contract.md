# GitHub Channel Publication Contract

[English](2026-07-29-github-channel-publication-contract.md) | [简体中文](2026-07-29-github-channel-publication-contract.zh-CN.md)

## Goal

Make GitHub-channel replies safe to publish automatically and traceable after the fact. The channel publishes only the agent's final response through the adapter; intermediate reasoning, tool output, and streaming chunks never become GitHub comments.

## Contract

- The GitHub adapter disables block streaming, so each accepted inbound event produces at most one final response to deliver.
- Final delivery uses the active prompt's issue/PR thread rather than a potentially stale shared-session target.
- Channel instructions tell the agent not to use `gh` or the GitHub API to create comments or reviews. The adapter owns public delivery.
- A final response whose trimmed content is only the `<no-reply/>` sentinel is intentionally suppressed. Whitespace, case, a space before `/>`, and a single wrapping code fence are normalized; any other content is published unchanged.
- Suppression and publication are recorded in a local append-only JSONL audit file at `~/.qwen/channels/<workspace-scope>/<channel>-<name-hash>-github-audit.jsonl`. Records contain time, channel, session, source message, thread, outcome, GitHub comment identity/URL when present, and a SHA-256 plus character count of the reply. They never contain reply text, credentials, or a GitHub token.
- Audit writes are best effort. An audit failure is logged without changing the publication result. An ambiguous GitHub API failure remains a delivery failure and is not retried. A definite no-write response — GitHub's rate limiter refusing the comment with a 403 or 429 that carries a numeric `x-ratelimit-remaining` and shows the budget exhausted, sends `retry-after`, or names a secondary rate limit in its message — is retried in process and, if GitHub still refuses it, written to a private pending-delivery file and retried on the next channel start. A rate-limit answer without that header is ambiguous.

## Flow

1. The GitHub adapter dispatches an accepted event into `ChannelBase`.
2. The active prompt keeps the inbound message and issue/PR thread available until final delivery finishes.
3. The agent returns one final response.
4. The adapter either suppresses the exact sentinel or creates one issue comment.
5. The adapter appends a publication audit record. The terminal task lifecycle remains owned by `ChannelBase`.
6. If final delivery fails with a definite no-write response, the adapter tries twice more, waiting for `retry-after` when it is a positive number of seconds, otherwise until the budget resets when it is exhausted, and otherwise one minute and then two (also when the reset already looks past). An ambiguous answer to one of those attempts ends them like any ambiguous failure, with no pending record. If GitHub still refuses, or the channel stops during a wait, the adapter stores the final text in `~/.qwen/channels/<workspace-scope>/<channel>-<name-hash>-github-pending-deliveries.json` with private file permissions and retries it after restart without rerunning the agent. That start-up pass stops sending at the first stored reply GitHub still rate-limits and keeps the later ones for the following start, together with that reply when the answer is a definite no-write; replies the audit already records as posted are dropped.

## Non-goals

- This does not retry ambiguous publication failures, create status comments, or enable response streaming. Those are separate parts of issue #8012.
- The instruction against direct `gh`/API publication is an operational boundary for the agent, not sandbox enforcement. Enforcing tool-level GitHub write restrictions belongs to the runtime permission model.
- Pending-delivery retention policy, including max attempts, max age, size caps, stale-reply handling, and orphan temporary file cleanup, is tracked separately in #8142.

## Verification

Focused GitHub adapter tests cover sentinel suppression, normal final-comment delivery, audit fields without reply text, and non-blocking audit write failures. Existing routing and delivery tests remain unchanged. Further adapter tests cover which rejections count as a definite no-write, the in-process waits and the stop during them, and the start-up pass over pending deliveries.
