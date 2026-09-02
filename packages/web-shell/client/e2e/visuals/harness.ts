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
import { VISUAL_VIEWPORT } from './constants';

export type VisualTheme = 'dark' | 'light';

export { VISUAL_VIEWPORT };

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

/**
 * Navigate to the new-session empty state (`/`) in the requested theme. Every
 * other scenario lands on `/session/:id` via `gotoSession`, so without this the
 * suite never renders the empty state at all — anything that lives only there
 * (the onboarding copy, the worktree-isolation toggle) is invisible to the
 * before/after preview. Asserts the theme took effect, same as `gotoSession`;
 * there is no replay to settle because no session is loaded.
 */
export async function gotoNewSession(
  page: Page,
  theme: VisualTheme,
): Promise<void> {
  await primeTheme(page, theme);
  await page.goto(`/?theme=${theme}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
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
  await freezeLoopingAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOTS_DIR, `${name}.png`),
    animations: 'disabled',
  });
}

/**
 * Pin looping animations to their first frame before a capture. Playwright's
 * `animations: 'disabled'` settles finite animations and is meant to reset
 * infinite ones, but a GPU-composited transform loop — e.g. the sidebar's
 * rotating activity spinner — is still captured mid-rotation at a random angle.
 * That angle differs between the base and head render passes, so the view reads
 * as "changed" against the 0.02% before/after threshold even when nothing did.
 * Pausing the infinite Web Animations and rewinding them to time 0 pins them to
 * a deterministic frame (verified: sidebar-attention drops from ~0.12% of pixels
 * differing between identical renders to 0); a two-frame wait lets the compositor
 * commit that frame before the capture reads it.
 *
 * Scope: this covers WAAPI and CSS `@keyframes` animations — everything
 * `document.getAnimations()` reports. A spinner hand-rolled on a
 * `requestAnimationFrame` loop instead would NOT be caught, and the flake would
 * silently return; if a spinner reimplementation ever reintroduces it, this is
 * the function to extend. `harness.spec.ts` pins the pause/rewind contract.
 */
export async function freezeLoopingAnimations(page: Page): Promise<void> {
  await page.evaluate(
    /* global document, requestAnimationFrame */
    async () => {
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getTiming().iterations === Infinity) {
          animation.pause();
          animation.currentTime = 0;
        }
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
  );
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
  // Track failure with an explicit boolean, not the truthiness of the caught
  // value: `throw undefined` / `throw null` / `Promise.reject()` must still mark
  // the flow failed (otherwise an aborted flow would look passed).
  let driveFailed = false;
  let driveError: unknown;
  try {
    page = await context.newPage();
    await drive(page);
  } catch (error) {
    driveFailed = true;
    driveError = error;
  } finally {
    try {
      await context.close();
    } catch (closeError) {
      // If the drive already failed, keep that original error (the close error
      // is secondary). But if the drive SUCCEEDED, a close failure is a real
      // problem (it can also leave the video unfinalized) — promote it so the
      // flow fails instead of masking it.
      if (!driveFailed) {
        driveFailed = true;
        driveError = closeError;
      }
    }
  }

  const video = page?.video();
  if (driveFailed) {
    // The flow errored — discard the partial recording rather than publishing a
    // meaningless "failed flow" video into the artifact.
    await video?.delete().catch(() => {});
    throw driveError;
  }

  // Drive succeeded, so the recording IS the deliverable: let a save failure or
  // a missing recording FAIL the flow (a silent pass with no .webm makes the
  // downstream GIF-conversion step fail confusingly). Deleting the raw copy is
  // best-effort.
  if (!video) {
    throw new Error(
      `No video recorded for flow "${name}" — recording did not start.`,
    );
  }
  await video.saveAs(join(VIDEO_DIR, `${name}.webm`));
  await video.delete().catch(() => {});
}

/** A short, human-readable pause so a recorded flow is legible as a GIF. */
export async function beat(page: Page, ms = 650): Promise<void> {
  await page.waitForTimeout(ms);
}
