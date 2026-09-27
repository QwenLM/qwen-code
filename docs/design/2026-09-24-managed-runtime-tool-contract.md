# Managed Runtime Tool Contract v2

[English](2026-09-24-managed-runtime-tool-contract.md) | [简体中文](2026-09-24-managed-runtime-tool-contract.zh-CN.md)

Status: contract, worker handlers, and Java tool transport implemented;
Broker transport wiring remains follow-up work

Related: #12380 (Managed Agent staged delivery), the attestation contract in
[2026-09-22-managed-runtime-attestation-contract.md](2026-09-22-managed-runtime-attestation-contract.md),
and the reconciliation thread on #12380 that this contract answers.

## 1. Problem

The owned Managed Runtime worker extends attestation with three tool
operations — `execute`, `status`, and `cancel`. The TypeScript worker and the
Java transport share one wire contract, with the evidence rules the recovery
design already demands:

- A Runtime never sees the Broker's execution id; it identifies a call by the
  original `reference` (`sessionId`, `promptId`, `callId`, `argsDigest`).
- A lookup must never prove a call did not run. A missing record, a timeout,
  or an expired lease is not evidence, so `status` answers `unknown` with 200
  rather than 404 or 500.
- `status` is read-only: it must never enter the prepare path, attach a
  session, or execute anything.

## 2. Scope

In scope: route manifest declarations, the shared schema and conformance
fixtures, and the worker handlers with their raw HTTP gate admission.
TypeScript contract tests and the Java fixture consumer share the contract;
the worker tests exercise the mounted handlers. The Java `HttpRuntimeTransport`
implements `execute`, `status`, and `cancel` against this contract.

Out of scope: wiring `HttpRuntimeTransport` into `RuntimeTransport`,
Harness-side tool wiring, and a
`not_started_proven` outcome, which needs the durable receipt store.

## 3. Design

### 3.1 Routes

All three operations are declared in `OWNED_MANAGED_RUNTIME_ROUTES` with the
attestation discipline: `POST` on an exact path, protocol version 2, closed
JSON bodies, `no-store` on both directions, bearer authentication before
parsing, and the lease id and epoch headers. `execute` accepts up to 256 KiB of
request so a tool call's `input` fits; `status` and `cancel` accept up to 16 KiB.
Every operation answers at most 1 MiB.
Larger tool outputs travel through the artifact delivery track, never through
these envelopes; its contract is the
[Managed Tool Result Contract](2026-09-26-managed-tool-result-contract.md),
which opts in through Tool v3 and leaves these v2 envelopes unchanged.

The fixture header objects are closed to the five protocol headers. This
constrains fixture declarations, not ordinary HTTP headers added by clients
or intermediaries. Negative cases use explicit omission/replacement directives.

The worker mounts all four declared handlers.
`ownedManagedRuntimeRouteGate` admits exactly their declared methods and
paths, including `execute`, `status`, and `cancel`. Undeclared paths, wrong
methods, trailing slashes, and query strings return an empty 404.

### 3.2 Requests

Every request is a closed object:

- `execute`: `protocolVersion`, `reference`, `toolName`, `input`.
- `status`: `protocolVersion`, `reference`, and an optional non-negative
  `afterSequence` cursor.
- `cancel`: `protocolVersion`, `reference`.

The reference is the original call identity the harness assigned; the Runtime
never learns any Broker-side identifier.

Tool input must also be encodable by the Runtime's JSON encoder for identity
comparison. Unencodable input, including excessive nesting within the byte
limit, is rejected with 400 before creating a journal entry. The journal keeps
the encoded input so retries compare strings without re-encoding stored data.

### 3.3 Responses

Every success is a closed object carrying `protocolVersion` and a `state` of
`prepared`, `executing`, `cancel_requested`, `settled`, or `unknown`:

- `unknown` means the Runtime holds no record of that reference. It is a 200,
  and it is not evidence of non-execution.
- `result` is required when the state is `settled` and forbidden otherwise; it carries
  `executionStatus` (`not_started`, `success`, `error`, or `cancelled`),
  `responseParts`, and an optional `error` with `message` and optional `type`.
