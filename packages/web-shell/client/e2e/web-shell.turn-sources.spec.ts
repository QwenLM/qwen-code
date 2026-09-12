import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  DaemonEvent,
  DaemonSessionAttachmentReference,
  SessionSource,
} from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const shared: SessionSource = {
  id: 'a'.repeat(64),
  kind: 'link',
  title: 'Shared source',
  description: 'A source registered before this turn and reused explicitly.',
  locator: { type: 'url', url: 'https://example.test/shared' },
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};
const current: SessionSource = {
  ...shared,
  id: 'b'.repeat(64),
  title: 'Current source',
  description: 'The second source for this turn.',
  locator: { type: 'url', url: 'https://example.test/current' },
};
const unrelated: SessionSource = {
  ...shared,
  id: 'c'.repeat(64),
  title: 'Unassociated source',
  locator: { type: 'url', url: 'https://example.test/unassociated' },
};
const footer = '[data-web-shell-turn-sources-trigger]';
const popup = '[data-web-shell-turn-sources]';

async function openSources(page: Page, info: TestInfo) {
  let sources = [shared, current, unrelated];
  let revision = 1;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const record = (id: string, source: SessionSource, eventId: number) =>
    toolCallEvent(
      id,
      'record_source',
      { title: source.title, locator: source.locator },
      { id: eventId, rawOutput: { text: `Reference added: ${source.id}` } },
    );
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('First question', { id: 1 }),
      record('first-register', shared, 2),
      assistantTextEvent('First report without footnotes.', { id: 3 }),
      turnCompleteEvent('one', { id: 4 }),
      userTextEvent('Second question', { id: 5 }),
      record('reuse-shared', shared, 6),
      record('current-register', current, 7),
      assistantTextEvent(
        'Second report has one note[^a].\n\n[^a]: An explanatory footnote, separate from the source registry.',
        { id: 8 },
      ),
      turnCompleteEvent('two', { id: 9 }),
    ],
  });
  scenario.capabilities.features.push(
    'session_sources',
    'session_attachment_list',
  );
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  await page.route('**/session/*/sources*', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision, sources }),
    }),
  );
  await page.route('**/session/*/attachments', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ attachments: [] }),
    }),
  );
  await page.goto(`/session/${scenario.sessionId}?theme=dark&lang=en`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('First report without footnotes.')).toBeVisible();
  await expect(page.locator(footer)).toHaveText(['1 source', '2 sources']);
  return {
    errors,
    async replace(next: SessionSource[]) {
      sources = next;
      revision += 1;
      await daemon.sendEvent({
        v: 1,
        type: 'source_changed',
        data: { sessionId: scenario.sessionId, revision },
      });
    },
  };
}

