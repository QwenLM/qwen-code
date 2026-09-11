/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import type { DaemonSessionAgentTaskStatus } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
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

/**
 * One teammate per lifecycle state the roster has to keep apart, plus one
 * ordinary subagent as the control row.
 *
 * `idle` is the state this projection exists to represent: a teammate that has
 * reported and is waiting for the next assignment is neither running nor
 * finished, and collapsing it into either would hide the only thing a leader
 * asks the roster — who is free right now. `completed` is the separate
 * terminal state, and the shared-task column is what tells the two apart when
 * both are otherwise quiet.
 */
const TEAMMATES: readonly DaemonSessionAgentTaskStatus[] = [
  {
    kind: 'agent',
    id: 'scout-core@field-team',
    label: 'scout-core',
    description: 'Mapping the core package surface',
    status: 'running',
    startTime: Date.now() - 95_000,
    runtimeMs: 95_000,
    isBackgrounded: false,
    teamName: 'field-team',
    color: '#4ECDC4',
    teamTask: {
      id: '1',
      subject: 'Map the core package surface',
      status: 'in_progress',
    },
    recentActivities: [
      {
        name: 'read_file',
        description: 'packages/core/src/agents/team/TeamManager.ts',
        at: Date.now() - 4_000,
      },
    ],
  },
  {
    kind: 'agent',
    id: 'reviewer@field-team',
    label: 'reviewer',
    description: 'Waiting for the next assignment',
    status: 'idle',
    startTime: Date.now() - 148_000,
    runtimeMs: 148_000,
    isBackgrounded: false,
    teamName: 'field-team',
    color: '#FF6B6B',
    teamTask: {
      id: '2',
      subject: 'Review the auth migration',
      status: 'completed',
    },
  },
  {
    kind: 'agent',
    id: 'writer@field-team',
    label: 'writer',
    description: 'Shut down after the handoff',
    status: 'completed',
    startTime: Date.now() - 210_000,
    endTime: Date.now() - 30_000,
    runtimeMs: 170_000,
    isBackgrounded: false,
    teamName: 'field-team',
    color: '#FFD93D',
    teamTask: {
      id: '3',
      subject: 'Write the migration notes',
      status: 'completed',
    },
  },
];

/**
 * The control row: an ordinary subagent with no `teamName`. The roster merges
 * team rows and subagent rows into one list, so a capture without this row
 * would not catch a change that made every row render as a teammate — the
 * regression this projection is most likely to introduce, since both shapes now
 * share one adapter.
 */
const SUBAGENT: DaemonSessionAgentTaskStatus = {
  kind: 'agent',
  id: 'agent-search-index',
  label: 'general-purpose',
  description: 'Searching the repository for prior art',
  status: 'running',
  startTime: Date.now() - 40_000,
  runtimeMs: 40_000,
  isBackgrounded: true,
  subagentType: 'general-purpose',
};

function createTeamRosterScenario() {
  return createWebShellDaemonScenario({
    displayName: 'Migrate the auth service',
    capabilities: {
      features: ['session_events', 'session_agents'],
    },
    events: [
      userTextEvent('Migrate the auth service to the new token store.', {
        id: 1,
      }),
      assistantTextEvent(
        'Created team field-team with scout-core, reviewer and writer. ' +
          'scout-core is mapping the package surface now; reviewer has ' +
          'reported and is idle; writer finished and shut down.',
        { id: 2 },
      ),
      turnCompleteEvent('prompt-team-roster-visual', { id: 3 }),
    ],
    agentTasks: [...TEAMMATES, SUBAGENT],
  });
}

/**
 * Team rows are status-only in WebShell: there is no in-process teammate
 * transcript endpoint yet, so the panel deliberately disables them while the
 * ordinary subagent keeps its existing detail action. Asserting that split is
 * the point of this capture — a row that looks right but silently opens the wrong
 * surface is the failure mode a screenshot alone would not catch.
 */
async function assertRosterSplit(page: import('@playwright/test').Page) {
  const panel = page.getByTestId('environment-panel');
  await expect(panel.locator('[data-status="running"]')).toHaveCount(2);
  await expect(panel.locator('[data-status="idle"]')).toHaveCount(1);
  await expect(panel.locator('[data-status="completed"]')).toHaveCount(1);

  for (const teammate of TEAMMATES) {
    const row = panel.locator('button', { hasText: teammate.label });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-disabled', 'true');
  }

  // Shared-task ownership is the column that separates idle from completed.
  await expect(panel.getByText('Review the auth migration')).toBeVisible();

  const subagentRow = panel.locator('button', { hasText: 'general-purpose' });
  await expect(subagentRow).toHaveCount(1);
  await expect(subagentRow).toBeEnabled();
}

for (const theme of [
  'light',
  'dark',
] as const satisfies readonly VisualTheme[]) {
  test(`agent team roster ${theme}`, async ({ page }, testInfo) => {
    const scenario = createTeamRosterScenario();
    const daemon = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await gotoSession(page, scenario, daemon, theme);

    await page
      .getByRole('button', { name: 'Toggle environment information' })
      .click();

    await assertRosterSplit(page);
    await captureScreenshot(page, `agent-team-roster-${theme}`);
  });
}
