import { expect, test, type Page, type TestInfo } from '@playwright/test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import type { DaemonEvent, DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

// Production's asset service worker would bypass the network failure mocks.
test.use({ serviceWorkers: 'block' });

const MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const previewSelector = '[data-web-shell-excel-preview]';
const workbookPath = 'reports/quarterly.xlsx';

async function workbookBytes(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Quarterly');
  sheet.addRow(['Metric', 'Value', 'Notes']);
  sheet.addRow(['Revenue', 1234.5, 'Saved report']);
  sheet.getCell('B2').numFmt = '"¥"#,##0.00';
  sheet.addRow(['Margin', 0.125]);
  sheet.getCell('B3').numFmt = '0.00%';
  sheet.addRow(['Identifier', 123]);
  sheet.getCell('B4').numFmt = '000000';
  sheet.addRow(['Date', new Date('2026-10-08T00:00:00Z')]);
  sheet.getCell('B5').numFmt = 'yyyy-mm-dd';
  sheet.addRow(['Cached zero', { formula: '1-1', result: 0 }]);
  sheet.addRow(['Pending formula', { formula: 'SUM(B2:B3)' }]);
  sheet.addRow(['Error', { error: '#DIV/0!' }]);
  sheet.addRow(['Literal HTML', '<img src=x onerror=alert(1)>']);
  sheet.mergeCells('A10:C10');
  sheet.getCell('A10').value = 'Merged report note';
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('B1').font = { color: { argb: 'FF000000' } };
  sheet.getCell('A1').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF245B91' },
  };
  for (let row = 11; row <= 105; row++)
    sheet.getCell(row, 1).value = `Row ${row}`;
  workbook.addWorksheet('Details').addRow(['Second worksheet', 'Verified']);
  workbook.addWorksheet('Empty');
  const limited = workbook.addWorksheet('Limited');
  limited.getCell('A1').value = 'Visible limit marker';
  limited.getCell('AX2001').value = 'Outside preview limit';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function artifact(): DaemonSessionArtifact {
  return {
    id: 'excel-report',
    title: 'Quarterly workbook',
    kind: 'document',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    workspacePath: workbookPath,
    mimeType: MIME,
    retention: 'ephemeral',
    clientRetained: false,
    toolCallId: 'make-workbook',
    toolName: 'Artifact',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
  };
}

function referenceEvent(): DaemonEvent {
  const text = `@${workbookPath}`;
  return {
    id: 1,
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: {
          inputAnnotations: [
            {
              type: 'reference',
              start: 0,
              end: text.length,
              text,
              reference: {
                id: 'excel-reference',
                kind: 'file',
                value: workbookPath,
                serialized: text,
                metadata: { fileKind: 'file' },
              },
            },
          ],
        },
      },
    },
  };
}

async function install(
  page: Page,
  info: TestInfo,
  scenario: WebShellDaemonScenario,
  bytes: Buffer,
) {
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  const byteReads: string[] = [];
  const textReads: string[] = [];
  const attachmentReads: string[] = [];
  await page.route('**/workspace/models', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route('**/stat?*', (route) =>
    route.fulfill({
      json: {
        type: 'file',
        sizeBytes: bytes.length,
        modifiedMs: 1,
      },
    }),
  );
  await page.route('**/file/bytes?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    byteReads.push(params.get('path') ?? '');
    const offset = Number(params.get('offset') ?? 0);
    const chunk = bytes.subarray(
      offset,
      offset + Number(params.get('maxBytes') ?? bytes.length),
    );
    return route.fulfill({
      json: {
        path: params.get('path'),
        offset,
        sizeBytes: bytes.length,
        returnedBytes: chunk.length,
        contentBase64: chunk.toString('base64'),
      },
    });
  });
  await page.route('**/file?*', (route) => {
    textReads.push(route.request().url());
    return route.fulfill({
      status: 400,
      json: { error: 'Binary files must use byte reads' },
    });
  });
  await page.route('**/session/*/attachments/*', (route) => {
    attachmentReads.push(route.request().url());
    return route.fulfill({ contentType: MIME, body: bytes });
  });
  await page.route('**/session/*/attachments', (route) =>
    route.fulfill({
      json: {
        attachments: [
          {
            type: 'resource',
            attachmentId: 'incoming.xlsx',
            mimeType: MIME,
            size: bytes.length,
          },
        ],
      },
    }),
  );
  const open = async () => {
    await page.goto(`/session/${scenario.sessionId}?theme=dark&lang=en`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: scenario.sessionId,
        replayedCount: scenario.events.length,
      }),
    );
    await expect(
      page.locator('[data-web-shell-composer-editor] .cm-content'),
    ).toBeVisible();
  };
  return { open, byteReads, textReads, attachmentReads };
}