- `status` may additionally carry `lastSequence`, the Runtime's own progress
  cursor. The current Broker lookup does not consume it.

This slice fixes `responseParts` as an array only. Its element shape is
deliberately deferred to the worker handler and Broker wiring slices, which must
derive it from the actual tool-result path (`ToolCallResponseInfo.responseParts`
uses SDK `Part[]`) and add shared conformance coverage before serving results.
The text parts in these fixtures are illustrative, not a new part format.
A settled `not_started` is the Runtime's explicit terminal answer; a missing
record must still return `unknown` and never imply `not_started`.

Failures keep the shared classification: 401 credentials, 400/413 protocol,
409 identity, 404 incompatible. Under boot v2 of `managed-context/1`,
`execute` can also answer 409 `managed_context_unavailable`, whose class is
recovery; see [Managed Context Worker](2026-09-26-managed-context-worker.md).
JSON errors retain the shared stable codes;
the gate's incompatible 404 has an empty body. The attestation-named codes
are shared across routes; each parser enforces its own route's body cap.

### 3.4 Conformance fixtures

`managed-runtime-tool-v2.fixtures.json` mirrors the attestation suite: three
routes, one identity, and per-route canonical requests with cases covering the
success shapes and the negative discipline. `unknown-is-ok` cases pin the
evidence rule for `status` and `cancel`. The Java consumer pins the route
contract, every outcome classification, and the closed request/response field
sets.

The shared schema enforces each route's exact request fields, for both the
canonical request and any per-case body override. It also requires every `ok`
case to carry a response body, requires `result` exactly when the state is
`settled`, and permits `lastSequence` only on `status`. Each route has exactly
one suite, with fixed envelope limits and error-code vocabulary. Cases cover
all five states and all four execution statuses, including the closed error
object and a status request without a cursor. TypeScript mutation tests remove
required fields or add route-invalid fields to prove these constraints are
load-bearing, and pin the declared manifest to the fixture routes. Raw HTTP
tests prove exact gate admission and replay the negative fixtures against
the mounted worker handlers.

## 4. Validation

Run `npx vitest run src/serve/managed-runtime-attestation-contract.test.ts src/serve/managed-runtime-attestation-worker.test.ts src/serve/managed-runtime-tool-worker.test.ts` in
`packages/cli` and
`mvn test -Dtest=ManagedRuntimeAttestationConformanceTest` in
`packages/sdk-java/runtime-broker`. The TypeScript suite validates the shared
fixtures, schema mutations, exact gate admission, and real tool execution.
The Java suite consumes the same contract files.

### 4.1 Java transport

`HttpRuntimeTransport` validates the caller's reference keys before sending.
For `execute`, the caller map contains the four identity fields plus
`toolName` and `input`; the wire request separates those two fields from
`reference`. `status` and `cancel` send only the four identity fields and may
reuse that caller map. The `session` parameter remains for the future service
adapter; it is not sent or substituted for the original call identity.

This caller map is a transport request, not a new persisted identity format.
The Broker's stored reference remains the four-field identity. Before wiring
physical dispatch, the service adapter must obtain `toolName` and `input`
separately and assemble the transport request without adding the payload to
`reference_json` or changing execution idempotency.

Requests exceeding the route's cap are rejected before sending: 256 KiB for
`execute`, 16 KiB for `status` and `cancel`. Responses are bounded at 1 MiB and
must carry `no-store` and JSON headers. Parsing enforces closed envelope,
result, and error objects; protocol version 2; contract states and execution
statuses; non-empty error strings; and a result exactly when settled.
`lastSequence` is an optional non-negative integer on `status` only.
`execute` requires settlement and returns the result map. `status` and
`cancel` return the validated wire map. Shared error codes remain unchanged;
messages identify the operation and applicable limit. Server failures are
retryable; other HTTP failures are terminal.

Run `mvn test` and `mvn checkstyle:check` in
`packages/sdk-java/runtime-broker`. HTTP fixture replays verify the canonical
requests, success and unknown answers, malformed references and responses,
route-specific request limits, and tool results above 16 KiB through 1 MiB.
The worker handlers described below serve these routes.

## 5. Follow-up work

