/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import { createWebShellDaemonScenario } from '../utils/mockDaemon';
import {
  captureScreenshot,
  gotoSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

test.use({ viewport: { ...VISUAL_VIEWPORT } });

// Fixed clock so the captured timestamps and runtimes are identical between
// the base and head render passes of the visuals preview.
const T0 = 1_756_100_000_000;
const s = (n: number) => n * 1000;

function base(
  overrides: Partial<DaemonSessionWorkflowTaskStatus>,
): DaemonSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id: 'wf_ec511ac4f8818c74',
    label: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    status: 'running',
    startTime: T0,
    runtimeMs: s(96),
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
    pendingApprovals: [],
    ...overrides,
  };
}

const running = base({
  phaseVisits: [
    { id: 'p1', index: 0, title: 'Scan', startedAt: T0, endedAt: T0 + s(14) },
    { id: 'p2', index: 1, title: 'Review', startedAt: T0 + s(14) },
    { id: 'p3', index: 2, title: 'Verify', startedAt: T0 + s(60) },
  ],
  dispatches: [
    {
      id: 'd1',
      phaseVisitId: 'p1',
      label: 'Scope changed files',
      prompt:
        'List the files changed on this branch relative to main and group them by package.',
      status: 'completed',
      dependsOn: [],
      queuedAt: T0,
      startedAt: T0 + s(1),
      endedAt: T0 + s(13),
    },
    {
      id: 'd2',
      phaseVisitId: 'p2',
      label: 'review:bugs',
      prompt:
        'Review the changed files for correctness bugs. Report each finding with file, line, and a concrete failure scenario.',
      subagentId: 'sa-2',
      status: 'running',
      dependsOn: ['d1'],
      queuedAt: T0 + s(14),
      startedAt: T0 + s(15),
    },
    {
      id: 'd3',
      phaseVisitId: 'p2',
      label: 'review:perf',
      prompt: 'Review the changed files for efficiency regressions.',
      subagentId: 'sa-3',
      status: 'running',
      dependsOn: ['d1'],
      queuedAt: T0 + s(14),
      startedAt: T0 + s(15),
    },
    {
      id: 'd4',
      phaseVisitId: 'p2',
      label: 'review:security',
      prompt:
        'Review the changed files for security issues. Do not modify files.',
      subagentId: 'sa-4',
      status: 'running',
      dependsOn: ['d1'],
      queuedAt: T0 + s(14),
      startedAt: T0 + s(16),
    },
    {
      id: 'd5',
      phaseVisitId: 'p3',
      label: 'verify:bugs',
      prompt: 'Adversarially verify each bug finding.',
      status: 'queued',
      dependsOn: ['d2'],
      queuedAt: T0 + s(60),
    },
    {
      id: 'd6',
      phaseVisitId: 'p3',
      label: 'verify:perf',
      prompt: 'Adversarially verify each perf finding.',
      status: 'queued',
      dependsOn: ['d3'],
      queuedAt: T0 + s(60),
    },
  ],
  agentsDispatched: 6,
  agentsCompleted: 1,
  tokensSpent: 4_200,
  tokenBudgetTotal: 50_000,
  pendingApprovalCount: 1,
  pendingApprovals: [
    {
      approvalId: 'ap-1',
      subagentId: 'sa-4',
      name: 'Bash',
      description: 'npm audit --json',
      at: T0 + s(70),
    },
  ],
});

const completedDispatches = running.dispatches.map((d) => ({
  ...d,
  status: 'completed' as const,
  startedAt: d.startedAt ?? d.queuedAt + s(1),
  endedAt: d.endedAt ?? d.queuedAt + s(30),
}));

const completed = base({
  id: 'wf_9f2c0a11b7e0d3c2',
  label: 'release-readiness',
  status: 'completed',
  startTime: T0 - s(1800),
  runtimeMs: s(142),
  endTime: T0 - s(1800) + s(142),
  currentPhase: null,
  isHistorical: true,
  phaseVisits: running.phaseVisits.map((p) => ({
    ...p,
    endedAt: p.endedAt ?? T0 + s(140),
  })),
  dispatches: completedDispatches,
  agentsDispatched: 6,
  agentsCompleted: 6,
  tokensSpent: 18_400,
  tokenBudgetTotal: 50_000,
  pendingApprovalCount: 0,
});

const olderRun: DaemonSessionWorkflowTaskStatus = {
  ...completed,
  id: 'wf_5b7d3e0f2a19c4d8',
  startTime: T0 - s(7200),
  runtimeMs: s(131),
  tokensSpent: 17_900,
};

