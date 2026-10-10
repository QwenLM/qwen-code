# Web Shell composer context chips: where the workspace and git chips live

[English](web-shell-composer-context-chip-placement.md) | [简体中文](web-shell-composer-context-chip-placement.zh-CN.md)

Status: implemented
Date: 2026-09-20
Related: [web-shell-composer-workspace-selector.md](web-shell-composer-workspace-selector.md) (the composer dropdown this design moves), [web-shell-pane-header-actions.md](web-shell-pane-header-actions.md) (the pane header's workspace tag, whose placement the new icon follows)

## Problem

The composer toolbar carried two controls that say _where_ a prompt goes rather
than _how_ it runs: the workspace selector, and — before the first prompt — the
git branch chip. Sitting between the `+` menu and the mode/model controls, they
made the toolbar read as one flat list of unrelated actions. In a session it
was worse than cosmetic: the workspace selector only ever acts on the _next_
session, so it sat among controls that act on the current one.

## Current state

- `ChatEditor` renders both chips inside the composer toolbar, gated by
  `visibleToolbarActions`. The workspace selector needs the `workspace` action
  plus either more than one registered workspace or a workspace-creation
  capability; the git chip needs `gitBranch`, which only the empty-state
  default toolbar enables.
- `ChatContextHeader` renders the session title and the trailing panel actions;
  its leading area held nothing but the title.
- The split-pane header already shows a read-only workspace tag, and `App`
  renders the main header only once the chat is no longer empty.

## Goals

- Before the session exists, the workspace and git chips sit in their own row
  directly under the composer box, so the composer itself stays about the
  prompt.
- Once the session exists, the chat header reports the session's workspace as a
  single leading icon, naming the folder on hover and offering no click
  behavior.
- That header icon is always present in the main chat header: the same folder
  glyph whether or not a workspace exists, with the tooltip carrying the
  difference.

## Non-goals

- No change to which controls are available: hosts still opt in through
  `composerToolbarActions`, and no item is added to the `header.items`
  customization contract. The parent visibility check is aligned with the existing
  standalone selector callback requirement solely to prevent an empty row.
- No new daemon route, protocol field, or persistence. The icon is derived from
  workspace state the shell already holds.
- No change to the split-pane composer or its workspace chip, where the chip's
  job is telling panes apart. The shared workspace menu now prefers opening
  above its trigger in all placements, including embedded hosts.
- No workspace switching from the header icon. Choosing a workspace for a
  session that already exists stays the sidebar's job.
- No new i18n keys: the icon reuses `workspace.paneLabel` and
  `sidebar.noWorkspace`.

## Proposal

`ChatEditor` takes `contextChipPlacement: 'toolbar' | 'below' | 'header'`,
defaulting to `toolbar`.

- `toolbar` keeps today's layout for the split panes and for hosts that
  configure the composer themselves.
- `below` moves both chips into a row rendered inside the composer shell right
  after the bordered box. That row always shows their labels, because it has a
  width budget of its own — the toolbar's label-fitting measurement does not
  reach outside the toolbar. The row has a muted background and rounded bottom
  corners, extending behind the composer to form one connected surface. Its Git
  control uses neutral text without a border, colored fill, or trailing chevron,
  and has wider horizontal padding. Hovering Git shows the full branch name in
  the shared tooltip, wrapping long unbroken names; the workspace menu opens
  above its trigger like Git.
- `header` drops the workspace selector from the composer and leaves git in the
  toolbar, because the chat header owns the workspace.

`App` passes `below` while the chat is empty (`isChatEmptyState`) and `header`
otherwise, so exactly one surface reports the workspace at a time.

`ChatContextHeader` gains `workspaceName` / `workspacePath` and renders a
leading `role="img"` folder icon before its content. Hovering it opens the
app's own tooltip — the same one the pane workspace chip uses — with the
workspace name and its full path, because an icon-only trigger cannot name the
workspace by itself; the accessible name is `workspace.paneLabel`. The
no-workspace state keeps the same glyph and only swaps the tooltip and the
accessible name for `sidebar.noWorkspace`: the icon is the one place that always
answers "which workspace is this session in?", so it stays put. The icon is not
a button, so it adds no action to the header. It matches the title color and
shows a rounded accent background on hover; keyboard triggering is not supported.

## Design decisions

- **The switch follows the empty state, not the message count.** The header
  renders only when the chat is not empty, so keying both surfaces on the same
  flag is what keeps the workspace from being reported twice.
- **The header icon is unconditional; the composer chips are not.** A host that
  enables the `workspace` composer action gets the whole treatment, but the
  icon no longer needs a second workspace or a creation capability: reporting
  the workspace is useful with one registered workspace, where switchability
  was the only reason the control used to hide.
- **A read-only icon.** Hover reports the workspace and nothing is clickable,
  so the header keeps its existing action set and workspace switching stays a
  pre-session action.
- **Hosts that render their own header keep it.** `renderChatHeader` already
  receives `workspaceCwd`, so such a host owns this indicator too and no icon
  is injected into its header.

## Constraints

- The row renders only when at least one chip is actually available. Standalone
  workspace selection requires both support and its selection callback. Controlled
  action visibility, selected values, callbacks, and disabled states are preserved.
- The placement prop is additive and defaults to today's behavior, so the
  split-pane composer and the existing tests are unchanged.
- Both chips stay the same components in both placements: one renderer per
  chip, parameterized by compactness, instead of duplicated markup.

## Risks

- With a single workspace and no creation capability the composer still hides
  the workspace selector, while the header shows the workspace icon — the
  surfaces can differ in whether the _control_ appears even though both report
  the same workspace.
- The header icon also appears in shells with no workspace concept at all
  (standalone, Live), reporting `sidebar.noWorkspace`, which is a new visual
  element in those shells.

## Validation plan

- Unit: `ChatEditor` keeps both chips in the toolbar by default, moves them
  into the row under the composer for `below` (leaving neither behind in the
  toolbar), keeps git in the toolbar for `header`, and omits the row when
  neither chip is available. `ChatContextHeader` reports the workspace
  name/path, falls back to the name for the tooltip, reports the
  missing-workspace state, and adds no button.
- Typecheck, lint, formatting, and the existing `App`, `ChatEditor`, and
  `ChatContextHeader` suites.

## Acceptance criteria

- In a new chat the workspace and git chips appear directly under the composer
  box and are absent from the toolbar.
- In a session the header shows a single folder icon that names the workspace
  on hover, and the composer has no workspace control.
- A session without a workspace keeps the same folder icon in the same place,
  with a tooltip that says there is none.
- Split panes and hosts that configure the composer keep their previous layout.

## Open questions

None.