async function pasteWorkbook(
  page: Page,
  bytes: Buffer,
  name = 'incoming.xlsx',
) {
  await page.locator('[data-web-shell-composer-editor] .cm-content').evaluate(
    (element, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(
          [Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))],
          file.name,
          { type: file.mimeType },
        ),
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    },
    { base64: bytes.toString('base64'), name, mimeType: MIME },
  );
  await page
    .locator('[data-web-shell-composer-attachments]')
    .getByRole('button')
    .filter({ hasText: name })
    .first()
    .click();
}

test('previews artifact and @file with lazy Excel loading, formats and virtual scrolling', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const bytes = await workbookBytes();
  const scenario = createWebShellDaemonScenario({
    events: [
      referenceEvent(),
      toolCallEvent(
        'make-workbook',
        'Artifact',
        { file_path: workbookPath },
        { id: 2 },
      ),
      assistantTextEvent('The workbook is ready.', { id: 3 }),
      turnCompleteEvent('report', { id: 4 }),
    ],
    artifacts: [artifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const modules: string[] = [];
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('request', (request) => {
    if (/SpreadsheetPreview|excel-preview\.worker/.test(request.url()))
      modules.push(request.url());
  });
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  expect(modules).toEqual([]);
  expect(workers).toEqual([]);
  await page
    .locator(
      '[data-web-shell-message-list] [title="Quarterly workbook"] > button',
    )
    .click();
  const preview = page.locator(previewSelector);
  const table = preview.getByRole('table', { name: 'Quarterly', exact: true });
  await expect(table).toBeVisible();
  const explicitBlackCell = table.getByRole('cell', {
    name: 'Value',
    exact: true,
  });
  await expect(explicitBlackCell).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(explicitBlackCell).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  expect(modules.some((url) => url.includes('SpreadsheetPreview'))).toBe(true);
  // Worker creation is observable in both dev and the production inline build.
  expect(workers).toHaveLength(1);
  for (const value of [
    '¥1,234.50',
    '12.50%',
    '000123',
    '2026-10-08',
    '#DIV/0!',
    'Not calculated',
  ]) {
    await expect(table).toContainText(value);
  }
  await expect(
    table
      .getByRole('row')
      .filter({ hasText: 'Cached zero' })
      .getByRole('cell')
      .nth(1),
  ).toHaveText('0');
  await expect(
    table.getByRole('cell', { name: 'Merged report note', exact: true }),
  ).toHaveAttribute('colspan', '3');
  await expect(table).toContainText('<img src=x onerror=alert(1)>');
  await expect(table.locator('img')).toHaveCount(0);
  await preview.locator('[data-web-shell-excel-scroll]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(table).toContainText('Row 105');
  await expect(table).not.toContainText('Revenue');
  await preview.getByRole('tab', { name: 'Details', exact: true }).click();
  await expect(
    preview.getByRole('table', { name: 'Details', exact: true }),
  ).toContainText('Second worksheet');
  await preview.getByRole('tab', { name: 'Empty', exact: true }).click();
  await expect(preview).toContainText('This worksheet is empty.');
  await expect(preview.getByRole('table')).toHaveCount(0);
  await preview.getByRole('tab', { name: 'Limited', exact: true }).click();
  await expect(preview).toContainText('Preview limited to');
  await expect(preview).toContainText('Visible limit marker');
  await expect(preview).not.toContainText('Outside preview limit');
  await preview.getByRole('tab', { name: 'Quarterly', exact: true }).click();
  await expect(table).toContainText('Revenue');
  await preview.getByRole('tab', { name: 'Quarterly', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    preview.getByRole('tab', { name: 'Details', exact: true }),
  ).toBeFocused();
  await expect(
    preview.getByRole('tab', { name: 'Details', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    preview.getByRole('table', { name: 'Details', exact: true }),
  ).toContainText('Second worksheet');
  await page.keyboard.press('ArrowLeft');
  await expect(table).toContainText('Revenue');
  const selectedColors = await preview
    .getByRole('tab', { name: 'Quarterly', exact: true })
    .evaluate((element) => {
      const sample = document.createElement('span');
      sample.style.color = 'var(--agent-blue-400)';
      element.append(sample);
      const colors = {
        actual: getComputedStyle(element).color,
        expected: getComputedStyle(sample).color,
      };
      sample.remove();
      return colors;
    });
  await expect(
    preview.getByRole('tab', { name: 'Quarterly', exact: true }),
  ).toHaveCSS('color', selectedColors.expected);
  await page.screenshot({
    path: info.outputPath('excel-artifact-mock-daemon.png'),
    animations: 'disabled',
  });
  const downloadPromise = page.waitForEvent('download');
  await preview.getByRole('link', { name: /Download/i }).click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!)).toEqual(bytes);
  const previousReads = mock.byteReads.length;
  await page
    .locator('[data-web-shell-user-bubble]')
    .getByText(workbookPath, { exact: true })
    .click();
  await expect(table).toBeVisible();
  await expect.poll(() => mock.byteReads.length).toBeGreaterThan(previousReads);
  expect(mock.byteReads.every((path) => path === workbookPath)).toBe(true);
  expect(mock.textReads).toEqual([]);
});

test('keeps large worksheets virtual while scrolling through wrapped and merged cells', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Large');
  for (let r = 1; r <= 2000; r++) {
    sheet.addRow(
      Array.from({ length: 50 }, (_, c) =>
        c === 0 ? `Record ${r}` : r * 50 + c,
      ),
    );
  }
  sheet.getCell('B5').value = 'Wrapped content\n'.repeat(8);
  sheet.mergeCells('B40:C140');
  sheet.getCell('B40').value = 'Cross-window merge';
  workbook.addWorksheet('Small').addRow(['Small sheet top']);
  const narrow = workbook.addWorksheet('Long');
  narrow.getCell('A1').value = 'Long sheet top';
  narrow.getCell('J5001').value = 'Past the former row limit';
  for (let i = 3; i < 22; i++)
    workbook.addWorksheet(`Extra ${i}`).addRow([`Sheet ${i} content`]);
  workbook.getWorksheet('Extra 21')!.getCell('A100000').value =
    'Last allowed row';
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const scenario = createWebShellDaemonScenario({
    events: [
      toolCallEvent(
        'make-workbook',
        'Artifact',
        { file_path: workbookPath },
        { id: 1 },
      ),
      turnCompleteEvent('report', { id: 2 }),
    ],
    artifacts: [artifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  await page
    .locator(
      '[data-web-shell-message-list] [title="Quarterly workbook"] > button',
    )
    .click();
  const preview = page.locator(previewSelector);
  const table = preview.getByRole('table', { name: 'Large', exact: true });
  const scroll = preview.locator('[data-web-shell-excel-scroll]');
  await expect(
    table.getByRole('cell', { name: 'Record 1', exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByRole('button', { name: /Next page|Previous page/ }),
  ).toHaveCount(0);
  expect(await table.locator('tbody tr[data-index]').count()).toBeLessThan(70);
  expect(
    await table
      .locator('tbody tr[data-index="4"]')
      .evaluate((row) => row.getBoundingClientRect().height),
  ).toBeGreaterThan(100);
  await scroll.evaluate((element) => {
    element.scrollTop = 2500;
  });
  await expect(
    table.getByRole('cell', { name: 'Cross-window merge', exact: true }),
  ).toHaveAttribute('colspan', '2');
  await expect
    .poll(async () =>
      Number(
        await table
          .locator('tbody tr[data-index]')
          .first()
          .getAttribute('data-index'),
      ),
    )
    .toBeGreaterThan(39);
  for (const offset of ['end', 'start', 'end']) {
    await scroll.evaluate((element, target) => {
      element.scrollTop = target === 'end' ? element.scrollHeight : 0;
    }, offset);
    await expect(
      table.getByRole('cell', {
        name: offset === 'end' ? 'Record 2000' : 'Record 1',
        exact: true,
      }),
    ).toBeVisible();
    expect(await table.locator('tbody tr[data-index]').count()).toBeLessThan(
      70,
    );
  }
  await preview.getByRole('tab', { name: 'Small', exact: true }).click();
  await expect(preview.getByRole('table')).toContainText('Small sheet top');
  for (const selector of ['thead th:first-child', 'tbody th[scope="row"]']) {
    expect(
      await preview
        .getByRole('table')
        .locator(selector)
        .evaluate((element) => element.getBoundingClientRect().width),
    ).toBeCloseTo(56, 1);
  }
  await expect(preview.getByRole('tab')).toHaveCount(22);
  await preview.getByRole('tab', { name: 'Extra 21', exact: true }).click();
  await expect(preview.getByRole('table')).toContainText('Sheet 21 content');
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const lastRowNumber = preview.getByRole('rowheader', {
    name: '100000',
    exact: true,
  });
  await expect(lastRowNumber).toBeVisible();
  const rowNumberBounds = await lastRowNumber.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const cell = element.getBoundingClientRect();
    return { left: text.left - cell.left, right: cell.right - text.right };
  });
  expect(rowNumberBounds.left).toBeGreaterThanOrEqual(0);
  expect(rowNumberBounds.right).toBeGreaterThanOrEqual(0);
  await preview.getByRole('tab', { name: 'Long', exact: true }).click();
  await expect(preview.getByRole('table')).toContainText('Long sheet top');
  await expect(preview).not.toContainText('Preview limited to');
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    preview
      .getByRole('table')
      .getByRole('cell', { name: 'Past the former row limit', exact: true }),
  ).toBeVisible();

  await preview.getByRole('tab', { name: 'Large', exact: true }).click();
  await expect(
    table.getByRole('cell', { name: 'Record 1', exact: true }),
  ).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
});

test('previews incoming unsent Blob and leaves invalid workbook downloadable', async ({
  page,
}, info) => {
  const bytes = await workbookBytes();
  const mock = await install(page, info, createWebShellDaemonScenario(), bytes);
  await mock.open();
  await pasteWorkbook(page, bytes);
  const preview = page.locator(previewSelector);
  await expect(preview.getByRole('table', { name: 'Quarterly' })).toContainText(
    'Revenue',
  );
  expect(mock.byteReads).toEqual([]);
  expect(mock.attachmentReads).toEqual([]);
  await pasteWorkbook(page, Buffer.from('not a ZIP workbook'), 'broken.xlsx');
  await expect(preview.getByRole('alert')).toBeVisible();
  await expect(preview.getByRole('table')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await preview.getByRole('link', { name: /Download/i }).click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!)).toEqual(
    Buffer.from('not a ZIP workbook'),
  );
});

test('opens persisted attachment from message and Sources, then restores it after reload', async ({
  page,
}, info) => {
  const bytes = await workbookBytes();
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Read this workbook', { id: 1 }),
      {
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'resource',
              attachmentId: 'incoming.xlsx',
              mimeType: MIME,
              size: bytes.length,
            },
          },
        },
      },
      assistantTextEvent('Workbook attached.', { id: 3 }),
      turnCompleteEvent('incoming', { id: 4 }),
    ],
  });
  scenario.capabilities.features.push('session_attachment_list');
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  await page
    .locator('[data-web-shell-user-files]')
    .getByRole('button', { name: /incoming.xlsx/ })
    .click();
  await expect(
    page.locator(previewSelector).getByRole('table', { name: 'Quarterly' }),
  ).toBeVisible();
  await page.locator('[data-web-shell-turn-sources-trigger]').click();
  await page
    .locator('[data-web-shell-turn-sources]')
    .getByRole('button', { name: 'incoming.xlsx', exact: true })
    .click();
  await expect(
    page.locator(previewSelector).getByRole('table', { name: 'Quarterly' }),
  ).toContainText('Revenue');
  const previousReads = mock.attachmentReads.length;
  await mock.open();
  await expect(
    page.locator(previewSelector).getByRole('table', { name: 'Quarterly' }),
  ).toContainText('Revenue');
  expect(mock.attachmentReads.length).toBeGreaterThan(previousReads);
  expect(mock.byteReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
});