// The Workflows page needs the mock daemon to expose Workflow controls
// (`workflowsEnabled` + `savedWorkflows` on supported-commands), a task
// snapshot with workflow runs, and one readable saved definition. Each theme
// walks Saved → definition detail (with source) → Running (expanded graph) →
// History (expanded saved run).
for (const theme of [
  'light',
  'dark',
] as const satisfies readonly VisualTheme[]) {
  test(`workflow page ${theme}`, async ({ page }, testInfo) => {
    const scenario = createWebShellDaemonScenario({
      supportedCommands: {
        workflowsEnabled: true,
        savedWorkflows: [
          { name: 'review-changes', source: 'project' },
          { name: 'release-readiness', source: 'project' },
          { name: 'find-flaky-tests', source: 'user' },
        ],
      },
      workflowTasks: [running, completed, olderRun],
      savedWorkflowDetails: {
        'review-changes': {
          source: 'project',
          scriptPath: '/workspace/.qwen/workflows/review-changes.js',
          script: [
            'export const meta = {',
            "  name: 'review-changes',",
            "  description: 'Review changed files across dimensions, verify each finding',",
            "  whenToUse: 'Before opening a PR, or when a review needs independent verification',",
            '  phases: [',
            "    { title: 'Scan', detail: 'list changed files and group them by package' },",
            "    { title: 'Review', detail: 'one agent per dimension: bugs, perf, security' },",
            "    { title: 'Verify', detail: 'adversarially verify each finding' },",
            '  ],',
            '}',
            "const DIMENSIONS = ['bugs', 'perf', 'security']",
            "phase('Scan')",
            "const scope = await agent('List the files changed on this branch relative to main.', { schema: SCOPE })",
            "phase('Review')",
            'const findings = await parallel(DIMENSIONS.map((d) => () =>',
            '  agent(`Review ${scope.files.join(", ")} for ${d}.`, { label: `review:${d}`, schema: FINDINGS })))',
            "phase('Verify')",
            'return await pipeline(findings.flat(), (f) => agent(`Adversarially verify: ${f.title}`, { schema: VERDICT }))',
            '',
          ].join('\n'),
          meta: {
            name: 'review-changes',
            description:
              'Review changed files across dimensions, verify each finding',
            whenToUse:
              'Before opening a PR, or when a review needs independent verification',
            phases: [
              {
                title: 'Scan',
                detail: 'list changed files and group them by package',
              },
              {
                title: 'Review',
                detail: 'one agent per dimension: bugs, perf, security',
              },
              { title: 'Verify', detail: 'adversarially verify each finding' },
            ],
          },
        },
      },
    });
    const daemon = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await gotoSession(page, scenario, daemon, theme);

    await page.getByRole('button', { name: 'Workflows' }).first().click();
    await expect(page.getByRole('tab', { name: /Saved/ })).toBeVisible();
    await expect(page.getByText('/review-changes')).toBeVisible();
    await page.waitForTimeout(400);
    await captureScreenshot(page, `workflow-page-saved-${theme}`);

    await page
      .getByRole('button', { name: 'Show details for review-changes' })
      .click();
    await expect(
      page.locator('[data-workflow-detail="review-changes"]'),
    ).toContainText('Phases (3)');
    await page.getByRole('button', { name: 'Show source' }).click();
    await expect(
      page.locator('[data-workflow-source] pre').first(),
    ).toBeVisible();
    await page.waitForTimeout(600);
    await captureScreenshot(page, `workflow-page-saved-detail-${theme}`);
    await page
      .getByRole('button', { name: 'Show details for review-changes' })
      .click();

    await page.getByRole('tab', { name: /Running/ }).click();
    const runningRow = page
      .getByRole('tabpanel')
      .getByRole('button', { expanded: false })
      .first();
    await runningRow.click();
    await expect(page.locator('[data-workflow-dispatch="d2"]')).toBeVisible();
    await page.waitForTimeout(400);
    await captureScreenshot(page, `workflow-page-running-${theme}`);

    await page.getByRole('tab', { name: /History/ }).click();
    const historyRow = page
      .getByRole('tabpanel')
      .getByRole('button', { expanded: false })
      .first();
    await historyRow.click();
    await expect(page.locator('[data-workflow-dispatch="d1"]')).toBeVisible();
    await page.waitForTimeout(400);
    await captureScreenshot(page, `workflow-page-history-${theme}`);
  });
}
