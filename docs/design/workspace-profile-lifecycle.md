# Workspace profile lifecycle (L4)

[English](workspace-profile-lifecycle.md) | [简体中文](workspace-profile-lifecycle.zh-CN.md)

## Problem and scope

L3 only closes and deletes active `hosted-workspace-files/1` Sessions. Shell capture and publications, background Shell and Monitor resources, and MCP connections need additional durable settlement before the same close and deletion barrier can be used. This implements issue #13164 L4 in two slices: Shell first, then MCP. The development baseline includes the original-worker recovery, public Shell admission and H3 drain contracts from #13673, #13674 and #13889.

Support is exact: `hosted-workspace-shell/1` and `hosted-workspace-mcp/1`. `/2`, CSI, the internal TeamLead profile, new UI controls and changes to child foreground cancellation are excluded. Existing child cascades retain their policy. Session owner plus current read access remains the authorization rule; idempotency keys remain actor-scoped. An active, cancelling or approval-waiting foreground Turn is refused with `turn_active`.

Closing retains bytes. Archive and unarchive reuse L1; unarchive restores closed, never active. Delete reuses L2's atomic tombstone and private recovery/publication retirement. Physical collection remains O4-2's responsibility. Other Sessions and shared Workspace files are retained. Disabling new profile execution does not disable lifecycle cleanup of existing Sessions.

## Protocol and state machine

Keep `lifecycleProtocolVersion: 1` for files clients. Add optional `lifecycleV2Profiles`, containing only exact supported profiles; absence means no v2 support. Java combines this capability with its Broker's ability to verify original-worker retirement. New active Shell/MCP lifecycle operations persist protocol 2. Existing protocol 0 and 1 operations keep their behavior; unknown protocol versions are refused, never interpreted as legacy close.

Use the existing private `/session/:id/lifecycle` route. V2 requests carry `protocolVersion: 2` and `phase: effects | prepare_resources | settle_resources`, the Session key, operation kind and current operation/claim authority. V1 requests retain their original shape. Responses are bound to the operation, Session, phase and version. Resource acknowledgements are not completion proofs.

1. Admission checks actor/read/owner, idempotency, idle foreground journal and exact profile support, then commits the lifecycle fence and closing/deleting state. New ordinary work and warm are refused.
2. In `LIFECYCLE_ONLY`, reconcile previously started business effects and Hooks using original identities. Close runs SessionEnd; delete runs SessionEnd then SessionDelete, with L3's stable occurrence IDs. Unknown business effects are not replayed.
3. Java independently validates and saves the effects receipt, entering `DRAINING`. The existing receipt column is reused; it proves Hook effects only.
4. Always prepare the resources attachment under the current claim before drain, even when recovering an already-saved effects receipt. Settle profile resources while the writer and original publisher remain available.
5. Java independently verifies durable resource closure, detaches the writer, stops the original worker and, inside the final transaction, rechecks effects, resources, writer retirement and original stop evidence. Close completes or delete commits O4 retirement with the tombstone.

No new business table or unbounded aggregate receipt is needed. Recovery uses the operation's persisted protocol, existing fence phase, resource records, publication records and Broker ledgers. Resource uncertainty reports `workspace_lifecycle_resources_unsettled` and retains closing/deleting with recovery blocked. Existing identity, Hook and business execution errors remain distinct.

## Cleanup authority and recovery

V2 `DRAINING` permits a cleanup-only writer under the current operation claim. A resident writer whose lease expired during coordinator downtime may renew only when its token, writer ID and generation still own the locked journal head and the current resource claim is valid. A cold acquisition and this renewal serialize on that head: whichever wins fences the other. Ordinary renewal, files v1, the effects phase, old claims and replaced writers retain their lease checks. Cold attachment restores the saved definition and original identities. It must not run SessionStart, a model, ordinary tools, configure/discover/invoke, or Monitor rebuilding. Broker recovery acquire, status and release must themselves validate the current claim and saved binding/generation. New ordinary acquisition remains forbidden.

Journal and publication writes are narrowly qualified by existing resource identity: output reference advancement, terminal settlement, release evidence and cancellation of existing pending notifications. New executions, changed Runtime identity and new ordinary inputs are forbidden. New lifecycle Hook dispatch still checks current ACL and mount authorization. Claim takeover updates resident as well as cold attachments; an old claim cannot mutate cleanup records.

## Shell slice

Preparation disables new Monitor wakes and notification production without claiming the Monitor has physically stopped. The original observers and publisher continue flushing existing output. Enumerate every saved RuntimeSession from the durable Broker ledger, not `heldRuntimeTurns`. Extract the session drain portion of existing binding drain without calling `stopDrained`.

After original RuntimeSession drain, settle stdout/stderr capture, publication manifests and background/Monitor terminal records using original process exit/stop evidence. Cancel existing notifications without a model. Then close publishers and detach. Java checks tool receipts, output references, manifests, publication state and background records independently. Output must be sealed or have an explicit verifiable failure terminal; absence of pending in a new publisher is not evidence.

For foreground inline capture, the receipt outcome is `REFERENCED`, while the indirectly referenced manifest, pages and segments may remain `PUBLISHED`. Verify the original journal source and retained outcome, then check the manifest's original execution identity, stream digests and seals. A blocked capture still requires its manifest evidence even when `resultRef` is null. O2 publication outcomes use `TOOL_PUBLICATION`: perform the existing object/receipt verification before the final transaction, then recheck the publication phase, quarantine flag and exact admission, receipt sequence and revision inside that transaction. The MCP inline-record reader is not an output reader.

