import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

// UI integration uses a simulated daemon; it does not verify filesystem or Git operations.
async function openFiles(
  page: Page,
  baseURL: string,
  workspaceCwd = '/tmp/qwen-web-shell-e2e',
) {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd,
    capabilities: {
      workspaces: [
        {
          id: 'files-workspace',
          cwd: workspaceCwd,
          primary: true,
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
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installMockDaemon(page, scenario, { baseURL });
  const contents: Record<string, string> = {
    'README.md':
      '# Workspace guide\n\nA rendered **Markdown** document.\n\n- Browse files\n- Read source\n',
    'src/app.ts':
      'export const greeting: string = "Hello, files";\nconsole.log(greeting);\n',
    'index.html': '<h1>Workspace HTML</h1>',
    'src/guide.md': '# Workspace guide\n\nA nested document.\n',
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
  const directoryReads: string[] = [];
  let rootUpdated = false;
  let failedReads = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
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
              { name: 'deep', kind: 'directory', ignored: false },
              { name: 'empty', kind: 'directory', ignored: false },
              { name: 'broken', kind: 'directory', ignored: false },
              { name: 'linked', kind: 'symlink', ignored: false },
              { name: 'README.md', kind: 'file', ignored: false },
              { name: 'index.html', kind: 'file', ignored: false },
              { name: 'image.png', kind: 'file', ignored: false },
              { name: 'notes draft.md', kind: 'file', ignored: false },
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
                content,
                encoding: 'utf-8',
                truncated: false,
                sizeBytes: content.length,
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
  await page
    .getByRole('button', { name: 'Toggle right panel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Files.*Browse workspace files/ }),
  ).toBeVisible();
  await page.screenshot({ path: '/tmp/qwen-web-shell-files-entry.png' });
  await page
    .getByRole('button', { name: /Files.*Browse workspace files/ })
    .click();
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
    scenario,
    addRootFile: () => {
      rootUpdated = true;
    },
  };
}

test('@smoke filters loaded paths without changing input or fetching directories', async ({
  page,
}, testInfo) => {
  const { browser, directoryReads } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  const tree = browser.getByTestId('workspace-file-sidebar');
  const filter = tree.getByRole('textbox', { name: 'Filter files…' });
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
  expect(new Set(directoryReads)).toEqual(
    new Set(['/workspaces/%2Ftmp%2Fqwen-web-shell-e2e/list?path=.']),
  );
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
    await filter.dispatchEvent('keydown', {
      key: 'Escape',
      isComposing: true,
      keyCode: 229,
    });
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
  await page.screenshot({ path: '/tmp/qwen-web-shell-files-markdown.png' });
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
  await page.screenshot({ path: '/tmp/qwen-web-shell-files-source.png' });
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
  await page.reload();
  await expect(page.getByTestId('workspace-file-browser')).toBeVisible();
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
  await expect(source).toContainText('# Workspace guide');
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
    page.getByRole('heading', { name: 'Workspace guide' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(source).toContainText('# Workspace guide');
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

test('handles empty folders, directory errors, truncation, refresh, and narrow panels', async ({
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
  await tree.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(tree.getByRole('alert')).toHaveCount(0);
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
  await page.screenshot({ path: '/tmp/qwen-web-shell-files-narrow.png' });
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
  await browser.getByRole('treeitem', { name: 'long.ts', exact: true }).click();
  const source = browser.getByTestId('pierre-file-preview');
  await expect(source).toContainText('export const line0');
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

test('keeps large source files readable without tokenizing the entire text', async ({
  page,
}, testInfo) => {
  const { browser } = await openFiles(
    page,
    String(testInfo.project.use.baseURL),
  );
  await browser.getByRole('treeitem', { name: 'src', exact: true }).click();
  await browser
    .getByRole('treeitem', { name: 'large.ts', exact: true })
    .click();
  const source = browser.getByTestId('pierre-file-preview');
  await expect(source).toContainText('export const large0');
  await expect(source.locator('[data-line] span[style]')).toHaveCount(0);
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
    browser.getByRole('treeitem', { name: 'notes draft.md', exact: true }),
  ).toBeFocused();
  await rightClick('notes draft.md');
  await page.getByRole('menuitem', { name: 'Reference', exact: true }).click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toContainText('notes draft.md');
  await expect(editor).toBeFocused();
  await rightClick('README.md');
  await page.screenshot({ path: '/tmp/qwen-web-shell-files-context-menu.png' });
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
  await page.screenshot({ path: '/tmp/qwen-web-shell-files-deep-tree.png' });
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
