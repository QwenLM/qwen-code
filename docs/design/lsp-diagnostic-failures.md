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

A successful document report must contain an `items` array. Workspace reports
must also contain an `items` array. Each file report for a current URI must
contain its own `items` array without diagnostics lost during normalization;
malformed or out-of-scope locations remain omitted by the existing URI filter.
No previous result identifier is sent, so an
unchanged document report without items cannot establish a current result.
Unsupported methods, transport errors and invalid report envelopes fail the
query with the server name and original reason. They must not become an empty
or apparently complete partial result. Existing tool catches render those
failures without changing the public diagnostic result types.

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
- RPC rejection, timeout, connection closure and invalid report envelopes surface
  failure through document and workspace tools. Successful empty reports remain
  valid, and an earlier server's results do not conceal a later server failure.
- Existing routing/scope/lifecycle tests, build, typecheck, bundle and scoped
  lint/format checks pass. Real macOS and Linux runs corroborate the protocol
  behavior where available; no claim is made about unexecuted Windows tests.

## Risks

Diagnostic failures that were previously hidden now become visible. A failed
server prevents reporting document diagnostics as a complete successful result;
partial-result reporting would require a separate public contract. This repair
is not full push-diagnostic support or a guarantee that every LSP server supports
pull diagnostics. Existing filesystem race limits remain unchanged.
