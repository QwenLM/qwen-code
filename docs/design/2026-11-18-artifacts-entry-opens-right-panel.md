# Artifacts header entry opens the right panel's artifacts list tab

[English](2026-11-18-artifacts-entry-opens-right-panel.md) | [简体中文](2026-11-18-artifacts-entry-opens-right-panel.zh-CN.md)

Status: implemented. Local verification: web-shell typecheck, client vite build,
the full root build, focused unit/DOM tests, and headless-browser E2E against a
live daemon all pass.

## Problem statement

The chat header has two buttons that control the same `EnvironmentPanel`:

- **Toggle environment information** (`chatHeader.toggleEnvironment`) is a real
  toggle: it carries `aria-pressed={environmentOpen}` and opens or closes the
  panel.
- **Open artifacts (N)** (`chatHeader.openArtifacts`) is a one-way shortcut: it
  calls `handleEnvironmentPanelOpenChange(true)` and bumps `artifactsExpandSignal`
  to expand the panel's artifacts section. It has no `aria-pressed` and never
  closes anything.

Both were wired this way by #17397 (`e27d125a26`), which added the artifacts
entry as a deep link into the environment panel's artifacts section. Three
problems follow:

1. **Content overlap.** The artifacts entry shows a strict subset of what the
   environment toggle shows; two header buttons open one panel.
2. **State asymmetry.** The environment toggle highlights when open
   (`.action[aria-pressed='true']`); the artifacts button never highlights, even
   when it just opened the panel. In docked mode a second click on the artifacts
   button is a no-op, and the only way to close the panel is the _other_ button.
3. **Floating-mode flicker.** The floating environment panel dismisses on
   outside `pointerdown`, exempting only `data-web-shell-environment-toggle`.
   The artifacts entry (`data-web-shell-artifacts-entry`) is not exempt, so
   clicking it while the floating panel is open closes the panel on `pointerdown`
   and re-opens it on `click`.

## Current state

- `ChatContextHeader.tsx` renders the environment toggle (`aria-pressed`) and the
  artifacts entry (no `aria-pressed`, shown only when `artifactCount > 0`).
- `App.tsx` `artifactsHeaderEntry` gates on
  `artifactsHeaderItemVisible && mainView === 'chat' &&
environmentPanelItems.includes('artifacts') && connection.sessionId`, and its
  `onOpenArtifacts` opens the environment panel.
- `EnvironmentPanel.tsx` lists artifacts in its `artifacts` section; clicking a
  row calls `onOpenArtifact` → `openArtifactPanel`, which opens an `artifact:`
  tab in the right panel.
- The right panel (`ArtifactPanel.tsx`) is a multi-tab preview surface. Session
  level tabs opened from dedicated header buttons already exist: `token_usage`
  and `context_usage` (`openTokenUsagePanel` / `openContextUsagePanel`). With no
  active tab the panel shows a launcher (`right-panel-empty-actions`) that does
  not list artifacts.
- The right-panel header toggle (`rightPanelAvailable`) is hidden while the panel
  is open (`!artifactPanelOpen`), so the header has no visible close affordance
  for the right panel once it is open.
- Managed mode (`ManagedSessionsPage.tsx`) renders its own `ChatContextHeader`
  without `onOpenArtifacts` / `artifactCount`, and both `ArtifactPanel` render
  sites are gated on `!managedMode`. The artifacts entry is standalone-only.

## Goals

- Give the artifacts entry its own destination: the right extension panel, via a
  dedicated session-scoped **Artifacts list tab**.
- Make the entry a **toggle** of the right panel with `aria-pressed`, consistent
  with the right-panel toggle, removing the one-way asymmetry.
- Remove the content overlap between the artifacts entry and the environment
  toggle (they now open different panels).
- Preserve the early cold-open visibility shipped by #17397 (the entry still
  reads the load-embedded artifact list; only its destination changes).

## Non-goals / scope boundaries

- Standalone chat only. Managed mode is unchanged.
- The environment panel's `artifacts` section stays and remains reachable via the
  environment toggle. Removing it is an open question, not part of this change.
- Per-turn `TurnOutputs` chips are unchanged.
- The right-panel toggle button's own behavior is unchanged (it still hides while
  the panel is open).
- No change to artifact storage, the `/load` response shape, or the early-seed
  path in `useSessionArtifacts`.

## Proposed solution

Model the new tab on the existing `token_usage` / `context_usage` header-button
tabs.

### New tab kind and opener

- Add an `artifacts` member to `ArtifactPanelTab`:
  `{ id: string; kind: 'artifacts'; title: string; sessionId?: string }`.
  Session-scoped and fully serializable (the list itself is not stored on the
  tab).
- Add `openArtifactsListPanel(sessionId)` in `App.tsx`, mirroring
  `openTokenUsagePanel`: tab id `artifacts:${sessionId}`, upsert into
  `artifactPanelTabs`, set active, apply default width when closed, open the
  panel.

### List view component

- Add `ArtifactsListPanel.tsx` (collocated, modeled on `TokenUsagePanel` /
  `ContextUsagePanel`). Props: `artifacts`, `loading`, `onOpenArtifact`. It renders
  the same list shape as the environment panel's artifacts section
  (`FileTypeIcon` + `artifactDisplayName`), a loading skeleton, and an empty
  state. Clicking a row calls `onOpenArtifact(artifactId)`.
