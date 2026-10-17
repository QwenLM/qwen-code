import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const controlledName =
  'control-\u202e\u0001\u001b[31m\u00ad\u2060\u{e0041}file.ts';
const controlledDirectory = 'folder-\u202e\u0001';

// UI integration uses a simulated daemon; it does not verify filesystem or Git operations.
async function openFiles(
  page: Page,
  baseURL: string,
  workspaceCwd = '/tmp/qwen-web-shell-e2e',
  afterOpen?: () => Promise<void>,
  primary = true,
  creationEnabled = false,
  deletionEnabled = false,
  uploadEnabled = false,
  fileDeletionEnabled = false,
) {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    capabilities: {
      workspaceCwd: primary ? workspaceCwd : '/tmp/primary',
      workspaces: [
        {
          id: 'files-workspace',
          cwd: workspaceCwd,
          primary,
          trusted: true,
        },
      ],
    },
    events: [
      userTextEvent('Browse the workspace.', { id: 1 }),
      assistantTextEvent('Workspace ready.', { id: 2 }),
      turnCompleteEvent('files-ready', { id: 3 }),
    ],
  });
  if (
    creationEnabled ||
    deletionEnabled ||
    uploadEnabled ||
    fileDeletionEnabled
  )
    scenario.capabilities.features.push(
      ...(creationEnabled
        ? ['workspace_file_write', 'workspace_directory_create']
        : []),
      ...(deletionEnabled ? ['workspace_directory_delete'] : []),
      ...(fileDeletionEnabled ? ['workspace_file_delete'] : []),
      ...(uploadEnabled ? ['workspace_file_upload'] : []),
      'workspace_qualified_rest_core',
    );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installMockDaemon(page, scenario, { baseURL });
  const contents: Record<string, string> = {
    [controlledName]: 'export const originalPath = true;',
    'control-file.ts': 'export const ordinaryPath = true;',
    'notes  draft.md': '# Two spaces',
    [`${controlledDirectory}/child.ts`]: 'export const nestedOriginal = true;',
    'unsupported.lean': 'def unsupported := 42',
    'README.md':
      '# Workspace guide\n\nA rendered **Markdown** document.\n\n- Browse files\n- Read source\n',
    'src/app.ts':
      'export const greeting: string = "Hello, files";\nconsole.log(greeting);\n',
    'index.html': '<h1>Workspace HTML</h1>',
    'broken/recovered.ts': 'export const recovered = true;',
    'src/guide.md': '# Nested guide\n\nA nested document.\n',
    'notes draft.md': '# Draft notes',
    'src/large.ts': Array.from(
      { length: 1500 },
      (_, index) => `export const large${index} = "${'x'.repeat(750)}";`,
    ).join('\n'),
    'src/long.ts': Array.from(
      { length: 5000 },
      (_, index) => `export const line${index} = ${index};`,
    ).join('\n'),
  };
  const deepFolders = Array.from(
    { length: 14 },
    (_, index) => `level-${index}`,
  );
  const deepFile = 'a-long-filename-that-must-stay-readable-at-deep-levels.ts';
  contents[`deep/${deepFolders.join('/')}/${deepFile}`] =
    'export const deep = true;';
  const buffers = Object.fromEntries(
    Object.entries(contents).map(([path, content]) => [
      path,
      Buffer.from(content),
    ]),
  );
  buffers['image.png'] = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSxkAAAAASUVORK5CYII=',
    'base64',
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Summary');
  sheet.addRow(['Files workbook', 42]);
  buffers['report.xlsx'] = Buffer.from(await workbook.xlsx.writeBuffer());
  const directoryReads: string[] = [];
  const byteReads: string[] = [];
  const contentReads: string[] = [];
  let rootUpdated = false;
  let failedReads = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    if (/\/(?:stat|file(?:\/bytes)?)$/.test(url.pathname))
      contentReads.push(url.pathname);
    if (/^(?:\/workspaces\/[^/]+)?\/list$/.test(url.pathname)) {
      directoryReads.push(`${url.pathname}?path=${path}`);
      if (!path) {
        await route.fulfill({
          status: 400,
          json: { error: 'path query parameter is required' },
        });
        return;
      }
      if (path === 'broken' && failedReads++ === 0) {
        await route.fulfill({
          status: 500,
          json: { error: 'Directory temporarily unavailable' },
        });
        return;
      }
      const entries =
        path === '.'
          ? [
              { name: 'src', kind: 'directory', ignored: false },
              { name: controlledDirectory, kind: 'directory', ignored: false },
              { name: 'deep', kind: 'directory', ignored: false },
              { name: 'empty', kind: 'directory', ignored: false },
              { name: 'broken', kind: 'directory', ignored: false },
              { name: 'linked', kind: 'symlink', ignored: false },
              { name: 'README.md', kind: 'file', ignored: false },
              { name: 'index.html', kind: 'file', ignored: false },
              { name: 'image.png', kind: 'file', ignored: false },
              { name: 'report.xlsx', kind: 'file', ignored: false },
              { name: 'legacy.xls', kind: 'file', ignored: false },
              { name: 'notes draft.md', kind: 'file', ignored: false },
              { name: 'notes  draft.md', kind: 'file', ignored: false },
              { name: controlledName, kind: 'file', ignored: false },
              { name: 'control-file.ts', kind: 'file', ignored: false },
              { name: 'unsupported.lean', kind: 'file', ignored: false },
              ...(rootUpdated
                ? [{ name: 'new.txt', kind: 'file', ignored: false }]
                : []),
            ]
          : path === 'src'
            ? [
                ...Array.from({ length: 30 }, (_, index) => ({
                  name: `folder-${String(index).padStart(2, '0')}`,
                  kind: 'directory',
                  ignored: false,
                })),
                { name: 'app.ts', kind: 'file', ignored: false },
                { name: 'guide.md', kind: 'file', ignored: false },
                { name: 'long.ts', kind: 'file', ignored: false },
                { name: 'large.ts', kind: 'file', ignored: false },
              ]
            : path === 'broken'
              ? [{ name: 'recovered.ts', kind: 'file', ignored: false }]
              : path === 'deep' || path.startsWith('deep/')
                ? [
                    {
                      name: deepFolders[path.split('/').length - 1] ?? deepFile,
                      kind:
                        path.split('/').length <= deepFolders.length
                          ? 'directory'
                          : 'file',
                      ignored: false,
                    },
                  ]
                : path === controlledDirectory
                  ? [{ name: 'child.ts', kind: 'file', ignored: false }]
                  : [];
      await route.fulfill({
        json: { kind: 'list', path, entries, truncated: path === '.' },
      });
      return;
    }
    if (/^(?:\/workspaces\/[^/]+)?\/stat$/.test(url.pathname)) {
      await route.fulfill({
        json: {
          kind: 'stat',
          path,
          type: 'file',
          sizeBytes: buffers[path]?.length ?? 0,
          modifiedMs: 1,
        },
      });
      return;
    }
    if (/^(?:\/workspaces\/[^/]+)?\/file\/bytes$/.test(url.pathname)) {
      byteReads.push(`${url.pathname}?path=${path}`);
      const buffer = buffers[path];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const chunk = buffer?.subarray(
        offset,
        offset + Number(url.searchParams.get('maxBytes') ?? buffer.length),
      );
      await route.fulfill(
        buffer
          ? {
              json: {
                path,
                contentBase64: chunk!.toString('base64'),
                offset,
                returnedBytes: chunk!.length,
                sizeBytes: buffer.length,
              },
            }
          : { status: 404, json: { error: 'No such file' } },
      );
      return;
    }
    if (/^(?:\/workspaces\/[^/]+)?\/file$/.test(url.pathname)) {
      const content = contents[path];
      await route.fulfill(
        content === undefined
          ? { status: 404, json: { error: 'No such file' } }
          : {
              json: {
                kind: 'file',
                path,
                content: buffers[path]!.subarray(
                  0,
                  Number(
                    url.searchParams.get('maxBytes') ?? buffers[path]!.length,
                  ),
                ).toString('utf8'),
                encoding: 'utf-8',
                truncated:
                  buffers[path]!.length >
                  Number(
                    url.searchParams.get('maxBytes') ?? buffers[path]!.length,
                  ),
                sizeBytes: buffers[path]!.length,
              },
            },
      );
      return;
    }
    await route.fallback();
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await expect(
    page.getByText('Workspace ready.', { exact: true }),
  ).toBeVisible();
  await page.getByTestId('chat-header-workspace').click();
  await afterOpen?.();
  const browser = page.getByTestId('workspace-file-browser');
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(browser.getByTestId('workspace-file-content')).toBeHidden();
  await expect(browser.getByRole('separator')).toBeHidden();
  const initialTreeBox = (await browser
    .getByTestId('workspace-file-sidebar')
    .boundingBox())!;
  const initialBrowserBox = (await browser.boundingBox())!;
  expect(initialTreeBox.width).toBeCloseTo(initialBrowserBox.width, 0);
  return {
    browser,
    directoryReads,
    byteReads,
    contentReads,
    scenario,
    addRootFile: () => {
      rootUpdated = true;
    },
  };
}

