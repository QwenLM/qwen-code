# Scheduled Task Workspace Visibility

[English](scheduled-task-workspace-visibility.md) | [简体中文](scheduled-task-workspace-visibility.zh-CN.md)

## Problem and scope

Issue [#16383](https://github.com/QwenLM/qwen-code/issues/16383) reports that hiding
the workspace field makes scheduled tasks appear workspace-free. Currently a
single workspace or a host lock hides both the form selector and task-card
workspace labels. Tasks still execute in their assigned workspace.

This proposal is limited to Scheduled Tasks. The issue remains `need-discussion`;
the local implementation is a reviewable proposal, not a maintainer-approved
change to the wider Web Shell convention. Workspace-free scheduling (#8212),
other pages, task routing, storage, and daemon APIs are outside its scope.

## Display behavior

- Retain the existing multi-workspace selector and its edit/permission rules.
- When that selector is hidden, display the resolved workspace as a read-only
  label in the New/Edit form. Keep the existing **Workspace** terminology.
- Reuse existing workspace naming: display name, SSH label, or path basename.
  Reuse the existing workspace pill and native `title` with the full path.
- A host-locked form also displays **Fixed by host**.
- Show each task's workspace pill even for a single or host-locked workspace.
  Older capabilities can supply the existing `primaryWorkspaceCwd` fallback.
- If no workspace path is known, do not invent a workspace or show a misleading
  "no workspace" value. Preserve existing routing and loading behavior.

## Implementation and validation

Changes belong to `ScheduledTasksDialog.tsx`, its collocated tests and existing
styles, the English/Chinese strings in `i18n.tsx`, and the scheduled-task user
documentation. No new component, public prop, or request is needed.

Validate single-workspace creation/editing, host-locked secondary workspaces,
legacy primary-path capabilities, and unchanged multi-workspace selection.
Assertions must cover visible names/full-path titles and the original mutation
target. Check long paths and a narrow viewport in a browser. Build, typecheck,
focused tests, formatting, and independent review complete local validation.

## Open decision

Maintainers still need to accept always-visible execution context for this
page. Extending the convention to other Web Shell pages is a separate proposal.