test('rejects excessive merged area without losing the original download or crashing on reopen', async ({
  page,
}, info) => {
  const zip = await JSZip.loadAsync(await workbookBytes());
  const path = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(path)!.async('string');
  zip.file(
    path,
    xml.replace(
      /<mergeCells[^>]*>[\s\S]*?<\/mergeCells>/,
      '<mergeCells><mergeCell ref="A1:J10001"/></mergeCells>',
    ),
  );
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  const scenario = createWebShellDaemonScenario({
    events: [
      toolCallEvent(
        'make-workbook',
        'Artifact',
        { file_path: workbookPath },
        { id: 1 },
      ),
      turnCompleteEvent('report', { id: 2 }),
    ],
    artifacts: [artifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  await page
    .locator(
      '[data-web-shell-message-list] [title="Quarterly workbook"] > button',
    )
    .click();
  const preview = page.locator(previewSelector);
  await expect(preview.getByRole('alert')).toContainText('too complex');
  await expect(preview.getByRole('table')).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await preview.getByRole('link', { name: /Download/i }).click();
  expect(await readFile((await (await downloadPromise).path())!)).toEqual(
    bytes,
  );
  await page.reload();
  await expect(preview.getByRole('alert')).toContainText('too complex');
  await page.screenshot({
    path: info.outputPath('excel-merge-limit-mock-daemon.png'),
  });
});

test('retains all content when peripheral empty cells carry formatting', async ({
  page,
}, info) => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Orders');
  for (let row = 1; row <= 2000; row++)
    sheet.addRow([`Order ${row}`, row, row * 2]);
  sheet.getCell('XFD1').font = { bold: true };
  sheet.getRow(5000).font = { bold: true };
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const scenario = createWebShellDaemonScenario({
    events: [
      toolCallEvent(
        'make-workbook',
        'Artifact',
        { file_path: workbookPath },
        { id: 1 },
      ),
      turnCompleteEvent('report', { id: 2 }),
    ],
    artifacts: [artifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  await page
    .locator(
      '[data-web-shell-message-list] [title="Quarterly workbook"] > button',
    )
    .click();
  const preview = page.locator(previewSelector);
  await expect(preview.getByRole('table')).toHaveAttribute(
    'aria-rowcount',
    '2001',
  );
  await expect(preview.getByRole('columnheader')).toHaveCount(4);
  await expect(preview.getByRole('status')).toHaveCount(0);
  await preview.locator('[data-web-shell-excel-scroll]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    preview.getByRole('cell', { name: 'Order 2000', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('excel-formatted-extent-mock-daemon.png'),
  });
});

for (const allowWorker of [false, true]) {
  test(`host worker policy ${allowWorker ? 'permits preview' : 'keeps download fallback'}`, async ({
    page,
  }, info) => {
    const bytes = await workbookBytes();
    const scenario = createWebShellDaemonScenario({
      events: [
        toolCallEvent(
          'make-workbook',
          'Artifact',
          { file_path: workbookPath },
          { id: 1 },
        ),
        turnCompleteEvent('report', { id: 2 }),
      ],
      artifacts: [artifact()],
    });
    scenario.capabilities.features.push('session_artifacts');
    const mock = await install(page, info, scenario, bytes);
    await page.route(
      (url) => url.pathname === `/session/${scenario.sessionId}`,
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            // Vite dev serves a worker URL; production inlines the worker as a blob.
            'content-security-policy': allowWorker
              ? "worker-src 'self' blob:"
              : "worker-src 'none'",
          },
        });
      },
    );
    await mock.open();
    await page
      .locator(
        '[data-web-shell-message-list] [title="Quarterly workbook"] > button',
      )
      .click();
    const preview = page.locator(previewSelector);
    if (allowWorker) {
      await expect(preview.getByRole('table')).toBeVisible();
      await expect(preview.getByRole('alert')).toHaveCount(0);
    } else {
      await expect(preview.getByRole('alert')).toBeVisible();
      await expect(preview.getByRole('table')).toHaveCount(0);
    }
    const downloadPromise = page.waitForEvent('download');
    await preview.getByRole('link', { name: /Download/i }).click();
    const download = await downloadPromise;
    expect(await readFile((await download.path())!)).toEqual(bytes);
  });
}