test('@smoke reads a secondary workspace through qualified content endpoints', async ({
  page,
}, testInfo) => {
  const { browser, contentReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
    '/tmp/secondary',
    undefined,
    false,
  );
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  await expect(
    browser.getByRole('heading', { name: 'Workspace guide' }),
  ).toBeVisible();
  await browser
    .getByRole('treeitem', { name: 'image.png', exact: true })
    .click();
  await expect(
    browser.getByRole('img', { name: 'image.png', exact: true }),
  ).toBeVisible();
  for (const suffix of ['/stat', '/file', '/file/bytes'])
    expect(contentReads).toContain('/workspaces/%2Ftmp%2Fsecondary' + suffix);
  expect(
    contentReads.every((path) =>
      path.startsWith('/workspaces/%2Ftmp%2Fsecondary/'),
    ),
  ).toBe(true);
});

test('@smoke opens an Excel preview in a separate workspace file tab', async ({
  page,
}, testInfo) => {
  const { browser, contentReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
    '/tmp/secondary',
    undefined,
    false,
  );
  const workbook = browser.getByRole('treeitem', {
    name: 'report.xlsx',
    exact: true,
  });
  await workbook.click();
  await expect(browser.locator('[data-web-shell-excel-preview]')).toContainText(
    'Files workbook',
  );
  const initialReadCount = contentReads.length;
  for (let attempt = 0; attempt < 2; attempt++) {
    await workbook.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
    await expect(
      page.getByRole('tab', { name: 'report.xlsx', exact: true }),
    ).toHaveCount(1);
    await expect(browser).toBeHidden();
    const preview = page
      .locator('[data-web-shell-excel-preview]')
      .filter({ visible: true });
    await expect(preview).toContainText('Files workbook');
    await expect(preview.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect(browser).toBeVisible();
    await expect(
      browser.locator('[data-web-shell-excel-preview]'),
    ).toContainText('Files workbook');
  }
  expect(contentReads.length).toBeGreaterThan(initialReadCount);
  expect(
    contentReads.every((path) =>
      path.startsWith('/workspaces/%2Ftmp%2Fsecondary/'),
    ),
  ).toBe(true);
  await browser
    .getByRole('treeitem', { name: 'legacy.xls', exact: true })
    .click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Preview', exact: true }),
  ).toHaveCount(0);
});

