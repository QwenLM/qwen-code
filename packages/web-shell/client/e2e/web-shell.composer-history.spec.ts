import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const EDITOR = '[data-web-shell-composer-editor] .cm-content';
const paragraph =
  'Keep this unsent paragraph while moving the caret between visual rows. '.repeat(
    8,
  );
const history = [`Older prompt: ${paragraph}`, `Newest prompt: ${paragraph}`];

async function openSession(page: Page, baseURL: string) {
  await page.addInitScript((entries) => {
    localStorage.setItem('qwen-web-shell-history', JSON.stringify(entries));
  }, history);
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  const editor = page.locator(EDITOR);
  await expect(editor).toBeEditable();
  return editor;
}

async function caretOffset(editor: Locator) {
  return editor.evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.focusNode || !element.contains(selection.focusNode)) {
      throw new Error('The caret must remain in the composer');
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString().length;
  });
}

async function expectWrapped(editor: Locator) {
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
        return Array.from(element.querySelectorAll('.cm-line')).some(
          (line) => line.getBoundingClientRect().height > lineHeight * 2,
        );
      }),
    )
    .toBe(true);
}

for (const [name, draft] of [
  ['single paragraph', paragraph],
  ['explicit multiline draft with wrapped lines', `${paragraph}\n${paragraph}`],
]) {
  for (const key of ['ArrowUp', 'ArrowDown']) {
    test(`${key} moves within a wrapped ${name} without recalling history @smoke`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      const editor = await openSession(page, baseURL!);
      await editor.fill(draft!);
      await expectWrapped(editor);
      if (key === 'ArrowDown') await editor.press('ControlOrMeta+Home');
      const before = await caretOffset(editor);
      await editor.press(key);
      await expect(editor).toHaveText(draft!);
      if (key === 'ArrowUp') {
        expect(await caretOffset(editor)).toBeLessThan(before);
      } else {
        expect(await caretOffset(editor)).toBeGreaterThan(before);
      }
    });
  }
}

test('snaps to the edge before history and restores a wrapped draft after browsing wrapped entries @smoke', async ({
  page,
  baseURL,
}) => {
  const editor = await openSession(page, baseURL!);
  await editor.fill(paragraph);
  await expectWrapped(editor);
  await editor.press('ControlOrMeta+Home');
  await editor.press('ArrowRight');
  expect(await caretOffset(editor)).toBe(1);
  await editor.press('ArrowUp');
  await expect(editor).toHaveText(paragraph);
  expect(await caretOffset(editor)).toBe(0);

  await editor.press('ArrowUp');
  await expect(editor).toHaveText(history[1]!);
  await editor.press('ArrowUp');
  await expect(editor).toHaveText(history[0]!);
  await editor.press('ArrowDown');
  await expect(editor).toHaveText(history[1]!);
  await editor.press('ArrowDown');
  await expect(editor).toHaveText(paragraph);

  await editor.press('ArrowLeft');
  await editor.press('ArrowDown');
  await expect(editor).toHaveText(paragraph);
  expect(await caretOffset(editor)).toBe(paragraph.length);
});

test('a short single row still enters history immediately @smoke', async ({
  page,
  baseURL,
}) => {
  const editor = await openSession(page, baseURL!);
  await editor.fill('short draft');
  await editor.press('ArrowUp');
  await expect(editor).toHaveText(history[1]!);
  await editor.press('ArrowDown');
  await expect(editor).toHaveText('short draft');
});

test('an active selection is handled by the editor without replacing the draft @smoke', async ({
  page,
  baseURL,
}) => {
  const editor = await openSession(page, baseURL!);
  await editor.fill('selected draft');
  await editor.press('ControlOrMeta+A');
  await editor.press('ArrowUp');
  await expect(editor).toHaveText('selected draft');
});
