import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

// What jsdom cannot see of the Plan chip: the cascade that decides whether its
// close mark shows, and focus actually landing in the editor, which the unit
// suite only sees as a call on a mocked `focus`. The unit tests pin the
// stylesheet's shape and those calls; these pin the rendered result.

const CHIP = '[data-web-shell-plan-chip]';
const MARK = `${CHIP} [class*="planChipClose"]`;
const ICON = `${CHIP} [class*="planChipIcon"] > :not([class*="planChipClose"])`;
const EDITOR = '[data-web-shell-composer-editor] .cm-content';

test('@smoke shows the close mark in place of the icon only on hover or keyboard focus', async ({
  page,
}, testInfo) => {
  await gotoPlanningSession(page, testInfo);
  const chip = page.locator(CHIP);
  const width = async () => (await chip.boundingBox())!.width;
  const expectShown = async (mark: boolean) => {
    await expect(page.locator(MARK)).toHaveCSS('opacity', mark ? '1' : '0');
    await expect(page.locator(ICON)).toHaveCSS('opacity', mark ? '0' : '1');
  };

  await page.mouse.move(0, 0);
  await expectShown(false);
  const atRest = await width();

  await chip.hover();
  await expectShown(true);
  // The mark takes over the icon slot, so the controls beside the chip stay
  // where they were.
  expect(await width()).toBe(atRest);

  await page.mouse.move(0, 0);
  await expectShown(false);
  // Reached by keyboard, which is what makes the focus a visible one.
  await page.locator('[data-web-shell-mode-button]').focus();
  await page.keyboard.press('Tab');
  await expect(chip).toBeFocused();
  await expectShown(true);
});

test('@smoke hands keyboard focus to the input when Plan ends under a focused chip', async ({
  page,
}, testInfo) => {
  const { daemon, scenario } = await gotoPlanningSession(page, testInfo);
  const chip = page.locator(CHIP);
  await chip.focus();
  await expect(chip).toBeFocused();

  // The host reports the mode, so Plan can end with no click on the chip: a
  // plan approved elsewhere, or another client changing the mode.
  await daemon.sendEvent({
    id: 20,
    v: 1,
    type: 'approval_mode_changed',
    data: {
      sessionId: scenario.sessionId,
      previous: 'plan',
      next: 'default',
      persisted: false,
    },
  });

  await expect(chip).toHaveCount(0);
  // Left alone, focus falls to the body and the next Tab restarts at the top
  // of the page.
  await expect(page.locator(EDITOR)).toBeFocused();
});

test('@smoke keeps tint, close mark, and focus on the chip while its own request is in flight', async ({
  page,
}, testInfo) => {
  await gotoPlanningSession(page, testInfo);
  // The busy state lasts exactly as long as the mode change the click starts,
  // so hold that request: without it the browser would settle before the
  // assertions below could see the state they exist to pin.
  let releaseModeChange!: () => void;
  const modeChangeHeld = new Promise<void>((resolve) => {
    releaseModeChange = resolve;
  });
  await page.route('**/session/*/approval-mode', async (route) => {
    await modeChangeHeld;
    await route.fallback();
  });
  const chip = page.locator(CHIP);
  const width = async () => (await chip.boundingBox())!.width;
  const background = async () =>
    chip.evaluate((element) => getComputedStyle(element).backgroundColor);

  try {
    // The click leaves the pointer on the chip and hands focus to the input,
    // as it does for every composer control. The chip stays reachable while
    // busy, so a keyboard user can land on it mid-request.
    await chip.click();
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    // Inert, never natively disabled — toBeDisabled follows aria-disabled,
    // so the native attribute needs the JS property.
    await expect(chip).toHaveJSProperty('disabled', false);
    await chip.focus();
    await expect(chip).toBeFocused();
    await expect(page.locator(MARK)).toHaveCSS('opacity', '1');
    await expect(page.locator(ICON)).toHaveCSS('opacity', '0');
    const hoveredWidth = await width();
    const hoveredBackground = await background();

    await page.mouse.move(0, 0);
    await expect(page.locator(MARK)).toHaveCSS('opacity', '0');
    expect(await width()).toBe(hoveredWidth);
    // The tint must not drop under the pointer mid-request: it only survives
    // because the chip is never natively disabled, so `:not(:disabled):hover`
    // keeps matching while the request the click started is in flight.
    const restBackground = await background();
    expect(restBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(hoveredBackground).not.toBe(restBackground);

    await chip.hover();
    await expect(page.locator(MARK)).toHaveCSS('opacity', '1');
    expect(await background()).toBe(hoveredBackground);
  } finally {
    releaseModeChange();
  }
});

async function gotoPlanningSession(
  page: Page,
  testInfo: TestInfo,
): Promise<{ daemon: MockDaemonController; scenario: WebShellDaemonScenario }> {
  const scenario = createWebShellDaemonScenario({ currentMode: 'plan' });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId, replayedCount: 0 }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
  await expect(page.locator(CHIP)).toBeVisible();
  return { daemon, scenario };
}
