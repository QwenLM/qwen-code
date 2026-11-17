# Managed Runtime Skill Snapshot Import

[English](2026-11-08-managed-runtime-skill-import.md) | [简体中文](2026-11-08-managed-runtime-skill-import.zh-CN.md)

## Status and dependency

Implementation split from the reviewed full head `4736349cbe5d60f39251a148ef17df5f764a03bb`, 2026-11-08. This delivery depends on the archive/form installation in PR #16500 and does not depend on personal MCP OAuth. Keep it draft until its own source, contract and CI evidence is accepted. Existing whole-branch CI does not accept the new split head.

The shared installation authorities are described in the [English self-service design](2026-11-07-managed-skills-mcp-self-service.md) and [Chinese self-service design](2026-11-07-managed-skills-mcp-self-service.zh-CN.md).

## Goal and boundary

Let an authorized user discover project Skills from the execution Runtime actually owned by the selected Session, review a frozen snapshot and explicitly install it. Do not fall back to a daemon, the primary Workspace or a replacement Runtime. Discovery and preparation do not provision a Runtime or change Session configuration.

Use only the selected Workspace's `.qwen/skills` and `.agents/skills`, preserving their existing priority and marking shadowed candidates. Exclude user/global/extension directories. Return names, descriptions, relative paths, compatibility results and digests. Unsupported manifests become incompatible candidates rather than invalidating the entire discovery response. Names are bounded to 256 characters and descriptions to 4096 characters without NUL.

## Owner-fenced source access

The Hosted capability is `managed-runtime-skill-import/1`. Add candidate, snapshot and archive operations through the existing Runtime Broker extension metadata boundary. Only candidates may discover the existing owner without an expected generation. Snapshot and archive requests carry the observed binding ID/generation; all actual reads stay inside that original ready owner and resolved Workspace.

The Runtime worker resolves the selected Session's mounted directory and applies existing filesystem admission and cross-Session directory ownership checks. The control plane does not join an equivalent host path. An unknown, unready, changed, untrusted or draining owner fails closed without placement, attachment replacement or source fallback. A detected Harness boot change invalidates the cached client/attachment without replaying the discovering call.

## Snapshot and publication

Choose a candidate before copying. Check file identities, directory membership and content digests before and after the copy; a source change returns `source_changed`. Publish the copied immutable bytes and server-generated non-executable source metadata containing Workspace, relative path and digest. This is not a filesystem transaction across arbitrary concurrent writes.

Retain at most 256 snapshots per worker, two concurrent preparations, 512 MiB aggregate retained archive bytes and fifteen-minute expiry. The archive stays retryable after the last chunk, including when its response is lost. Reuse the 100 MiB compressed, 1 GiB expanded and 100,000-entry limits and containment/link/special-file refusals. Control-plane downloads have bounded concurrency and always release their permit, including temporary-file allocation failure.

Each archive chunk retains authorization, Session and original-owner checks. Their admission cost is an acknowledged review carryover; removing those checks for throughput is outside this split. Unknown transport outcomes and source refusals retain distinct bounded errors without leaking private transport details or replaying operations.

Reuse the first delivery's package preview, publication receipt, settings and explicit apply. Compiler, package and selection protocols remain version 1. A re-import publishes a new package revision, keeps the original extension identity when updating and still requires explicit idle Session application. Add no watcher or automatic model-visible directory refresh.

## Contracts and UI

Under `/v1/agents/sessions/{sessionId}/extensions/skills`, add candidate query, snapshot preparation and snapshot import, with the corresponding WebShell provider, generated types and Java SDK. Return original owner/generation with prepared descriptors. Preserve exact-input idempotency and reject mismatched snapshot digests or targets.

Expose **Import from current Workspace** on the managed extension/Skills view. Preview the selected snapshot before the one-confirmation publication/application chain. A busy Session, source change or replaced owner requires a fresh explicit review. Keep previously published content visible when apply cannot proceed; never report installed without the exact `active` receipt.

## Verification and rollout

Enable only when `qwen.managed-agent.extensions.runtime-skill-import-enabled` and first-stage self-service are enabled and the Harness capability is supported. Turning the entry off preserves published packages and does not introduce source watchers.

Verify candidate priority, incompatible content, selected-directory containment, symlinks/special files, source mutation, original-owner replacement, chunk retry, retention capacity and cleanup. Verify the UI's stable operation identities and explicit apply, keeping unrelated extensions and base hooks. Reuse unchanged first-stage checks and run affected Runtime source, Hosted routing and WebShell import tests/build/typechecks.

Java source review does not establish executed contract coverage. `ManagedAgentApiContractTest`, `SurfaceRegistryGateTest`, SDK/transport gates, real MySQL, original Runtime processes and process-fault acceptance remain required matching CI evidence. The shared local Java budget remains exhausted and is not reset by this PR.

## Review carryover

Preserve the previous review record on #16500. Noncritical deferrals include the stale update target after changing a reviewed source, complete `503`/`415` response documentation, and broader chunk/capacity coverage. Deferral is not implementation or acceptance; this split adds no new behavior to close them. Security and original-owner admission remain enforced.