test('turn sources count explicit reuse independently of footnotes and open the existing preview', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const { errors } = await openSources(page, info);
  const button = page.locator(footer).last();
  await page.mouse.move(0, 0);
  await expect(button.locator('..')).toHaveCSS('opacity', '0');
  await button.hover();
  await expect(button.locator('..')).toHaveCSS('opacity', '1');
  const list = page.locator(popup);
  await expect(list).toBeVisible();
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list).toContainText(shared.title);
  await expect(list).toContainText(current.title);
  await expect(list).not.toContainText(unrelated.title);
  await expect(page.locator('[data-web-shell-footnote-trigger]')).toHaveCount(
    1,
  );
  await page.screenshot({
    path: info.outputPath('turn-sources-list.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await list
    .getByRole('button', { name: 'Open source Shared source', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: shared.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(shared.description!, { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('source refresh drops deleted entries without borrowing unassociated sources or footnotes', async ({
  page,
}, info) => {
  const { errors, replace } = await openSources(page, info);
  await page.locator(footer).last().click();
  await expect(page.locator(popup).locator('li')).toHaveCount(2);
  await replace([shared, unrelated]);
  await expect(page.locator(footer)).toHaveText(['1 source', '1 source']);
  await expect(page.locator(popup).locator('li')).toHaveCount(1);
  await expect(page.locator(popup)).not.toContainText(current.title);
  await replace([unrelated]);
  await expect(page.locator(footer)).toHaveCount(0);
  await expect(page.locator(popup)).toHaveCount(0);
  await expect(page.locator('[data-web-shell-footnote-trigger]')).toHaveCount(
    1,
  );
  expect(errors).toEqual([]);
});

test('host sources match the session panel while the report keeps independent footnotes', async ({
  page,
}, info) => {
  test.skip(
    process.env['FOOTNOTE_BUILT'] === '1',
    'Host demo runs through the separately built transcript consumer.',
  );
  await page.goto('/e2e/footnote-citation-demo.html');
  const button = page.locator(footer);
  await expect(button).toHaveText('4 个来源');
  await expect(page.locator('[data-web-shell-footnote-trigger]')).toHaveText([
    '2',
    '',
  ]);
  await button.hover();
  await expect(page.locator(popup).locator('li')).toHaveCount(4);
  await expect(page.locator(popup)).toContainText('订单样例.csv');
  await expect(page.locator(popup)).not.toContainText('上一轮背景资料.pdf');
  await page
    .locator(popup)
    .getByRole('button', { name: '打开来源 订单样例.csv', exact: true })
    .click();
  await expect(page.locator('[data-demo-source-panel]')).toContainText(
    'data/orders.csv',
  );
  await expect(page.locator('[data-demo-source-panel]')).toContainText(
    '与会话来源面板使用同一条来源记录',
  );
  await page.getByRole('button', { name: '会话来源 5', exact: true }).click();
  await expect(page.locator('[data-demo-sources-panel] li')).toHaveCount(5);
  await page.screenshot({
    path: info.outputPath('turn-sources-host-demo.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('attachment sources load and refresh without opening the environment panel', async ({
  page,
}, info) => {
  const attachment = (
    attachmentId: string,
  ): DaemonSessionAttachmentReference => ({
    type: 'resource',
    attachmentId,
    mimeType: 'text/plain',
    size: 5,
  });
  const first = attachment('first.txt');
  const second = attachment('second.txt');
  let attachments = [first];
  const uploaded = (
    content: DaemonSessionAttachmentReference,
    id: number,
  ): DaemonEvent => ({
    id,
    v: 1,
    type: 'session_update',
    data: { update: { sessionUpdate: 'user_message_chunk', content } },
  });
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Read the first attachment', { id: 1 }),
      uploaded(first, 2),
      assistantTextEvent('The first attachment report.', { id: 3 }),
      turnCompleteEvent('one', { id: 4 }),
    ],
  });
  scenario.capabilities.features.push('session_attachment_list');
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  await page.route('**/session/*/attachments', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ attachments }),
    }),
  );
  await page.goto(`/session/${scenario.sessionId}?theme=dark&lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.locator(footer)).toHaveText(['1 source']);
  await page.locator(footer).hover();
  await expect(page.locator(popup)).toContainText('first.txt');
  await page.keyboard.press('Escape');
  await expect(page.locator(popup)).toHaveCount(0);

  attachments = [first, second];
  await daemon.sendEvent(
    userTextEvent('Reuse the first and read the second', { id: 5 }),
  );
  await daemon.sendEvent(uploaded(first, 6));
  await daemon.sendEvent(uploaded(second, 7));
  await daemon.sendEvent(
    assistantTextEvent('Both attachments report.', { id: 8 }),
  );
  await daemon.sendEvent(turnCompleteEvent('two', { id: 9 }));
  await expect(page.locator(footer)).toHaveText(['1 source', '2 sources']);
  await page.locator(footer).last().hover();
  await expect(page.locator(popup).locator('li')).toHaveCount(2);
  await expect(page.locator(popup)).toContainText('second.txt');
  for (const panel of await page.getByTestId('environment-panel').all()) {
    await expect(panel).not.toBeVisible();
  }
  await page.screenshot({
    path: info.outputPath('turn-attachment-sources.png'),
    animations: 'disabled',
  });
});
