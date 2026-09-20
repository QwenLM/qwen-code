import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { DaemonWorkspaceSettingsStatus } from '@qwen-code/sdk/daemon';
import { WEB_SHELL_SETTING_ITEM_IDS } from '../settings';
import { createWebShellDaemonScenario } from './utils/mockDaemon';
import {
  completeReplay,
  installScenario,
  resolveBaseURL,
  submitLocalCommand,
} from './visuals/harness';

test('live daemon settings honor host inclusion and exclusion lists @smoke', async ({
  page,
}, testInfo) => {
  test.skip(process.platform === 'win32', 'Daemon harness requires POSIX');
  const directory = await mkdtemp(join(tmpdir(), 'qwen-settings-exclusions-'));
  const token = 'settings-exclusions-test';
  const daemon = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../../cli/dist/index.js', import.meta.url)),
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--token',
      token,
      '--workspace',
      directory,
    ],
    {
      env: {
        ...process.env,
        QWEN_HOME: join(directory, 'config'),
        QWEN_RUNTIME_DIR: join(directory, 'runtime'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  daemon.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  daemon.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let spawnError: Error | undefined;
  daemon.on('error', (error) => {
    spawnError = error;
  });
  try {
    await expect
      .poll(
        () => {
          if (spawnError) throw spawnError;
          if (daemon.exitCode !== null) throw new Error(output);
          return output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1];
    const response = await fetch(
      `http://127.0.0.1:${port}/workspace/settings`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    expect(response.status).toBe(200);
    const settings = (await response.json()) as DaemonWorkspaceSettingsStatus;
    expect(settings.settings.some(({ key }) => key === 'omni.enabled')).toBe(
      true,
    );

    // Use live descriptors with the existing browser harness: no copied schema
    // or hidden-key list can drift independently from the daemon and page.
    const scenario = createWebShellDaemonScenario({ settings });
    const mock = await installScenario(
      page,
      scenario,
      resolveBaseURL(testInfo),
    );
    await page.route('**/workspace/models', (route) =>
      route.fulfill({ json: { models: [] } }),
    );
    await page.route('**/live/setup', (route) =>
      route.fulfill({
        status: 404,
        json: { error: 'not available in fixture' },
      }),
    );
    const cases = [
      { name: 'default', exclude: '', empty: false },
      {
        name: 'exclude-all',
        exclude: WEB_SHELL_SETTING_ITEM_IDS.join(','),
        empty: true,
      },
      {
        name: 'allowlist-desktop',
        include: 'setting:language,builtin:chat-width',
        empty: false,
      },
      { name: 'empty-allowlist', include: '', empty: true },
      {
        name: 'conflict',
        include: 'setting:language,builtin:chat-width',
        exclude: 'setting:language',
        empty: false,
      },
      {
        name: 'allowlist-mobile',
        include: 'setting:language,builtin:chat-width',
        empty: false,
        mobile: true,
      },
    ];
    for (const scenarioCase of cases) {
      await page.setViewportSize(
        scenarioCase.mobile
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
      );
      const params = new URLSearchParams({ sessionId: scenario.sessionId });
      if (scenarioCase.include !== undefined) {
        params.set('include', scenarioCase.include);
      }
      if (scenarioCase.exclude !== undefined) {
        params.set('exclude', scenarioCase.exclude);
      }
      const loaded = page.waitForResponse(
        (res) =>
          res.url().endsWith('/workspace/settings') &&
          res.request().method() === 'GET',
      );
      await page.goto(`/e2e/settings-harness.html?${params}`);
      await completeReplay(
        page,
        mock,
        scenario.sessionId,
        scenario.events.length,
      );
      await submitLocalCommand(page, '/settings');
      await loaded;
      const nav = page.getByRole('navigation', { name: 'Settings' });
      for (const scope of ['Workspace', 'User']) {
        await page.getByRole('tab', { name: scope, exact: true }).click();
        if (scenarioCase.name === 'default') {
          await nav.getByRole('button', { name: /^Experimental/ }).click();
          await expect(
            page.getByText('Enable Omni Media Delivery', { exact: true }),
          ).toBeVisible();
        } else if (scenarioCase.empty) {
          await expect(nav.getByRole('button')).toHaveCount(0);
          await expect(page.locator('[data-slot="empty"]')).toBeVisible();
        } else {
          const languageIncluded = scenarioCase.name !== 'conflict';
          await expect(nav.getByRole('button')).toHaveCount(
            languageIncluded ? 2 : 1,
          );
          if (languageIncluded) {
            await nav.getByRole('button', { name: /^General/ }).click();
            await expect(
              page.getByText('Language: UI', { exact: true }),
            ).toBeVisible();
            await expect(page.getByRole('combobox')).toHaveCount(1);
          } else {
            await expect(
              nav.getByRole('button', { name: /^General/ }),
            ).toHaveCount(0);
          }
          await nav.getByRole('button', { name: /^UI/ }).click();
          await expect(
            page.getByText('Chat width', { exact: true }),
          ).toBeVisible();
          await expect(page.getByRole('combobox')).toHaveCount(1);
          await expect(
            page.getByText('Browser task notifications', { exact: true }),
          ).toHaveCount(0);
        }
      }
      if (scenarioCase.name === 'default') {
        await nav.getByRole('button', { name: /^UI/ }).click();
        await expect(
          page.getByText('Chat width', { exact: true }),
        ).toBeVisible();
      }
      if (
        scenarioCase.name === 'default' ||
        scenarioCase.name === 'allowlist-desktop' ||
        scenarioCase.name === 'allowlist-mobile' ||
        scenarioCase.name === 'empty-allowlist'
      ) {
        await page.screenshot({
          path: testInfo.outputPath(`${scenarioCase.name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
    }
  } finally {
    if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      daemon.kill('SIGTERM');
      const timeout = setTimeout(() => daemon.kill('SIGKILL'), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