for (const module of ['WorkspaceFileBrowser', 'PierreFilePreview']) {
  test(`@smoke contains ${module} import failures and reloads successfully`, async ({
    page,
  }, testInfo) => {
    let blocked = true;
    let attempts = 0;
    await page.route(`**/${module}.tsx*`, async (route) => {
      attempts++;
      if (blocked) await route.abort('failed');
      else await route.continue();
    });
    const recover = async () => {
      const panel = page.locator('aside[aria-label="Right panel"]');
      await expect(panel.getByRole('alert')).toBeVisible();
      await expect(
        panel.getByRole('button', { name: 'Close Files', exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.cm-content[contenteditable="true"]'),
      ).toHaveCount(1);
      if (module === 'PierreFilePreview') {
        await expect(
          panel.getByRole('treeitem', { name: 'README.md', exact: true }),
        ).toBeVisible();
      }
      blocked = false;
      await Promise.all([
        page.waitForEvent('load'),
        panel.getByRole('button', { name: 'Reload page', exact: true }).click(),
      ]);
      await expect(page.getByTestId('workspace-file-browser')).toBeVisible();
    };
    const { browser } = await openFiles(
      page,
      String(testInfo.project.use.baseURL),
      '/tmp/qwen-web-shell-e2e',
      module === 'WorkspaceFileBrowser' ? recover : undefined,
    );
    const openSource = async () => {
      await browser
        .getByRole('treeitem', { name: 'README.md', exact: true })
        .click();
      await browser
        .getByRole('button', { name: 'Source', exact: true })
        .click();
    };
    await openSource();
    if (module === 'PierreFilePreview') {
      await recover();
      await openSource();
    }
    await expect(browser.getByTestId('pierre-file-preview')).toContainText(
      '# Workspace guide',
    );
    expect(attempts).toBeGreaterThan(1);
  });
}

for (const fullscreen of [false, true]) {
  test(`@smoke tabs through the file tree in a ${fullscreen ? 'fullscreen ' : ''}drawer`, async ({
    page,
  }, testInfo) => {
    const { browser } = await openFiles(
      page,
      String(testInfo.project.use.baseURL),
    );
    await page.setViewportSize({ width: 430, height: 900 });
    await expect(page.locator('[data-slot="drawer-content"]')).toBeVisible();
    if (fullscreen)
      await page
        .getByRole('button', { name: 'Fullscreen', exact: true })
        .click();
    if (fullscreen)
      await expect(
        page.getByRole('button', { name: 'Exit fullscreen', exact: true }),
      ).toBeVisible();
    const filter = browser.getByRole('textbox', { name: 'Filter files…' });
    await page
      .locator('[data-slot="drawer-content"]')
      .evaluate(async (node) => {
        await Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        );
      });
    const row = browser.getByRole('treeitem', { name: 'broken', exact: true });
    await filter.focus();
    await page.keyboard.press('Tab');
    await expect(row).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(filter).toBeFocused();
  });
}

test('@smoke filters loaded paths without changing input or fetching directories', async ({
  page,
}, testInfo) => {
  const { browser, directoryReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const tree = browser.getByTestId('workspace-file-sidebar');
  await expect(
    tree.getByRole('tree', { name: 'Files', exact: true }),
  ).toBeVisible();
  const filter = tree.getByRole('textbox', { name: 'Filter files…' });
  const initialReadCount = directoryReads.length;
  await filter.fill('Read ');
  await expect(filter).toHaveValue('Read ');
  await expect(
    tree.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await filter.fill('not-a-loaded-path');
  await expect(
    tree.getByRole('status').filter({ hasText: 'No matches in loaded paths' }),
  ).toBeVisible();
  await expect(tree.getByRole('treeitem')).toHaveCount(0);
  await filter.fill('src');
  await expect(
    tree.getByRole('treeitem', { name: 'src', exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(
    directoryReads.every(
      (read) => read === '/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/list?path=.',
    ),
  ).toBe(true);
  expect(directoryReads.length).toBe(initialReadCount);
  await filter.fill('');
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await expect(
    tree.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeVisible();
  await filter.fill('APP');
  await expect(filter).toHaveValue('APP');
  await filter.fill('src\\APP');
  await expect(filter).toHaveValue('src\\APP');
  await tree.getByRole('treeitem', { name: 'app.ts', exact: true }).click();
  await expect(filter).toHaveValue('');
  for (const mode of ['dock', 'fullscreen', 'drawer']) {
    if (mode === 'fullscreen') {
      await page
        .getByRole('button', { name: 'Fullscreen', exact: true })
        .click();
    } else if (mode === 'drawer') {
      await page.setViewportSize({ width: 430, height: 900 });
      await expect(
        page.getByRole('dialog', { name: 'Right panel', exact: true }),
      ).toBeVisible();
    }
    await filter.fill('not-a-loaded-path');
    await expect(tree.getByRole('treeitem')).toHaveCount(0);
    for (const isComposing of [true, false]) {
      await filter.dispatchEvent('keydown', {
        key: 'Escape',
        isComposing,
        keyCode: 229,
      });
      await expect(filter).toHaveValue('not-a-loaded-path');
    }
    await expect(filter).toHaveValue('not-a-loaded-path');
    await expect(browser).toBeVisible();
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(browser).toBeVisible();
    await expect(
      tree.getByRole('treeitem', { name: 'src', exact: true }),
    ).toBeVisible();
    if (mode === 'fullscreen') {
      await expect(
        page.getByRole('button', { name: 'Exit fullscreen', exact: true }),
      ).toBeVisible();
      await filter.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Fullscreen', exact: true }),
      ).toBeVisible();
    } else if (mode === 'drawer') {
      await filter.press('Escape');
      await expect(browser).toBeHidden();
    }
  }
});

test('@smoke browses files with Pierre, previews Markdown and source, and restores the workspace tab', async ({
  page,
}, testInfo) => {
  const { browser, directoryReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const tree = browser.getByTestId('workspace-file-sidebar');
  const content = browser.getByTestId('workspace-file-content');
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(
    content.getByRole('heading', { name: 'Workspace guide' }),
  ).toBeVisible();
  const contentBox = await content.boundingBox();
  const treeBox = await tree.boundingBox();
  expect(contentBox!.x + contentBox!.width).toBeLessThanOrEqual(treeBox!.x + 1);

  await browser.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(content.getByTestId('pierre-file-preview')).toContainText(
    '# Workspace guide',
  );
  await browser.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    content.getByRole('heading', { name: 'Workspace guide' }),
  ).toBeVisible();
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'app.ts', exact: true }).click();
  await expect(content.getByTestId('pierre-file-preview')).toContainText(
    'Hello, files',
  );
  await expect(content.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(content.locator('[data-line] span[style]')).not.toHaveCount(0);
  await expect(
    tree.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    tree.getByRole('treeitem', { name: 'folder-29', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    tree.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeFocused();

  await tree.locator('[data-file-tree-virtualized-scroll]').evaluate((node) => {
    node.scrollTop = 0;
  });
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  expect(
    directoryReads.filter((read) => read.endsWith('path=src')),
  ).toHaveLength(1);
  expect(directoryReads.every((read) => read.startsWith('/workspaces/'))).toBe(
    true,
  );
  await tree.getByRole('textbox', { name: 'Filter files…' }).fill('app');
  await expect(
    tree.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toHaveCount(0);
  await expect(
    tree.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeVisible();
  await tree.getByRole('treeitem', { name: 'app.ts', exact: true }).click();
  await expect(
    tree.getByRole('textbox', { name: 'Filter files…' }),
  ).toHaveValue('');
  await browser
    .getByRole('button', { name: 'Toggle file tree', exact: true })
    .click();
  await expect(tree).toBeHidden();
  await expect(content.getByTestId('pierre-file-preview')).toBeVisible();
  await browser
    .getByRole('button', { name: 'Toggle file tree', exact: true })
    .click();
  await expect(tree).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('workspace-file-browser')).toBeVisible();
  await expect(
    page
      .getByTestId('workspace-file-browser')
      .getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Files', exact: true }),
  ).toHaveCount(1);
});

test('retains the expanded tree, selected source and scroll position across tab switches', async ({
  page,
}, testInfo) => {
  const { browser, directoryReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const tree = browser.getByTestId('workspace-file-sidebar');
  const content = browser.getByTestId('workspace-file-content');
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await expect(
    tree.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeVisible();
  await tree.getByRole('treeitem', { name: 'guide.md', exact: true }).click();
  await browser.getByRole('button', { name: 'Source', exact: true }).click();
  const source = content.getByTestId('pierre-file-preview');
  await expect(source).toContainText('# Nested guide');
  const separator = browser.getByRole('separator', {
    name: 'Resize file preview and tree',
  });
  await expect
    .poll(async () => (await tree.boundingBox())!.width)
    .toBeLessThan((await browser.boundingBox())!.width * 0.5);
  const beforeWidth = (await tree.boundingBox())!.width;
  const handleBox = (await separator.boundingBox())!;
  await page.mouse.move(handleBox.x, handleBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 80, handleBox.y + 50, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await tree.boundingBox())!.width)
    .toBeGreaterThan(beforeWidth + 50);
  const draggedWidth = (await tree.boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await tree.boundingBox())!.width)
    .toBeLessThan(draggedWidth - 1);
  const resizedWidth = (await tree.boundingBox())!.width;
  expect(resizedWidth).toBeGreaterThan(150);
  const scroll = tree.locator('[data-file-tree-virtualized-scroll]');
  const scrollTop = await scroll.evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  const readsBefore = directoryReads.length;
  await tree
    .getByRole('treeitem', { name: 'guide.md', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await expect(browser).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Nested guide' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(source).toContainText('# Nested guide');
  await expect(
    browser.getByRole('button', { name: 'Preview', exact: true }),
  ).toBeVisible();
  expect(await scroll.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  expect(directoryReads).toHaveLength(readsBefore);
  expect((await tree.boundingBox())!.width).toBeCloseTo(resizedWidth, 0);
  expect(
    await tree.evaluate((node) => getComputedStyle(node).paddingBottom),
  ).toBe('12px');
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(
    tree.getByRole('treeitem', { name: 'src', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('textbox', { name: 'Filter files…' }).fill('app');
  await page.getByRole('tab', { name: 'src/guide.md', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(
    tree.getByRole('textbox', { name: 'Filter files…' }),
  ).toHaveValue('app');
  await expect(
    tree.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeVisible();
});

test('@smoke handles empty folders, directory errors, truncation, refresh, and narrow panels', async ({
  page,
}, testInfo) => {
  const { browser, directoryReads, addRootFile } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const tree = browser.getByTestId('workspace-file-sidebar');
  await expect(
    tree.getByText('Only the first 2,000 entries are shown'),
  ).toBeVisible();
  await tree.getByRole('treeitem', { name: 'empty', exact: true }).click();
  await expect(tree.getByText('Empty folder', { exact: true })).toBeVisible();
  await tree.getByRole('treeitem', { name: 'broken', exact: true }).click();
  await expect(tree.getByRole('alert')).toContainText(
    'Directory temporarily unavailable',
  );
  const failedReadCount = directoryReads.filter((read) =>
    read.endsWith('path=broken'),
  ).length;
  await tree.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(tree.getByRole('alert')).toHaveCount(0);
  await expect(
    tree.getByRole('treeitem', { name: 'recovered.ts', exact: true }),
  ).toBeVisible();
  expect(
    directoryReads.filter((read) => read.endsWith('path=broken')),
  ).toHaveLength(failedReadCount + 1);
  await tree.getByRole('treeitem', { name: 'linked', exact: true }).click();
  await expect(browser.getByTestId('workspace-file-content')).toContainText(
    'No such file',
  );
  expect(directoryReads.some((read) => read.endsWith('path=linked'))).toBe(
    false,
  );
  await expect(
    tree.getByRole('treeitem', { name: 'new.txt', exact: true }),
  ).toHaveCount(0);
  addRootFile();
  await browser.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    tree.getByRole('treeitem', { name: 'new.txt', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(
    page.getByRole('dialog', { name: 'Right panel', exact: true }),
  ).toBeVisible();
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(
    browser.getByRole('button', { name: 'Toggle file tree', exact: true }),
  ).toBeVisible();
  await browser
    .getByRole('button', { name: 'Toggle file tree', exact: true })
    .click();
  await expect(tree).toBeHidden();
  await expect(
    browser.getByRole('button', { name: 'Toggle file tree', exact: true }),
  ).toBeInViewport();
});

test('virtualizes a long source file and keeps its final lines reachable', async ({
  page,
}, testInfo) => {
  const { browser } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await browser.getByRole('treeitem', { name: 'src', exact: true }).click();
  await browser
    .getByRole('textbox', { name: 'Filter files…', exact: true })
    .fill('src/long.ts');
  await browser.getByRole('treeitem', { name: 'long.ts', exact: true }).click();
  const source = browser.getByTestId('pierre-file-preview');
  await expect(source).toContainText('export const line0');
  expect(await source.locator('[data-line]').count()).toBeGreaterThan(0);
  expect(await source.locator('[data-line]').count()).toBeLessThan(500);
  await source.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(source).toContainText('export const line4999');
  const scrollTop = await source.evaluate((node) => node.scrollTop);
  await page.getByRole('tab', { name: 'README.md', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(source).toContainText('export const line4999');
  expect(await source.evaluate((node) => node.scrollTop)).toBe(scrollTop);
});

test('@smoke keeps large source files readable without tokenizing the entire text', async ({
  page,
}, testInfo) => {
  const { browser, byteReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  await browser.getByRole('treeitem', { name: 'src', exact: true }).click();
  await browser
    .getByRole('treeitem', { name: 'large.ts', exact: true })
    .click();
  const source = browser.getByTestId('pierre-file-preview');
  await expect
    .poll(
      () =>
        byteReads.filter((path) => path.endsWith('path=src/large.ts')).length,
    )
    .toBeGreaterThan(1);
  await expect(source).toContainText('export const large0');
  await expect(source.locator('[data-line] span[style]')).toHaveCount(0);
  expect(await source.locator('[data-line]').count()).toBeGreaterThan(0);
  expect(await source.locator('[data-line]').count()).toBeLessThan(500);
});

for (const [cwd, absolutePath] of [
  ['/tmp/work\\space\\', '/tmp/work\\space\\/README.md'],
  ['C:\\work\\space\\', 'C:\\work\\space\\README.md'],
  ['\\\\server\\share\\work', '\\\\server\\share\\work\\README.md'],
]) {
  test(`copies absolute paths using the workspace platform (${cwd})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copied: string }).copied = text;
          },
        },
      });
    });
    const { browser } = await openFiles(
      page,
      String(testInfo.project.use.baseURL),
      cwd,
    );
    await browser
      .getByRole('treeitem', { name: 'README.md', exact: true })
      .click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Copy absolute path', exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { copied: string }).copied),
      )
      .toBe(absolutePath);
  });
}

test('offers file context actions, previews images and HTML, and references a file in the composer', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  const { browser } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const content = browser.getByTestId('workspace-file-content');
  const rightClick = async (name: string) => {
    await browser
      .getByRole('treeitem', { name, exact: true })
      .and(browser.locator(`[data-item-path="${name}"]`))
      .click({ button: 'right' });
    await expect(
      page.getByRole('menuitem', { name: 'Copy relative path', exact: true }),
    ).toBeVisible();
  };
  await rightClick('README.md');
  await page
    .getByRole('menuitem', { name: 'Copy relative path', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { copied: string }).copied),
    )
    .toBe('README.md');
  await rightClick('README.md');
  await expect(
    page.getByRole('menu', { name: 'Files: README.md', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('menuitem', { name: 'Copy absolute path', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { copied: string }).copied),
    )
    .toBe('/tmp/qwen-web-shell-e2e/README.md');
  await rightClick('README.md');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('README.md');
  expect(await readFile((await download.path())!, 'utf8')).toContain(
    '# Workspace guide',
  );
  await browser
    .getByRole('treeitem', { name: 'image.png', exact: true })
    .click();
  const image = content.getByRole('img', { name: 'image.png', exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(1);
  await rightClick('image.png');
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'image.png', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('img', { name: 'image.png', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await rightClick('index.html');
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="Preview index.html"]')
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Workspace HTML' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await rightClick('README.md');
  await page.getByRole('menuitem', { name: 'Preview', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Workspace guide' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const treeFocusRow = browser.locator('[role="treeitem"][tabindex="0"]');
  await browser.getByRole('textbox', { name: 'Filter files…' }).click();
  await page.keyboard.press('Tab');
  await expect(treeFocusRow).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('tab', { name: 'Files', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(treeFocusRow).toBeFocused();
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    browser.locator('[role="treeitem"][data-item-path="notes draft.md"]'),
  ).toBeFocused();
  await rightClick('notes draft.md');
  await page.getByRole('menuitem', { name: 'Reference', exact: true }).click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toContainText('notes draft.md');
  await expect(editor).toBeFocused();
  await rightClick('README.md');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect
    .poll(() =>
      browser
        .getByRole('tree')
        .evaluate((node) => node.matches(':focus-within')),
    )
    .toBe(true);
  expect(pageErrors).toEqual([]);
});

for (const fullscreen of [false, true]) {
  test(`returns to the composer after referencing a file from a ${fullscreen ? 'fullscreen ' : ''}drawer @smoke`, async ({
    page,
  }, testInfo) => {
    const { browser } = await openFiles(
      page,
      String(testInfo.project.use.baseURL),
    );
    await page.setViewportSize({ width: 430, height: 1000 });
    const drawer = page.getByRole('dialog', {
      name: 'Right panel',
      exact: true,
    });
    await expect(drawer).toBeVisible();
    if (fullscreen) {
      await drawer
        .getByRole('button', { name: 'Fullscreen', exact: true })
        .click();
    }
    await browser
      .getByRole('treeitem', { name: 'README.md', exact: true })
      .click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Reference', exact: true })
      .click();
    await expect(drawer).toHaveCount(0);
    const editor = page.locator('.cm-content[contenteditable="true"]');
    await expect(editor).toContainText('README.md');
    await expect(editor).toBeFocused();
    await editor.click({ trial: true });
    await page.keyboard.type('continue typing', { delay: 50 });
    await expect(editor).toContainText('continue typing');
    await expect(editor).toBeFocused();
  });
}

test('scrolls the entire deep tree horizontally without squeezing names', async ({
  page,
}, testInfo) => {
  const { browser } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const tree = browser.getByTestId('workspace-file-sidebar');
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'deep', exact: true }).click();
  for (let index = 0; index < 14; index++) {
    await tree
      .getByRole('treeitem', { name: `level-${index}`, exact: true })
      .click();
  }
  const leaf = tree.getByRole('treeitem', {
    name: 'a-long-filename-that-must-stay-readable-at-deep-levels.ts',
    exact: true,
  });
  await expect(leaf).toBeAttached();
  const scroll = tree.locator('[data-file-tree-virtualized-scroll]');
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeGreaterThan(200);
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.scrollLeft = node.scrollWidth;
  });
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(200);
  await expect(leaf).toBeInViewport();
  const name = leaf.locator('[data-item-section="content"]');
  expect(
    await name.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  const leafBox = (await name.boundingBox())!;
  const treeBox = (await tree.boundingBox())!;
  expect(leafBox.x + leafBox.width).toBeLessThanOrEqual(
    treeBox.x + treeBox.width,
  );

  await leaf.click();
  await expect(browser.getByTestId('workspace-file-content')).toContainText(
    'export const deep = true',
  );
  await leaf.click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Copy relative path', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(leaf).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(
    tree.getByRole('treeitem', { name: 'level-13', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(leaf).toBeFocused();
});

test('@smoke cleans tree labels while keeping distinct raw file and directory paths', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  const { browser, directoryReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const rows = browser.getByRole('treeitem', {
    name: 'control-file.ts',
    exact: true,
  });
  await expect(rows).toHaveCount(2);
  const identities = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-item-path')),
  );
  expect(new Set(identities)).toEqual(
    new Set([controlledName, 'control-file.ts']),
  );
  for (let index = 0; index < 2; index++) {
    const row = rows.nth(index);
    const path = identities[index]!;
    await expect(row).toHaveAttribute('aria-label', 'control-file.ts');
    for (const character of [
      '\u0001',
      '\u001b',
      '\u202e',
      '\u00ad',
      '\u2060',
      '\u{e0041}',
    ])
      expect(await row.textContent()).not.toContain(character);
    await row.click();
    await expect(browser.getByTestId('pierre-file-preview')).toContainText(
      path === controlledName ? 'originalPath' : 'ordinaryPath',
    );
    await row.click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Copy relative path', exact: true })
      .click();
    expect(
      await page.evaluate(
        () => (window as unknown as { copied: string }).copied,
      ),
    ).toBe(path);
    await row.click({ button: 'right' });
    await page
      .getByRole('menuitem', { name: 'Copy absolute path', exact: true })
      .click();
    expect(
      await page.evaluate(
        () => (window as unknown as { copied: string }).copied,
      ),
    ).toBe(`/tmp/qwen-web-shell-e2e/${path}`);
  }
  const filter = browser.getByRole('textbox', {
    name: 'Filter files…',
    exact: true,
  });
  await filter.fill('control-file.ts');
  await expect(rows).toHaveCount(2);
  await expect(browser.getByText('No matches in loaded paths')).toBeHidden();
  await filter.fill('notes  draft.md');
  const spaced = browser.locator(
    '[role="treeitem"][data-item-path="notes  draft.md"]',
  );
  await expect(spaced).toHaveAttribute('aria-label', 'notes  draft.md');
  expect(
    await spaced
      .locator('[data-truncate-content="visible"]')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent).join('')),
  ).toBe('notes  draft.md');
  expect(
    await spaced
      .locator('[data-truncate-content="visible"]')
      .first()
      .evaluate((node) => getComputedStyle(node).whiteSpace),
  ).toBe('pre');
  await filter.fill('');
  await browser.getByRole('treeitem', { name: 'folder-', exact: true }).click();
  await browser
    .getByRole('treeitem', { name: 'child.ts', exact: true })
    .click();
  await expect(browser.getByTestId('pierre-file-preview')).toContainText(
    'nestedOriginal',
  );
  expect(
    directoryReads.some((read) => read.endsWith(`path=${controlledDirectory}`)),
  ).toBe(true);
});

test('@smoke closes inline content to a full-width tree and reopens the same file', async ({
  page,
}, testInfo) => {
  const { browser, directoryReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  await browser.getByRole('treeitem', { name: 'folder-', exact: true }).click();
  const file = browser.getByRole('treeitem', { name: 'child.ts', exact: true });
  const tree = browser.getByTestId('workspace-file-sidebar');
  const content = browser.getByTestId('workspace-file-content');
  for (const hideTree of [false, true]) {
    await file.click();
    await expect(content).toBeVisible();
    if (hideTree)
      await browser
        .getByRole('button', { name: 'Toggle file tree', exact: true })
        .click();
    await browser
      .getByRole('button', { name: 'Close file preview', exact: true })
      .click();
    await expect(content).toBeHidden();
    await expect(browser.getByRole('separator')).toBeHidden();
    await expect(file).toBeVisible();
    await expect(
      browser.getByRole('textbox', { name: 'Filter files…', exact: true }),
    ).toBeFocused();
    await expect
      .poll(async () => (await tree.boundingBox())!.width)
      .toBeCloseTo((await browser.boundingBox())!.width, 0);
  }
  expect(
    directoryReads.filter((read) =>
      read.endsWith(`path=${controlledDirectory}`),
    ),
  ).toHaveLength(1);
  await file.click();
  await expect(browser.getByTestId('pierre-file-preview')).toContainText(
    'nestedOriginal',
  );
});

test('@smoke renders unsupported source as plain text on a cold load', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { browser } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  await browser
    .getByRole('treeitem', { name: 'unsupported.lean', exact: true })
    .click();
  const source = browser.getByTestId('pierre-file-preview');
  await expect(source).toContainText('def unsupported := 42');
  await expect(source.locator('[data-line] span[style]')).toHaveCount(0);
  expect(await source.locator('[data-line]').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('@smoke creates root files and folders with toolbar actions', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    false,
    true,
  );
  await expect(
    browser
      .getByRole('button', { name: 'Refresh', exact: true })
      .locator('svg'),
  ).toHaveClass(/lucide-rotate-cw/);
  await expect(
    browser
      .getByRole('button', { name: 'New file', exact: true })
      .locator('svg'),
  ).toHaveClass(/lucide-sticky-note-plus/);
  await browser.getByRole('treeitem', { name: 'deep', exact: true }).click();
  const calls: { url: string; body: unknown }[] = [];
  for (const endpoint of ['file/write', 'directory/create'])
    await page.route(`**/${endpoint}`, async (route) => {
      calls.push({
        url: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      await route.fulfill({
        status: 201,
        json: { path: route.request().postDataJSON().path },
      });
    });
  for (const [label, name] of [
    ['New file', 'root.txt'],
    ['New folder', 'root-folder'],
  ]) {
    await browser.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: label, exact: true });
    await expect(
      dialog.getByRole('textbox', { name: 'Name', exact: true }),
    ).toBeFocused();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      browser.getByRole('treeitem', { name, exact: true }),
    ).toBeVisible();
  }
  expect(calls).toEqual([
    {
      url: '/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/file/write',
      body: { path: 'root.txt', content: '', mode: 'create' },
    },
    {
      url: '/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/directory/create',
      body: { path: 'root-folder' },
    },
  ]);
  await expect(
    browser.getByRole('treeitem', { name: 'level-0', exact: true }),
  ).toBeVisible();
  await browser.screenshot({
    path: test.info().outputPath('create-toolbar-completed.png'),
  });
});

test('@smoke folder trailing menu creates inside that folder', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  const folder = browser.getByRole('treeitem', { name: 'src', exact: true });
  const calls: string[] = [];
  for (const endpoint of ['file/write', 'directory/create'])
    await page.route(`**/${endpoint}`, async (route) => {
      calls.push(route.request().postDataJSON().path);
      await route.fulfill({ status: 201, json: { path: calls.at(-1) } });
    });
  for (const [label, name] of [
    ['New file', 'nested.txt'],
    ['New folder', 'nested-folder'],
  ]) {
    await folder.hover();
    await browser.getByRole('button', { name: 'Options', exact: true }).click();
    await expect(
      page.getByRole('menuitem', { name: label, exact: true }),
    ).toBeVisible();
    await page
      .getByRole('menu')
      .screenshot({ path: test.info().outputPath('create-folder-menu.png') });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: label, exact: true });
    await expect(dialog).toContainText('/tmp/qwen-web-shell-e2e/src');
    await dialog.screenshot({
      path: test.info().outputPath('create-dialog.png'),
    });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();
    const filter = browser.getByRole('textbox', { name: 'Filter files…' });
    await filter.fill(name);
    await expect(
      browser.getByRole('treeitem', { name, exact: true }),
    ).toBeVisible();
    await filter.fill('');
  }
  expect(calls).toEqual(['src/nested.txt', 'src/nested-folder']);
  const filter = browser.getByRole('textbox', { name: 'Filter files…' });
  await filter.fill('app.ts');
  await expect(
    browser.getByRole('treeitem', { name: 'app.ts', exact: true }),
  ).toBeVisible();
  await filter.fill('');
  await folder.focus();
  await page.keyboard.press('Shift+F10');
  await expect(
    page.getByRole('menuitem', { name: 'New file', exact: true }),
  ).toBeVisible();
});

test('@smoke validates names, cancels and keeps creation errors retryable', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  let calls = 0;
  let finish!: () => void;
  await page.route('**/file/write', async (route) => {
    calls++;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await route.fulfill({
        status: 409,
        json: { error: 'File already exists' },
      });
    } else
      await route.fulfill({
        status: 201,
        json: { path: route.request().postDataJSON().path },
      });
  });
  await browser.getByRole('button', { name: 'New file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New file', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('../escape.txt');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('single name');
  expect(calls).toBe(0);
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden();
  expect(calls).toBe(0);
  await browser.getByRole('button', { name: 'New file', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('conflict.txt');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await expect(
    dialog.getByRole('button', { name: 'Creating…', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: /^cancel$/i }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  finish();
  await expect(dialog.getByRole('alert')).toContainText('File already exists');
  await expect(
    browser.getByRole('treeitem', {
      name: 'conflict.txt',
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('retry.txt');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(calls).toBe(2);
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(
    browser.getByRole('treeitem', { name: 'retry.txt', exact: true }),
  ).toBeVisible();
});

test('@smoke does not offer creation without capabilities', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(page, baseURL!);
  await expect(
    browser.getByRole('button', { name: 'New file', exact: true }),
  ).toHaveCount(0);
  await expect(
    browser.getByRole('button', { name: 'New folder', exact: true }),
  ).toHaveCount(0);
  const folder = browser.getByRole('treeitem', { name: 'src', exact: true });
  await folder.hover();
  await expect(
    browser.getByRole('button', { name: 'Options', exact: true }),
  ).toHaveCount(0);
  await folder.click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'New file', exact: true }),
  ).toHaveCount(0);
});

test('@smoke merges a late empty listing after creating in a folder', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  let release!: () => void;
  let listingPending = false;
  await page.route('**/list?path=empty', async (route) => {
    listingPending = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: { kind: 'list', path: 'empty', entries: [], truncated: false },
    });
  });
  await page.route('**/file/write', (route) =>
    route.fulfill({ status: 201, json: { path: 'empty/new.txt' } }),
  );
  const folder = browser.getByRole('treeitem', { name: 'empty', exact: true });
  await folder.click();
  await expect.poll(() => listingPending).toBe(true);
  await folder.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New file', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('new.txt');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  const listingResponse = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get('path') === 'empty',
  );
  release();
  await (await listingResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    browser.getByRole('treeitem', { name: 'new.txt', exact: true }),
  ).toBeVisible();
  await expect(
    browser.getByText('empty: Empty folder', { exact: true }),
  ).toHaveCount(0);
});

test('@smoke restores folder focus after cancelling or completing creation', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  const folder = browser.getByRole('treeitem', { name: 'empty', exact: true });
  const open = async () => {
    await folder.hover();
    await browser.getByRole('button', { name: 'Options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'New file', exact: true });
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden();
  await expect(folder).toBeFocused();
  await page.route('**/file/write', (route) =>
    route.fulfill({ status: 201, json: { path: 'empty/focus.txt' } }),
  );
  await open();
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('focus.txt');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(folder).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(
    browser.getByRole('treeitem', { name: 'focus.txt', exact: true }),
  ).toBeVisible();
});

async function openFolderDelete(
  page: Page,
  browser: ReturnType<Page['getByTestId']>,
  name: string,
) {
  const folder = browser.getByRole('treeitem', { name, exact: true });
  await folder.hover();
  await browser.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  return page.getByRole('alertdialog', { name: 'Delete folder?', exact: true });
}

test('@smoke confirms recursive folder deletion and preserves other expansion', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    false,
    true,
    true,
  );
  const calls: { url: string; body: unknown }[] = [];
  await page.route('**/directory/delete', async (route) => {
    calls.push({
      url: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    await route.fulfill({ json: { kind: 'directory_delete', path: 'deep' } });
  });
  const src = browser.getByRole('treeitem', { name: 'src', exact: true });
  await src.click();
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  const deep = browser.getByRole('treeitem', { name: 'deep', exact: true });
  await deep.click();
  await expect(
    browser.getByRole('treeitem', { name: 'level-0', exact: true }),
  ).toBeVisible();
  const dialog = await openFolderDelete(page, browser, 'deep');
  await expect(dialog).toContainText(
    'all its contents will be permanently deleted',
  );
  await expect(dialog).toContainText('This action cannot be undone');
  await expect(dialog.getByText('deep', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^cancel$/i })).toBeFocused();
  await expect(dialog).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: test.info().outputPath('folder-delete-confirmation.png'),
  });
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(deep).toBeFocused();
  expect(calls).toHaveLength(0);
  await openFolderDelete(page, browser, 'deep');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(calls).toHaveLength(0);
  await openFolderDelete(page, browser, 'deep');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(deep).toHaveCount(0);
  await expect(
    browser.getByRole('treeitem', { name: 'level-0', exact: true }),
  ).toHaveCount(0);
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await expect(
    browser.locator('[role="treeitem"][tabindex="0"]'),
  ).toBeFocused();
  expect(calls).toEqual([
    {
      url: '/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/directory/delete',
      body: { path: 'deep' },
    },
  ]);
  await page.screenshot({
    path: test.info().outputPath('folder-delete-completed.png'),
  });
});

test('@smoke keeps folder deletion busy and failures retryable', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    true,
  );
  let release!: () => void;
  let calls = 0;
  await page.route('**/directory/delete', async (route) => {
    calls++;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 500,
        json: { error: 'Folder could not be removed' },
      });
    } else await route.fulfill({ json: { path: 'empty' } });
  });
  const dialog = await openFolderDelete(page, browser, 'empty');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Deleting…', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: /^cancel$/i }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect(calls).toBe(1);
  release();
  await expect(dialog.getByRole('alert')).toContainText(
    'Folder could not be removed',
  );
  await expect(
    browser.getByRole('treeitem', {
      name: 'empty',
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    browser.getByRole('treeitem', { name: 'empty', exact: true }),
  ).toHaveCount(0);
  expect(calls).toBe(2);
});

test('@smoke drops a late descendant listing after folder deletion', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    true,
  );
  let release!: () => void;
  let pending = false;
  await page.route('**/list?path=empty', async (route) => {
    pending = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        kind: 'list',
        path: 'empty',
        entries: [{ name: 'ghost.txt', kind: 'file', ignored: false }],
        truncated: false,
      },
    });
  });
  await page.route('**/directory/delete', (route) =>
    route.fulfill({ json: { path: 'empty' } }),
  );
  await browser.getByRole('treeitem', { name: 'empty', exact: true }).click();
  await expect.poll(() => pending).toBe(true);
  const dialog = await openFolderDelete(page, browser, 'empty');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden();
  const response = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get('path') === 'empty',
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    browser.getByRole('treeitem', { name: 'empty', exact: true }),
  ).toHaveCount(0);
  await expect(
    browser.getByRole('treeitem', { name: 'ghost.txt', exact: true }),
  ).toHaveCount(0);
});

test('@smoke only offers folder deletion with its capability', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  await browser
    .getByRole('treeitem', { name: 'empty', exact: true })
    .click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'New file', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'New folder', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
});

test('@smoke centers the initial Files loading label horizontally', async ({
  page,
  baseURL,
}) => {
  let release!: () => void;
  await page.route('**/WorkspaceFileBrowser.tsx*', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await openFiles(page, baseURL!, undefined, async () => {
    const loading = page
      .getByRole('status')
      .filter({ hasText: /^Loading(?:\.\.\.|…)$/ });
    await expect(loading).toBeVisible();
    expect(
      await loading.evaluate((node) => getComputedStyle(node).textAlign),
    ).toBe('center');
    await page.screenshot({
      path: test.info().outputPath('files-loading-centered.png'),
    });
    release();
  });
});

test('@smoke closes the preview of a deleted folder descendant', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
    true,
  );
  await page.route('**/directory/delete', (route) =>
    route.fulfill({ json: { path: 'src' } }),
  );
  const src = browser.getByRole('treeitem', { name: 'src', exact: true });
  await src.click();
  const filter = browser.getByRole('textbox', {
    name: 'Filter files…',
    exact: true,
  });
  await filter.fill('app.ts');
  await browser.getByRole('treeitem', { name: 'app.ts', exact: true }).click();
  await expect(browser.getByTestId('workspace-file-content')).toBeVisible();
  await filter.clear();
  const dialog = await openFolderDelete(page, browser, 'src');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(src).toHaveCount(0);
  await expect(browser.getByTestId('workspace-file-content')).toBeHidden();
  await expect(browser.getByRole('separator')).toBeHidden();
});

test('@smoke preserves an unrelated preview after folder deletion', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
    true,
  );
  await page.route('**/directory/delete', (route) =>
    route.fulfill({ json: { path: 'src' } }),
  );
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  const content = browser.getByTestId('workspace-file-content');
  await expect(content).toBeVisible();
  const dialog = await openFolderDelete(page, browser, 'src');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    browser.getByRole('treeitem', { name: 'src', exact: true }),
  ).toHaveCount(0);
  await expect(content).toBeVisible();
  await expect(
    content.getByText('Workspace guide', { exact: true }),
  ).toBeVisible();
  await expect(browser.getByRole('separator')).toBeVisible();
});

test('@smoke loads a newly created folder on its first expansion', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  await page.route('**/directory/create', (route) =>
    route.fulfill({ status: 201, json: { path: 'fresh' } }),
  );
  let reads = 0;
  await page.route('**/list?path=fresh', (route) => {
    reads++;
    return route.fulfill({
      json: {
        kind: 'list',
        path: 'fresh',
        entries: [{ name: 'external.txt', kind: 'file', ignored: false }],
        truncated: false,
      },
    });
  });
  await browser
    .getByRole('button', { name: 'New folder', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('fresh');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(reads).toBe(0);
  await browser.getByRole('treeitem', { name: 'fresh', exact: true }).click();
  await expect(
    browser.getByRole('treeitem', { name: 'external.txt', exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);
});

test('@smoke filters a deleted child out of a late ancestor listing', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
    true,
  );
  let release!: () => void;
  let pending = false;
  await page.route('**/list?path=empty', async (route) => {
    pending = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        kind: 'list',
        path: 'empty',
        entries: [{ name: 'child', kind: 'directory', ignored: false }],
        truncated: false,
      },
    });
  });
  await page.route('**/directory/create', (route) =>
    route.fulfill({ status: 201, json: { path: 'empty/child' } }),
  );
  await page.route('**/directory/delete', (route) =>
    route.fulfill({ json: { path: 'empty/child' } }),
  );
  const parent = browser.getByRole('treeitem', { name: 'empty', exact: true });
  await parent.click();
  await expect.poll(() => pending).toBe(true);
  await parent.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New folder', exact: true });
  await create
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('child');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toBeHidden();
  const child = browser.getByRole('treeitem', { name: 'child', exact: true });
  await child.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const remove = page.getByRole('alertdialog', {
    name: 'Delete folder?',
    exact: true,
  });
  await remove.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(remove).toBeHidden();
  await expect(child).toHaveCount(0);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).searchParams.get('path') === 'empty',
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(child).toHaveCount(0);
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
});

test('@smoke discards a stale subtree after exclusive folder recreation', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
  );
  let reads = 0;
  await page.route('**/list?path=empty', (route) =>
    route.fulfill({
      json: {
        kind: 'list',
        path: 'empty',
        entries: [
          {
            name: ++reads === 1 ? 'old.txt' : 'new.txt',
            kind: 'file',
            ignored: false,
          },
        ],
        truncated: false,
      },
    }),
  );
  await page.route('**/directory/create', (route) =>
    route.fulfill({ status: 201, json: { path: 'empty' } }),
  );
  const folder = browser.getByRole('treeitem', { name: 'empty', exact: true });
  await folder.click();
  const stale = browser.getByRole('treeitem', { name: 'old.txt', exact: true });
  await expect(stale).toBeVisible();
  await stale.click();
  await expect(browser.getByTestId('workspace-file-content')).toBeVisible();
  await browser
    .getByRole('button', { name: 'New folder', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('empty');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(stale).toHaveCount(0);
  await expect(browser.getByTestId('workspace-file-content')).toBeHidden();
  await folder.click();
  await expect(
    browser.getByRole('treeitem', { name: 'new.txt', exact: true }),
  ).toBeVisible();
  expect(reads).toBe(2);
});

async function dropLocalFiles(
  page: Page,
  target: import('@playwright/test').Locator,
  names: string[],
  directory = false,
) {
  const dataTransfer = await page.evaluateHandle(
    ({ names, directory }) => {
      const transfer = new DataTransfer();
      for (const name of names) {
        transfer.items.add(new File([new Uint8Array([0, 255, 128, 10])], name));
      }
      if (directory)
        Object.defineProperty(transfer, 'items', {
          value: Array.from(transfer.items).map((item) => {
            item.webkitGetAsEntry = () =>
              ({ isDirectory: true }) as FileSystemEntry;
            return item;
          }),
        });
      return transfer;
    },
    { names, directory },
  );
  const canceled = await target.evaluate((element, transfer) => {
    const dispatch = (type: string) => {
      const event = new DragEvent(type, {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return { dragover: dispatch('dragover'), drop: dispatch('drop') };
  }, dataTransfer);
  await dataTransfer.dispose();
  return canceled;
}

test('@smoke uploads dropped files into root and directory rows with bottom progress', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    false,
    false,
    false,
    true,
  );
  const sidebar = browser.getByTestId('workspace-file-sidebar');
  const uploads: { url: string; path: string; bytes: number[] }[] = [];
  let finish: (() => void) | undefined;
  await page.route('**/file/upload?*', async (route) => {
    const request = route.request();
    uploads.push({
      url: new URL(request.url()).pathname,
      path: new URL(request.url()).searchParams.get('path')!,
      bytes: [...request.postDataBuffer()!],
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fulfill({
      json: {
        kind: 'file_upload',
        path: uploads.at(-1)!.path,
        sizeBytes: 4,
        hash: 'sha256:test',
      },
    });
  });
  await browser.screenshot({ path: test.info().outputPath('before.png') });
  await dropLocalFiles(page, sidebar, ['root.bin', 'second.bin']);
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toEqual({
    url: '/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/file/upload',
    path: 'root.bin',
    bytes: [0, 255, 128, 10],
  });
  const progress = sidebar.getByRole('progressbar', { name: 'Uploading' });
  await expect(progress).toBeVisible();
  const barBox = (await progress.boundingBox())!;
  const sidebarBox = (await sidebar.boundingBox())!;
  expect(barBox.height).toBe(3);
  expect(barBox.y + barBox.height).toBeCloseTo(
    sidebarBox.y + sidebarBox.height,
    0,
  );
  finish!();
  await expect.poll(() => uploads.length).toBe(2);
  expect(uploads[1].path).toBe('second.bin');
  await expect(progress).toHaveAttribute('aria-valuenow', '50');
  await browser.screenshot({ path: test.info().outputPath('progress.png') });
  // Wait for the hook's success row dismissal while the second upload stays pending.
  await expect(
    browser.getByTestId('workspace-file-upload-status'),
  ).not.toContainText('root.bin');
  await expect(progress).toHaveAttribute('aria-valuenow', '50');
  finish!();
  await expect(progress).toBeHidden();
  await expect(
    sidebar.getByRole('treeitem', { name: 'root.bin', exact: true }),
  ).toBeVisible();

  const folder = sidebar.getByRole('treeitem', { name: 'empty', exact: true });
  await expect(
    browser.getByTestId('workspace-file-upload-status'),
  ).toContainText('second.bin');
  await dropLocalFiles(page, folder, ['nested.bin']);
  await expect.poll(() => uploads.length).toBe(3);
  expect(uploads[2].path).toBe('empty/nested.bin');
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  finish!();
  await expect(progress).toBeHidden();
  await page.route('**/list?path=empty', (route) =>
    route.fulfill({
      json: {
        kind: 'list',
        path: 'empty',
        entries: [{ name: 'nested.bin', kind: 'file', ignored: false }],
        truncated: false,
      },
    }),
  );
  await folder.click();
  await expect(
    sidebar.getByRole('treeitem', { name: 'nested.bin', exact: true }),
  ).toBeVisible();
  await expect(sidebar).not.toContainText('empty: Empty folder');
  await expect(sidebar.getByRole('alert')).toBeHidden();
  await browser.screenshot({ path: test.info().outputPath('completed.png') });
});

test('@smoke file-row drops preserve preview and use server-confirmed collision names', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
  );
  const sidebar = browser.getByTestId('workspace-file-sidebar');
  await sidebar.getByRole('treeitem', { name: 'src', exact: true }).click();
  const row = sidebar.getByRole('treeitem', { name: 'guide.md', exact: true });
  await row.click();
  await expect(browser.getByTestId('workspace-file-content')).toContainText(
    'Nested guide',
  );
  let uploadPath: string | null = null;
  await page.route('**/file/upload?*', async (route) => {
    uploadPath = new URL(route.request().url()).searchParams.get('path');
    await route.fulfill({
      json: {
        kind: 'file_upload',
        path: 'src/guide (1).md',
        sizeBytes: 4,
        hash: 'sha256:test',
      },
    });
  });
  await dropLocalFiles(page, row, ['guide.md']);
  await expect.poll(() => uploadPath).toBe('src/guide.md');
  await expect(
    sidebar.getByRole('treeitem', { name: 'guide (1).md', exact: true }),
  ).toBeVisible();
  await expect(browser.getByTestId('workspace-file-content')).toContainText(
    'Nested guide',
  );
  await expect(sidebar.getByRole('progressbar')).toBeHidden();
});

test('@smoke retains upload errors and ignores folders and text drags', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
  );
  const sidebar = browser.getByTestId('workspace-file-sidebar');
  let requests = 0;
  await page.route('**/file/upload?*', async (route) => {
    requests++;
    await route.fulfill({ status: 403, json: { error: 'Upload denied' } });
  });
  await dropLocalFiles(page, sidebar, ['local-folder'], true);
  const textTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'hello');
    return transfer;
  });
  const dragoverCanceled = await sidebar.evaluate((element, transfer) => {
    const event = new DragEvent('dragover', {
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, textTransfer);
  expect(dragoverCanceled).toBe(false);
  await expect(sidebar).not.toContainText('Drop files');
  const dropCanceled = await sidebar.evaluate((element, transfer) => {
    const event = new DragEvent('drop', {
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, textTransfer);
  expect(dropCanceled).toBe(false);
  await textTransfer.dispose();
  await expect(sidebar.getByRole('progressbar')).toBeHidden();
  expect(requests).toBe(0);
  await dropLocalFiles(page, sidebar, ['denied.bin']);
  await expect(
    browser.getByTestId('workspace-file-upload-status'),
  ).toContainText('Upload denied');
  await expect(sidebar.getByRole('progressbar')).toBeHidden();
  await browser.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    browser.getByTestId('workspace-file-upload-status'),
  ).not.toContainText('Upload denied');
});

test('@smoke prevents navigation and upload when tree upload capability is unavailable', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(page, baseURL!);
  const url = page.url();
  let requests = 0;
  await page.route('**/file/upload?*', async (route) => {
    requests++;
    await route.abort();
  });
  expect(
    await dropLocalFiles(page, browser.getByTestId('workspace-file-sidebar'), [
      'disabled.bin',
    ]),
  ).toEqual({ dragover: true, drop: true });
  await expect(browser).toBeVisible();
  expect(page.url()).toBe(url);
  expect(requests).toBe(0);
  await expect(browser.getByRole('progressbar')).toBeHidden();
});

test('@smoke targets restored directories while refresh and upload overlap', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
  );
  const sidebar = browser.getByTestId('workspace-file-sidebar');
  const paths: string[] = [];
  let finishUpload!: () => void;
  await page.route('**/file/upload?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    paths.push(path);
    await new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    await route.fulfill({
      json: { kind: 'file_upload', path, sizeBytes: 4, hash: 'sha256:test' },
    });
  });
  await dropLocalFiles(
    page,
    sidebar.getByRole('treeitem', { name: 'empty', exact: true }),
    ['first.bin'],
  );
  await expect.poll(() => paths.length).toBe(1);
  let finishListing!: () => void;
  let listingPending = false;
  await page.route('**/list?path=.', async (route) => {
    listingPending = true;
    await new Promise<void>((resolve) => {
      finishListing = resolve;
    });
    await route.fulfill({
      json: {
        kind: 'list',
        path: '.',
        entries: [{ name: 'empty', kind: 'directory', ignored: false }],
        truncated: false,
      },
    });
  });
  await browser.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => listingPending).toBe(true);
  finishUpload();
  const restored = sidebar.getByRole('treeitem', {
    name: 'empty',
    exact: true,
  });
  await expect(restored).toBeVisible();
  await dropLocalFiles(page, restored, ['second.bin']);
  await expect.poll(() => paths.length).toBe(2);
  expect(paths).toEqual(['empty/first.bin', 'empty/second.bin']);
  finishUpload();
  finishListing();
  await expect(sidebar.getByRole('progressbar')).toBeHidden();
  await restored.click();
  await expect(
    sidebar.getByRole('treeitem', { name: 'first.bin', exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole('treeitem', { name: 'second.bin', exact: true }),
  ).toBeVisible();
  await expect(sidebar.getByRole('alert')).toBeHidden();
  await expect(sidebar).not.toContainText('empty: Empty folder');
});

test('@smoke guards preview drops and keeps progress and errors visible with the tree collapsed', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
  );
  const sidebar = browser.getByTestId('workspace-file-sidebar');
  await sidebar
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  const content = browser.getByTestId('workspace-file-content');
  await expect(content).toContainText('Workspace guide');
  let requests = 0;
  let finish!: () => void;
  await page.route('**/file/upload?*', async (route) => {
    requests++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fulfill({ status: 403, json: { error: 'Upload denied' } });
  });
  for (const target of [content, browser.locator('header')]) {
    expect(await dropLocalFiles(page, target, ['ignored.bin'])).toEqual({
      dragover: true,
      drop: true,
    });
  }
  expect(requests).toBe(0);
  await dropLocalFiles(page, sidebar, ['denied.bin']);
  await expect.poll(() => requests).toBe(1);
  await browser
    .getByRole('button', { name: 'Toggle file tree', exact: true })
    .click();
  await expect(sidebar).toBeHidden();
  await expect(browser.getByRole('progressbar')).toBeVisible();
  await browser.screenshot({
    path: test.info().outputPath('collapsed-progress.png'),
  });
  finish();
  await expect(browser.getByRole('progressbar')).toBeHidden();
  await expect(
    browser.getByTestId('workspace-file-upload-status'),
  ).toContainText('denied.bin');
  await expect(
    browser.getByRole('button', { name: 'Dismiss', exact: true }).locator('..'),
  ).toBeVisible();
  await browser.screenshot({
    path: test.info().outputPath('collapsed-error.png'),
  });
  await browser.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    browser.getByTestId('workspace-file-upload-status'),
  ).not.toContainText('denied.bin');
});

test('@smoke shows readable root, directory and file-parent drop hints and clears on leave', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
  );
  const sidebar = browser.getByTestId('workspace-file-sidebar');
  await sidebar.getByRole('treeitem', { name: 'src', exact: true }).click();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'hint.bin'));
    return data;
  });
  for (const [target, destination] of [
    [sidebar, 'qwen-web-shell-e2e'],
    [sidebar.getByRole('treeitem', { name: 'empty', exact: true }), 'empty'],
    [sidebar.getByRole('treeitem', { name: 'guide.md', exact: true }), 'src'],
  ] as const) {
    await target.dispatchEvent('dragover', {
      dataTransfer: transfer,
      composed: true,
    });
    await expect(sidebar).toContainText(
      `Drop files to upload into: ${destination}`,
    );
    await sidebar.dispatchEvent('dragleave', {
      dataTransfer: transfer,
      relatedTarget: null,
      composed: true,
    });
    await expect(sidebar).not.toContainText('Drop files to upload into:');
  }
  await transfer.dispose();
});

test('@smoke coordinates new-folder uploads with folder deletion', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    true,
    true,
    true,
  );
  await page.route('**/directory/create', (route) =>
    route.fulfill({ status: 201, json: { path: 'fresh' } }),
  );
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  await browser
    .getByRole('button', { name: 'New folder', exact: true })
    .click();
  const create = page.getByRole('dialog', { name: 'New folder', exact: true });
  await create
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('fresh');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toBeHidden();
  let uploadRequests = 0;
  let finishUpload!: () => void;
  await page.route('**/file/upload?*', async (route) => {
    uploadRequests++;
    const path = new URL(route.request().url()).searchParams.get('path');
    expect(path).toBe('fresh/keep.bin');
    await new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    await route.fulfill({
      json: { kind: 'file_upload', path, sizeBytes: 4, hash: 'sha256:test' },
    });
  });
  let deleteRequests = 0;
  let finishDelete!: () => void;
  await page.route('**/directory/delete', async (route) => {
    deleteRequests++;
    await new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    await route.fulfill({ json: { kind: 'directory_delete', path: 'fresh' } });
  });
  const folder = browser.getByRole('treeitem', {
    name: 'fresh',
    exact: true,
    includeHidden: true,
  });
  await dropLocalFiles(page, folder, ['keep.bin']);
  await expect.poll(() => uploadRequests).toBe(1);
  const remove = await openFolderDelete(page, browser, 'fresh');
  const confirm = remove.getByRole('button', { name: 'Delete', exact: true });
  await expect(confirm).toBeDisabled();
  expect(deleteRequests).toBe(0);
  await expect(
    browser.getByRole('progressbar', { includeHidden: true }),
  ).toHaveCount(1);
  await expect(remove).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: test.info().outputPath('create-upload-delete.png'),
  });
  finishUpload();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => deleteRequests).toBe(1);
  expect(await dropLocalFiles(page, folder, ['blocked.bin'])).toEqual({
    dragover: true,
    drop: true,
  });
  expect(uploadRequests).toBe(1);
  await expect(
    remove.getByRole('button', { name: 'Deleting…', exact: true }),
  ).toBeDisabled();
  finishDelete();
  await expect(remove).toBeHidden();
  await expect(folder).toHaveCount(0);
  await expect(
    browser.getByRole('treeitem', { name: 'keep.bin', exact: true }),
  ).toHaveCount(0);
  await expect(browser.getByTestId('workspace-file-content')).toContainText(
    'Workspace guide',
  );
  await expect(browser.getByRole('progressbar')).toBeHidden();
});

async function openDeleteMenu(
  page: Page,
  browser: import('@playwright/test').Locator,
  name = 'README.md',
) {
  await browser
    .getByRole('treeitem', { name, exact: true })
    .click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toBeVisible();
}

test('@smoke confirms irreversible file deletion and preserves other tree state', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    false,
    true,
    true,
    true,
    true,
  );
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click();
  await expect(browser.getByTestId('workspace-file-content')).toContainText(
    'Workspace guide',
  );
  await browser.getByRole('treeitem', { name: 'deep', exact: true }).click();
  await expect(
    browser.getByRole('treeitem', { name: 'level-0', exact: true }),
  ).toBeVisible();
  const calls: { url: string; path: string }[] = [];
  let finish!: () => void;
  await page.route('**/file/delete', async (route) => {
    calls.push({
      url: new URL(route.request().url()).pathname,
      path: route.request().postDataJSON().path,
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fulfill({ json: { kind: 'file_delete', path: 'README.md' } });
  });
  await browser.screenshot({
    path: test.info().outputPath('delete-before.png'),
  });
  await openDeleteMenu(page, browser);
  await page
    .getByRole('menu')
    .screenshot({ path: test.info().outputPath('delete-menu.png') });
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete file?' });
  await expect(dialog).toContainText('/tmp/qwen-web-shell-e2e/README.md');
  await expect(dialog).toContainText('This cannot be undone.');
  await expect(dialog.getByRole('button', { name: /^cancel$/i })).toBeFocused();
  expect(calls).toHaveLength(0);
  await dialog.screenshot({
    path: test.info().outputPath('delete-confirmation.png'),
  });
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden();
  await expect(
    browser.locator('[role="treeitem"][tabindex="0"]'),
  ).toBeFocused();
  expect(calls).toHaveLength(0);
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await openDeleteMenu(page, browser);
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(
    browser.locator('[role="treeitem"][tabindex="0"]'),
  ).toBeFocused();
  expect(calls).toHaveLength(0);
  await openDeleteMenu(page, browser);
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Delete file', exact: true })
    .click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({
    url: '/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/file/delete',
    path: 'README.md',
  });
  await expect(
    dialog.getByRole('button', { name: /^cancel$/i }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Deleting…', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  finish();
  await expect(dialog).toBeHidden();
  await expect(
    browser.locator('[role="treeitem"][tabindex="0"]'),
  ).toBeFocused();
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeHidden();
  await expect(browser.getByTestId('workspace-file-content')).toBeHidden();
  await expect(
    browser.getByRole('treeitem', { name: 'level-0', exact: true }),
  ).toBeVisible();
  await browser.screenshot({
    path: test.info().outputPath('delete-completed.png'),
  });

  await page.route('**/file/upload?*', (route) =>
    route.fulfill({
      json: {
        kind: 'file_upload',
        path: 'README.md',
        sizeBytes: 4,
        hash: 'sha256:test',
      },
    }),
  );
  await dropLocalFiles(page, browser.getByTestId('workspace-file-sidebar'), [
    'README.md',
  ]);
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(browser.getByRole('progressbar')).toBeHidden();
  await page.route('**/file/delete', (route) =>
    route.fulfill({ json: { kind: 'file_delete', path: 'README.md' } }),
  );
  await openDeleteMenu(page, browser);
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Delete file', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeHidden();
  await expect(
    browser.getByRole('treeitem', { name: 'level-0', exact: true }),
  ).toBeVisible();
});

test('@smoke keeps failed deletions visible for retry', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
    true,
  );
  let calls = 0;
  await page.route('**/file/delete', async (route) => {
    calls++;
    await route.fulfill(
      calls === 1
        ? { status: 403, json: { error: 'Deletion denied' } }
        : { json: { kind: 'file_delete', path: 'README.md' } },
    );
  });
  await openDeleteMenu(page, browser);
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog
    .getByRole('button', { name: 'Delete file', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText('Deletion denied');
  await expect(
    browser.locator('[role="treeitem"][data-item-path="README.md"]'),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Delete file', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(calls).toBe(2);
  await expect(
    browser.getByRole('treeitem', { name: 'README.md', exact: true }),
  ).toBeHidden();
});

test('@smoke hides file deletion without capability and for symlinks', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(page, baseURL!);
  await browser
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Download', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await browser
    .getByRole('treeitem', { name: 'linked', exact: true })
    .click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Download', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
});

test('@smoke never offers deletion for a symlink even with capability', async ({
  page,
  baseURL,
}) => {
  const { browser } = await openFiles(
    page,
    baseURL!,
    undefined,
    undefined,
    true,
    false,
    false,
    true,
    true,
  );
  await browser
    .getByRole('treeitem', { name: 'linked', exact: true })
    .click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Download', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Delete', exact: true }),
  ).toHaveCount(0);
});
