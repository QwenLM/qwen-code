# Managed Runtime takeover reconciliation (G2)

[English](managed-runtime-takeover-scan.md) | [简体中文](managed-runtime-takeover-scan.zh-CN.md)

## Problem and scope

Issue #12952 G2 requires a replacement Broker to reconcile executions when it
adopts a persisted Runtime Session. Today acquisition restores the Session but
does not inspect its executions; the explicit reconciler only accepts UNKNOWN.
This change covers the Broker, its in-memory and JDBC ledgers, and recovery
tests. G0/G1 admission, Harness affinity, periodic scans, and multi-instance
control-plane policy remain separate.

## Design

After the original binding has been adopted and attested, acquisition of a
persisted READY Session scans its potentially dispatched executions:
EXECUTING, CANCEL_REQUESTED, and UNKNOWN. PREPARED and DISPATCHING have not
crossed the durable dispatch boundary and retain their existing explicit
start/retry behavior. The scan never starts a tool or claims a dispatch.

The ledger returns at most 100 candidates per page, scoped by binding,
generation, Harness Session, and Runtime Session. Keyset ordering uses the
execution ID hash, matching JDBC's existing primary key. Every visited record,
including an unresolved record, advances the cursor so unavailable evidence
does not starve later pages. Pages run sequentially. Each status request uses
the existing operation lease timeout; only one lookup is active at a time.
Total adoption latency scales with the number of candidates, while page memory
and individual lookup duration are bounded.

Lookups use the adopted original generation's attested route and the existing
status/result validation. A valid settled result is committed with an atomic
identity/version/state check, preserving the dispatch owner, generation,
lease, cancellation intent, and event sequence. It does not first fence the
record to UNKNOWN. The existing UNKNOWN-only repository API retains its
contract; a separate evidence settlement operation accepts the three scan
states. A concurrent terminal write wins and is never overwritten.

Unavailable, malformed, or nonterminal Runtime answers leave the execution
unsettled. These states already prevent redispatch: expired EXECUTING and
CANCEL_REQUESTED become UNKNOWN on an explicit retry, and UNKNOWN never
dispatches. Storage failures abort adoption instead of pretending to finish
the scan. Shutdown stops further lookups and late settlement writes.

Each successful settlement is durable before the next lookup. An interrupted
acquisition restarts enumeration; already terminal rows are excluded and are
not looked up again. Unresolved rows may be looked up on a later adoption.
No durable scan table, timer, public route, or operator cursor is needed.

## Consumers and constraints

`RuntimeBrokerService.acquire` is the adoption entry point used by
`RuntimeBrokerHttpServer` and embedded callers. The private acquire route
remains scoped to its resolved Runtime Session. `ToolExecutionRepository` has
in-memory and JDBC implementations and test wrappers. The shared JDBC contract
also runs against the Managed Agent Server's Flyway schema and MySQL; no schema
change is required. Ordinary CLI storage and Hosted public admission do not
change.

## Verification and acceptance

- Adoption resolves valid original-generation evidence without execute,
  claim, or intermediate UNKNOWN writes, including expired claims.
- Unavailable, invalid, and nonterminal evidence remains blocked; an explicit
  retry cannot execute those calls again.
- More than one page is visited even when early records remain unresolved.
- Interruption and a replacement Broker skip durable settlements.
- Other Sessions and generations are excluded; stale version/identity and
  concurrent terminal writes cannot overwrite a receipt.
- Run focused Broker tests, JDBC contract tests, build, typecheck, and bundle;
  perform independent verification and repeated forward/reverse diff audits.

## Open questions

None for G2. A periodic retry policy and a fixed overall adoption deadline with
a durable scheduler are deferred rather than added to this slice.
