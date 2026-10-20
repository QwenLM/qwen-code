import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type {
  DaemonEvent,
  DaemonSessionArtifact,
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
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

// Full Chromium includes the PDF viewer; headless-shell does not.
test.use({ channel: 'chromium', serviceWorkers: 'block' });

test.describe('PDF attachment framing', () => {
  test('@smoke permits PDF blob frames under the development CSP', async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) {
        violations.push(message.text());
      }
    });
    const response = await page.goto('/e2e/composer-layout-harness.html');
    expect(response?.headers()['content-security-policy']).toContain(
      'frame-src http: https: blob:;',
    );
    await page.setContent('<iframe title="PDF attachment"></iframe>');
    const url = await page.locator('iframe').evaluate((frame, base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([bytes], { type: 'application/pdf' }),
      );
      (frame as HTMLIFrameElement).src = url;
      return url;
    }, pdfBytes.toString('base64'));
    try {
      await expect
        .poll(() => page.frames().some((frame) => frame.url() === url))
        .toBe(true);
      expect(
        violations.filter((message) => message.includes('frame-src')),
      ).toEqual([]);
    } finally {
      await page.evaluate((value) => URL.revokeObjectURL(value), url);
    }
  });
});

const PDF_MIME = 'application/pdf';
const pdfPath = 'report.PDF';
const pdfBytes = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDEwMCBUZCAoUERGIHByb2JlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=',
  'base64',
);

function pdfArtifact(): DaemonSessionArtifact {
  return {
    id: 'pdf-report',
    title: 'PDF report',
    kind: 'pdf',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    workspacePath: pdfPath,
    mimeType: PDF_MIME,
    retention: 'ephemeral',
    clientRetained: false,
    toolCallId: 'make-pdf',
    toolName: 'Artifact',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  };
}

function pdfReference(workspacePath = pdfPath): DaemonEvent {
  const text = `@${workspacePath}`;
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
                id: 'pdf-reference',
                kind: 'file',
                value: workspacePath,
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

// Simulated daemon responses exercise browser integration, not real filesystem operations.
async function installPdfScenario(
  page: Page,
  info: TestInfo,
  scenario: WebShellDaemonScenario,
  workspacePath = pdfPath,
) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  const byteReads: string[] = [];
  const textReads: string[] = [];
  const attachmentReads: string[] = [];
  await page.route('**/workspace/models', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route('**/list?*', (route) => {
    const directory =
      new URL(route.request().url()).searchParams.get('path') ?? '.';
    const parts = workspacePath.split('/');
    const index = directory === '.' ? 0 : directory.split('/').length;
    return route.fulfill({
      json: {
        kind: 'list',
        path: directory,
        truncated: false,
        entries: [
          {
            name: parts[index],
            kind: index === parts.length - 1 ? 'file' : 'directory',
            ignored: false,
          },
        ],
      },
    });
  });
  await page.route('**/stat?*', (route) =>
    route.fulfill({
      json: {
        kind: 'stat',
        path: workspacePath,
        type: 'file',
        sizeBytes: pdfBytes.length,
        modifiedMs: 1,
      },
    }),
  );
  await page.route('**/file/bytes?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    byteReads.push(params.get('path') ?? '');
    const offset = Number(params.get('offset') ?? 0);
    const chunk = pdfBytes.subarray(
      offset,
      offset + Number(params.get('maxBytes') ?? pdfBytes.length),
    );
    return route.fulfill({
      json: {
        path: params.get('path'),
        offset,
        sizeBytes: pdfBytes.length,
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
    return route.fulfill({ contentType: PDF_MIME, body: pdfBytes });
  });
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

async function capturePdf(page: Page, info: TestInfo, label: string) {
  const iframe = page.locator('iframe[title^="Preview "]:visible');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('src', /^blob:/);
  const src = await iframe.getAttribute('src');
  const currentViewer = () =>
    page
      .frames()
      .find(
        (frame) =>
          frame.url().startsWith('chrome-extension://') &&
          frame.parentFrame()?.url() === src,
      );
  await expect.poll(() => Boolean(currentViewer())).toBe(true);
  const viewer = currentViewer()!;
  await expect(viewer.locator('viewer-page-selector #pagelength')).toHaveText(
    '1',
  );
  await page.screenshot({
    path: info.outputPath(`pdf-${label}-mock-daemon.png`),
    animations: 'disabled',
  });
}

async function pastePdf(page: Page, mimeType = PDF_MIME) {
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
    { base64: pdfBytes.toString('base64'), name: 'incoming.PDF', mimeType },
  );
  await page
    .locator('[data-web-shell-composer-attachments]')
    .getByRole('button')
    .filter({ hasText: 'incoming.PDF' })
    .first()
    .click();
}

test('previews an unsent PDF attachment without workspace reads', async ({
  page,
}, info) => {
  const mock = await installPdfScenario(
    page,
    info,
    createWebShellDaemonScenario(),
  );
  await mock.open();
  await pastePdf(page);
  await capturePdf(page, info, 'attachment');
  expect(mock.byteReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
  expect(mock.attachmentReads).toEqual([]);
});

test('previews a generic-MIME PDF attachment by its extension', async ({
  page,
}, info) => {
  const mock = await installPdfScenario(
    page,
    info,
    createWebShellDaemonScenario(),
  );
  await mock.open();
  await pastePdf(page, 'application/octet-stream');
  await capturePdf(page, info, 'generic-attachment');
  expect(mock.byteReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
});

test('previews a persisted PDF attachment from its message', async ({
  page,
}, info) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Read this PDF', { id: 1 }),
      {
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'resource',
              attachmentId: 'incoming.PDF',
              mimeType: PDF_MIME,
              size: pdfBytes.length,
            },
          },
        },
      },
      assistantTextEvent('PDF attached.', { id: 3 }),
      turnCompleteEvent('incoming', { id: 4 }),
    ],
  });
  const mock = await installPdfScenario(page, info, scenario);
  await mock.open();
  await page
    .locator('[data-web-shell-user-files]')
    .getByRole('button', { name: /incoming.PDF/ })
    .click();
  await capturePdf(page, info, 'persisted-attachment');
  expect(mock.attachmentReads).toHaveLength(1);
  expect(mock.byteReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
});

