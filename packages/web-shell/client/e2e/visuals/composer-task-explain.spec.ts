/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionShellTaskStatus,
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
  clearFocus,
  FIXED_CAPTURE_TIME,
  gotoSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

test.use({ viewport: { ...VISUAL_VIEWPORT } });

// Running-task elapsed derives from `now - startTime` on the frozen page
// clock, so the start instants come from the capture constant, not a
// hardcoded epoch that would render a months-long runtime.
const T0 = FIXED_CAPTURE_TIME.getTime();
const s = (n: number) => n * 1000;

const agentTasks: DaemonSessionAgentTaskStatus[] = [
  {
    kind: 'agent',
    id: 'task-readme',
    label: 'Read README.md',
    description: 'Reading README.md',
    status: 'running',
    startTime: T0 - s(74),
    runtimeMs: s(74),
    isBackgrounded: true,
    subagentType: 'Explore',
    toolUseId: 'agent-readme',
    prompt: 'Read README.md and summarize the project layout.',
    recentActivities: [
      { name: 'read_file', description: 'Read README.md', at: T0 - s(9) },
    ],
  },
  {
    kind: 'agent',
    id: 'task-package',
    label: 'Read package.json',
    description: 'Reading package.json',
    status: 'running',
    startTime: T0 - s(41),
    runtimeMs: s(41),
    isBackgrounded: true,
    subagentType: 'Explore',
    toolUseId: 'agent-package',
    prompt: 'Read package.json and list the build scripts.',
    recentActivities: [
      { name: 'read_file', description: 'Read package.json', at: T0 - s(6) },
    ],
  },
];

const shellTask: DaemonSessionShellTaskStatus = {
  kind: 'shell',
  id: 'task-shell',
  label: 'npm test',
  description: 'npm test',
  status: 'running',
  startTime: T0 - s(12),
  runtimeMs: s(12),
  command: 'npm test',
  cwd: '/workspace',
};

const EXPLAIN_ANSWER =
  'Two Explore agents are reading README.md and package.json to prepare a repository orientation, while npm test runs the unit suite in the background. Next: combine the findings into a summary.';

function createComposerTaskExplainScenario() {
  return createWebShellDaemonScenario({
    workflowTasks: [...agentTasks, shellTask],
    btwAnswer: EXPLAIN_ANSWER,
    events: [
      userTextEvent('Prepare a repository orientation and run the tests.', {
        id: 1,
      }),
      toolCallEvent(
        'agent-readme',
        'Agent',
        { description: 'Read README.md', subagent_type: 'Explore' },
        { id: 2 },
      ),
      toolCallEvent(
        'agent-package',
        'Agent',
        { description: 'Read package.json', subagent_type: 'Explore' },
        { id: 3 },
      ),
      toolCallEvent(
        'shell-test',
        'run_shell_command',
        { command: 'npm test' },
        { id: 4 },
      ),
      assistantTextEvent('Both explorations and the test run are underway.', {
        id: 5,
      }),
      turnCompleteEvent('prompt-task-explain', { id: 6 }),
    ],
  });
}

for (const theme of [
  'light',
  'dark',
] as const satisfies readonly VisualTheme[]) {
  test(`composer task explain ${theme}`, async ({ page }, testInfo) => {
    const scenario = createComposerTaskExplainScenario();
    const daemon = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await gotoSession(page, scenario, daemon, theme);

    const chips = page.locator('[data-testid="composer-task-chips"]');
    await expect(chips).toBeVisible();
    await expect(chips.locator('[data-kind="agent"]')).toContainText(
      '2 local agents',
    );
    await expect(chips.locator('[data-kind="shell"]')).toContainText('1 shell');
    // Only the single-task shell chip carries a "?" at the chip row itself.
    const chipExplain = chips.locator('[data-testid="composer-task-explain"]');
    await expect(chipExplain).toHaveCount(1);
    await expect(chipExplain).toBeVisible();
    await expect(chipExplain.locator('svg')).toHaveCount(1);
    await clearFocus(page);
    await captureScreenshot(page, `composer-task-explain-chips-${theme}`);

    // Keyboard focus lands on the "?" with the same ring as its chip; a
    // fill alone would be indistinguishable from hover in the light theme.
    await chips.locator('[data-kind="shell"]').focus();
    await page.keyboard.press('Tab');
    await expect(chipExplain).toBeFocused();
    await captureScreenshot(page, `composer-task-explain-focus-${theme}`);

    // The multi-task chip opens a list with one "?" per row.
    await chips.locator('[data-kind="agent"]').click();
    const list = page.locator('[data-testid="composer-task-list"]');
    await expect(list).toBeVisible();
    await expect(list.locator('[data-testid="composer-task-row"]')).toHaveCount(
      2,
    );
    const rowExplains = list.locator('[data-testid="composer-task-explain"]');
    await expect(rowExplains).toHaveCount(2);
    await expect(rowExplains.first()).toBeVisible();
    await expect(rowExplains.last()).toBeVisible();
    await captureScreenshot(page, `composer-task-explain-list-${theme}`);

    // Asking streams the model's explanation into the btw panel; the list
    // stays open so another task can be asked about next. The panel echoes
    // the short display line, never the composed fact dump.
    await list.locator('[data-testid="composer-task-explain"]').first().click();
    const panel = page.locator('[class*="btwPanel"]');
    await expect(panel).toContainText(EXPLAIN_ANSWER);
    await expect(panel).toContainText(
      'Explain what this task is doing: Read README.md',
    );
    await expect(panel).not.toContainText('Task facts:');
    await expect(list).toBeVisible();
    await captureScreenshot(page, `composer-task-explain-answer-${theme}`);
  });
}
