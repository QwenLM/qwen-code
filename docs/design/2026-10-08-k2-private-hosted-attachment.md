# K2 private Hosted attachment and text composition

[English](2026-10-08-k2-private-hosted-attachment.md) | [简体中文](2026-10-08-k2-private-hosted-attachment.zh-CN.md)

Status: implemented private prerequisite; locally verified on base
`85e7795c002439c5731e6a1c0eb1636d2f43069f` plus this batch.
Refs #12380, #13395 and Draft #13526. This is an operator-only prerequisite of
K2; it does not qualify CSI files, retirement or public profile selection.

## Problem and current state

The private operator can resolve the original committed Session, provision its
original binding and install its original context. Native SQL already admits
the closed CSI genesis, first activation and bounded streamed text grammar.
Before this batch, the Hosted process had no production caller connecting these
pieces. Ordinary Hosted open/load creates a broader definition, can adopt an activation, and
seals the HTTP writer on unsuccessful open. Its generic tool runner can also
release a Runtime. Those lifecycle semantics cannot own this private Session.

## Goals and boundaries

Connect one previously committed private Session to the current authenticated
Hosted boot, using the original Runtime Broker, SQL store, HMAC issuer and
text runner. Keep writer generation 1 and activation epoch 1. Never replace
the original request, create a second Session, load an existing native owner,
adopt a new boot, or release ownership as error cleanup.

Public Spring/Hosted CSI selection, tools, deadlines, ordinary lifecycle,
rewind, hooks, MCP, Runtime continuation/cancel, physical writer termination,
NodeUnpublish, DRAINED/RELEASED and safe volume reuse remain closed. File
execution and the full MySQL/current-cluster acceptance matrix remain later
work. A successful local attachment is not full K2 acceptance.

## Trusted startup and producer

`QWEN_HOSTED_CSI_SESSION_STORE_URL` is read once by `runQwenServe`, carried in
`ServeOptions` and consumed by the server's private registrar. It is accepted
only in authenticated loopback `hosted-harness` mode with both configured
Runtime Broker URL and token. The store URL must be HTTPS or loopback HTTP,
without userinfo, query or fragment. There is no public CLI profile selector
or request-body URL override. Lease duration is fixed at 60000 ms.

The existing CSI classifier gains `text <reviewed-runtime-json>
<text-request-json>`. The Java operator reuses the strict original request
reader and original SQL resolution before issuing any Hosted request. Its
trusted startup credentials include `K2_HOSTED_URL`, `K2_HOSTED_TOKEN`,
`QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` and
`QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY`. The bound original
`WriterCredentialPolicy` issues the token for the resolved tenant, workspace
and Session. The binding key is never sent. Existing Hosted capability
negotiation supplies the current boot ID; no ordinary create/load is called.

The text file contains exactly `promptId` and `text`. Both file size and text
length are bounded; canonical UUIDs and nonempty text are required. Operator
failures print a generic diagnostic without credentials. The operator closes
only its HTTP client, never the remote attachment or original Runtime.
The producer retains the cancelable HTTP exchange and cancels it when its
30-second local wait ends, including partial response bodies. The
[JDK 21 cancellation contract](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html)
provides best effort local cleanup, not proof that the remote operation stopped.

## Original Runtime readback

For the CSI profile only, the existing acquire response includes
`scope.canonicalCwd` and `scope.isolationClass`, derived from the admitted
original Runtime Session. The protocol version stays 1 and ordinary responses
stay compatible. A dedicated Hosted consumer sends the original Session UUID
as both Harness and Runtime UUID, with `turnKind: bootstrap`. It requires the
private capability digest, matching tenant/workspace, session isolation,
canonical absolute Linux cwd and original binding generation 1. Workspace
generation remains the original persisted value.

The response is a current original-scope readback, not a Store credential or
file grant. The consumer pins the returned binding, cwd and full scope and
compares them on every later operation. SQL independently fences every native
commit against current original authority. No primary cwd fallback is allowed.
The operator must first warm the original Runtime to READY through its existing
authenticated Broker entry. Attachment does not implicitly warm or release it;
the trusted Store URL must address that original SQL deployment. Supply its
deployment base, for example `http://127.0.0.1:8081`; the HTTP client appends
`/internal/managed-session-store/v1`.

## Private routes and ownership

All routes are under `/session/:id/internal-csi`, inherit protocol/boot
middleware, and additionally require a verified bearer on the primary
listener. They are live-session-owner scoped; store access stays in the
resolved Session. Unknown, ordinary, opening, failed, blocked and stopped
owners never fall back to an ordinary or primary runtime.

