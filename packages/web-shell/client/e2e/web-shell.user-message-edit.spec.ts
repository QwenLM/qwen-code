import { expect, test, type Locator } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';
const EDITOR_PREFERRED_WIDTH = 420;

async function expectEditorInsideBubble(bubble: Locator, width: number) {
  await expect
    .poll(
      () =>
        bubble.evaluate((element) => {
          const bubbleRect = element.getBoundingClientRect();
          return Math.max(
            -bubbleRect.left,
            bubbleRect.right - window.innerWidth,
            ...Array.from(element.querySelectorAll('textarea, button')).flatMap(
              (control) => {
                const rect = control.getBoundingClientRect();
                return [
                  bubbleRect.left - rect.left,
                  rect.right - bubbleRect.right,
                ];
              },
            ),
          );
        }),
      { message: `px of editor/viewport overflow at ${width}px viewport` },
    )
    .toBeLessThanOrEqual(1);
}

test('message editor stays inside its bubble while resizing @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 850 });
  // Pin the sidebar to its default width: the 800px step only exercises the
  // shrink-to-fit clamp while the sidebar leaves the bubble narrower than
  // the editor's preferred width.
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [SIDEBAR_WIDTH_STORAGE_KEY, '260'] as const,
  );
  const original =
    'Where is this view saved, and is it automatically cleaned up?';
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent(original, { id: 1 }),
      assistantTextEvent('The view is saved in your workspace.', { id: 2 }),
      turnCompleteEvent('prompt-edit-layout', { id: 3 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}?lang=en`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  const bubble = page.locator('[data-web-shell-user-bubble]');
  const editor = bubble.getByRole('textbox', { name: 'Edit message' });
  await editor.fill('Updated question');

  for (const width of [800, 390, 1440]) {
    await test.step(`viewport ${width}px`, async () => {
      await page.setViewportSize({ width, height: 850 });
      await expect(editor).toHaveValue('Updated question');
      await expectEditorInsideBubble(bubble, width);
      if (width === 800) {
        // Witnesses that the clamp actually engages at this width; a layout
        // change that stops exercising it fails loudly here instead of
        // leaving the overflow poll above vacuous.
        await expect
          .poll(() => editor.evaluate((el) => el.getBoundingClientRect().width))
          .toBeLessThan(EDITOR_PREFERRED_WIDTH);
      }
      if (width === 1440) {
        await expect(editor).toHaveCSS('width', `${EDITOR_PREFERRED_WIDTH}px`);
      }
      await expect(
        bubble.getByRole('button', { name: 'Send', exact: true }),
      ).toBeEnabled();
    });
  }

  await bubble.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(bubble).toHaveText(original);
});
