/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  permissionRequestEvent,
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

const THEMES: readonly VisualTheme[] = ['dark', 'light'];

// Same wire shape the browser-notifications spec uses for a live AskUser
// question: toolCall._meta.toolName plus rawInput.questions.
function askUserQuestionEvent(sessionId: string) {
  return permissionRequestEvent('ask-details-visual', {
    id: 1,
    sessionId,
    toolCall: {
      toolCallId: 'ask-details-visual',
      title: 'Ask user 1 question',
      kind: 'think',
      _meta: { toolName: 'ask_user_question' },
      rawInput: {
        questions: [
          {
            header: 'Backend',
            question: '缓存用哪种存储后端？',
            options: [
              { label: 'SQLite', description: '本地文件数据库，无需额外服务' },
              { label: 'Redis', description: '内存存储，需要常驻服务' },
            ],
          },
        ],
      },
    },
  });
}

for (const theme of THEMES) {
  test(`ask-user details action opens a side task (${theme})`, async ({
    page,
  }, testInfo) => {
    const scenario = createWebShellDaemonScenario({ events: [] });
    scenario.capabilities.features.push('session_side_task');
    const daemon = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await page.route(`**/session/${scenario.sessionId}/side-task`, (route) =>
      route.fulfill({
        json: {
          sessionId: 'ask-details-side-task',
          workspaceCwd: scenario.workspaceCwd,
          attached: false,
          clientId: 'side-task-fixture-client',
          createdAt: '2026-11-06T00:00:00.000Z',
          hasActivePrompt: false,
          displayName: 'Side task',
          parentSessionId: scenario.sessionId,
          state: scenario.state,
        },
      }),
    );
    await gotoSession(page, scenario, daemon, theme, { language: 'zh-CN' });
    await daemon.sendEvent(askUserQuestionEvent(scenario.sessionId));

    const panel = page.locator('[data-web-shell-ask-panel]');
    await expect(panel).toBeVisible();
    const details = panel.getByRole('button', { name: '问细节' });
    await expect(details).toBeVisible();
    await expect(details).toHaveAttribute(
      'title',
      '打开侧边任务，在作答前解释这个问题',
    );
    await captureScreenshot(page, `ask-user-details-panel-${theme}`);

    await details.click();
    await expect(page.locator('button[title="侧边任务"]')).toBeVisible();
    await captureScreenshot(page, `ask-user-details-side-task-${theme}`);
    // The question stays pending: the details action never answers it.
    await expect(panel).toBeVisible();
    await expect(panel.getByText('缓存用哪种存储后端？')).toBeVisible();
  });
}