test('keeps artifact and incoming Blob downloadable when the lazy preview module fails', async ({
  page,
}, info) => {
  const bytes = await workbookBytes();
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Prepare the workbook', { id: 1 }),
      toolCallEvent(
        'make-workbook',
        'Artifact',
        { file_path: workbookPath },
        { id: 2 },
      ),
      assistantTextEvent('The workbook is ready.', { id: 3 }),
      turnCompleteEvent('report', { id: 4 }),
    ],
    artifacts: [artifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const mock = await install(page, info, scenario, bytes);
  const blockedModules: string[] = [];
  await page.route(
    /\/SpreadsheetPreview(?:-[^/?]+)?\.(?:tsx|js)(?:\?|$)/,
    (route) => {
      blockedModules.push(route.request().url());
      return route.abort('failed');
    },
  );
  await mock.open();
  await page
    .locator(
      '[data-web-shell-message-list] [title="Quarterly workbook"] > button',
    )
    .click();
  const panel = page.getByRole('complementary', {
    name: 'Right panel',
    exact: true,
  });
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(blockedModules.length).toBeGreaterThan(0);
  await expect(panel.locator(previewSelector)).toHaveCount(0);
  expect(mock.byteReads).toEqual([]);
  const artifactDownloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download', exact: true }).click();
  const artifactDownload = await artifactDownloadPromise;
  expect(await readFile((await artifactDownload.path())!)).toEqual(bytes);
  const workspaceReadCount = mock.byteReads.length;
  await pasteWorkbook(page, bytes);
  await expect(panel.getByRole('alert')).toBeVisible();
  const attachmentDownloadPromise = page.waitForEvent('download');
  await panel
    .getByRole('link', { name: 'Download incoming.xlsx', exact: true })
    .click();
  const attachmentDownload = await attachmentDownloadPromise;
  expect(await readFile((await attachmentDownload.path())!)).toEqual(bytes);
  expect(mock.byteReads).toHaveLength(workspaceReadCount);
  expect(mock.attachmentReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
});
