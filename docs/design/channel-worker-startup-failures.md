# Channel worker startup failure reporting

## Context

[Issue #6909](https://github.com/QwenLM/qwen-code/issues/6909) identifies a diagnostic gap in daemon-managed channels. An adapter's `connect()` rejection is logged by the worker, but the worker then reports only ready or exits with `No channels connected.` The supervisor, dynamic control API, SDK, and CLI therefore lose the actionable provider error.

This change carries bounded, sanitized `connect()` failures through the worker startup boundary. It does not change configuration parsing, extension loading, adapter construction, daemon boot fail-fast behavior, or post-start failure history.

## Behavior

- If at least one selected adapter connects, the worker becomes ready. Its current snapshot contains the failed channel names and reasons, and dynamic enable still returns success with `partial: true`.
- If every adapter fails during a dynamic enable, replacement, or reload, the request returns `502 channel_worker_start_failed` with the attempted failures. `state` describes the post-rollback current state; the attempted failures are not persisted into that state.
- If every adapter fails during daemon boot, startup remains fail-fast. Because the daemon listener does not remain available, no later GET is promised.
- A new worker generation clears startup failures from the preceding generation.

Only `connect()` rejections produce these records. `phase` is currently `connect`; the SDK deliberately widens it to `string` so a future additive phase does not require a breaking type change. Adapter `code` values are diagnostic and not a stable cross-adapter taxonomy.

## Contract

A current worker snapshot may contain:

```ts
interface ChannelStartupFailure {
  channel: string;
  phase: 'connect';
  code?: string;
  message: string;
}

interface ChannelWorkerSnapshot {
  startupFailures?: ChannelStartupFailure[];
  startupFailuresTruncated?: boolean;
}
```

A dynamic start failure may additionally contain failures annotated with the trusted supervisor workspace:

```ts
interface ChannelStartupAttemptFailure extends ChannelStartupFailure {
  workspaceCwd: string;
}
```

The existing top-level error string, rollback fields, and state remain compatible. All new fields are optional.

## IPC and lifecycle

The child sends one `channel_startup_failure` message from each `connect()` catch and waits for `channel_startup_report_ack` before trying the next adapter. The parent validates, sanitizes, stores, and only then acknowledges the item. The send callback is not the durability boundary: it proves only that Node accepted the message, while the ACK proves the supervisor processed it before the worker can synchronously exit.

At most 64 failures are transferred. Failure 65 produces one `channel_startup_failures_truncated` marker, which is also acknowledged; later failures remain stderr-only. Only one report is outstanding, so the ACK needs no request identifier.

Malformed, overlong, out-of-order, or unacknowledgeable startup protocol messages fail the bounded startup and terminate the child. Unrelated unknown IPC messages retain their existing behavior. The existing ready schema and validation are intentionally unchanged.

Every pre-ready terminal path wraps already accepted failures in `ChannelWorkerStartupError`. Reconcile and manager errors clone those details while preserving cleanup or restoration problems separately as `rollbackError`. The workspace is added from supervisor configuration, never from child IPC.

## Security and bounds

Worker and supervisor both normalize control and invisible characters, exactly redact the daemon token and sensitive environment values, apply generic credential rules, and truncate by Unicode code point. The dynamic-failure HTTP response and CLI display boundaries validate again, apply generic redaction, cap output, and ignore malformed entries.

Limits are 64 failures, 128 code points for channel, 64 for code, and 512 for message. Failure objects and snapshots are cloned at ownership boundaries to prevent callers from mutating supervisor state.

## Alternatives rejected

- Reading stderr in the supervisor is ambiguous, couples behavior to log prose, and cannot provide reliable channel attribution.
- Waiting only for the `process.send()` callback still races synchronous worker exit.
- Persisting a last failed attempt would change lifecycle semantics and overlaps the separate last-error/history work; dynamic failures instead live only in the failing response.
- Inventing auth/network/config categories would create an unstable taxonomy across adapters. The implementation preserves only an adapter-provided string or finite numeric code.

## Verification

Unit coverage exercises ACK ordering, all/partial failure, abort and timeout paths, malformed protocol input, ACK failure, safe exception access, exact and generic redaction, deep copies, generation reset, 64/65 truncation, rollback propagation, HTTP validation, SDK exports, and CLI formatting. The real plugin-example integration test uses a locally allocated then closed port to produce deterministic `ECONNREFUSED` without external credentials or network dependencies.
