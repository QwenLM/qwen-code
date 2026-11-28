/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
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
  gotoSession,
  installScenario,
  resolveBaseURL,
  VISUAL_VIEWPORT,
} from './harness';

test.use({ viewport: { ...VISUAL_VIEWPORT } });

const EXEC_SOURCE = [
  'const r = await Promise.allSettled([',
  "  tools.run_shell_command({ command: 'git branch --show-current' }),",
  "  tools.glob({ pattern: '**/*.md' }),",
  ']);',
  'for (const [i, x] of r.entries()) {',
  '  text({',
  '    i,',
  "    out: x.status === 'fulfilled' ? x.value.output : String(x.reason),",
  '  });',
  '}',
].join('\n');

test('exec tool call arguments', async ({ page }, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    capabilities: {
      features: [
        'session_events',
        'permission_vote',
        'session_permission_vote',
        'session_scope_override',
        'session_source_metadata',
        'workspace_settings',
        'workspace_voice',
        'session_artifacts',
      ],
    },
    events: [
      userTextEvent('Inspect the repository with exec.', { id: 1 }),
      toolCallEvent(
        'call-exec',
        'exec',
        { source: EXEC_SOURCE },
        {
          id: 2,
          rawOutput: 'main\n42 markdown files' as unknown as Record<
            string,
            unknown
          >,
        },
      ),
      assistantTextEvent('Inspection complete.', { id: 3 }),
      turnCompleteEvent('prompt-exec', { id: 4 }),
    ],
  });
  const daemon = await installScenario(
    page,
    scenario,
    resolveBaseURL(testInfo),
  );
  await gotoSession(page, scenario, daemon, 'dark');

  await page.getByRole('button', { name: 'Expand steps', exact: true }).click();
  await page.getByRole('button', { name: 'Exec', exact: true }).click();
  await expect(page.getByText('Arguments', { exact: true })).toBeVisible();
  await expect(page.locator('pre').first()).toBeVisible();
  await clearFocus(page);
  await captureScreenshot(page, 'exec-tool-card-dark');

  const userRow = page
    .locator('[data-web-shell-message-row]')
    .filter({ has: page.getByText('Inspect the repository with exec.') });
  await userRow.hover();
  await userRow
    .getByRole('button', { name: 'More message actions', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'View tool calls', exact: true })
    .click();
  const turnCalls = page.locator('[data-web-shell-turn-calls]');
  await expect(turnCalls).toBeVisible();
  await turnCalls.locator('li > button').first().click();
  await expect(turnCalls.getByText('Arguments', { exact: true })).toBeVisible();
  await clearFocus(page);
  await captureScreenshot(page, 'exec-turn-calls-dark');
});
