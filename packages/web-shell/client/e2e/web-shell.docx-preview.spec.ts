import { expect, test, type Page, type TestInfo } from '@playwright/test';
import JSZip from 'jszip';
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

test.use({ serviceWorkers: 'block' });
const MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const documentPath = 'report.DOCX';
const previewSelector = '[data-web-shell-docx-preview]';

async function documentBytes(
  hostile = false,
  bookmarks = false,
): Promise<Buffer> {
  const zip = new JSZip();
  const paragraph = (text: string) =>
    `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const relationship = (
    id: string,
    kind: string,
    target: string,
    external = false,
  ) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
  const image = (id: string) =>
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Embedded marker"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="marker.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="${MIME.replace('.document', '.document.main+xml')}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('root', 'officeDocument', 'word/document.xml')}</Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('styles', 'styles', 'styles.xml')}${relationship('image', 'image', 'media/marker.png')}${relationship('header', 'header', 'header1.xml')}${relationship('footer', 'footer', 'footer1.xml')}${relationship('link', 'hyperlink', 'https://example.test/docs', true)}${hostile ? relationship('chunk', 'aFChunk', 'hostile.html') + relationship('external', 'image', 'https://docx-attacker.invalid/image.png', true) + relationship('javascript', 'hyperlink', 'javascript:top.__docxAttack=true', true) : ''}</Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>${hostile ? '<w:style w:type="paragraph" w:styleId="Hostile"><w:rPr><w:rFonts w:ascii="Arial; position:fixed; inset:0; background:red"/></w:rPr></w:style>' : ''}</w:styles>`,
  );
  zip.file(
    'word/header1.xml',
    `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph('DOCX header')}</w:hdr>`,
  );
  zip.file(
    'word/footer1.xml',
    `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraph('DOCX footer')}</w:ftr>`,
  );
  zip.file(
    'word/media/marker.png',
    await readFile(
      new URL('../assets/qwen-code-notification.png', import.meta.url),
    ),
  );
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>DOCX preview probe</w:t></w:r></w:p>${paragraph('Readable document body')}<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc>${paragraph('Metric')}</w:tc><w:tc>${paragraph('Value')}</w:tc></w:tr><w:tr><w:tc>${paragraph('Revenue')}</w:tc><w:tc>${paragraph('1234')}</w:tc></w:tr></w:tbl>${image('image')}<w:p><w:hyperlink r:id="link"><w:r><w:t>External reference</w:t></w:r></w:hyperlink></w:p>${bookmarks ? '<w:p><w:hyperlink w:anchor="details"><w:r><w:t>Jump to details</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:bookmarkStart w:id="1" w:name="details"/><w:r><w:t>Bookmark destination</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' : ''}${hostile ? `<w:altChunk r:id="chunk"/>${image('external').replace('r:embed=', 'r:link=')}<w:p><w:pPr><w:pStyle w:val="Hostile"/></w:pPr><w:hyperlink r:id="javascript"><w:r><w:t>JavaScript reference</w:t></w:r></w:hyperlink></w:p>` : ''}<w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360"/></w:sectPr></w:body></w:document>`,
  );
  if (hostile)
    zip.file(
      'word/hostile.html',
      '<style>body{position:fixed;inset:0;background:red}</style><script>top.__docxAttack=true;top.location="https://docx-attacker.invalid/navigation"</script><img src="https://docx-attacker.invalid/chunk.png" onerror="top.__docxAttack=true"><p>ALTCHUNK MUST NOT RENDER</p>',
    );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function artifact(workspacePath = documentPath): DaemonSessionArtifact {
  return {
    id: 'docx-report',
    title: 'Word report',
    kind: 'document',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    workspacePath,
    mimeType: MIME,
    retention: 'ephemeral',
    clientRetained: false,
    toolCallId: 'make-docx',
    toolName: 'Artifact',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  };
}

