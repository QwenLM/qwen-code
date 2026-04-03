# task_update Diff Display — Design Spec

**Date:** 2026-04-02

## Problem

When `task_update` completes, it currently returns a `TodoResultDisplay` containing the full task list — the same shape used by `task_list`. The result is low-signal: you see all tasks re-rendered, and a lone `◐` with no surrounding context feels like a spinner artifact rather than a confirmation.

There's no indication of:

- Which fields actually changed
- What the values were before the update
- Whether the update had any effect

## Solution

Replace the `returnDisplay` for `task_update` with a new `TaskUpdateDiffDisplay` type that shows a compact diff block: task title as a header, then only the fields that changed, with before → after values.

## Visual Design

```
  ✓ Update task 5e24f34e: status=in_progress
    Explore project context for brainstorming
    status      pending → in_progress
```

```
  ✓ Update task 5e24f34e: status=completed, title=...
    Research auth patterns
    title       "Research auth" → "Research auth patterns"
    status      in_progress → completed
    priority    medium → high
```

No-op update (nothing changed):

```
  ✓ Update task 5e24f34e
    Explore project context
    no changes
```

## Fields Diffed

- `status`
- `title`
- `priority`
- `description` (shown when added or changed; truncated to ~80 chars if long)

## Data Shape

New interface added to `tools.ts` alongside `TodoResultDisplay`:

```ts
export interface TaskUpdateDiffDisplay {
  type: 'task_update_diff';
  taskId: string;
  title: string; // post-update title (for display header)
  changes: Array<{
    field: 'status' | 'title' | 'priority' | 'description';
    from: string;
    to: string;
  }>;
}
```

`ToolResultDisplay` union is extended to include `TaskUpdateDiffDisplay`.

## Rendering

`useResultDisplayRenderer` in `ToolMessage.tsx` gets a new `'task_update_diff'` case that maps to `{ type: 'task_update_diff', data: TaskUpdateDiffDisplay }`.

A new `TaskUpdateDiffDisplay.tsx` component renders:

- Line 1: task title in primary text color
- Lines 2+: one row per changed field — field name left-padded, `from → to` in secondary color
- If `changes` is empty: `no changes` in muted/secondary color
- Description values are truncated to 80 chars with `…` suffix

## Files Affected

| File                                                       | Change                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/core/src/tools/tools.ts`                         | Add `TaskUpdateDiffDisplay` interface; extend `ToolResultDisplay` union     |
| `packages/core/src/tools/task-update.ts`                   | Read task before update, diff fields, return `TaskUpdateDiffDisplay`        |
| `packages/cli/src/ui/components/TaskUpdateDiffDisplay.tsx` | New component                                                               |
| `packages/cli/src/ui/components/messages/ToolMessage.tsx`  | Add `task_update_diff` case to `useResultDisplayRenderer` and render branch |

## Out of Scope

- `task_create`, `task_output`, `task_stop`, `task_list`, `task_get` — unchanged
- No change to `llmContent` return value
- No change to `TodoDisplay` component
