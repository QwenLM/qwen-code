import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
  type Frame,
} from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../..');
const workspacePath = path.resolve(__dirname, '../../test/fixtures/workspace');
const createTempDir = (suffix: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `qwen-code-vscode-${suffix}-`));
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const resolveVSCodeExecutablePath = async (): Promise<string> => {
  if (process.env.VSCODE_EXECUTABLE_PATH) {
    return process.env.VSCODE_EXECUTABLE_PATH;
  }
  if (process.platform === 'darwin') {
    const defaultPath =
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
  }
  return downloadAndUnzipVSCode();
};

const getCommandPaletteShortcut = () =>
  process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';
const getQuickOpenShortcut = () =>
  process.platform === 'darwin' ? 'Meta+P' : 'Control+P';

export const test = base.extend<{
  electronApp: ElectronApplication;
  page: Page;
}>({
  electronApp: async ({}, use: (r: ElectronApplication) => Promise<void>) => {
    const executablePath = await resolveVSCodeExecutablePath();
    const userDataDir = createTempDir('user-data');
    const extensionsDir = createTempDir('extensions');
    const electronApp = await _electron.launch({
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        `--extensionDevelopmentPath=${extensionPath}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--new-window',
        workspacePath,
      ],
    });

    await use(electronApp);
    try {
      await withTimeout(electronApp.evaluate(({ app }) => app.quit()), 3_000);
    } catch {
      // Ignore if the app is already closed or evaluate fails.
    }
    try {
      await withTimeout(electronApp.context().close(), 5_000);
    } catch {
      // Ignore context close errors.
    }
    try {
      await withTimeout(electronApp.close(), 10_000);
    } catch {
      try {
        await withTimeout(electronApp.kill(), 5_000);
      } catch {
        const process = electronApp.process();
        if (process && !process.killed) {
          process.kill('SIGKILL');
        }
      }
    }
  },
  page: async ({ electronApp }: { electronApp: ElectronApplication }, use: (r: Page) => Promise<void>) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
    await page.close().catch(() => undefined);
  },
});

export { expect };

export const waitForWebviewReady = async (page: Page) => {
  await page.waitForSelector('iframe.webview', {
    state: 'visible',
    timeout: 60_000,
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        continue;
      }
      const url = frame.url();
      if (!url.startsWith('vscode-webview://')) {
        continue;
      }
      try {
        const hasRoot = await frame.evaluate(
          () => Boolean(document.querySelector('#root')),
        );
        if (hasRoot) {
          return frame;
        }
      } catch {
        // Ignore detached/cross-origin frames during probing.
      }
    }
    await page.waitForTimeout(500);
  }

  const frameUrls = page.frames().map((frame) => frame.url());
  throw new Error(
    `Qwen Code webview not ready. Frames: ${frameUrls.join(', ')}`,
  );
};

export const runCommand = async (page: Page, command: string) => {
  const input = page.locator('.quick-input-widget input');
  await page.locator('.monaco-workbench').waitFor();
  await page.click('.monaco-workbench');
  await page.keyboard.press('Escape').catch(() => undefined);

  const openInput = async (shortcut: string) => {
    await page.keyboard.press(shortcut);
    return input.waitFor({ state: 'visible', timeout: 2_000 }).then(
      () => true,
      () => false,
    );
  };

  const commandRow = page
    .locator('.quick-input-list .monaco-list-row', { hasText: command })
    .first();

  const tryCommand = async (shortcut: string, query: string) => {
    const opened = await openInput(shortcut);
    if (!opened) {
      return false;
    }

    await input.fill(query);
    const found = await commandRow
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(
        () => true,
        () => false,
      );

    if (found) {
      await commandRow.click();
      await input.waitFor({ state: 'hidden' }).catch(() => undefined);
      return true;
    }

    await page.keyboard.press('Escape').catch(() => undefined);
    return false;
  };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await tryCommand(getQuickOpenShortcut(), `>${command}`)) {
      return;
    }
    if (await tryCommand(getCommandPaletteShortcut(), command)) {
      return;
    }
    if (await tryCommand('F1', command)) {
      return;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(`Command not available yet: ${command}`);
};

export const dispatchWebviewMessage = async (
  webview: Frame,
  payload: unknown,
) => {
  await webview.evaluate((message: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  }, payload);
};