function referenceEvent(workspacePath = documentPath): DaemonEvent {
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
                id: 'docx-reference',
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

// These responses exercise browser integration, not real daemon filesystem operations.
async function install(
  page: Page,
  info: TestInfo,
  scenario: WebShellDaemonScenario,
  bytes: Buffer,
  workspacePath = documentPath,
) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  const byteReads: string[] = [],
    textReads: string[] = [],
    attachmentReads: string[] = [];
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
      json: { type: 'file', sizeBytes: bytes.length, modifiedMs: 1 },
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

async function pasteDocument(
  page: Page,
  bytes: Buffer,
  name = 'incoming.DOCX',
  mimeType = MIME,
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
    { base64: bytes.toString('base64'), name, mimeType },
  );
  await page
    .locator('[data-web-shell-composer-attachments]')
    .getByRole('button')
    .filter({ hasText: name })
    .first()
    .click();
}

async function captureDocument(page: Page, info: TestInfo, label: string) {
  const preview = page.locator(`${previewSelector}:visible`);
  const iframe = preview.locator('iframe');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveCSS('visibility', 'visible');
  const frame = preview.frameLocator('iframe');
  await expect(
    frame.getByText('DOCX preview probe', { exact: true }),
  ).toBeVisible();
  await expect(frame.getByRole('table')).toContainText('Revenue');
  await expect(
    frame.getByText('DOCX header', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    frame.getByText('DOCX footer', { exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      frame
        .locator('img')
        .first()
        .evaluate(
          (image) =>
            (image as HTMLImageElement).complete &&
            (image as HTMLImageElement).naturalWidth > 0,
        ),
    )
    .toBe(true);
  await iframe.evaluate(async (element) => {
    await (element as HTMLIFrameElement).contentDocument!.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({
    path: info.outputPath(`docx-${label}-mock-daemon.png`),
    animations: 'disabled',
  });
  expect(
    await frame
      .getByText('DOCX preview probe', { exact: true })
      .evaluate((element) => element.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(0);
  await expect(
    frame.getByRole('cell', { name: 'Revenue', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(frame.locator('img').first()).toBeInViewport({ ratio: 1 });
  for (const element of [
    frame.getByRole('cell', { name: 'Revenue', exact: true }),
    frame.locator('img').first(),
  ]) {
    expect(
      await element.evaluate((node) => node.getBoundingClientRect().left),
    ).toBeGreaterThanOrEqual(0);
  }
  const scroll = await frame.locator('body').evaluate(() => {
    const scrolling = document.scrollingElement!;
    const maximum = scrolling.scrollWidth - scrolling.clientWidth;
    scrolling.scrollLeft = maximum;
    return { maximum, actual: scrolling.scrollLeft };
  });
  expect(scroll.maximum).toBeGreaterThan(0);
  expect(scroll.actual).toBe(scroll.maximum);
  expect(
    await frame
      .locator('section.docx')
      .first()
      .evaluate(
        (element) =>
          element.getBoundingClientRect().right <=
          document.documentElement.clientWidth,
      ),
  ).toBe(true);
  if (label === 'artifact')
    await page.screenshot({
      path: info.outputPath('docx-artifact-scroll-right-mock-daemon.png'),
    });
  await frame.locator('body').evaluate(() => {
    document.scrollingElement!.scrollLeft = 0;
  });
  return { preview, frame };
}

for (const mimeType of [MIME, 'application/octet-stream']) {
  test(`previews an unsent DOCX attachment (${mimeType}) without workspace reads`, async ({
    page,
  }, info) => {
    const bytes = await documentBytes();
    const mock = await install(
      page,
      info,
      createWebShellDaemonScenario(),
      bytes,
    );
    await mock.open();
    await pasteDocument(page, bytes, 'incoming.DOCX', mimeType);
    await captureDocument(page, info, 'attachment');
    expect(mock.byteReads).toEqual([]);
    expect(mock.textReads).toEqual([]);
    expect(mock.attachmentReads).toEqual([]);
  });
}

test('previews persisted DOCX attachment bytes from its message', async ({
  page,
}, info) => {
  const bytes = await documentBytes();
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Read this document', { id: 1 }),
      {
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'resource',
              attachmentId: 'incoming.DOCX',
              mimeType: MIME,
              size: bytes.length,
            },
          },
        },
      },
      assistantTextEvent('Document attached.', { id: 3 }),
      turnCompleteEvent('incoming', { id: 4 }),
    ],
  });
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  await page
    .locator('[data-web-shell-user-files]')
    .getByRole('button', { name: /incoming.DOCX/ })
    .click();
  await captureDocument(page, info, 'persisted-attachment');
  expect(mock.attachmentReads).toHaveLength(1);
  expect(mock.byteReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
});

test('previews workspace DOCX artifact and @ reference and downloads original bytes', async ({
  page,
}, info) => {
  const bytes = await documentBytes();
  const scenario = createWebShellDaemonScenario({
    events: [
      referenceEvent(),
      toolCallEvent(
        'make-docx',
        'Artifact',
        { file_path: documentPath },
        { id: 2 },
      ),
      assistantTextEvent('The document is ready.', { id: 3 }),
      turnCompleteEvent('docx-report', { id: 4 }),
    ],
    artifacts: [artifact()],
  });
  scenario.capabilities.features.push('session_artifacts');
  const mock = await install(page, info, scenario, bytes);
  await mock.open();
  await page
    .locator(`[data-web-shell-message-list] [title="${documentPath}"] > button`)
    .click();
  const { preview } = await captureDocument(page, info, 'artifact');
  const pending = page.waitForEvent('download');
  await preview.getByRole('link', { name: /Download/i }).click();
  expect(await readFile((await (await pending).path())!)).toEqual(bytes);
  await page
    .locator('[data-web-shell-user-bubble]')
    .getByText(documentPath, { exact: true })
    .click();
  await captureDocument(page, info, 'reference');
  expect(mock.byteReads.length).toBeGreaterThan(0);
  expect(mock.byteReads.every((path) => path === documentPath)).toBe(true);
  expect(mock.textReads).toEqual([]);
});

for (const [index, workspacePath] of [
  'reports/Q3#final.docx',
  'reports/Q3?final.docx',
  'reports.xlsx#approved/report.docx',
  'reports?approved/report.docx',
].entries()) {
  test(`previews literal DOCX path ${index + 1}: ${workspacePath} in Files, standalone tab, @ and Sources`, async ({
    page,
  }, info) => {
    const bytes = await documentBytes();
    const scenario = createWebShellDaemonScenario();
    const source: SessionSource = {
      id: 'a'.repeat(64),
      kind: 'file',
      title: 'Word reference',
      workspaceCwd: scenario.workspaceCwd,
      locator: { type: 'workspace_file', workspacePath },
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
    };
    scenario.events = [
      referenceEvent(workspacePath),
      toolCallEvent(
        'register-docx',
        'record_source',
        { title: source.title, locator: source.locator },
        { id: 2, rawOutput: { text: `Reference added: ${source.id}` } },
      ),
      assistantTextEvent('Document source ready.', { id: 3 }),
      turnCompleteEvent('docx-source', { id: 4 }),
    ];
    scenario.capabilities.features.push('session_sources');
    const mock = await install(page, info, scenario, bytes, workspacePath);
    await page.route('**/session/*/sources*', (route) =>
      route.fulfill({ json: { revision: 1, sources: [source] } }),
    );
    await mock.open();
    await page
      .locator('[data-web-shell-user-bubble]')
      .getByText(workspacePath, { exact: true })
      .click();
    await captureDocument(page, info, 'literal-reference');
    await page.getByTestId('chat-header-workspace').click();
    const browser = page.getByTestId('workspace-file-browser');
    const [directory, filename] = workspacePath.split('/');
    await browser
      .getByRole('treeitem', { name: directory, exact: true })
      .click();
    const file = browser.getByRole('treeitem', { name: filename, exact: true });
    await file.click();
    await captureDocument(page, info, 'literal-files');
    await file.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    await expect(browser).toBeHidden();
    await expect(page.getByRole('tab', { selected: true })).toContainText(
      filename,
    );
    await captureDocument(page, info, 'literal-files-tab');
    await page.locator('[data-web-shell-turn-sources-trigger]').click();
    await page
      .locator('[data-web-shell-turn-sources]')
      .getByRole('button', { name: `Open source ${source.title}`, exact: true })
      .click();
    await captureDocument(page, info, 'literal-source');
    expect(mock.byteReads.length).toBeGreaterThan(0);
    expect(mock.byteReads.every((path) => path === workspacePath)).toBe(true);
    expect(mock.textReads).toEqual([]);
  });
}

test('isolates hostile DOCX content and blocks document navigation and external resources', async ({
  page,
}, info) => {
  const bytes = await documentBytes(true);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('docx-attacker.invalid') ||
      request.url().includes('example.test/docs')
    )
      externalRequests.push(request.url());
  });
  await page.route('https://docx-attacker.invalid/**', (route) =>
    route.fulfill({ status: 200, body: 'blocked test resource' }),
  );
  const mock = await install(page, info, createWebShellDaemonScenario(), bytes);
  await mock.open();
  const shellStyle = await page.locator('body').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    position: getComputedStyle(element).position,
  }));
  const originalURL = page.url();
  await pasteDocument(page, bytes);
  const { preview, frame } = await captureDocument(page, info, 'hostile');
  await expect(preview.locator('iframe')).toHaveAttribute(
    'sandbox',
    'allow-same-origin',
  );
  await expect(frame.locator('script')).toHaveCount(0);
  await expect(frame.locator('a[href]')).toHaveCount(0);
  await expect(frame.getByText('ALTCHUNK MUST NOT RENDER')).toHaveCount(0);
  const originalFrameURL = await frame
    .locator('body')
    .evaluate(() => location.href);
  await frame.getByText('External reference', { exact: true }).click();
  await frame.getByText('JavaScript reference', { exact: true }).click();
  expect(page.url()).toBe(originalURL);
  expect(await frame.locator('body').evaluate(() => location.href)).toBe(
    originalFrameURL,
  );
  await expect(
    frame.getByText('DOCX preview probe', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, '__docxAttack')),
  ).toBeUndefined();
  expect(
    await page.locator('body').evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      position: getComputedStyle(element).position,
    })),
  ).toEqual(shellStyle);
  expect(externalRequests).toEqual([]);
  expect(mock.byteReads).toEqual([]);
});