- Complete the session verbs and wire `HttpRuntimeTransport` into
  `RuntimeTransport`. Supply `toolName`/`input` separately from the stored
  reference as described in §4.1, and cover real Broker dispatch end to end.
- The `UNKNOWN` execution reconciler shipped in #12655. Its transport must
  validate the status wire envelope, then project it to `{state, result}`
  (`result` only for `settled`). Strip `protocolVersion` and `lastSequence`;
  the Broker rejects extra fields and has no cursor consumer yet.
- Whether a cancel of an execution the Runtime reports as still running sends
  the physical cancel is deliberately deferred.

## 6. Worker implementation

The merged attestation worker now mounts the three routes beside `attest`.
Its executor admits exactly the first-slice ordinary tools — `read_file`,
`write_file`, `edit`, and foreground `run_shell_command` — over a real
`Config` rooted at the attested workspace cwd, with checkpointing disabled.
Under boot v2 of `managed-context/1`, each new call instead runs in its
Session's installed effective directory, behind an activation gate; see
[Managed Context Worker](2026-09-26-managed-context-worker.md).
Admission happens on the Harness side; the worker executes with no further
approval gate. Harness admission must include the workspace-boundary
decision: the worker does not confine tool paths or shell commands to the
workspace. The invocation journal is in-memory by construction: the
worker process is the Runtime generation, so a restart is a new generation
rather than a continuation, and `unknown` is the honest answer for anything
the process never saw. The worker disables conversation-dependent file-read
caching: it has no transcript residency evidence and can serve multiple
Runtime sessions. Harness admission owns any prior-read requirement.

Semantics mounted on the contract:

- `execute` is idempotent by `reference.callId`: the same identity joins the
  in-flight invocation or returns its settled result; the same `callId` with
  a different digest or payload is a 409 identity conflict. An unadmitted
  tool name is a 409 as well — it can never be valid for this generation.
  `run_shell_command` whose validated input normalizes to `is_background: true`
  is rejected before creating a journal entry or starting a process. This
  includes case-insensitive string `"true"`; omitted, false, or string `"false"`
  remains foreground. After protocol admission, parameter validation or copying
  failures settle as errors without execution.
  Tools receive a copy of the input so parameter normalization cannot change
  the original payload used to identify retries.
- `status` is read-only and answers `unknown` (200) for a reference the
  Runtime holds no record of; a known invocation answers its state with the
  journal's monotonic `lastSequence`.
- `cancel` settles a `prepared` invocation as cancelled without touching the
  tool, aborts an `executing` one and answers `cancel_requested`, and is
  idempotent thereafter. A cancel the Runtime honored settles the invocation
  as `cancelled` whether the tool surfaces the abort as an error or as an
  early result.
- The worker keeps its 5-second HTTP `requestTimeout`, which bounds receipt
  of the request body, not the duration of a complete request's execution.
  Per-tool timeouts govern execution; headers and keep-alive bounds stay as
  they were.
- Before publishing a settled result, the worker checks the serialized
  status envelope against the 1 MiB response cap. Oversized output is replaced
  with a small terminal error (preserving a cancelled status), retained for
  execute retries, status, and cancel. This is an executed call with unavailable
  output, never `not_started` or an invitation to execute it again.
- `prepared` is an internal journal state: execution advances to `executing`
  synchronously, so HTTP callers cannot observe or cancel a prepared entry.

Validation adds `managed-runtime-tool-worker.test.ts`: every negative shared
fixture is replayed over raw HTTP against the real mounted routes, and the
behavioral cases execute a real `read_file` in a temporary workspace, answer
`unknown` for unseen references, join a concurrent duplicate execute, reject
a same-callId different-digest retry with 409, refuse an unadmitted tool, and
cancel an in-flight foreground shell command. Additional regression cases
reject background shell calls without recording them, including normalized
string booleans; admit omitted and boolean/string false `is_background`
values; and settle invalid values without starting a command.

Still follow-up: harness-side `RuntimeBackedTool` wiring, file-history
settlement, capability-digest verification against the admitted tool set,
journal retention bounds, image input support for the synthetic
`managed-runtime-worker` model, and the artifact delivery track for large
outputs.
