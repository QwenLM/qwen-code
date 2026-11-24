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
  const option = page.getByRole('option').filter({ hasText: `/${skill}` });
  await expect(option).toBeVisible();
  const optionLabel = option.locator(':scope > span').first();
  await expect(optionLabel).toContainText(`/${skill}`);
  await expect(option).not.toContainText(extension);
  await option.hover();
  const detail = page.locator('[data-web-shell-slash-detail]');
  await expect(detail).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('extension-skill.png') });
  const title = detail.getByText(new RegExp(`^/?${skill}$`));
  await expect(title).toBeVisible();
  const extensionBadge = detail.getByText(extension, { exact: true });
  await expect(extensionBadge).toBeVisible();
  const descriptionBlock = detail.getByText(description, { exact: true });
  await expect(descriptionBlock).toBeVisible();
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
  const extensionStyle = await extensionBadge.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontWeight: Number.parseFloat(style.fontWeight),
      borderTopWidth: Number.parseFloat(style.borderTopWidth),
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  const descriptionStyle = await descriptionBlock.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontWeight: Number.parseFloat(style.fontWeight),
    };
  });
  expect(extensionStyle.scrollWidth).toBeLessThanOrEqual(extensionStyle.width);
  expect(extensionStyle.color).not.toBe(descriptionStyle.color);
  expect(extensionStyle.backgroundColor).not.toBe(
    descriptionStyle.backgroundColor,
  );
  expect(extensionStyle.fontWeight).toBeGreaterThan(
    descriptionStyle.fontWeight,
  );
  expect(extensionStyle.borderTopWidth).toBeGreaterThan(0);
  await option.click();
  await page.keyboard.insertText('test-request');
  await expect(editor).toHaveText(`/${qualifiedName} test-request`);

  await editor.fill('/');
  const standaloneOption = page
    .getByRole('option')
    .filter({ hasText: standalone });
  const standaloneLabel = standaloneOption.locator(':scope > span').first();
  await expect(standaloneLabel).toContainText(standalone);
  const labelLayout = await standaloneLabel.evaluate((label) => ({
    width: label.clientWidth,
    scrollWidth: label.scrollWidth,
  }));
  expect(labelLayout.scrollWidth).toBeLessThanOrEqual(labelLayout.width);
  await standaloneOption.hover();
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
  await expect(option).not.toContainText(extension);
  await option.hover();
  await expect(title).toBeVisible();
  await expect(extensionBadge).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('workspace-extension-skill.png'),
  });
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);
});

test('keeps Extension badge visually distinct in light theme and without description', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('qwen-code-web-shell-theme', 'light');
    localStorage.setItem('qwen-code-web-shell-language', 'zh-CN');
  });
  const extension = 'dataworks-suite';
  const withDescSkill = 'sql-review';
  const noDescSkill = 'quick-export';
  const description = '检查 SQL 查询并生成优化建议。';
  const scenario = createWebShellDaemonScenario({
    supportedCommands: {
      availableCommands: [
        {
          name: `${extension}:${withDescSkill}`,
          description,
          _meta: { source: 'plugin-command' },
        },
        {
          name: `${extension}:${noDescSkill}`,
          description: '',
          _meta: { source: 'plugin-command' },
        },
      ],
      availableSkills: [
        `${extension}:${withDescSkill}`,
        `${extension}:${noDescSkill}`,
      ],
    },
    skills: {
      skills: [
        {
          kind: 'skill',
          name: `${extension}:${withDescSkill}`,
          description,
          level: 'extension',
          status: 'ok',
          modelInvocable: true,
          extensionName: extension,
        },
        {
          kind: 'skill',
          name: `${extension}:${noDescSkill}`,
          description: '',
          level: 'extension',
          status: 'ok',
          modelInvocable: true,
          extensionName: extension,
        },
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

  const withDescOption = page
    .getByRole('option')
    .filter({ hasText: `/${withDescSkill}` });
  await expect(withDescOption).toBeVisible();
  await expect(withDescOption).not.toContainText(extension);
  await withDescOption.hover();

  const detail = page.locator('[data-web-shell-slash-detail]');
  await expect(detail).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('extension-skill-light-zh.png'),
  });
  const extensionBadge = detail.getByText(extension, { exact: true });
  const descriptionBlock = detail.getByText(description, { exact: true });
  await expect(extensionBadge).toBeVisible();
  await expect(descriptionBlock).toBeVisible();
  const [extensionStyle, descriptionStyle] = await Promise.all([
    extensionBadge.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontWeight: Number.parseFloat(style.fontWeight),
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
      };
    }),
    descriptionBlock.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontWeight: Number.parseFloat(style.fontWeight),
      };
    }),
  ]);
  expect(extensionStyle.color).not.toBe(descriptionStyle.color);
  expect(extensionStyle.backgroundColor).not.toBe(
    descriptionStyle.backgroundColor,
  );
  expect(extensionStyle.fontWeight).toBeGreaterThan(
    descriptionStyle.fontWeight,
  );
  expect(extensionStyle.borderTopWidth).toBeGreaterThan(0);

  const noDescOption = page
    .getByRole('option')
    .filter({ hasText: `/${noDescSkill}` });
  await expect(noDescOption).toBeVisible();
  await expect(noDescOption).not.toContainText(extension);
  await noDescOption.hover();
  await expect(detail.getByText(noDescSkill, { exact: true })).toBeVisible();
  await expect(detail.getByText(extension, { exact: true })).toBeVisible();
});
