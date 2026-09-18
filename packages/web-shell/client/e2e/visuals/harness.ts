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
import { FIXED_CAPTURE_TIME, VISUAL_VIEWPORT } from './constants';

export type VisualTheme = 'dark' | 'light';

export { FIXED_CAPTURE_TIME, VISUAL_VIEWPORT };

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

/**
 * Pin the page clock so anything rendering a wall-clock time is byte-identical
 * across the base and head capture passes.
 *
 * Those two passes run minutes apart inside the SAME job -- the base render
 * waits on its own `npm install` first -- so every timestamped view differed on
 * every run purely because of when it was photographed. On PR #11267 that was
 * the entire preview: the one view the compose step flagged as CHANGED,
 * `terminal-turn-error-copy-narrow-dark`, scored exactly 0.02% (the threshold)
 * and the whole diff was a `09:09:28` tip against a `09:18:16` one.
 *
 * What `setFixedTime` actually installs is Playwright's FULL fake clock, not a
 * `Date`-only shim: `setTimeout`, `setInterval`, `requestAnimationFrame`,
 * `requestIdleCallback`, `performance` and `Intl` are all replaced. Timers and
 * rAF keep firing, so replay, streaming and `freezeLoopingAnimations` behave
 * normally in outcome -- but two things do change and will cost a debugging
 * session if they are not written down:
 *
 * - `performance.mark`/`measure` return throwaway entries and `getEntries()`
 *   comes back empty, so a capture can never observe a measure-storm.
 * - Every `Date.now()`-delta window in the app is pinned permanently shut:
 *   background-agent grace misses, catalog staleness, retry backoff, live-state
 *   reconcile throttling. Nothing seeds those states today, so nothing fails --
 *   but a scenario that needs one to elapse will hang inside `gotoSession` and
 *   surface as a bare expect timeout. Such a scenario must seed already-expired
 *   timestamps or drive `page.clock.fastForward` / `runFor` itself.
 *
 * `visual-capture-contracts.test.ts` pins that every navigation helper still
 * calls this before `page.goto`; nothing in the visuals suite reads the clock,
 * so a dropped call would otherwise stay green.
 */
export async function freezeWallClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(FIXED_CAPTURE_TIME);
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
  /**
   * Extra query parameters for views the app addresses by URL rather than by
   * click — `{ view: 'cockpit' }` opens the Session Workflow dependency
   * canvas. Kept here so the URL shape, the theme priming and the theme
   * assertion stay in one place instead of being re-implemented per spec.
   */
  search: Readonly<Record<string, string>> = {},
): Promise<void> {
  await primeTheme(page, theme);
  await freezeWallClock(page);
  const query = new URLSearchParams({ theme, ...search });
  await page.goto(
    `/session/${encodeURIComponent(scenario.sessionId)}?${query.toString()}`,
  );
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
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
  await freezeWallClock(page);
  await page.goto(`/?theme=${theme}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
}

/**
 * Navigate to the settings harness page, which maps `?exclude=` onto the
 * shell's `settings` prop — the standalone entry never passes one, so the
 * host-exclusion scenarios can only render through that page. Freezes the
 * clock before navigating like every other helper; the theme assertion keys
 * on the shell's own surface because the harness paints the `<html>` theme
 * class from the same `?theme=` param, where it cannot mislabel.
 */
export async function gotoSettingsHarness(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
  theme: VisualTheme,
  exclude: readonly string[] = [],
): Promise<void> {
  await freezeWallClock(page);
  const params = new URLSearchParams({ theme, sessionId: scenario.sessionId });
  if (exclude.length > 0) params.set('exclude', exclude.join(','));
  await page.goto(`/e2e/settings-harness.html?${params.toString()}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  // The shell's own theme must agree with the filename: the app root carries
  // a plain `dark` literal only in the dark theme. The last bare root is the
  // app; the session provider's loading placeholder is also a bare
  // [data-web-shell-root].
  const rootClass = await page
    .locator('[data-web-shell-root]:not([data-web-shell-gate])')
    .last()
    .getAttribute('class');
  expect(rootClass?.split(/\s+/).includes('dark')).toBe(theme === 'dark');
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
 * Drop focus from whatever holds it. Which element is focused is part of what a
 * capture shows — Chrome paints a `:focus-visible` ring around it — and a
 * scenario that does not drive focus itself inherits whatever the app happened
 * to autofocus. The cockpit focuses its back button on mount
 * (`SessionWorkflowCockpit.tsx`), and whether the UA draws a ring for a
 * *programmatic* `.focus()` is a heuristic, so one unchanged tree rendered both
 * ways: across five captures the ring appeared in three of the five light
 * renders and three of the five dark ones, and every appearance flipped
 * `session-workflow-cockpit-*` to CHANGED at 0.05% — 2.5× the threshold, with
 * all 499 differing pixels inside the ring's own box and the button's border
 * and label byte-identical (#11465). `blur()` moves focus to `<body>`, which
 * matches no focus selector, so no ring can be painted.
 *
 * Deliberately NOT called from `captureScreenshot`: several captures are of a
 * focused state on purpose, and blurring all of them moved 11 of 68 views —
 * `slash-menu-dark` by 30.1%, since its menu is open *because* the composer has
 * focus. Scenarios whose focus is ambient rather than the subject call this
 * themselves, before `captureScreenshot`.
 */
export async function clearFocus(page: Page): Promise<void> {
  await page.evaluate(
    /* global document */
    () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
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