test('previews workspace PDF artifacts and @file references using byte reads', async ({
  page,
}, info) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      pdfReference(),
      toolCallEvent('make-pdf', 'Artifact', { file_path: pdfPath }, { id: 2 }),
      assistantTextEvent('The PDF is ready.', { id: 3 }),
      turnCompleteEvent('pdf-report', { id: 4 }),
    ],
    artifacts: [pdfArtifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const mock = await installPdfScenario(page, info, scenario);
  await mock.open();
  await page
    .locator(`[data-web-shell-message-list] [title="${pdfPath}"] > button`)
    .click();
  await capturePdf(page, info, 'artifact');
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('link', { name: /Download/ })
    .last()
    .click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!)).toEqual(pdfBytes);
  const reads = mock.byteReads.length;
  await page
    .locator('[data-web-shell-user-bubble]')
    .getByText(pdfPath, { exact: true })
    .click();
  await capturePdf(page, info, 'reference');
  await expect.poll(() => mock.byteReads.length).toBeGreaterThan(reads);
  expect(mock.byteReads.every((path) => path === pdfPath)).toBe(true);
  expect(mock.textReads).toEqual([]);
});

test('previews PDF selection in Files and opens its standalone tab', async ({
  page,
}, info) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Browse PDFs.', { id: 1 }),
      assistantTextEvent('Workspace ready.', { id: 2 }),
      turnCompleteEvent('files-ready', { id: 3 }),
    ],
  });
  const mock = await installPdfScenario(page, info, scenario);
  await mock.open();
  await page.getByTestId('chat-header-workspace').click();
  const browser = page.getByTestId('workspace-file-browser');
  const file = browser.getByRole('treeitem', { name: pdfPath, exact: true });
  await file.click();
  await capturePdf(page, info, 'files-selection');
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: pdfPath, exact: true }),
  ).toHaveCount(1);
  await expect(browser).toBeHidden();
  await capturePdf(page, info, 'files-tab');
  expect(mock.byteReads.every((path) => path === pdfPath)).toBe(true);
  expect(mock.textReads).toEqual([]);
});

for (const [index, workspacePath] of [
  'reports/Q3#final.pdf',
  'reports/Q3?final.pdf',
  'reports#approved/report.pdf',
  'reports?approved/report.pdf',
  'reports.xlsx#approved/report.pdf',
].entries()) {
  test(`previews literal workspace PDF path ${index + 1}: ${workspacePath} across Files, references and Sources`, async ({
    page,
  }, info) => {
    const scenario = createWebShellDaemonScenario();
    const source: SessionSource = {
      id: 'a'.repeat(64),
      kind: 'file',
      title: 'PDF reference',
      workspaceCwd: scenario.workspaceCwd,
      locator: { type: 'workspace_file', workspacePath },
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
    };
    scenario.events = [
      pdfReference(workspacePath),
      toolCallEvent(
        'register-pdf',
        'record_source',
        { title: source.title, locator: source.locator },
        {
          id: 2,
          rawOutput: { text: `Reference added: ${source.id}` },
        },
      ),
      assistantTextEvent('PDF source ready.', { id: 3 }),
      turnCompleteEvent('pdf-source', { id: 4 }),
    ];
    scenario.capabilities.features.push('session_sources');
    const mock = await installPdfScenario(page, info, scenario, workspacePath);
    await page.route('**/session/*/sources*', (route) =>
      route.fulfill({ json: { revision: 1, sources: [source] } }),
    );
    await mock.open();
    await page
      .locator('[data-web-shell-user-bubble]')
      .getByText(workspacePath, { exact: true })
      .click();
    await capturePdf(page, info, 'literal-reference');
    await page.getByTestId('chat-header-workspace').click();
    const browser = page.getByTestId('workspace-file-browser');
    const [directory, filename] = workspacePath.split('/');
    await browser
      .getByRole('treeitem', { name: directory, exact: true })
      .click();
    const file = browser.getByRole('treeitem', { name: filename, exact: true });
    await file.click();
    await capturePdf(page, info, 'literal-files');
    await file.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    await expect(browser).toBeHidden();
    await expect(page.getByRole('tab', { selected: true })).toContainText(
      filename,
    );
    await capturePdf(page, info, 'literal-files-tab');
    await page.locator('[data-web-shell-turn-sources-trigger]').click();
    await page
      .locator('[data-web-shell-turn-sources]')
      .getByRole('button', { name: `Open source ${source.title}`, exact: true })
      .click();
    await capturePdf(page, info, 'literal-source');
    expect(mock.byteReads.length).toBeGreaterThan(0);
    expect(mock.byteReads.every((path) => path === workspacePath)).toBe(true);
    expect(mock.textReads).toEqual([]);
  });
}