test('keeps invalid DOCX downloadable and offers retry', async ({
  page,
}, info) => {
  const bytes = Buffer.from('not a DOCX ZIP');
  const mock = await install(page, info, createWebShellDaemonScenario(), bytes);
  await mock.open();
  await pasteDocument(page, bytes, 'broken.docx');
  const preview = page.locator(`${previewSelector}:visible`);
  await expect(preview.getByRole('alert')).toBeVisible();
  await preview.getByRole('button', { name: /Retry|Try again/i }).click();
  await expect(preview.getByRole('alert')).toBeVisible();
  const pending = page.waitForEvent('download');
  await preview.getByRole('link', { name: /Download/i }).click();
  expect(await readFile((await (await pending).path())!)).toEqual(bytes);
  await page.screenshot({
    path: info.outputPath('docx-invalid-mock-daemon.png'),
  });
});

for (const extension of ['doc', 'docm']) {
  test(`keeps legacy .${extension} artifacts download-only despite DOCX MIME`, async ({
    page,
  }, info) => {
    const workspacePath = `report.${extension}`;
    const bytes = await documentBytes();
    const scenario = createWebShellDaemonScenario({
      events: [
        toolCallEvent(
          'make-docx',
          'Artifact',
          { file_path: workspacePath },
          { id: 1 },
        ),
        assistantTextEvent('The document is ready.', { id: 2 }),
        turnCompleteEvent('legacy-document', { id: 3 }),
      ],
      artifacts: [artifact(workspacePath)],
    });
    scenario.capabilities.features.push('session_artifacts');
    const mock = await install(page, info, scenario, bytes, workspacePath);
    await mock.open();
    await page
      .locator(
        `[data-web-shell-message-list] [title="${workspacePath}"] > button`,
      )
      .click();
    await expect(page.locator(previewSelector)).toHaveCount(0);
    await expect(
      page
        .getByRole('complementary', { name: 'Right panel' })
        .getByRole('button', { name: 'Download', exact: true }),
    ).toBeVisible();
    expect(mock.byteReads).toEqual([]);
    expect(mock.textReads).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`legacy-${extension}-mock-daemon.png`),
    });
  });
}

