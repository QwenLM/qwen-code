# LSP diagnostic negotiation and failure visibility

[English](lsp-diagnostic-failures.md) | [简体中文](lsp-diagnostic-failures.zh-CN.md)

> Status: Implemented locally; verification is recorded separately.

## Problem

The client requests `textDocument/diagnostic` without advertising its existing
pull-diagnostic support. The JSON server used in real testing selects push
instead, reports malformed JSON through `publishDiagnostics`, and rejects the
pull request. The service ignores that rejection and returns an empty array,
which the tool presents as no diagnostics. Workspace diagnostic request failures
and malformed report envelopes can produce the same false-clean result.

## Decision

Advertise `textDocument.diagnostic` with dynamic registration and related-document
support disabled. Use the existing pull request, normalization and tool output;
do not add a push cache just to repair capability negotiation.

Successful document and workspace reports must contain an `items` array. A
missing or `null` response cannot establish a current clean report; this replaces
the former null compatibility policy when integrating main's failure accounting.
Each in-scope file report must contain its own `items` array without diagnostics
lost during normalization. Empty-string diagnostic messages are valid; missing
or non-string messages remain invalid. Malformed URI strings and out-of-scope
locations remain omitted. Physical-resolution failure is distinct from malformed
URI syntax: it rejects rather than dropping a potentially in-scope report, without
retiring its delivered state merely because result scope is unknown.

No previous result identifier is sent, so an unchanged report without items
cannot establish a current result. Invalid report envelopes and malformed
in-scope payloads reject even after earlier diagnostics; scope, synchronization
and scan-budget failures also remain hard errors. Independent transport failures
are accounted for per server under main's policy: actual nonempty diagnostics
from healthy servers survive, but do not certify complete analysis. Empty results
require a usable answering server and no relevant failed/unreachable server.
An unsupported `-32601` sibling cannot veto a genuine supported answer; when no
server answers, including a lone unsupported workspace pull, the query rejects.
Document empty-answer ownership checks apply after file routing; explicit
`serverName` bypasses language/root and declaration-based ownership, never the
workspace boundary. Rejections name the server or unresolved URI and retain the
original reason. The tool exposes them as `ToolErrorType.EXECUTION_FAILED` without
changing the public diagnostic array types. The
[disk synchronization design](lsp-disk-document-sync.md) records the integrated
failure/ownership ledger; unrelated transport catches remain outside this repair.

## Boundaries

Keep current workspace containment, explicit-map authority, extensionless legacy
routing, document synchronization and diagnostic normalization. Related-document
reports, dynamic diagnostic registration, refresh requests and unsolicited push
caching are not implemented. A push-only server that cannot answer the pull
request reports failure rather than a clean file. Workspace result limits and
out-of-scope filtering are unchanged.

## Acceptance

- Reproduce malformed JSON being pushed while the current pull request fails.
- Verify initialization advertises only the supported diagnostic behavior.
- With a real JSON backend, malformed files return nonempty pull diagnostics
  and valid files return successful empty reports after open/change.
- The freshly built CLI displays the actual backend error for malformed files,
  not `No diagnostics found`; a mock model is clearly distinguished from a real
  model. Missing model authentication and unavailable platforms are disclosed.
- RPC rejection, timeout or connection closure cannot establish a clean result.
  Valid empty reports remain usable; null/missing results alone reject. Actual
  healthy-server diagnostics survive independent RPC failures, but invalid
  payloads and scope/synchronization/scan errors reject even after earlier results.
  A lone unsupported workspace request fails; supported empty sibling reports
  still succeed. Empty-message diagnostics and adjacent real errors are retained.
- Existing routing/scope/lifecycle tests, build, typecheck, bundle and scoped
  lint/format checks pass. Real macOS and Linux runs corroborate the protocol
  behavior where available; no claim is made about unexecuted Windows tests.

## Risks

Diagnostic failures that were previously hidden now become visible. Main's
partial-result policy preserves actual diagnostics across independent transport
failures, without certifying completeness. Null responses no longer certify clean
results. Invalid payloads and unresolved result scope remain hard failures. This repair
is not full push-diagnostic support or a guarantee that every LSP server supports
pull diagnostics. Existing filesystem race limits remain unchanged.