Native `read_file`, `write_file`, `edit` and `glob` calls in a Shell profile use ordinary file results, which do not create O3 capture receipts. Their settled Broker ledger may satisfy resource closure only when a committed `managed-tool-input` in the same Session verifies its bytes and digest, names the original Harness and Runtime Sessions, and its exact `payloadJson` digest matches the execution request. The invocation must be legacy `deferred`, without `runtimeProtocol` or a publication grant. Merely missing a capture or receipt does not identify a file call: legacy tool v2 also supports Shell. Unknown executions, foreign/corrupt/uncommitted inputs and Shell calls without their receipts remain blocked. Acceptance includes real Write/Read followed by close on a Shell profile and the running Shell cancel → native-file Turn → close sequence.

The manifest invocation digest follows the original execution protocol. Only a saved `runtimeProtocol: 3` with `dispatchMode: deferred` uses its bare `inputDigest`; a missing or invalid digest blocks cleanup. Its `argsDigest` hashes the complete request and cannot substitute for the input digest. Deferred v3/O2 and H3 start invocations retain their original `argsDigest` comparison; background process holds do not replace the start invocation's identity. Do not select the digest merely by field presence or strip a hash prefix.

A stopped worker does not prove missing output was published. Unknown output remains blocked; do not rerun Shell, start a new capture or rebuild a Monitor to fabricate settlement. A known capture failure is retained as a failure rather than rewritten as successful output.

## MCP slice

Reconcile all started configure, raw operations, tool invocations and earlier Hook effects before lifecycle Hooks. A never-dispatched intent may become `not_started_proven` only with supporting evidence. Unknown started effects remain blocked even when the worker is dead.

On a live original worker: restore the original owner with recovery acquisition; use each configuration's stable H1 release ID; persist `drained`; release the original Broker RuntimeSession; persist `released`. Releasing the owner before connections would make subsequent H1 status/release unavailable. Include every configuration revision and the owner shared with Hooks, including a Hook-only owner with no MCP configuration.

For a provably stopped original worker, known business and Hook effects plus the trusted matching stop proof can establish local connection closure and release the exact owner. Keep the proof source; do not forge an H1 release acknowledgement or claim remote Session deletion. HTTP DELETE timeout is compatible with local closure when local transport is closed. Endpoints, secrets and connection recipes never enter public receipts. Ordinary MCP worker replacement qualification remains unchanged.

A matching NOT_FOUND observation permits the stopped cleanup path to wait for the original worker's stop receipt while a LOST binding still has saved owners. It does not release them by itself. Persist that receipt before moving the binding into DRAINING or releasing owners; the transition and each stopped-owner release independently check the current lifecycle claim inside the Broker transaction. Unknown dispatched executions still block before stop/release. An MCP resource-phase `workspace_close_identity_unverified` may enter this evidence-checked fallback; execution, authorization and claim failures retain their errors, as does a Shell identity failure. Retries may reuse the original receipt but cannot create a worker, replay effects or manufacture H1 acknowledgements.

## Affected components

| Layer              | Changes                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| CLI Hosted Harness | Three lifecycle phases, cleanup-only attachment, original Hook/MCP owners, Monitor wake suppression and output settlement.          |
| Java SDK           | Optional exact profile capabilities, v2 load and lifecycle request/receipt validation.                                              |
| Managed server     | Profile admission, current-claim writer/record authorization, independent effect/resource verification and final atomic retirement. |
| Runtime Broker     | Durable owner enumeration, original RuntimeSession drain and claim checks on recovery controls.                                     |

Source changes are concentrated in `packages/cli/src/serve/`, `packages/sdk-java/qwencode/`, `packages/managed-agent-server/` and `packages/managed-agent-server/`, with collocated tests. The E2E plan and execution results are in `.qwen/e2e-tests/workspace-profile-lifecycle.md`.

## Validation and rollout

Harness v2 advertisement is disabled by default. Set `QWEN_HOSTED_LIFECYCLE_V2_PROFILES=hosted-workspace-shell/1` for the validated Shell slice; add `hosted-workspace-mcp/1` only after MCP validation. Unsupported or duplicate entries are refused at startup. Publication object bytes are verified before entering the final SQL transaction; that transaction rechecks immutable receipt/catalog identities, resource terminal states and stop proofs.

The validation plan covers exact negotiation, files v1 compatibility, execution-disabled cleanup, actor idempotency and authorization, active Turn refusal, phase/claim fencing and DRAINING cold attachment. Shell checks include foreground, background, Monitor, durable old holds, final output during stop and known failure versus unknown output. MCP checks include stdio/HTTP/SSE, multiple revisions, Hook-only owner, lost release acknowledgement, dead worker and unknown business effects.

Real MySQL and process fault tests cut after Hook/effects, drain, publication seal, detach, stop and before tombstone; claim takeover must not duplicate Hooks or business effects. Public API Shell deletion must trigger O4-2 collection without a seam. Close must never run SessionDelete, and deletion and retirement must commit together. Build, typecheck, bundle, focused tests and review precede declaring completion; actual results are recorded separately from this design. The macOS development run cannot replace the Linux original-worker/H3 cgroup tests or the complete MCP transport release matrix; these remain release gates, and v2 profiles stay unadvertised by default.

Upgrade all Java/Broker lifecycle consumers before deploying a Harness advertising v2 profiles. Enable Shell only after its validation, then MCP. Do not downgrade to a v1-only consumer while v2 operations remain unfinished. There are no unresolved product decisions.
