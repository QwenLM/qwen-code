# task_update Diff Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `task_update`'s full-task-list display with a compact before→after diff showing only the fields that changed.

**Architecture:** Add a `TaskUpdateDiffDisplay` type to the core tools layer; read the task state before mutation in `task-update.ts` to compute the diff; add a new Ink component in the CLI to render it; wire the new type into `ToolMessage.tsx`'s display dispatcher.

**Tech Stack:** TypeScript, React/Ink (CLI rendering), existing `tools.ts` display type union pattern

---

### Task 1: Add `TaskUpdateDiffDisplay` type to core

**Files:**

- Modify: `packages/core/src/tools/tools.ts` (around line 576, after `TodoResultDisplay`)

- [ ] **Step 1: Write the failing type-check test**

Create file `packages/core/src/tools/__tests__/task-update-diff-display.test.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest';
import type { ToolResultDisplay, TaskUpdateDiffDisplay } from '../tools.js';

describe('TaskUpdateDiffDisplay type', () => {
  it('is a member of ToolResultDisplay union', () => {
    const display: TaskUpdateDiffDisplay = {
      type: 'task_update_diff',
      taskId: 'abc123',
      title: 'My task',
      changes: [{ field: 'status', from: 'pending', to: 'in_progress' }],
    };
    expectTypeOf(display).toMatchTypeOf<ToolResultDisplay>();
  });

  it('allows empty changes array', () => {
    const display: TaskUpdateDiffDisplay = {
      type: 'task_update_diff',
      taskId: 'abc123',
      title: 'My task',
      changes: [],
    };
    expectTypeOf(display).toMatchTypeOf<ToolResultDisplay>();
  });

  it('allows all diffable fields', () => {
    const display: TaskUpdateDiffDisplay = {
      type: 'task_update_diff',
      taskId: 'abc123',
      title: 'My task',
      changes: [
        { field: 'status', from: 'pending', to: 'in_progress' },
        { field: 'title', from: 'Old', to: 'New' },
        { field: 'priority', from: 'low', to: 'high' },
        { field: 'description', from: 'Before', to: 'After' },
      ],
    };
    expectTypeOf(display).toMatchTypeOf<ToolResultDisplay>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (type not yet defined)**

```bash
cd /path/to/protoCLI && npm run typecheck 2>&1 | head -20
```

Expected: type error — `TaskUpdateDiffDisplay` not found.

- [ ] **Step 3: Add the interface and extend the union in `tools.ts`**

In `packages/core/src/tools/tools.ts`, after the `TodoResultDisplay` interface (around line 583), add:

```ts
export interface TaskUpdateDiffDisplay {
  type: 'task_update_diff';
  taskId: string;
  /** Post-update task title, used as display header */
  title: string;
  changes: Array<{
    field: 'status' | 'title' | 'priority' | 'description';
    from: string;
    to: string;
  }>;
}
```

Then extend the `ToolResultDisplay` union (around line 551) to include `TaskUpdateDiffDisplay`:

```ts
export type ToolResultDisplay =
  | string
  | FileDiff
  | TodoResultDisplay
  | TaskUpdateDiffDisplay
  | PlanResultDisplay
  | AgentResultDisplay
  | AnsiOutputDisplay
  | McpToolProgressData;
```

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck 2>&1 | grep -E "error|warning" | head -20
```

Expected: No new errors introduced. The type test file should resolve cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/tools.ts packages/core/src/tools/__tests__/task-update-diff-display.test.ts
git commit -m "feat(tasks): add TaskUpdateDiffDisplay type to ToolResultDisplay union"
```

---

### Task 2: Update `task-update.ts` to compute and return a diff

**Files:**

- Modify: `packages/core/src/tools/task-update.ts`

- [ ] **Step 1: Write the failing unit test**

Create `packages/core/src/tools/__tests__/task-update.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../config/config.js';
import type { Task } from '../../services/task-store.js';
import { TaskUpdateTool } from '../task-update.js';
import type { TaskUpdateDiffDisplay } from '../tools.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Do the thing',
    status: 'pending',
    priority: 'medium',
    description: undefined,
    createdBy: 'agent',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeConfig(before: Task | null, after: Task | null) {
  const store = {
    get: vi.fn().mockReturnValue(before),
    update: vi.fn().mockReturnValue(after),
    list: vi.fn().mockReturnValue(after ? [after] : []),
  };
  return {
    getTaskStore: () => store,
    _store: store,
  } as unknown as Config;
}

