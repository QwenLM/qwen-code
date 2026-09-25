# Hosted Runtime foundation boundary

[English](hosted-runtime-foundation-boundary.md) | [简体中文](hosted-runtime-foundation-boundary.zh-CN.md)

## Status and problem

PR #12691 contains foundations extracted from #12358, not a runnable Hosted
Harness. Review found missing session-loop and worker-route integration, native
execution APIs that do not exist on main, and incompatible Java and TypeScript
execution contracts. The agreed scope is to make the foundations buildable and
fail closed, without importing the preview architecture.

## Scope and decisions

`qwen serve --profile hosted-harness` fails before opening a listener, even with
valid credentials. Experimental Managed Gateway/worker/auto-local settings also
fail. Default serve remains available; explicit broker options require the
unavailable hosted profile. Environment-only broker settings have no effect in
default mode. Help text describes this restriction.

Bridge managed-tool methods are optional capabilities. A local provider rejects a
bridge without these capabilities before creating a session. This does not add a
working ACP worker implementation. Unused declarations for durable session-store
and continuation metadata are not evidence of persistence or recovery support.

The built-in managed factory admits ReadFile, WriteFile, Edit, NotebookEdit,
Glob, LS (when enabled), and ZoomImage only when already admitted by the source
registry. Shell and both Grep implementations are excluded until physical process
ownership and cancellation settlement are available. Native optional undefined
parameters are projected to JSON for response and integrity digests; incoming
requests retain strict validation. Edit confirmations have a bounded response
budget independent of the smaller request budget.

ProcessRegistry distinguishes a proven nonzero/signal exit with ProcessExitError
from failures to establish process-tree cleanup. Only the proven-exit error is
accepted during local worker reclamation. Other shutdown consumers retain the
existing Error behavior and messages.

## Broker contract and ownership

All HTTP Broker operations are scoped by the resolved Harness session and its
Runtime session; tenant/workspace claims come from the service resolver. These
are not primary-daemon or process-global workspace routes.

The Java service supports immediate execution creation. Its HTTP adapter returns
501 runtime_broker_operation_unsupported for deferred prepare/start and operator
resolution, with no dispatch or resolution side effects. UNKNOWN records return
409 runtime_broker_execution_unknown, never a fabricated executing status. The
TypeScript two-phase client therefore fails against unsupported operations; it
must not be mounted as a production closed loop yet.

The Java HTTP transport still supports attestation and its existing tool
execute/status/cancel format. Acquire/control/release fail closed. Its reference
and result formats differ from the TypeScript ManagedToolV2Client format; this PR
does not claim interoperability between them.

The local-process provisioner recognizes only processes it owns. An unowned or
unreachable process is UNKNOWN. Only a locally observed dead Process supports
NOT_FOUND. Broker restart adoption remains unavailable, preventing a transient
attestation failure from authorizing a replacement worker beside a live one.

Broker clients can retry failed acquisition, invalidate issued clients on release,
and retain terminal release intent across concurrent release calls.

## Validation and acceptance

Build and typecheck all packages. Run focused Core, Bridge, CLI and Java tests.
Test real ReadFile preparation, oversized-but-bounded edit confirmations, acquire
retry, released-client rejection, unsupported profile startup, forced worker
termination and Java HTTP unsupported/UNKNOWN/authentication boundaries.

Tests imported from the preview for absent worker routes are removed; provider
unit and transport-fixture tests remain. Those removed tests cannot establish
worker coverage until an actual worker implementation is included.

Acceptance requires ordinary serve to load, unsupported modes to open no listener,
prepare to dispatch nothing, unknown outcomes to remain unknown, and all included
code to compile. Live model/tool round trips and restart recovery are not claimed.

## Follow-up requirements

A later integration must add the resident session loop, owned ACP worker routes,
a shared wire format, durable reserve/start and explicit resolution APIs, session
store/continuation wiring, process containment for Shell/Grep, and a real cold-start
E2E test. Enabling the hosted profile depends on those behaviors, not solely on
configuration validation or mocked transport tests.
