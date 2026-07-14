/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from '../utils/mockDaemon';

export type VisualTheme = 'dark' | 'light';

/** Fixed viewport so captures have a stable layout/size run to run. */
export const VISUAL_VIEWPORT = { width: 1280, height: 800 } as const;

/** localStorage key the web-shell reads for its persisted theme (see index.html). */
const THEME_STORAGE_KEY = 'qwen-code-web-shell-theme';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Root the capture pipeline collects. The CI job points
 * WEB_SHELL_VISUALS_OUTPUT_DIR at a temp dir; locally it defaults next to the
 * spec so `npm run test:e2e:visuals` drops artifacts under the package.
 */
export const VISUALS_OUTPUT_DIR = process.env['WEB_SHELL_VISUALS_OUTPUT_DIR']
  ? resolve(process.env['WEB_SHELL_VISUALS_OUTPUT_DIR'])
  : join(HERE, 'output');

export const SCREENSHOTS_DIR = join(VISUALS_OUTPUT_DIR, 'screenshots');
export const VIDEO_DIR = join(VISUALS_OUTPUT_DIR, 'video');
/** Playwright writes raw per-context videos here before we save them by name. */
const VIDEO_RAW_DIR = join(VISUALS_OUTPUT_DIR, 'video-raw');

/**
 * Force a theme deterministically: seed localStorage before any app code runs,
 * then navigate with `?theme=`. `getInitialTheme()` consumes the query param on
 * load (main.tsx strips it afterwards), and the localStorage seed is the
 * belt-and-suspenders fallback if the app ever re-reads.
 */
async function primeTheme(page: Page, theme: VisualTheme): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Private-mode / storage-disabled: the ?theme= param still applies.
      }
    },
    [THEME_STORAGE_KEY, theme] as const,
  );
}

export function resolveBaseURL(testInfo: TestInfo): string {
  const value = testInfo.project.use.baseURL;
  if (!value)
    throw new Error('Expected a Playwright baseURL to be configured.');
  return value;
}

export async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  baseURL: string,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, { baseURL });
}

/**
 * Navigate to a session in the requested theme and wait for the replayed
 * transcript to settle. Asserts the theme actually took effect so a
 * mislabelled light/dark capture fails loudly instead of shipping silently.
 */
export async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
  theme: VisualTheme,
): Promise<void> {
  await primeTheme(page, theme);
  await page.goto(
    `/session/${encodeURIComponent(scenario.sessionId)}?theme=${theme}`,
  );
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
}

export async function completeReplay(
  page: Page,
  daemon: MockDaemonController,
  sessionId?: string,
  replayedCount = 0,
): Promise<void> {
  const connection = await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

export async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
}

export async function submitLocalCommand(
  page: Page,
  text: string,
): Promise<void> {
  await fillComposer(page, text);
  await page.locator('[data-web-shell-composer-submit]').click();
}

/** Capture the current viewport to `<output>/screenshots/<name>.png`. */
export async function captureScreenshot(
  page: Page,
  name: string,
): Promise<void> {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: join(SCREENSHOTS_DIR, `${name}.png`),
    animations: 'disabled',
  });
}

/**
 * Record a continuous flow to `<output>/video/<name>.webm`. A dedicated
 * browser context owns the video lifecycle so the file can be saved under a
 * stable name (the CI job converts it to an inline GIF).
 */
export async function recordFlow(
  browser: Browser,
  baseURL: string,
  name: string,
  drive: (page: Page) => Promise<void>,
): Promise<void> {
  mkdirSync(VIDEO_DIR, { recursive: true });
  mkdirSync(VIDEO_RAW_DIR, { recursive: true });
  const context: BrowserContext = await browser.newContext({
    baseURL,
    viewport: { ...VISUAL_VIEWPORT },
    recordVideo: { dir: VIDEO_RAW_DIR, size: { ...VISUAL_VIEWPORT } },
  });
  let page: Page | undefined;
  let driveError: unknown;
  try {
    page = await context.newPage();
    await drive(page);
  } catch (error) {
    driveError = error;
  } finally {
    try {
      await context.close();
    } catch {
      // Best-effort close (the browser may have crashed mid-drive); preserve
      // driveError for the re-throw below instead of masking it here.
    }
  }
  const video = page?.video();
  if (video) {
    try {
      await video.saveAs(join(VIDEO_DIR, `${name}.webm`));
      await video.delete(); // drop the hash-named raw copy; keep only the named one
    } catch {
      // Best-effort video capture; if `drive` failed the video may never have
      // finalized — don't let that I/O error mask the real drive failure below.
    }
  }
  if (driveError) throw driveError;
}

/** A short, human-readable pause so a recorded flow is legible as a GIF. */
export async function beat(page: Page, ms = 650): Promise<void> {
  await page.waitForTimeout(ms);
}
