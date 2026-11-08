/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

test('wraps Skill details and separates the owning Extension', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const extension = 'dataworks-data-analysis-extension';
  const skill =
    'dataanalysis-personal-directory-with-a-very-long-unbroken-skill-name';
  const qualifiedName = `${extension}:${skill}`;
  const standalone = 'standalone-skill-with-a-very-long-unbroken-name';
  const colonName = 'analysis:report';
  const description = 'Manage SQL, Markdown, Jupyter Notebook, and HTML files.';
  const scenario = createWebShellDaemonScenario({
    supportedCommands: {
      availableCommands: [
        {
          name: qualifiedName,
          description,
          input: { hint: '<request>' },
          _meta: { source: 'plugin-command' },
        },
        {
          name: standalone,
          description,
          input: { hint: '<request>' },
          _meta: { source: 'skill' },
        },
        {
          name: 'ordinary-command',
          description: 'Ordinary command description.',
          input: { hint: '<request>' },
          _meta: { source: 'plugin-command' },
        },
        {
          name: colonName,
          description,
          input: { hint: '<request>' },
          _meta: { source: 'skill' },
        },
      ],
      availableSkills: [qualifiedName, standalone, colonName],
    },
    skills: {
      skills: [
        {
          kind: 'skill',
          name: qualifiedName,
          description,
          level: 'extension',
          status: 'ok',
          modelInvocable: true,
          extensionName: extension,
        },
        ...[standalone, colonName].map((name) => ({
          kind: 'skill' as const,
          name,
          description,
          level: 'user' as const,
          status: 'ok' as const,
          modelInvocable: true,
        })),
      ],
    },
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await expect(editor).toBeVisible();
  await editor.fill('/');
  const option = page.getByRole('option').filter({ hasText: qualifiedName });
  await expect(option).toBeVisible();
  await option.hover();
  const detail = page.locator('[data-web-shell-slash-detail]');
  await expect(detail).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('extension-skill.png') });
  const title = detail.getByText(new RegExp(`^/?${skill}$`));
  await expect(title).toBeVisible();
  await expect(detail.getByText(extension, { exact: false })).toBeVisible();
  const layout = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(layout.height).toBeGreaterThan(layout.lineHeight);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  expect(layout.whiteSpace).not.toBe('nowrap');
  await expect(detail).toContainText(description);
  await option.click();
  await page.keyboard.insertText('test-request');
  await expect(editor).toHaveText(`/${qualifiedName} test-request`);

  await editor.fill('/');
  await page.getByRole('option').filter({ hasText: standalone }).hover();
  await expect(detail.getByText(new RegExp(`^/?${standalone}$`))).toBeVisible();
  await expect(detail).not.toContainText(extension);

  await page
    .getByRole('option')
    .filter({ hasText: `/${colonName}` })
    .hover();
  await expect(detail.getByText(new RegExp(`^/?${colonName}$`))).toBeVisible();
  await expect(detail).not.toContainText(extension);

  await page
    .getByRole('option')
    .filter({ hasText: '/ordinary-command' })
    .hover();
  await expect(detail).toContainText('/ordinary-command');
  await expect(detail).toContainText('Ordinary command description.');

  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await editor.fill('/');
  await expect(option).toBeVisible();
  await option.hover();
  await expect(title).toBeVisible();
  await expect(detail.getByText(extension, { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('workspace-extension-skill.png'),
  });
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);
});
