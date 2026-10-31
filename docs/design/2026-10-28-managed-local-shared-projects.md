# Shared local projects in Managed

[English](2026-10-28-managed-local-shared-projects.md) | [简体中文](2026-10-28-managed-local-shared-projects.zh-CN.md)

## Status and problem

Local implementation based on `149d577ed6`; validation is recorded below. Existing local imports register a project parent as a physical storage root and publish one `.qwen-managed-storage.json` there. Independent local installations use separate catalogs and identities, so the second installation refuses that marker. Stopping a launcher does not transfer the registration or prove its durable workers stopped.

The requested behavior is to let trusted local installations use the same existing project without a parent-directory takeover. Each installation continues to own its catalog, processes and allocated worktrees. This follow-up is included in PR #15745 alongside the main-Session worktree support.

## Registration and layout

New local-path imports receive the opaque storage ID `imported-<receipt key>`. Existing `created-` receipts, including earlier local imports, retain their current meaning and marker location. The new prefix must resolve to a valid actor-scoped creation receipt with a pinned `localRoot`; a prefix alone never authorizes a path. No schema migration or public request field is added.

The project parent remains a shared layout and navigation boundary. Main and child worktree paths stay storage-relative and outside the source Git worktree. Selecting a project continues to set its relative working directory; this does not introduce a project filesystem sandbox or globally claim its parent.

Registration metadata for a new imported storage lives under `<runtime state directory>/imported-projects/<storage ID>/.qwen-managed-storage.json`. These canonical, private directories belong to this installation. Registration never creates, reads for ownership, replaces or removes the external root's global marker. A pre-existing global marker and the project files remain untouched.

The catalog still records the original host/device/inode/birth identity and per-installation registration. Source replacement, missing private metadata, malformed receipts, revoked grants and unknown bindings continue to fail closed. Replaying a completed request does not recreate missing metadata or restore access. Turning off new imports does not disable existing imported roots.

## Execution and maintenance

`WorkspaceCreationStore` allocates the new storage identity. `WorkspaceCreationRoots` resolves it and its private metadata. `WorkspaceStorageGuard` uses that metadata for registration, normal verification, locked verification, file roots, inspection and probe verification. `WorkspaceExecutionStore` retains its existing catalog-local admission and lease checks and refuses exclusive rewind for the new shared storage. LOCAL Runtime and file protocols do not change; SSH bootstrap and CSI remain outside this behavior.

Two installations may edit the same imported project, with the same ordinary editing conflicts as independent terminals. No cross-installation exclusive-write or physical-recovery guarantee is introduced. Independent worktrees remain the way to isolate edits.

Main/child worktree preparation, exact-path cleanup and stopped-operation reconciliation continue to use each installation's recorded IDs and identities. They do not enumerate, prune or delete another installation's worktrees. A maintenance hold coordinates that installation's own executions only.

Whole-storage fencing, physical snapshot/recovery, file-history rewind and storage migration require exclusive authority and are refused for new shared imports with `workspace_shared_directory` before mutating their storage state. Gate the storage guard's fence, recovery-registration, captured-registration, restore and migration entry points. Own-process Runtime recovery remains available. Application-owned roots, explicitly configured mounts, legacy imports and deployed SSH/CSI retain their existing protection.

## Compatibility and scope

The runtime state directory already required by durable local execution also stores import metadata and must be preserved with the catalog. Older Java readers reject the new storage prefix rather than silently treating it as an owned root. Existing receipts and on-disk markers are not migrated, repaired or rewritten automatically.

This implementation does not relocate worktree containers into a second mount, narrow the existing parent navigation grant, redesign pending-creation UI, coordinate arbitrary external editors or alter deployment authentication. A project-content root with a separate private worktree mount would be a larger follow-up.

## Validation and acceptance

Use separate catalogs and private state directories with one real project: both imports must succeed, keep the same project contents and leave an existing foreign global marker byte-identical. Verify completed replay, restart/disabled-new-import behavior, missing or tampered private metadata, source replacement and actor/tenant denial. Legacy and application-owned marker refusal must remain intact.

Exercise normal file resolution, main worktree creation/cleanup and per-installation metadata independence. Whole-root maintenance must refuse without advancing operation state or touching files. Select affected H2/unit cases and real MySQL 8.4 cases, plus a real-process local startup/import path. Local Java checks share one 600-second budget for this requested change; full supported-platform, fault and static-analysis gates remain with CI. Record failed attempts and gaps separately.

### Recorded local results

The unchanged baseline reproduced the collision: installation A imported successfully and installation B returned `workspace_unavailable`. The installed global CLI was 0.24.1 without Managed support, so the baseline used production Java classes with native Git and independent H2 catalogs.

On the local implementation, the 54 selected creation, storage-guard, shared-import and worktree-store unit/H2 cases passed across focused runs. Three selected MySQL 8.4.11 cases passed: independent catalogs with an untouched foreign marker, legacy receipt resumption and exclusive-maintenance refusal. The native macOS MySQL instance disabled binary logging; the Linux-only native-AIO setting was not applicable. Java packaging and Checkstyle passed.

Two actual `serve --managed` installations using the changed Java payload and the unchanged built CLI each imported the same fixture, replayed their request, browsed files and reported supported worktree options. A separate production Java/native Git probe prepared two isolated worktrees, refused dirty cleanup and cleaned one without changing the other checkout, private metadata or foreign global marker. Task-owned services and fixtures were removed; the user's running demo and real Projects directory were untouched.

The first focused run exposed two new-test fixture/expectation errors, not product failures: a completed receipt replay returns the persisted Workspace without re-registering missing metadata, and the seeded legacy receipt must write `result_json` separately from `previousStatus`. Both were corrected and the affected cases rerun. A subsequent Checkstyle failure for import-group blank lines was corrected before the passing package/style run. Failed logs are retained in the local test artifacts.

These results establish the selected native macOS paths only. Model Turns, browser interaction, process restart/fault recovery, Linux execution, full MySQL/Hosted profiles and full static-analysis gates were not run for this follow-up. Required CI acceptance remains pending; earlier PR or design evidence is not substituted for these gaps.