- `ArtifactPanel.tsx`: add a `PackageIcon` tab-bar icon for `kind: 'artifacts'`;
  add a content branch rendering `ArtifactsListPanel` from the existing
  `artifacts` / `loading` props; add a top-level `onOpenArtifact?: (artifactId:
string) => void` prop wired to `openArtifactPanel` at the call site.

### Persistence

- Add `Pick<Extract<ArtifactPanelTab, { kind: 'artifacts' }>, 'id' | 'kind' |
'title' | 'sessionId'>` to `PersistedArtifactPanelTab`, and a matching case in
  `parsePersistedArtifactPanelTab`. Restore needs no rewiring because the list
  comes from the live `artifacts` prop.

### Header wiring and state

- `artifactsHeaderEntry.onOpenArtifacts` becomes a toggle:
  `artifactPanelOpen ? closeArtifactPanel() : openArtifactsListPanel(sessionId)`.
- Drop the `environmentPanelItems.includes('artifacts')` gate condition; the entry
  now depends on the right panel, not the environment panel. Keep
  `artifactsHeaderItemVisible && mainView === 'chat' && connection.sessionId`.
  The button renders when `artifactCount > 0`, or when the right panel is open
  AND the artifacts list tab is the active tab (`artifactsTabActive`, i.e.
  `activeArtifactPanelTabId === 'artifacts:<sessionId>'`) so a restored
  zero-artifact artifacts tab keeps its close affordance; it never appears for
  unrelated open tabs at zero artifacts.
- `ChatContextHeader.tsx`: give the artifacts button
  `aria-pressed={rightPanelOpen}` (`rightPanelOpen` is already
  `artifactPanelOpen`). Because the right-panel toggle hides while open, the
  artifacts button is the header's visible open/close affordance once the panel
  is open.
- Update the `ChatHeaderRenderInfo.onOpenArtifacts` contract comment to "opens the
  right panel's artifacts list tab (toggle)"; the custom `renderChatHeader` path
  uses the same handler.

### Cleanup

- Remove `artifactsExpandSignal` (state in `App.tsx`, prop and effect in
  `EnvironmentPanel.tsx`, and the related tests). Its only consumer was the
  header entry opening the environment panel, which no longer happens. The
  environment panel's artifacts section keeps its default-expanded behavior.

### i18n

- Reuse `environment.artifacts` for the tab title and `environment.artifactsEmpty`
  / `common.loading` for the empty and loading states. These keys already exist
  in every locale, so no new strings are added.

## Key design decisions and rationale

- **Dedicated list tab, not launcher or auto-open-latest.** A tab is consistent
  with the panel's tab model, stays reachable when other tabs are open, and
  faithfully shows all N artifacts (matching the count badge). The launcher only
  renders with no active tab; auto-opening one artifact would show 1 of N.
- **Toggle semantics.** Open ensures the artifacts tab is active; clicking while
  open closes the panel. `aria-pressed` reflects `artifactPanelOpen`, matching the
  right-panel toggle and filling the header close affordance.
- **List from the live prop, not tab payload.** Keeps the tab fully serializable
  and restore trivial, and avoids a stale snapshot.
- **Keep the environment panel artifacts section.** Limits scope; the duplication
  with the new tab is recorded as an open question for maintainer discussion.

## Constraints and risks

- A new tab kind must be handled everywhere tab kinds are switched:
  `getArtifactPanelTabKind`, `isWorkspaceScopedTab`, the tab-bar icon chain, the
  content chain, and persistence parse/restore. A missed branch can misrender.
- Removing `artifactsExpandSignal` touches `EnvironmentPanel` and its tests;
  confirm no other consumer remains.
- `aria-pressed` reflects the whole right panel, not specifically the artifacts
  tab; when another tab is active the button still reads pressed. This matches
  the right-panel toggle and is accepted.
- The floating environment-panel outside-click bug no longer involves the
  artifacts entry (it no longer opens that panel); the environment toggle
  exemption is unchanged.

## Validation plan

- Unit: `ArtifactsListPanel` (list / click / empty / loading); `ArtifactPanel`
  artifacts tab render and icon; `parsePersistedArtifactPanelTab` accepts
  `artifacts`; `ChatContextHeader` artifacts `aria-pressed` and label; `App`
  header entry opens the right panel artifacts tab and a second click closes it;
  environment panel still lists artifacts after `artifactsExpandSignal` removal.
- E2E (headless against a real daemon): cold-open a session with artifacts; click
  the artifacts entry; assert the right panel opens on the artifacts list tab
  (not the environment panel); click a listed artifact and assert its preview
  tab; click the entry again and assert the right panel closes and `aria-pressed`
  flips; assert the environment toggle still opens the environment panel
  independently.
- Regression: per-turn chips unchanged; managed mode unchanged; environment panel
  artifacts section still works.

## Acceptance criteria

- The artifacts entry opens the right panel's artifacts list tab, not the
  environment panel.
- The entry is a toggle with `aria-pressed`; a second click closes the right
  panel.
- Clicking a listed artifact opens its preview tab.
- The environment toggle is unaffected; the artifacts entry no longer causes
  floating-panel flicker.
- A persisted artifacts tab restores across reload.
- Build, typecheck, bundle, and focused unit tests pass.

## Open questions

- Whether to also remove the environment panel's artifacts section, now duplicated
  by the right-panel tab (deferred to maintainer discussion).
- Whether `aria-pressed` should reflect specifically the artifacts tab being
  active rather than the whole right panel.