describe('task-update returnDisplay', () => {
  it('shows status diff when status changes', async () => {
    const before = makeTask({ status: 'pending' });
    const after = makeTask({ status: 'in_progress' });
    const config = makeConfig(before, after);
    const tool = new TaskUpdateTool(config);
    const invocation = (tool as any).createInvocation({
      taskId: 'task-1',
      status: 'in_progress',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.type).toBe('task_update_diff');
    expect(display.taskId).toBe('task-1');
    expect(display.title).toBe('Do the thing');
    expect(display.changes).toEqual([
      { field: 'status', from: 'pending', to: 'in_progress' },
    ]);
  });

  it('shows title diff when title changes', async () => {
    const before = makeTask({ title: 'Old title' });
    const after = makeTask({ title: 'New title', status: 'pending' });
    const config = makeConfig(before, after);
    const tool = new TaskUpdateTool(config);
    const invocation = (tool as any).createInvocation({
      taskId: 'task-1',
      title: 'New title',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'title',
      from: 'Old title',
      to: 'New title',
    });
  });

  it('shows priority diff when priority changes', async () => {
    const before = makeTask({ priority: 'low' });
    const after = makeTask({ priority: 'high' });
    const config = makeConfig(before, after);
    const tool = new TaskUpdateTool(config);
    const invocation = (tool as any).createInvocation({
      taskId: 'task-1',
      priority: 'high',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'priority',
      from: 'low',
      to: 'high',
    });
  });

  it('shows description diff when description changes', async () => {
    const before = makeTask({ description: 'Before desc' });
    const after = makeTask({ description: 'After desc' });
    const config = makeConfig(before, after);
    const tool = new TaskUpdateTool(config);
    const invocation = (tool as any).createInvocation({
      taskId: 'task-1',
      description: 'After desc',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toContainEqual({
      field: 'description',
      from: 'Before desc',
      to: 'After desc',
    });
  });

  it('returns empty changes array when nothing changed', async () => {
    const task = makeTask({ status: 'pending' });
    // update called with same value
    const after = makeTask({ status: 'pending' });
    const config = makeConfig(task, after);
    const tool = new TaskUpdateTool(config);
    const invocation = (tool as any).createInvocation({
      taskId: 'task-1',
      status: 'pending',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = result.returnDisplay as TaskUpdateDiffDisplay;

    expect(display.changes).toEqual([]);
  });

  it('returns error display when task not found', async () => {
    const config = makeConfig(null, null);
    const tool = new TaskUpdateTool(config);
    const invocation = (tool as any).createInvocation({
      taskId: 'missing',
      status: 'completed',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.returnDisplay).toContain('not found');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test -- packages/core/src/tools/__tests__/task-update.test.ts 2>&1 | tail -30
```

Expected: FAIL — `returnDisplay` is a `todo_list`, not `task_update_diff`.

- [ ] **Step 3: Rewrite `execute()` in `task-update.ts`**

Replace the `execute` method in `TaskUpdateToolInvocation`:

```ts
async execute(_signal: AbortSignal): Promise<ToolResult> {
  const store = this.config.getTaskStore();

  // Snapshot state before update for diff computation
  const before = store.get(this.params.taskId);

  const task = store.update(this.params.taskId, {
    status: this.params.status as TaskStatus | undefined,
    title: this.params.title,
    description: this.params.description,
    priority: this.params.priority as TaskPriority | undefined,
  });

  if (!task) {
    return {
      llmContent: `Task "${this.params.taskId}" not found.`,
      returnDisplay: `Task not found: ${this.params.taskId}`,
      error: {
        message: `Task "${this.params.taskId}" not found.`,
      },
    };
  }

  const taskJson = JSON.stringify(task, null, 2);

  // Build diff: only include fields that actually changed
  const changes: Array<{
    field: 'status' | 'title' | 'priority' | 'description';
    from: string;
    to: string;
  }> = [];

  const checkField = (
    field: 'status' | 'title' | 'priority' | 'description',
    fromVal: string | undefined,
    toVal: string | undefined,
  ) => {
    const from = fromVal ?? '';
    const to = toVal ?? '';
    if (from !== to) {
      changes.push({ field, from, to });
    }
  };

  if (before) {
    checkField('status', before.status, task.status);
    checkField('title', before.title, task.title);
    checkField('priority', before.priority, task.priority);
    checkField('description', before.description, task.description);
  }

  return {
    llmContent: `Task updated successfully.\n\n<system-reminder>\nUpdated task: ${taskJson}\nContinue with your current work.\n</system-reminder>`,
    returnDisplay: {
      type: 'task_update_diff' as const,
      taskId: task.id,
      title: task.title,
      changes,
    },
  };
}
```

Also add `store.get` to the method's type usage — check that `TaskStore` (returned by `this.config.getTaskStore()`) has a `get(id: string): Task | undefined` method. If it doesn't exist, check `task-store.ts` and add it.

- [ ] **Step 4: Verify `TaskStore.get()` exists**

```bash
grep -n "get(" packages/core/src/services/task-store.ts | head -10
```

If no `get(id)` method exists, add one to the store class (it will be near the `update` method):

```ts
get(id: string): Task | undefined {
  // look at how update() fetches the task and mirror that pattern
}
```

Read `packages/core/src/services/task-store.ts` to confirm the pattern before adding.

- [ ] **Step 5: Run tests**

```bash
npm run test -- packages/core/src/tools/__tests__/task-update.test.ts 2>&1 | tail -30
```

Expected: All 6 tests PASS.

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck 2>&1 | grep "error" | head -20
```

Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/task-update.ts packages/core/src/tools/__tests__/task-update.test.ts packages/core/src/services/task-store.ts
git commit -m "feat(tasks): compute before/after diff in task_update returnDisplay"
```

---

### Task 3: Build `TaskUpdateDiffDisplay` Ink component

**Files:**

- Create: `packages/cli/src/ui/components/TaskUpdateDiffDisplay.tsx`

- [ ] **Step 1: Write the component**

Create `packages/cli/src/ui/components/TaskUpdateDiffDisplay.tsx`:

```tsx
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { TaskUpdateDiffDisplay as TaskUpdateDiffDisplayData } from '@qwen-code/qwen-code-core';
import { Colors } from './colors.js';
import { theme } from '../semantic-colors.js';

const FIELD_COL_WIDTH = 14; // left-pad field names to align arrows
const DESC_MAX_LEN = 80;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

interface Props {
  data: TaskUpdateDiffDisplayData;
}

export const TaskUpdateDiffDisplay: React.FC<Props> = ({ data }) => {
  return (
    <Box flexDirection="column">
      {/* Task title header */}
      <Box>
        <Text color={theme.text.primary}>{data.title}</Text>
      </Box>

      {data.changes.length === 0 ? (
        <Box>
          <Text color={theme.text.secondary}>no changes</Text>
        </Box>
      ) : (
        data.changes.map(({ field, from, to }) => {
          const fromVal =
            field === 'description' ? truncate(from, DESC_MAX_LEN) : from;
          const toVal =
            field === 'description' ? truncate(to, DESC_MAX_LEN) : to;
          const isString = field === 'title' || field === 'description';
          const fromDisplay = isString ? `"${fromVal}"` : fromVal;
          const toDisplay = isString ? `"${toVal}"` : toVal;

          return (
            <Box key={field} flexDirection="row">
              <Box width={FIELD_COL_WIDTH}>
                <Text color={theme.text.secondary}>{field}</Text>
              </Box>
              <Text color={theme.text.secondary}>
                {fromDisplay}
                {' → '}
              </Text>
              <Text color={Colors.AccentGreen}>{toDisplay}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
};
```

- [ ] **Step 2: Verify the import path for `Colors`**

Check that `Colors` is exported from `packages/cli/src/ui/components/colors.ts` and that `Colors.AccentGreen` exists:

```bash
grep -n "AccentGreen" packages/cli/src/ui/components/colors.ts
```

If `Colors.AccentGreen` doesn't exist, use `theme.status.success` from `semantic-colors.js` instead (same green used by completed tasks in `TodoDisplay`).

- [ ] **Step 3: Verify `TaskUpdateDiffDisplay` is exported from core**

```bash
grep -n "TaskUpdateDiffDisplay" packages/core/src/index.ts 2>/dev/null || grep -rn "TaskUpdateDiffDisplay" packages/core/src/tools/index.ts 2>/dev/null
```

Find the core barrel export file and add the export if missing:

```bash
grep -rn "TodoResultDisplay" packages/core/src/ --include="*.ts" -l
```

Look at how `TodoResultDisplay` is exported; export `TaskUpdateDiffDisplay` the same way.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck 2>&1 | grep "error" | head -20
```

Expected: No errors in the new component file.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/components/TaskUpdateDiffDisplay.tsx
git commit -m "feat(tasks): add TaskUpdateDiffDisplay Ink component"
```

---

### Task 4: Wire `task_update_diff` into `ToolMessage.tsx`

**Files:**

- Modify: `packages/cli/src/ui/components/messages/ToolMessage.tsx`

- [ ] **Step 1: Add the new case to `useResultDisplayRenderer`**

In `ToolMessage.tsx`, update the `DisplayRendererResult` type union (around line 43) to add the new case:

```ts
type DisplayRendererResult =
  | { type: 'none' }
  | { type: 'todo'; data: TodoResultDisplay }
  | { type: 'task_update_diff'; data: TaskUpdateDiffDisplay } // ← add this
  | { type: 'plan'; data: PlanResultDisplay }
  | { type: 'string'; data: string }
  | { type: 'diff'; data: { fileDiff: string; fileName: string } }
  | { type: 'task'; data: AgentResultDisplay }
  | { type: 'ansi'; data: AnsiOutput };
```

Add the import at the top of the file alongside the existing `TodoResultDisplay` import:

```ts
import type {
  TodoResultDisplay,
  TaskUpdateDiffDisplay, // ← add
  AgentResultDisplay,
  PlanResultDisplay,
  AnsiOutput,
  Config,
  McpToolProgressData,
} from '@qwen-code/qwen-code-core';
```

In `useResultDisplayRenderer`, add the `task_update_diff` check **before** the `todo_list` check:

```ts
// Check for TaskUpdateDiffDisplay
if (
  typeof resultDisplay === 'object' &&
  resultDisplay !== null &&
  'type' in resultDisplay &&
  resultDisplay.type === 'task_update_diff'
) {
  return {
    type: 'task_update_diff',
    data: resultDisplay as TaskUpdateDiffDisplay,
  };
}
```

- [ ] **Step 2: Add the import for the new component**

In the import block of `ToolMessage.tsx`, add:

```ts
import { TaskUpdateDiffDisplay as TaskUpdateDiffRenderer } from '../TaskUpdateDiffDisplay.js';
```

(Alias to `TaskUpdateDiffRenderer` to avoid name collision with the imported type.)

- [ ] **Step 3: Add the render branch**

In the JSX block that dispatches on `displayRenderer.type`, add after the `todo` branch:

```tsx
{
  displayRenderer.type === 'task_update_diff' && (
    <TaskUpdateDiffRenderer data={displayRenderer.data} />
  );
}
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck 2>&1 | grep "error" | head -20
```

Expected: No errors.

- [ ] **Step 5: Run all tests**

```bash
npm run test 2>&1 | tail -30
```

Expected: All existing tests pass; the two new test files pass.

- [ ] **Step 6: Smoke test manually**

```bash
npm run build && node packages/cli/bundle/gemini.js -p "create a task called 'test task' then immediately mark it in_progress"
```

Expected output should show a diff block:

```
  ✓ Update task <id>: status=in_progress
    test task
    status      pending → in_progress
```

- [ ] **Step 7: Final commit**

```bash
git add packages/cli/src/ui/components/messages/ToolMessage.tsx
git commit -m "feat(tasks): wire task_update_diff display into ToolMessage renderer"
```
