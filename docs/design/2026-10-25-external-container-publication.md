# External container boot and publication

[English](2026-10-25-external-container-publication.md) | [简体中文](2026-10-25-external-container-publication.zh-CN.md)

## Scope and current state

This is the worker-side step of [#15512](https://github.com/QwenLM/qwen-code/issues/15512), following the [phase-2 design](https://github.com/QwenLM/qwen-code/pull/15520). Container mode previously admitted boot-v1 session workers and the dedicated CSI profiles, but rejected ordinary boot-v2. The change admits an explicit external-storage extension and exposes foreground publication. Local boot-v2 and CSI boot documents remain separate contracts. The broker, adapter, registration HTTP API, provider probe and PUBLIC K8s path are outside this change.

The worker remains session-isolated. It uses the existing workspace capability digest, context installation and activation checks. Publication covers foreground process pipes (`stdout` and `stderr`); PTY, background Shell, monitor, hook and MCP execution are not admitted by this external profile. The adapter and broker consumers are follow-up work; this surface is inert until they supply the registration descriptor, install context, activate it and begin each capture.

## Registered storage admission

Container boot-v2 retains its existing context fields and adds exactly:

```json
{
  "storage": {
    "kind": "external",
    "physicalKey": "physical-a",
    "aliasPath": "/external/workspace-a",
    "mountRoot": "/workspace",
    "registrationRevision": 1
  }
}
```

The context `mountRoot` must equal the storage `mountRoot`. Paths must be normalized absolute POSIX paths other than `/`, without dot segments, trailing separators or symbolic-link resolution. Identifiers and path components use ASCII letters, digits, dot, underscore and hyphen, with at most 128 characters per component and 2048 characters per path. The revision is a positive safe integer.

Boot cannot prove registration by comparing its fields with themselves. Before starting the worker, the adapter must write a sibling `registration.json` in the canonical, owner-owned `0700` boot directory, outside the workspace. This closed JSON document contains exactly `providerId`, `physicalKey`, `aliasPath`, `mountRoot` and `registrationRevision`. The worker requires an owner-owned regular `0600` file, rejects symlinks and extra hard links, bounds it to 16 KiB and decodes UTF-8 strictly. All four storage fields must equal boot. Provider identity comes from this trusted adapter channel; boot does not independently select a provider.

The trust chain is central registration → broker storage provision → adapter durable journal → private descriptor → worker comparison. This PR implements only the final read and comparison. A missing, malformed or mismatched descriptor fails startup with a generic error. No fallback physical key is selected. The worker creates a missing mount root as `0700`, checks ownership and read/write/search access, and pins its filesystem identity before admitting tools. Later mount checks reject replacement or permission changes. Registration data and filesystem failure details are not echoed in responses.

## Publication contract

Successful external admission starts the ordinary worker listener on port `43190` and a separate publication listener on `43191`, both inside the container. The ready receipt adds `publication: { url, paths }`. The adapter must forward the publication port explicitly. It is not a public HTTP service. Publication paths are absent from the ordinary listener and from v1, local v2 and CSI workers.

All publication routes are POST, use `Cache-Control: no-store`, the existing bearer token and lease ID/epoch headers, and additionally require `X-Qwen-Managed-Runtime-Incarnation` and `X-Qwen-Managed-Storage-Revision`. Bodies are closed JSON and bounded to 64 KiB; responses also remain within 64 KiB. Authentication, revision and incarnation failures do not return storage identity or raw error details.

- `/internal/managed-runtime/v2/publication:begin`: `{ protocolVersion: 2, reference, capture, expiresAt }`. Reference and capture use the existing Tool-v3 parsers and exact captured-input identity. `expiresAt` is an absolute millisecond timestamp supplied by the authenticated broker. It must remain in the future and cannot change on retry. The response contains an opaque `channelId`. At most 64 foreground channels may be installed per worker. Retrying the same execution and input returns the same channel; rebinding it fails closed.
- `/internal/managed-runtime/v2/publication:read`: `{ protocolVersion: 2, channelId, streamId, sequence, acknowledgedSequence }`. Stream is `stdout` or `stderr`. Sequence starts at zero; acknowledgement starts at `-1` and may only advance over a delivered sequence. Reads return `pending` until the foreground capture is finalized, then `ready` with base64 bytes and a durable receipt containing channel, stream, sequence, length, SHA-256 digest and EOF. Each chunk is at most 32 KiB. EOF is a separate empty sequence. To confirm receipt of EOF, repeat its read with `acknowledgedSequence` equal to the EOF sequence. Older sequences remain replayable after stopping.
- `/internal/managed-runtime/v2/publication:stop-drained`: `{ protocolVersion: 2, channel: "all" }`. This seals new executions and publications. Unfinished or unacknowledged channels return `undrained` with channel IDs. Once every stream's EOF is acknowledged, the existing executor retirement checks require committed result acknowledgement and proof that its process groups are stopped. A missing or failed proof returns `unknown`. Successful retirement persists a worker-domain stop receipt before returning `drained`; retries return the same proof while every channel lease remains live.

An unknown channel, expired publication lease, conflicting input or stale Runtime domain fails closed. Expiration does not create a drain proof and rejects replay even when an earlier stop proof exists. The 64-channel limit applies over the worker lifetime; expired channels retain their evidence and are not silently reclaimed. No channel is silently replaced, and capture never falls back to an uncaptured execution. Restart creates a new private publication directory and knows none of the old channels; it cannot certify their drain.

## Storage and failure semantics

Publication reuses the local foreground capture, segment store, Session resource store and writer lease. Begin, final, read, acknowledgement and stop receipts are persisted in worker-private `0700` directories beside boot, outside the workspace; resource files are private and synced before receipts are acknowledged. Raw bytes retain existing local capture limits. The authenticated read endpoint intentionally delivers the captured bytes; it does not redact or filter them. Credentials, registration descriptors and private filesystem paths are excluded from publication metadata and error responses.

Read replay is available after admission is sealed. Incomplete capture, unacknowledged results, physical-stop uncertainty, storage failure and lease expiry cannot become successful drain. Worker shutdown closes both listeners after executor shutdown and releases local writer leases. Retained output is not automatically deleted; retention and recovery belong to the later adapter/broker integration.

## Validation and acceptance

| Instrument                                    | What it can falsify                                                                                 | Limit                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Real private boot files and filesystem checks | Missing/mismatched registration, unsafe paths and permissions, accidental mount creation on refusal | Local POSIX filesystem, not a production sandbox    |
| Real HTTP listeners                           | Port separation, authentication and stale lease/revision/incarnation rejection                      | No adapter forwarding                               |
| Actual subprocess and local durable capture   | Binary stdout/stderr integrity, bounded replay, explicit EOF acknowledgement                        | Foreground process pipes only                       |
| Real executor and process ledger              | No drain before result acknowledgement; persisted, replayable stop proof                            | No broker Session transaction or crash-recovery E2E |
| Existing container, worker and Tool-v3 suites | Regressions in previously admitted worker profiles                                                  | Full cross-platform CI remains separate             |

Acceptance requires successful external boot only after matching registration, private output, byte-exact bounded reads, and fail-closed unknown/expired/drain paths. Linux container and real-adapter E2E verification remain follow-up integration work. Windows does not admit this POSIX external-storage profile.
