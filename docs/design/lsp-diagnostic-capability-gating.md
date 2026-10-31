# LSP Diagnostic Capability Gating

[English](lsp-diagnostic-capability-gating.md) | [简体中文](lsp-diagnostic-capability-gating.zh-CN.md)

## Status

Implemented for issue #13283.

## Problem

Before this change, the LSP manager retained only `textDocumentSync` from a successful
`initialize` response. The diagnostic service therefore cannot distinguish a
server that explicitly lacks pull diagnostics from a server whose initialization
failed before capabilities were known. It warms and requests known unsupported
servers, potentially waits for the request timeout, and lets their failures veto
a supporting sibling's clean report.

Document and workspace pulls are separate capabilities. A provider may support
`textDocument/diagnostic` while setting `workspaceDiagnostics: false`.

## Goals

- Capture document and workspace pull support from the real initialization
  response.
- Advertise client support for both diagnostic pull methods.
- Exclude known unsupported servers before warmup or requests.
- Preserve failure vetoes for supporting servers and for unknown or failed
  initialization.
- Report unsupported diagnostics when every candidate is known not to support
  the requested pull.

## Scope

This change adds no push-diagnostic subscription, changes no diagnostic
attribution table, and does not infer support from server names or JSON-RPC error
text. The existing numeric `-32601` fallback remains intact for servers whose
advertised capability is inaccurate. Other LSP operations are unchanged.

## Design

`LspServerHandle` receives an optional per-connection `diagnosticPull` record
with a three-state `document` value and a `workspace` boolean. A successful
initialization always sets the record: an omitted or null `diagnosticProvider`
leaves document support unknown and workspace support false; explicit false
means both are false;
an object or true enables document pull; only an object with
`workspaceDiagnostics: true` enables workspace pull. Before a new connection
starts, and when a connection stops or resets, the record is cleared.

An absent record means unknown, not unsupported. Diagnostic selection excludes
only a record whose requested method is explicitly false. The same predicate is
used by initial ready selection, newly-ready selection, and unreachable-server
accounting. Thus a supporting server that fails still vetoes, and a failed or
starting server without completed initialization remains unreachable and vetoes.

When configured candidates exist but every relevant candidate is known
unsupported, selection throws an unsupported-diagnostics error without warmup
or a protocol request. Document selection retains the existing file relevance
rules before deciding whether an unsupported server is a candidate.

The initialize request advertises `textDocument.diagnostic.dynamicRegistration`
as false and `workspace.diagnostics.refreshSupport` as false. These fixed method
flags match the client's static pull implementation and add no registration or
refresh behavior.

## Downstream Consumers

- `LspServerManager` initialization writes capability state; startup, stop, and
  crash reset clear it.
- `NativeLspService.getDiagnosticHandles` selects initial document and workspace
  candidates and produces the all-unsupported error.
- `NativeLspService.newlyReadyDiagnosticHandles` applies the same gate to servers
  that become ready during a query.
- `NativeLspService.unreachableDiagnosticServers` excludes known unsupported
  servers from failure veto accounting while retaining unknown states.
- `NativeLspService.diagnostics` consumes document support through those helpers.
- `NativeLspService.workspaceDiagnostics` consumes workspace support through
  those helpers.

No other consumer reads `diagnosticPull`.

## Constraints and Risks

Real initialization captures from gopls 0.22.0 and Pyright 1.1.414 omit
`diagnosticProvider` even though document pulls return source diagnostics.
Omission therefore remains unknown for document pulls, preserving the numeric
`-32601` fallback for unsupported servers. This intentionally cannot avoid every
document timeout: omission alone cannot distinguish these servers from
typescript-language-server 5.3.0, which omits the field and returns `-32601`.
Workspace pulls still require explicit advertisement. Unknown initialization
continues to veto false clean reports.

Dynamic registration is unsupported and advertised as false. Capabilities are
captured once per connection; later registration requests do not update them.

## Validation

- Reproduce the timeout and veto on the base revision.
- Test the real initialization handshake and captured document/workspace flags.
- Feed an omitted-capability initialize response through the real manager and
  then query the service: document pulls remain available, workspace pulls do not.
- Test capability clearing on stop and crash reset.
- Test initial, newly-ready, and unreachable paths for both requested methods.
- Test all-unsupported errors and conservative supporting/unknown failures.
- Run focused core tests, build, typecheck, and preflight.

## Acceptance Criteria

- Known unsupported servers receive no warmup or diagnostic pull request.
- Document-only providers receive no workspace pull request.
- All-known-unsupported queries report unsupported.
- Supporting failures and unknown initialization still veto clean output.
- Capability state cannot survive its connection.
- Existing `-32601` classification and all non-diagnostic LSP behavior remain
  unchanged.

## Open Questions

None. Push diagnostics remain separate work.
