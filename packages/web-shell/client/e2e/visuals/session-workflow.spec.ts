/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSettingDescriptor,
} from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from '../utils/mockDaemon';
import {
  captureScreenshot,
  gotoSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

test.use({ viewport: { ...VISUAL_VIEWPORT } });

// Fixed clock so runtimes render identically between the base and head passes
// of the before/after preview.
const T0 = 1_756_100_000_000;
const s = (n: number) => n * 1000;

/**
 * The Session Workflow surfaces are gated on this setting, so the mock daemon
 * has to advertise it as effective — without it `App` passes `planTodos={[]}`
 * and the graph never mounts.
 */
const sessionWorkflowSetting: DaemonSettingDescriptor = {
  key: 'experimental.sessionWorkflow',
  type: 'boolean',
  label: 'Session Workflow Plan & Review',
  category: 'experimental',
  requiresRestart: false,
  default: false,
  values: { effective: true, user: true },
};

// A diamond so the capture exercises what the graph exists to draw: more than
// one layer, a node with two upstreams, and a step that unblocks two others.
// Stable ids and dependency edges travel in `_meta.qwenTodo`, not as
// top-level fields — `parseTodoItemsFromEntries` reads them from there, and a
// fixture that puts `blockedBy` at the top level silently produces a plan with
// no edges and the flat layout instead of the graph.
const todo = (
  id: string,
  content: string,
  status: string,
  blockedBy?: readonly string[],
) => ({
  content,
  status,
  _meta: { qwenTodo: { id, ...(blockedBy ? { blockedBy } : {}) } },
});

const todos = [
  todo('inspect-readme', 'Read README.md', 'completed'),
  todo('inspect-package', 'Read package.json', 'in_progress'),
  todo('compare-findings', 'Compare the two findings', 'pending', [
    'inspect-readme',
    'inspect-package',
  ]),
  todo('write-summary', 'Write the orientation summary', 'pending', [
    'compare-findings',
  ]),
];

// Pinned to the SDK type so a reshape of the agent-task payload fails this
// spec at compile time instead of silently degrading the capture (the graph
// count assertions only guard the todo panel, not the task rendering).
const agentTasks: DaemonSessionAgentTaskStatus[] = [
  {
    kind: 'agent',
    id: 'task-readme',
    label: 'Explore',
    description: 'Reading README.md',
    status: 'completed',
    startTime: T0,
    endTime: T0 + s(18),
    runtimeMs: s(18),
    isBackgrounded: true,
    subagentType: 'Explore',
    toolUseId: 'agent-readme',
    stats: { toolUses: 3, totalTokens: 1_840, durationMs: s(18) },
    recentActivities: [
      { name: 'read_file', description: 'Read README.md', at: T0 + s(4) },
    ],
  },
  {
    kind: 'agent',
    id: 'task-package',
    label: 'Explore',
    description: 'Reading package.json',
    status: 'running',
    startTime: T0 + s(2),
    runtimeMs: s(74),
    isBackgrounded: true,
    subagentType: 'Explore',
    toolUseId: 'agent-package',
    stats: { toolUses: 2, totalTokens: 960, durationMs: s(74) },
    recentActivities: [
      { name: 'read_file', description: 'Read package.json', at: T0 + s(9) },
    ],
  },
];

function createSessionWorkflowScenario() {
  return createWebShellDaemonScenario({
    settings: { v: 1, settings: [sessionWorkflowSetting] },
    workflowTasks: agentTasks,
    events: [
      userTextEvent('Prepare a repository orientation.', { id: 1 }),
      // The `sessionWorkflow` marker is what separates a Workflow plan from an
      // ordinary Todo list; `blockedBy` on the entries is what gives the graph
      // its edges.
      toolCallEvent(
        'todo-call',
        'todo_write',
        { todos },
        {
          id: 2,
          rawOutput: { sessionWorkflow: true, todos },
        },
      ),
      toolCallEvent(
        'agent-readme',
        'Agent',
        { description: 'Read README.md', todo_id: 'inspect-readme' },
        { id: 3 },
      ),
      toolCallEvent(
        'agent-package',
        'Agent',
        { description: 'Read package.json', todo_id: 'inspect-package' },
        { id: 4 },
      ),
      assistantTextEvent('Both explorations are underway.', { id: 5 }),
      turnCompleteEvent('prompt-session-workflow', { id: 6 }),
    ],
  });
}

// `?view=cockpit` is the addressable entry to the dependency canvas, so the
// capture does not depend on finding and clicking the floating Todo summary.
for (const theme of [
  'light',
  'dark',
] as const satisfies readonly VisualTheme[]) {
  test(`session workflow cockpit ${theme}`, async ({ page }, testInfo) => {
    const scenario = createSessionWorkflowScenario();
    const daemon = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await gotoSession(page, scenario, daemon, theme, { view: 'cockpit' });

    // The graph, not just the page: without these the capture can race the
    // measure pass and land on an empty canvas.
    await expect(page.locator('[data-plan-node-id]')).toHaveCount(todos.length);
    // Edge count rather than visibility: an SVG `<path>` with a stroke and no
    // fill is not what Playwright calls visible, and the count also catches
    // the failure this fixture actually hit — dependencies declared at the
    // wrong nesting level render four nodes, zero edges and the flat layout,
    // which looks like a plausible graph until you count the lines.
    await expect(page.locator('[data-plan-edge]')).toHaveCount(3);
    // Gate the capture on task-derived content: the counts above only guard
    // the todo graph. A broken tool-call ↔ task linkage (e.g. a `toolUseId`
    // drift) still renders the canvas but silently drops the runtime metric
    // and the inspector's agent row. `1m 14s` is `formatRuntime(runtimeMs)`
    // for the fixture's running task — locale-independent.
    await expect(page.getByText('1m 14s')).toBeVisible();
    await captureScreenshot(page, `session-workflow-cockpit-${theme}`);
  });
}
