# W2 WebShell cwd capability

[English](2026-10-09-managed-workspace-w2-capability.md) | [简体中文](2026-10-09-managed-workspace-w2-capability.zh-CN.md)

## Problem and scope

The durable same-Workspace cwd routes already exist, but the WebShell Session capability is reserved. A browser needs an explicit per-caller support/permission signal before offering the operation. The BFF portion of the combined W2 PR implements only `capabilities.cwdChange`, marks it implemented in OpenAPI v1.34 and regenerates the WebShell type. The [WebShell design](2026-10-09-managed-workspace-w2-webshell.md) describes the UI and recovery delivered in the same PR. This capability change adds no route, table, operation list, public capability or WorkspaceContext state derivation.

## Authority and implementation

Advertise true only when Workspace files execution is enabled, the Session is ACTIVE and undeleted, it has a Workspace binding, and the caller passes the current cwd admission authority. At this baseline that means the original Workspace Session creator, with the exact ACTIVE Registry generation/storage and a surviving creator OPERATOR/OWNER grant. Use the same Registry facts predicate for admission, settlement and capability reads. Do not use `workspaceTurns`: cwd admission does not require its agent, execution profile or Harness-readiness gates.

The capability promises support and permission, not an idle Session. Turns, approvals, retained Runtime sessions, open operations and revision CAS remain admission decisions. Operation query continues to use its existing read authorization independently of this flag, so a readable admitted operation stays queryable after cwd authority is revoked.

For list pages, union cwd-shaped and Turn-shaped candidates for the existing batched creator read. Keep Turn grants limited to Turn candidates. Query execution Registry facts once for the creator-owned cwd candidates with an `IN` predicate. Skip that query when no candidates survive or the deployment is disabled. The enabled creator page has six queries for both one and twenty Sessions; the existing disabled page budget remains unchanged. The default store fails closed if it cannot supply Registry facts.

## Coordination and release gate

#13545 is still open. Its broader actor authority must converge with this shared admission predicate when that change lands; this slice does not pre-enable its role semantics. Frontend code uses the BFF capability and never infers creator/roles.

Keep the entire combined frontend/BFF PR draft; do not merge or deploy it before #13564's cwd instruction-cache fix and joint acceptance pass. In one existing Hosted attachment, A→B must change the next Turn's physical write directory and its QWEN.md/AGENTS.md instructions without rebuilding the Session. A deterministic model proving tool writes does not prove instruction adoption. Rewind and in-session rule editing are outside this slice. There is no additional frontend release switch.

## Verification and behavior E2E plan

Run `ManagedCwdChangeOperationTest`, `ManagedCwdOperationContractShapeTest`, `ManagedAgentApiContractTest` and `Issue13181QueryBudgetTest` under JDK 21, followed by Checkstyle. Verify active/bound/undeleted shape, deployment opt-in, creator identity, revoked grants, Registry state/generation/storage, independent agent/profile gates, and fixed list-query budgets. Public reserved fields must remain absent from implemented traffic/types.

After the root build, typecheck and bundle, run `HostedPublicWorkspaceIT#workspaceCwdChangeSettlesThroughBothSurfaces` with the local Node executable and bundle. Verify public/BFF completion, idempotent replay, context event/revision, root switching, invalid/missing paths, stale revisions and foreign actor refusal. After switching, the next real tool write must land in B while A's sentinel remains unchanged. The local case uses real Java/Broker/Harness/worker processes, H2 and a deterministic HTTP model; it covers neither real MySQL parity nor the #13564 rules gate.

For release acceptance, additionally test spaces/Unicode and symlink containment on the real filesystem, active Turn/approval refusal, two-tab admission races, and the same-attachment rules scenario above. Record each layer's actual evidence and keep enablement blocked if the instruction scenario is outstanding.