test('preserves the Sources attachment download name', async ({
  page,
}, info) => {
  const bytes = await documentBytes();
  const attachmentId = 'stored-blob-123';
  const source: SessionSource = {
    id: 'b'.repeat(64),
    kind: 'file',
    title: 'Quarterly report.docx',
    locator: { type: 'attachment', attachmentId },
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  };
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Read the attached report', { id: 1 }),
      {
        id: 2,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'resource',
              attachmentId,
              mimeType: MIME,
              size: bytes.length,
            },
          },
        },
      },
      toolCallEvent(
        'record-attachment',
        'record_source',
        { title: source.title, locator: source.locator },
        { id: 3, rawOutput: { text: `Reference added: ${source.id}` } },
      ),
      assistantTextEvent('Attachment source ready.', { id: 4 }),
      turnCompleteEvent('attachment-source', { id: 5 }),
    ],
  });
  scenario.capabilities.features.push(
    'session_sources',
    'session_attachment_list',
  );
  const mock = await install(page, info, scenario, bytes);
  await page.route('**/session/*/sources*', (route) =>
    route.fulfill({ json: { revision: 1, sources: [source] } }),
  );
  await page.route('**/session/*/attachments', (route) =>
    route.fulfill({
      json: {
        attachments: [
          {
            type: 'resource',
            attachmentId,
            mimeType: MIME,
            size: bytes.length,
          },
        ],
      },
    }),
  );
  await mock.open();
  await page.locator('[data-web-shell-turn-sources-trigger]').click();
  await page
    .locator('[data-web-shell-turn-sources]')
    .getByRole('button', { name: `Open source ${source.title}`, exact: true })
    .click();
  const { preview } = await captureDocument(
    page,
    info,
    'sources-attachment-name',
  );
  const downloadLink = preview.getByRole('link', { name: /Download/i });
  const pending = page.waitForEvent('download');
  await downloadLink.click();
  const download = await pending;
  console.log(
    'SOURCES_DOWNLOAD_OBSERVATION ' +
      JSON.stringify({
        title: source.title,
        attachmentId,
        downloadAttribute: await downloadLink.getAttribute('download'),
        suggestedFilename: download.suggestedFilename(),
      }),
  );
  expect(await readFile((await download.path())!)).toEqual(bytes);
  expect(mock.byteReads).toEqual([]);
  expect(mock.textReads).toEqual([]);
  expect(download.suggestedFilename()).toBe(source.title);
});