| Route             | Behavior                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST .../attach` | Closed body `{tenantId, workspaceId, writerToken}`; current Broker admission, create-only native owner; successful exact same-boot retry returns the original owner.                                      |
| `POST .../text`   | Closed body `{promptId, text}`; reserve one local turn, recheck current authority, commit input and run actual settled-history text. Exact retry joins/returns the original turn; changed text conflicts. |
| `GET .../history` | Current admission, then original sink projection; returns native transcript, not CSI file history or a restore grant.                                                                                     |

Private owners have an independent Map. Initialization reserves the UUID before
the first asynchronous operation. Ordinary and private maps are mutually
exclusive, including UUID case aliases. Existing ordinary routes are gated
before any store I/O for a reserved private UUID; the ordinary registrar exposes
only its actual ownership predicate to this gate. Other private subroutes fail
closed. Authentication alone does not authorize lifecycle or tool operations.

## Native composition and text

The owner directly composes the existing HTTP journal, resource store,
`LocalManagedSessionAuthority` and `ManagedSessionRecordSink`. It publishes
only definition `{engine: managed, sessionId, toolProfile:
csi-files-retirement/1}` and root `{cwd: brokerCanonicalCwd}`, opens with
`requireNew: true`, and installs the first activation using the current Hosted
boot as worker ID. It checks writer generation 1 before genesis and activation
epoch 1 before exposing the owner. Generic ManagedSession release, replacement
and close reject; only the private owner can stop local activity.

Text uses the original `managed-input` array and `managed-admission` digest,
`submitInput` with source `hosted-harness`, no deadline, and the real
`runHostedHarnessTurn` with `historyMode: settled`. No generic ToolTurn, hooks
or primary workspace context is supplied. The runner produces the original
checkpoint, model attempts, deltas/retractions, full assistant Parts and
settlement. A pending or uncertain native input blocks fresh prompts. A settled
model error retains its actual native settlement and can accept a later prompt.

## Failure and shutdown

Any partially successful or uncertain initialization becomes a sticky failed
owner. It stops local renewals but never retries genesis, installs another
activation, seals a writer, releases a Runtime or deletes persisted ownership.
Successful attachment retry must still pass fresh current admission and writer
checks; the Map is not an authority grant.

HTTP stores gain `stopLocal()`, a permanent local fence with no remote seal.
It clears their timer, prevents manual and scheduled renewal/rescheduling, and
joins the already-entered renewal promise. Staged resources are retained.
Ordinary `close()` continues to seal. The private owner separately stops and
joins its activation renewal, blocks new requests, aborts its active model,
joins admitted operations and initialization, and stops the HTTP store locally.
Both standalone server drain and real `runQwenServe` host drain consume this
same closure. Shutdown is not a CSI release receipt.

## Files and decisions

Changes affect the private Hosted module and tests; serve startup, options,
profile validation, server and shutdown; the ordinary registrar's ownership
predicate; HTTP store local-stop method and tests; original Broker acquire
readback and tests; Java operator text entry and tests; and this bilingual
design. Ordinary session assembly and Core tool profile definitions need no
new options. This feature touches core/cross-package infrastructure and
requires maintainer review before release.

## Validation and acceptance

First record global CLI metadata and current private-route 404/public-selector
refusal with the existing build. Independent verification then drives the real
Java text producer through authenticated Hosted HTTP and original SQL HTTP
store, with original CREATE/Broker context setup. Observe two streamed text
turns, exact genesis, writer/activation generation 1, current cwd, native
checkpoint/attempt/delta/Parts/history and exact prompt retries.

Negative controls cover absent/wrong bearer, secondary listener, wrong boot,
HMAC, scope, ordinary owner, cwd/URL/profile injection, mismatched acquire
readback, concurrent prompts, lost response, partial initialization, new boot,
retirement between acquire and commit, ordinary release/file routes and
in-flight renewal at local stop. Verify no remote seal, release or delete.
Keep synthetic Kubernetes/context receipts, H2, packaged launch seams and real
model boundaries explicit. Pin inputs, raw results, origin/cleanup evidence and
the actual committed bytes. Build, typecheck, bundle, focused tests, static
checks, lint and two full audits precede publication to the same Draft PR.

## Recorded local results

Independent verification on the seventeen-file candidate completed eleven
bounded windows. The actual Java text entry, final Hosted bundle and original
SQL Controller/transactional Store connected two streamed turns, exact retries,
settled native history, a tool-call refusal and a later successful text turn.
Fresh bad HMAC and owner/scope conflicts rolled back; retirement racing genesis
rejected the native commit. One lost genesis response recovered by exact replay;
three lost receipts left an uncertain, sticky owner. A held real activation
renewal kept shutdown pending until it completed, without remote seal/release.

The original partial-response timeout defect was reproduced and repaired. The
repaired producer timed out at about 30.12 seconds and exited at 30.35 seconds,
before the receiver released its incomplete response. Separate local-stop and
secondary-listener components also passed, with fixture grants and tagged HTTP
authentication explicitly scoped to those components.

H2, synthetic Kubernetes/context setup, a MockMvc-to-HTTP SQL adapter and an
owned deterministic OpenAI SSE provider are qualification seams. They do not
prove MySQL locking, full deployed Agent service, live model, Linux/CSI or cloud
behavior. All owned test resources were removed and frozen inputs remained
unchanged. Six failed setup/expectation attempts and one cleanup-audit
classification were preserved as diagnostics. The report binds only this
candidate, not later main merges or full K2 acceptance.

## Open work

This batch leaves private files/publication/tool grant composition, aggregate
retirement, physical writer/CSI unpublish proof, restart recovery, public
selection, MySQL RC/warmed-RR and current cloud qualification open. Existing
original predicates must be reused as those layers are implemented; no cached
context, transcript, receipt or green CI substitutes for their authority.
