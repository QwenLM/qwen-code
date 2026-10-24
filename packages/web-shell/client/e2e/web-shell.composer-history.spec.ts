import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const EDITOR = '[data-web-shell-composer-editor] .cm-content';
const paragraph = Array.from(
  { length: 8 },
  () =>
    'Keep this unsent paragraph while moving the caret between visual rows.',
).join(' ');
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
    const lineIndex = Array.from(
      element.querySelectorAll('.cm-line'),
    ).findIndex((line) => line.contains(selection.focusNode));
    if (lineIndex < 0)
      throw new Error('The caret must be inside a document line');
    return range.toString().length + lineIndex;
  });
}

async function expectText(editor: Locator, text: string) {
  await expect
    .poll(() => editor.locator('.cm-line').allTextContents())
    .toEqual(text.split('\n'));
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
      await expectText(editor, draft!);
      await expectWrapped(editor);
      if (key === 'ArrowDown') await editor.press('ControlOrMeta+Home');
      const before = await caretOffset(editor);
      await editor.press(key);
      await expectText(editor, draft!);
      if (key === 'ArrowUp') {
        expect(await caretOffset(editor)).toBeLessThan(before);
        expect(await caretOffset(editor)).toBeGreaterThan(0);
      } else {
        expect(await caretOffset(editor)).toBeGreaterThan(before);
        expect(await caretOffset(editor)).toBeLessThan(draft!.length);
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
  await editor.press('ControlOrMeta+Home');
  await editor.press('ArrowRight');
  expect(await caretOffset(editor)).toBe(1);
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

for (const [name, draft, wrapped] of [
  ['short RTL', 'שלום עולם זה טקסט בעברית', false],
  ['mixed LTR/RTL', 'abc שלום', false],
  ['mixed RTL/LTR', 'שלום abc', false],
  [
    'wrapped RTL',
    Array.from({ length: 12 }, () => 'שלום עולם זה טקסט בעברית').join(' '),
    true,
  ],
] as const) {
  test(`a ${name} draft reaches history and is restored @smoke`, async ({
    page,
    baseURL,
  }) => {
    const editor = await openSession(page, baseURL!);
    await editor.fill(draft);
    await expectText(editor, draft);
    if (wrapped) {
      await expectWrapped(editor);
      await editor.press('ControlOrMeta+Home');
      await editor.press('ArrowDown');
      await expectText(editor, draft);
      expect(await caretOffset(editor)).toBeGreaterThan(0);
      expect(await caretOffset(editor)).toBeLessThan(draft.length);
      await editor.press('ControlOrMeta+Home');
      expect(await caretOffset(editor)).toBe(0);
    }
    await editor.press('ArrowUp');
    await expectText(editor, history[1]!);
    await editor.press('ArrowDown');
    await expectText(editor, draft);
  });
}

for (const key of ['ArrowUp', 'ArrowDown']) {
  test(`${key} moves inside an edited recalled entry instead of paging history @smoke`, async ({
    page,
    baseURL,
  }) => {
    const editor = await openSession(page, baseURL!);
    await editor.fill('unsent draft');
    await editor.press('ArrowUp');
    await expectText(editor, history[1]!);
    await editor.pressSequentially('x');
    const edited = `${history[1]}x`;
    await expectText(editor, edited);
    await expectWrapped(editor);
    if (key === 'ArrowDown') await editor.press('ControlOrMeta+Home');
    const before = await caretOffset(editor);
    await editor.press(key);
    await expectText(editor, edited);
    const after = await caretOffset(editor);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(edited.length);
    if (key === 'ArrowUp') expect(after).toBeLessThan(before);
    else expect(after).toBeGreaterThan(before);
  });
}

test('active selections preserve both drafts and recalled history @smoke', async ({
  page,
  baseURL,
}) => {
  const editor = await openSession(page, baseURL!);
  await editor.fill('selected draft');
  await editor.press('ControlOrMeta+A');
  await editor.press('ArrowUp');
  await expect(editor).toHaveText('selected draft');
  await editor.press('ArrowUp');
  await expectText(editor, history[1]!);
  await editor.press('ControlOrMeta+A');
  await editor.press('ArrowUp');
  await expectText(editor, history[1]!);
});

for (const [recall, paged] of [
  ['search', false],
  ['panel', false],
  ['search', true],
  ['panel', true],
] as const) {
  test(`a ${recall} recall keeps wrapped text while arrows move inside it (paged: ${paged}) @smoke`, async ({
    page,
    baseURL,
  }) => {
    const editor = await openSession(page, baseURL!);
    await editor.fill('unsent draft');
    if (paged) {
      await editor.press('ArrowUp');
      await expectText(editor, history[1]!);
    }
    await editor.press('Control+r');
    const search = page.locator('[data-web-shell-composer-history-search]');
    await search.fill('Older prompt:');
    if (recall === 'search') {
      await search.press('Tab');
    } else {
      await page.getByRole('button', { name: /Older prompt:/ }).click();
    }
    await expectText(editor, history[0]!);
    await expectWrapped(editor);
    await editor.press('ControlOrMeta+Home');
    await editor.press('ArrowDown');
    const middle = await caretOffset(editor);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(history[0]!.length);
    await expectText(editor, history[0]!);
    await expect(editor).toBeFocused();

    await editor.press('ArrowUp');
    await expectText(editor, history[0]!);
    expect(await caretOffset(editor)).toBeLessThan(middle);
    await expect(editor).toBeFocused();

    await editor.press('ControlOrMeta+Home');
    await editor.press('ArrowUp');
    await expectText(editor, history[1]!);
    await editor.press('ArrowDown');
    await expectText(editor, history[0]!);
  });
}