test('scrolls an internal DOCX bookmark without navigating either document', async ({
  page,
}, info) => {
  const bytes = await documentBytes(false, true);
  const mock = await install(page, info, createWebShellDaemonScenario(), bytes);
  await mock.open();
  await pasteDocument(page, bytes);
  const { frame, preview } = await captureDocument(
    page,
    info,
    'bookmark-before',
  );
  const destination = frame.getByText('Bookmark destination', { exact: true });
  await expect(destination).not.toBeInViewport();
  const parentURL = page.url();
  const frameURL = await frame.locator('body').evaluate(() => location.href);
  const before = await frame
    .locator('body')
    .evaluate(() => document.scrollingElement!.scrollTop);
  const bookmark = frame.locator('a').filter({ hasText: 'Jump to details' });
  await bookmark.click();
  const after = await frame
    .locator('body')
    .evaluate(() => document.scrollingElement!.scrollTop);
  console.log(
    'BOOKMARK_OBSERVATION ' +
      JSON.stringify({
        before,
        after,
        destinationTop: await destination.evaluate(
          (element) => element.getBoundingClientRect().top,
        ),
        href: await bookmark.getAttribute('href'),
      }),
  );
  await page.screenshot({
    path: info.outputPath('docx-bookmark-after-mock-daemon.png'),
  });
  expect(page.url()).toBe(parentURL);
  expect(await frame.locator('body').evaluate(() => location.href)).toBe(
    frameURL,
  );
  await expect(preview.locator('iframe')).toHaveAttribute(
    'sandbox',
    'allow-same-origin',
  );
  await expect(destination).toBeInViewport();
  expect(after).toBeGreaterThan(before);
});
