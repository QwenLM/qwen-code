import {
  devices,
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk';
import {
  spawnDaemon,
  type SpawnedDaemon,
} from '../../../../integration-tests/cli/_daemon-harness.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const token = 'shared-input-history-test';
const editorSelector =
  '[data-web-shell-composer-editor] .cm-content, textarea[data-web-shell-composer-editor]';
let daemon: SpawnedDaemon;
let root: string;
let workspace: string;

// Only the ACP model child is replaced; HTTP, SSE and history files are real.
test.skip(process.platform === 'win32', 'Daemon harness requires POSIX');
test.setTimeout(120_000);

test.beforeAll(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'qwen-shared-input-history-')),
  );
  workspace = join(root, 'workspace');
  const home = join(root, 'home');
  await Promise.all([
    mkdir(join(workspace, '.qwen'), { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  const settings = JSON.stringify({
    security: { folderTrust: { enabled: true } },
  });
  await Promise.all([
    writeFile(join(workspace, '.qwen', 'settings.json'), settings),
    writeFile(join(home, 'settings.json'), settings),
  ]);
  daemon = await spawnDaemon({
    workspaceCwd: workspace,
    token,
    cliBin: join(repoRoot, 'dist/cli.js'),
    bootTimeoutMs: 30_000,
    extraArgs: [
      '--enable-session-shell',
      '--allow-origin',
      process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://127.0.0.1:5174',
    ],
    envDrop: [/^QWEN_/, /^OPENAI_/, /^ANTHROPIC_/, /^AWS_/],
    env: {
      HOME: home,
      QWEN_HOME: home,
      QWEN_RUNTIME_DIR: join(root, 'runtime'),
      QWEN_CLI_ENTRY: join(
        repoRoot,
        'integration-tests/fixtures/mock-acp-child/agent.mjs',
      ),
      MOCK_ACP_PROMPT_DELAY_MS: '500',
    },
  });
  await daemon.client.grantWorkspaceTrust();
});

test.afterAll(async () => {
  await daemon?.dispose();
  await rm(root, { recursive: true, force: true });
});

const editor = (page: Page) => page.locator(editorSelector).first();

async function expectEditorText(locator: Locator, text: string) {
  await expect
    .poll(() =>
      locator.evaluate((element) =>
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
          ? element.value
          : element.textContent,
      ),
    )
    .toBe(text);
}

async function writeDraft(page: Page, text: string) {
  await editor(page).click();
  await editor(page).press('ControlOrMeta+A');
  await editor(page).pressSequentially(text);
}

async function submit(page: Page, text: string) {
  const admitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/prompt'),
  );
  await writeDraft(page, text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await admitted;
  expect([200, 202]).toContain(response.status());
  await expect(response.json()).resolves.toMatchObject({
    promptId: expect.any(String),
  });
}

test('refreshes an open mobile history from another desktop client @smoke', async ({
  browser,
  baseURL,
}) => {
  const client = await DaemonSessionClient.createOrAttach(
    new DaemonClient({ baseUrl: daemon.base, token }),
    { workspaceCwd: workspace },
    'desktop-sdk-client',
  );
  expect((await client.shellCommand('printf desktop-shell')).exitCode).toBe(0);
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
  });
  const mobile = await context.newPage();
  await mobile.addInitScript(() => {
    localStorage.setItem(
      'qwen-web-shell-history',
      JSON.stringify(['local-only-pending']),
    );
  });
  const harnessUrl = (clientId: string) => {
    const params = new URLSearchParams({
      daemon: daemon.base,
      token,
      sessionId: client.sessionId,
      clientId,
      cwd: workspace,
    });
    return `${baseURL}/e2e/live-input-history-harness.html?${params}`;
  };
  await mobile.goto(harnessUrl('browser-mobile'));
  await expect(editor(mobile)).toBeEditable();
  await writeDraft(mobile, 'draft-not-submitted');
  await mobile.getByRole('button', { name: 'Add to message' }).click();
  await mobile.getByRole('button', { name: 'Input history' }).click();
  const historyPanel = mobile
    .locator('[data-web-shell-composer-history-search]')
    .locator('..')
    .locator('..');
  const historyEntries = historyPanel.locator('button:has(span)');
  await expect(historyEntries).toHaveCount(1);
  await expect(historyPanel).toContainText('local-only-pending');

  const desktop = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await desktop.goto(harnessUrl('browser-desktop'));
  await expect(editor(desktop)).toBeEditable();
  await submit(desktop, 'desktop-original');
  await expect
    .poll(() =>
      historyEntries.locator(':scope > span:nth-child(2)').allTextContents(),
    )
    .toEqual(['desktop-original', 'local-only-pending']);
  await submit(desktop, 'desktop-followup');
  await expect
    .poll(() =>
      historyEntries.locator(':scope > span:nth-child(2)').allTextContents(),
    )
    .toEqual(['desktop-followup', 'desktop-original', 'local-only-pending']);

  await historyPanel
    .getByRole('button', { name: 'close', exact: true })
    .click();
  await expectEditorText(editor(mobile), 'draft-not-submitted');
  const persisted = await fetch(`${daemon.base}/workspace/input-history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(persisted.status).toBe(200);
  await expect(persisted.json()).resolves.toMatchObject({
    entries: ['desktop-original', 'desktop-followup'],
  });
  await context.close();
});
