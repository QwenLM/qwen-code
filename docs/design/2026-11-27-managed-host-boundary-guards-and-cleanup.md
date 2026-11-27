# Chat-Core Boundary Guard and Managed-Host Leaf Daemon Import Decoupling (Slice 6a)

[English](2026-11-27-managed-host-boundary-guards-and-cleanup.md) |
[简体中文](2026-11-27-managed-host-boundary-guards-and-cleanup.zh-CN.md)

Status: implemented (Slice 6a of
[Unified Chat Surface](2026-11-16-unified-chat-surface.md); remaining
`ChatEditor` and transcript/message daemon-edge cleanup plus the final
`dist-managed-host/index.js` CI grep gate are tracked as Slices 6b and 6c).
Date: 2026-11-27.

## Problem

With all three chat columns (`ManagedSessionsPage`, `ChatPane`, `App` main
chat) rendering through the shared `ChatSurface` and Managed usage/context
parity landed in Slice 5, two Slice 6 goals remained:

1. No automated source-level boundary guard enforced that `chat-core/**` never
   imports daemon modules (`daemon/**`, `@qwen-code/sdk/daemon`,
   `@qwen-code/web-shell/daemon-react-sdk`) or branches on `controller.kind`,
   and no ratchet prevented new daemon value imports from entering the
   `managed-host.tsx` entry graph.
2. A live TypeScript-AST transitive value-import census from
   `packages/web-shell/client/managed-host.tsx` on `main` (`b58b8d7992dd`)
   found 47 daemon value-import edges grouped into three independent clusters:
   - **Cluster 1 (16 edges — Managed direct & leaf/pure-helper imports):**
     `use-managed-model-change.ts` (`withActionTimeout`), `useComposerCore.ts`
     (`subscribeSidechannelRemotePrompt`), `ToolDetailsContext.tsx` &
     `ShellToolOutput.tsx` (`isShellResultDisplay`), `AddWorkspaceDialog.tsx`
     (`DaemonHttpError`), `turnOutputSelectors.ts` →
     `useSessionScheduledTasks.ts` (`scheduledTaskRuntimeKey`, 3 edges),
     `ManagedLocalFilesControl.tsx` → `LocalFilesControl.tsx` (4 edges), and
     `ChatContextHeader.tsx` → `LocalControlQrButton.tsx` (4 edges), plus
     decoupling `ArtifactIcon.tsx` off `artifactUtils.ts` (`artifact-mime.ts`).
   - **Cluster 2 (15 edges — Slice 6b):** `ChatEditor.tsx` static daemon-only
     toolbar/upload imports (`VoiceButton`, `LiveVoiceButton`,
     `BranchPickerPopover`, `useFileUpload`).
   - **Cluster 3 (16 edges — Slice 6c):** `TranscriptViewport`, `TurnOutputs`
     (`artifactUtils.ts` + `useArtifactWorkspaceTarget.ts`), `ToolApproval`
     (`BrowserNotificationControl`), `SystemMessage` status sub-cards,
     `ToolFilePreviewButton`, and `HookStatistics`.

Breaking Slice 6 into three surgical increments keeps every PR small, reviewable,
and zero-regression while enforcing an immediate non-regression ratchet.

## Goals

- Add a TypeScript-AST source-level boundary guard test
  (`packages/web-shell/client/chat-core/boundary.test.ts`) enforcing:
  - Zero daemon imports (value or type, static or dynamic) anywhere in
    `packages/web-shell/client/chat-core/**` non-test source files and zero
    `controller.kind` property accesses in `ChatSurface.tsx`.
  - A strict bidirectional ratchet on `managed-host.tsx`'s transitive daemon
    value-import edges (fails on any newly added edge AND fails on stale
    entries once an edge is cleared).
- Clear all 16 Cluster-1 daemon value-import edges (47 → 31) via minimal,
  behavior-preserving extractions and slot injection with full backwards
  compatibility for daemon callers.

## Non-goals

- Decoupling `ChatEditor.tsx` daemon toolbar/upload imports (Slice 6b) or
  `TranscriptViewport` / `MessageList` / `ToolApproval` / `SystemMessage`
  daemon edges and adding the `dist-managed-host/index.js` CI grep gate
  (Slice 6c).
- Changing any daemon/Java HTTP/SSE routes, OpenAPI schemas, storage keys, or
  i18n keys.

## Scope

- **Pure utility extractions (re-exported from original daemon modules for full
  compatibility):**
  - `packages/web-shell/client/utils/action-timeout.ts` (`withActionTimeout`,
    re-exported by `daemon/timing.ts`; consumed by
    `components/managed/use-managed-model-change.ts`, −1 edge).
  - `packages/web-shell/client/utils/remote-prompt-sidechannel.ts`
    (`subscribeSidechannelRemotePrompt`, `publishSidechannelRemotePrompt`,
    `RemotePromptSidechannelEvent`, re-exported by
    `daemon/remotePromptSidechannel.ts`; consumed by `hooks/useComposerCore.ts`,
    −1 edge).
  - `packages/web-shell/client/utils/shell-result-display.ts`
    (`ShellResultDisplay`, `isShellResultDisplay`, pinned by parity unit tests
    against `@qwen-code/sdk/daemon`'s `isShellResultDisplay`; consumed by
    `ToolDetailsContext.tsx` and `ShellToolOutput.tsx`, −2 edges).
  - `packages/web-shell/client/components/artifacts/artifact-mime.ts`
    (`AUDIO_EXTENSIONS`, `pathExtension`, `isAudioArtifact`,
    `normalizeArtifactMimeType`, re-exported by `artifactUtils.ts`; consumed by
    `ArtifactIcon.tsx`, clearing the `FileTypeIcon` → `ArtifactIcon` path).
  - `packages/web-shell/client/components/dialogs/scheduledTasksSchedule.ts`
    (`scheduledTaskRuntimeKey`, re-exported by
    `hooks/useSessionScheduledTasks.ts`; consumed by
    `components/artifacts/turnOutputSelectors.ts`, −3 edges).
