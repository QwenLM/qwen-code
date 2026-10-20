# Select an existing Managed Workspace directory

[English](2026-10-16-managed-workspace-directory-selection.md) | [简体中文](2026-10-16-managed-workspace-directory-selection.zh-CN.md)

Status: Implemented and verified locally on Lima Linux. Production acceptance is outside this change.

## Problem and current state

Before this change, New workspace accepted only a name and creates an empty server-owned directory. A user cannot select an existing Linux project. The local debug deployment runs Java and its `local-process` tool workers in Lima Linux, so directory discovery must run there as well.

## Proposed behavior

New workspace offers an existing-directory mode alongside empty-directory creation. The user selects an authorized root, browses its real subdirectories, and creates a named Workspace at the chosen project directory. The project stays in place. The selection persists across page reloads and becomes the default directory for new Sessions in that Workspace.

The selectable roots are existing ACTIVE ROOT Workspaces backed by local storage on which the authenticated actor has OWNER access. An administrator registers a projects parent directory once and grants that root to its owner. The local deployment exposes its Linux projects parent this way. The chosen directory is a working directory, not a new permission boundary: Workspaces within the same storage retain the existing shared file access and physical-owner lease semantics.

## API and authority

The WebShell-only `workspaces/directories/query` route accepts `workspaceId` and `cwdRelative`. It returns the canonical authorized root and directory, a bounded list of immediate real child directories, and a truncation flag. The route is persisted-workspace scoped; tenant, actor, ACTIVE ROOT state, OWNER grant, configured mount, native identity, and marker verification all apply before filesystem discovery. Paths are normalized with the existing relative-path contract. Traversal, symlinks, reserved maintenance directories, inaccessible directories, and unsupported storage fail closed. Discovery never falls back to the ordinary daemon. SSH and CSI storage are excluded from local directory candidates and refused before local filesystem resolution; SSH registration keeps its separate node/path check and operation APIs. OpenAPI v1.56 names the local browse request separately from the v1.52 SSH directory-check request.

The existing create request gains optional `sourceWorkspaceId` and `cwdRelative` fields. Both must be supplied together. Without them, existing empty-directory creation is unchanged. With them, creation verifies the source and directory and publishes a new logical Workspace using that source's storage, configuration, and policy. It neither creates nor registers another physical root. Source identity and generation are pinned in the receipt and checked again before publication. A changed or revoked source cannot complete a pending request.

The existing actor-scoped WORKSPACE_CREATE receipt persists the selected source, generation, storage, and directory. Its digest covers the normalized request, including source generation when selected. Same-key retries compare with the pinned generation rather than silently rebinding after source changes. Completed replay checks the new Workspace's current access and never restores a grant. No schema or native marker change is needed. Receipt data supplies an optional `defaultCwdRelative` in WebShell summaries; legacy and static Workspaces default to `.`. Public Session-selection semantics remain unchanged.

## Browser integration

Reuse the shared directory-browser dialog and its stale-response protection. Directory requests use the Java Managed provider. The browser preserves the pending name, source, directory, and idempotency key before submission. An uncertain operation remains retryable with the exact same request. An explicit abandon-local-confirmation action removes only the persisted browser record and unlocks directory/name editing, including after reload. It warns that a Workspace may already exist and is not deleted; a new creation uses a new key. A browser storage failure preserves the frozen request. Selecting, refreshing, or newly creating a Workspace initializes the composer directory from its persisted default without changing its prompt or model.

## Affected areas

| Area                              | Change                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Java Workspace store and registry | Authorized directory discovery, selected-directory creation, receipt projection |
| WebShell API contract             | Directory query, optional create fields and default directory, surface gate     |
| WebShell provider and creator     | Directory dialog, pending request persistence, default directory                |
| Deployment and validation         | Register a Linux projects parent; scoped API, UI, and real tool checks          |

## Boundaries and risks

This change covers the existing trusted Linux local-process deployment. It does not select Mac paths, import arbitrary ungranted server paths, create new machine transports, copy projects, or alter runtime recovery. The storage root remains outside Git worktrees; repositories remain child directories, preserving marker and child-Git lifecycle rules. Administrators must choose a parent whose entire file-access scope is appropriate for its owner. Directory discovery is bounded; it does not recursively scan the filesystem. Receipt and grant transactions must remain correct under concurrent retries and source revocation.

## Validation and acceptance

1. Baseline New workspace has no directory choice; the new API is absent.
2. An owner can browse real Linux child directories and create a Workspace that reads the existing project's files with a real model/tool call.
3. Refresh, reselect, and a Java-only restart preserve the default project directory and native registration.
4. Reader, operator, other actor, other tenant, inactive source, traversal, symlink, maintenance directory, and unconfigured storage requests are refused without disclosing directory contents.
5. Same-key and concurrent retries create one Workspace; changed requests conflict; pending source changes fail; completed replay does not regrant access or register held storage.
6. Empty creation, model selection, prompt preservation, ordinary daemon behavior, and original Workspace recovery continue to work.

## Local UI evidence

The selected Linux project remains the Workspace's default directory after creation and refresh.

![Selected Linux directory in the Managed composer](../assets/managed-agent-local-debugging/directory-selected.png)

## Open questions

None for this scope. Additional selectable project parents are administrator configuration, not inferred from browser-provided paths.
