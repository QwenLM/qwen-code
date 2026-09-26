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
// The `60vw` arm of the editor's `width: min(420px, 60vw)`.
const EDITOR_VIEWPORT_FRACTION = 0.6;

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

  // Each step carries the width oracle for its own viewport, so retuning the
  // sweep moves the guards with it instead of orphaning bare-literal checks.
  const measureEditorWidth = () =>
    editor.evaluate((el) => el.getBoundingClientRect().width);
  const widthSteps: ReadonlyArray<{
    viewport: number;
    expectEditorWidth: (viewport: number) => Promise<void>;
  }> = [
    {
      // Sidebar pinned inline: the bubble content box is narrower than the
      // editor's preferred width here, so the shrink-to-fit clamp must
      // engage; otherwise the containment poll would pass vacuously.
      viewport: 800,
      expectEditorWidth: () =>
        expect.poll(measureEditorWidth).toBeLessThan(EDITOR_PREFERRED_WIDTH),
    },
    {
      // Sidebar out of layout: only the 60vw arm of the editor's
      // `width: min(420px, 60vw)` sets the width at this viewport.
      viewport: 390,
      expectEditorWidth: (viewport) =>
        expect
          .poll(measureEditorWidth)
          .toBeCloseTo(viewport * EDITOR_VIEWPORT_FRACTION, -1),
    },
    {
      viewport: 1440,
      expectEditorWidth: () =>
        expect(editor).toHaveCSS('width', `${EDITOR_PREFERRED_WIDTH}px`),
    },
  ];

  for (const step of widthSteps) {
    await test.step(`viewport ${step.viewport}px`, async () => {
      await page.setViewportSize({ width: step.viewport, height: 850 });
      await expect(editor).toHaveValue('Updated question');
      await expectEditorInsideBubble(bubble, step.viewport);
      await step.expectEditorWidth(step.viewport);
      await expect(
        bubble.getByRole('button', { name: 'Send', exact: true }),
      ).toBeEnabled();
    });
  }

  await bubble.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(bubble).toHaveText(original);
});
