import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const EDITOR = '[data-web-shell-composer-surface] .cm-content';
const ANSWER = 'This side answer stays outside the main conversation.';

async function openSession(page: Page, testInfo: TestInfo) {
  const scenario = createWebShellDaemonScenario({ btwAnswer: ANSWER });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: scenario.sessionId }),
  );
  await expect(page.locator(EDITOR)).toBeEditable();
  return daemon;
}

for (const busy of [false, true]) {
  test(`prepares and submits a BTW question while main task is ${busy ? 'running' : 'idle'}`, async ({
    page,
  }, testInfo) => {
    const daemon = await openSession(page, testInfo);
    const editor = page.locator(EDITOR);
    if (busy) {
      await editor.fill('Continue the main task');
      await editor.press('Enter');
      await expect.poll(() => daemon.promptRequests().length).toBe(1);
      await expect(
        page.getByRole('button', { name: 'esc to cancel', exact: true }),
      ).toBeVisible();
    }
    const question = 'What does this term mean?';
    await editor.fill(busy ? `/BTW ${question}` : question);
    await page.getByTestId('composer-add-menu-trigger').click();
    const action = page.getByTestId('composer-add-menu-btw');
    await expect(action).toContainText('Ask a side question');
    await expect(action).toContainText('/btw');
    await expect(action).toContainText('Keep the main task running');
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('btw-menu.png'),
    });
    const mutationsBefore = daemon.requests.filter((r) => r.method === 'POST');
    await action.click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText(`/btw ${question}`);
    expect(daemon.requests.filter((r) => r.method === 'POST')).toEqual(
      mutationsBefore,
    );
    await editor.press('Enter');
    await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
    const btwRequests = daemon.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/btw'),
    );
    expect(btwRequests).toHaveLength(1);
    expect(btwRequests[0]?.body).toMatchObject({ question });
    expect(daemon.promptRequests()).toHaveLength(busy ? 1 : 0);
    expect(
      daemon.requests.filter(
        (r) =>
          r.method === 'POST' && /\/(cancel|pending-prompts)$/.test(r.path),
      ),
    ).toHaveLength(0);
    await expect(
      page.locator('[data-web-shell-message-list]'),
    ).not.toContainText(ANSWER);
    if (busy) {
      await expect(
        page.getByRole('button', { name: 'esc to cancel', exact: true }),
      ).toBeVisible();
    }
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('btw-answer.png'),
    });
  });
}

test('prepares empty drafts and preserves an existing BTW prefix', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  const editor = page.locator(EDITOR);
  for (const [draft, expected] of [
    ['', '/btw fresh question'],
    ['/btw existing question', '/btw existing question'],
  ]) {
    await editor.fill(draft);
    await page.getByTestId('composer-add-menu-trigger').click();
    await page.getByTestId('composer-add-menu-btw').click();
    await expect(editor).toBeFocused();
    if (!draft) await editor.pressSequentially('fresh question');
    await expect(editor).toHaveText(expected);
  }
  expect(daemon.promptRequests()).toHaveLength(0);
  expect(daemon.requests.filter((r) => r.path.endsWith('/btw'))).toHaveLength(
    0,
  );
});

test('disables the BTW entry with an explanation while a file is attached', async ({
  page,
}, testInfo) => {
  const daemon = await openSession(page, testInfo);
  const composer = page.locator('[data-web-shell-composer]');
  await page.locator(EDITOR).fill('Keep this draft and attachment');
  await composer
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Keep this attachment'),
    });
  await expect(
    page.locator('[data-web-shell-composer-attachments]'),
  ).toContainText('notes.txt');
  await page.getByTestId('composer-add-menu-trigger').click();
  const action = page.getByTestId('composer-add-menu-btw');
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await expect(action).toContainText('Remove attachments');
  await expect(page.locator(EDITOR)).toHaveText(
    'Keep this draft and attachment',
  );
  expect(daemon.promptRequests()).toHaveLength(0);
});