- **Shared UI & dialog decoupling:**
  - `packages/web-shell/client/components/LocalFilesPanel.tsx`: extract the
    pure prop-driven `LocalFilesPanel`, `getLocalFilesDotClass`,
    `getLocalFilesTooltip`, `LOCAL_FILES_DAEMON_COMMAND`, and
    `deriveLocalFilesDaemonCommand` out of `LocalFilesControl.tsx` (which
    re-exports them); `ManagedLocalFilesControl.tsx` imports from
    `./LocalFilesPanel` (−4 edges).
  - `packages/web-shell/client/components/ChatContextHeader.tsx`: replace the
    direct `LocalControlQrButton` import / `onOpenLocalControlSettings` prop
    with a backend-neutral `renderLeadingAction?: (actionClassName: string) =>
ReactNode` slot supplied by `App.tsx` (−4 edges).
  - `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx`:
    replace `err instanceof DaemonHttpError` with a structural HTTP-404
    `clone_job_not_found` check on `err instanceof Error` (−1 edge).
- **Automated boundary & parity tests:**
  - `packages/web-shell/client/chat-core/boundary.test.ts`: AST-based
    `chat-core/**` zero-daemon & zero-`controller.kind` guard plus exact
    31-edge `managed-host.tsx` transitive ratchet.
  - `packages/web-shell/client/utils/shell-result-display.test.ts`: parity test
    against `@qwen-code/sdk/daemon`'s `isShellResultDisplay`.

## Key Design Decisions

1. **Use TypeScript AST (`ts.createSourceFile`) rather than regexes for
   boundary enforcement.**
   - Regex scanning misses multiline named `import { type A, B }` mixes,
     re-exports (`export { x } from ...`), and dynamic `import(...)`, and
     false-positives on prose comments. Walking `ts.ImportDeclaration`,
     `ts.ExportDeclaration`, and dynamic `ts.CallExpression` nodes produces an
     exact, compiler-grade value-import graph.
2. **Make the managed-host ratchet bidirectional.**
   - Comparing the discovered set of daemon value-import edges for exact
     equality against the pinned allowlist catches both regressions (new daemon
     import introduced) and stale allowlist lines (ensuring Slices 6b and 6c
     shrink the list cleanly to empty).
3. **Preserve backwards-compatible re-exports on moved utilities.**
   - Re-exporting `withActionTimeout`, `remotePromptSidechannel`,
     `LocalFilesPanel`, and `artifact-mime` from their prior modules keeps all
     daemon callers and existing unit tests untouched while severing the
     managed-host graph's transitive edges.

## Constraints

- Zero behavioral or visual changes on either daemon (`App.tsx`, `ChatPane`,
  `LocalFilesControl`, `AddWorkspaceDialog`) or Managed
  (`ManagedSessionsPage`, `ManagedLocalFilesControl`, `ManagedAgentWebShell`).
- No new runtime dependencies, routes, schemas, storage keys, or i18n keys.
- `build:managed-host` and `build-artifact.test.ts` remain green.

## Validation & Acceptance Criteria

- **Unit & boundary tests:**
  - `chat-core/boundary.test.ts` (asserting 0 `chat-core` daemon imports, 0
    `controller.kind` accesses, and exact 31 remaining `managed-host.tsx` edges
    with all 16 Cluster-1 edges absent), `utils/shell-result-display.test.ts`,
    `ChatContextHeader.test.tsx`, `LocalFilesPanel.test.tsx`,
    `LocalFilesControl.test.tsx`, `ManagedLocalFilesControl.test.tsx`,
    `AddWorkspaceDialog.test.tsx`, `use-managed-model-change.test.tsx`,
    `ManagedSessionsPage.test.tsx`, `App.test.tsx` (header/local-control cases),
    and `build-artifact.test.ts` all pass.
- **Mutation witnesses:** Injecting a synthetic daemon import or
  `controller.kind` check into `chat-core`, or adding a daemon value import
  reachable from `managed-host.tsx`, verified to turn `boundary.test.ts` red;
  mutating `AddWorkspaceDialog`'s 404 check or `ChatContextHeader`'s
  `renderLeadingAction` slot verified red.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`,
  `eslint --max-warnings=0`, `prettier --check`, `web-shell` + `managed-host`
  builds, and repository `npm run typecheck`.
- **Real browser verification:** Real Chromium verification of both
  `<ManagedAgentWebShell>` (confirming `ManagedSessionsPage` renders cleanly
  with 0 errors after decoupling) and Playwright
  `web-shell.split-persist.spec.ts` / `App` header local-control rendering.
