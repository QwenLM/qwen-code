import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { expect, test, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

let fixture: ViteDevServer;
let fixtureDir: string;
let fixtureUrl: string;
const fixtureReferrers: Array<string | undefined> = [];

test.beforeAll(async () => {
  fixtureDir = await realpath(
    await mkdtemp(join(tmpdir(), 'qwen-preview-e2e-')),
  );
  await writeFile(
    join(fixtureDir, 'index.html'),
    '<!doctype html><input aria-label="App input"><p id="message"></p><p id="storage"></p><p id="referrer"></p><button id="popup">Probe popup</button><script type="module" src="/app.js"></script>',
  );
  await writeFile(
    join(fixtureDir, 'app.js'),
    `import { message } from './message.js';
document.querySelector('#message').textContent = message;
document.querySelector('#referrer').textContent = document.referrer || 'empty';
document.querySelector('#popup').onclick = () => document.querySelector('#popup').textContent = window.open('/popup') === null ? 'Blocked popup' : 'Opened popup';
localStorage.setItem('preview-module', 'working');
document.querySelector('#storage').textContent = localStorage.getItem('preview-module');
if (import.meta.hot) import.meta.hot.accept('./message.js', (module) => {
  document.querySelector('#message').textContent = module.message;
});`,
  );
  await writeFile(
    join(fixtureDir, 'message.js'),
    "export const message = 'Before update';",
  );
  fixture = await createServer({
    configFile: false,
    root: fixtureDir,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'preview-navigation-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (url.pathname === '/')
              fixtureReferrers.push(req.headers.referer);
            const target = url.searchParams.get('target') ?? '';
            if (url.pathname === '/redirect') {
              res.writeHead(302, { Location: target });
              res.end();
            } else if (url.pathname === '/navigate') {
              res.setHeader('Content-Type', 'text/html');
              res.end(
                `<script>location.href=${JSON.stringify(target)}</script>`,
              );
            } else if (url.pathname === '/nested') {
              res.setHeader('Content-Type', 'text/html');
              res.end(
                `<!doctype html><body><script>const child=document.createElement('iframe');child.src=${JSON.stringify(target)};document.body.append(child)</script>`,
              );
            } else if (url.pathname === '/unframeable') {
              res.setHeader(
                'Content-Security-Policy',
                "frame-ancestors 'none'",
              );
              res.end('This page requires external opening');
            } else {
              next();
            }
          });
        },
      },
    ],
  });
  await fixture.listen();
  const address = fixture.httpServer!.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await fixture?.close();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'session_artifacts'] },
    events: [
      userTextEvent('Build a webpage.', { id: 1 }),
      toolCallEvent(
        'record-preview',
        'Artifact',
        { title: 'Historical webpage', url: fixtureUrl },
        { id: 2, rawOutput: { recorded: true } },
      ),
      assistantTextEvent('The webpage is ready.', { id: 3 }),
      turnCompleteEvent('build-webpage', { id: 4 }),
      userTextEvent('Change the heading.', { id: 5 }),
      toolCallEvent(
        'record-link',
        'record_artifact',
        { title: 'Recorded link', url: fixtureUrl },
        { id: 6, rawOutput: { recorded: true } },
      ),
      assistantTextEvent('The heading has changed.', { id: 7 }),
      turnCompleteEvent('update-webpage', { id: 8 }),
    ],
    artifacts: [
      {
        id: 'recorded-link',
        kind: 'link',
        storage: 'external_url',
        source: 'tool',
        status: 'available',
        title: 'Recorded link',
        url: fixtureUrl,
        retention: 'restorable',
        clientRetained: false,
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        toolCallId: 'record-link',
        toolName: 'record_artifact',
      },
      {
        id: 'historical-webpage',
        kind: 'html',
        storage: 'published',
        source: 'tool',
        status: 'available',
        title: 'Historical webpage',
        url: fixtureUrl,
        retention: 'restorable',
        clientRetained: false,
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        toolCallId: 'record-preview',
        toolName: 'Artifact',
      },
    ],
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await expect(
    page
      .locator('[data-web-shell-message-list]')
      .getByText('Historical webpage', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Toggle right panel', exact: true })
    .click();
  await page
    .getByRole('button', { name: /Web preview.*Preview a running/ })
    .click();
});

async function openPreview(page: Page, url: string) {
  await page.getByRole('textbox', { name: 'Development URL' }).fill(url);
  await page
    .locator('[data-web-shell-web-preview]:visible')
    .getByRole('button', { name: 'Open', exact: true })
    .click();
}

function appFrame(page: Page) {
  return page
    .frameLocator('iframe[title="Web preview frame"]')
    .frameLocator('iframe[title="Application preview"]');
}

test('runs modules, storage and HMR, preserves tabs, and restores settings', async ({
  page,
}) => {
  await openPreview(page, fixtureUrl);
  const app = appFrame(page);
  await expect(app.locator('#message')).toHaveText('Before update');
  await expect(app.locator('#storage')).toHaveText('working');
  await expect(app.locator('#referrer')).toHaveText('empty');
  expect(fixtureReferrers.length).toBeGreaterThan(0);
  expect(fixtureReferrers.every((value) => value === undefined)).toBe(true);
  await app.getByRole('button', { name: 'Probe popup', exact: true }).click();
  await expect(
    app.getByRole('button', { name: 'Blocked popup', exact: true }),
  ).toBeVisible();
  await app.getByRole('textbox', { name: 'App input' }).fill('Keep this state');
  await writeFile(
    join(fixtureDir, 'message.js'),
    "export const message = 'After update';",
  );
  await expect(app.locator('#message')).toHaveText('After update');
  await expect(app.getByRole('textbox')).toHaveValue('Keep this state');

  await page
    .getByRole('button', { name: 'Mobile width (390 px)', exact: true })
    .click();
  expect(await app.locator('html').evaluate(() => window.innerWidth)).toBe(390);
  await expect(app.getByRole('textbox')).toHaveValue('Keep this state');

  await page.getByRole('button', { name: 'Add panel', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Web preview', exact: true })
    .click();
  await page
    .getByRole('tab', { name: `${fixtureUrl}/`, exact: true })
    .first()
    .click();
  await expect(appFrame(page).getByRole('textbox')).toHaveValue(
    'Keep this state',
  );
  await page
    .getByRole('button', { name: 'Refresh preview', exact: true })
    .first()
    .click();
  await expect(appFrame(page).getByRole('textbox')).toHaveValue('');

  await expect(
    page.getByRole('link', { name: 'Open externally' }).first(),
  ).toHaveAttribute('href', `${fixtureUrl}/`);
  await expect(
    page.getByRole('link', { name: 'Open externally' }).first(),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  const [external] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: 'Open externally' }).first().click(),
  ]);
  await external.waitForLoadState();
  expect(external.url()).toBe(`${fixtureUrl}/`);
  expect(await external.evaluate(() => window.opener)).toBeNull();
  await external.close();
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Development URL' }).first(),
  ).toHaveValue(`${fixtureUrl}/`);
  await expect(appFrame(page).locator('#message')).toHaveText('After update');
  expect(
    await appFrame(page)
      .locator('html')
      .evaluate(() => window.innerWidth),
  ).toBe(390);
  await page
    .getByRole('button', { name: `Close ${fixtureUrl}/`, exact: true })
    .click();
  await expect(page.locator('iframe[title="Web preview frame"]')).toHaveCount(
    0,
  );
});

test('rejects unsafe URLs and preserves the working preview after invalid input', async ({
  page,
}) => {
  await openPreview(page, fixtureUrl);
  await expect(appFrame(page).locator('#storage')).toHaveText('working');
  for (const url of [
    'javascript:alert(1)',
    'https://user:secret@example.com',
    page.url(),
  ]) {
    await openPreview(page, url);
    await expect(page.getByRole('alert')).toContainText('development address');
    await expect(appFrame(page).locator('#storage')).toHaveText('working');
  }
});

test('@smoke blocks direct redirects and script navigation, and protects host descendants', async ({
  page,
}, testInfo) => {
  const violations: string[] = [];
  const target = `${String(testInfo.project.use.baseURL)}/e2e/composer-layout-harness.html?preview-probe=1`;
  const targetRequests: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy'))
      violations.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url() === target) targetRequests.push(request.url());
  });
  for (const path of ['redirect', 'navigate']) {
    violations.length = 0;
    await openPreview(
      page,
      `${fixtureUrl}/${path}?target=${encodeURIComponent(target)}`,
    );
    await expect
      .poll(() => violations.some((message) => message.includes('frame-src')))
      .toBe(true);
    expect(targetRequests).toHaveLength(0);
  }
  violations.length = 0;
  const protectedTarget = `${fixtureUrl}/unframeable`;
  const protection = await page.request.get(protectedTarget);
  expect(protection.headers()['content-security-policy']).toBe(
    "frame-ancestors 'none'",
  );
  await openPreview(
    page,
    `${fixtureUrl}/nested?target=${encodeURIComponent(protectedTarget)}`,
  );
  await expect
    .poll(() =>
      violations.some((message) => message.includes('frame-ancestors')),
    )
    .toBe(true);
  expect(page.frames().some((frame) => frame.url() === protectedTarget)).toBe(
    false,
  );
});

test('keeps the external fallback available for frame-blocked applications', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => violations.push(message.text()));
  await openPreview(page, `${fixtureUrl}/unframeable`);
  await expect
    .poll(() =>
      violations.some((message) => message.includes('frame-ancestors')),
    )
    .toBe(true);
  await expect(page.getByText('Blank page?', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open externally' }),
  ).toHaveAttribute('href', `${fixtureUrl}/unframeable`);
});

test('reopens a live webpage from its historical message after closing the tab and reloading', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Close Web preview', exact: true })
    .click();
  const transcript = page.locator('[data-web-shell-message-list]');
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      page.getByText('The heading has changed.', { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText('Historical webpage', { exact: true }),
    ).toBeVisible();
    await transcript.locator('[title="Historical webpage"] > button').click();
    await expect(appFrame(page).locator('#storage')).toHaveText('working');
    await expect(page.getByText('Live page.', { exact: false })).toBeVisible();
    await page
      .getByRole('button', { name: 'Close Historical webpage', exact: true })
      .click();
    await expect(page.locator('iframe[title="Web preview frame"]')).toHaveCount(
      0,
    );
    await expect(
      transcript.getByText('Historical webpage', { exact: true }),
    ).toBeVisible();
    await page.reload();
  }
});

test('recorded links open metadata without automatically loading a live frame', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Close Web preview', exact: true })
    .click();
  await page
    .locator('[data-web-shell-message-list] [title="Recorded link"] > button')
    .click();
  await expect(
    page.getByRole('tab', { name: 'Recorded link', exact: true }),
  ).toBeVisible();
  await expect(page.locator('iframe[title="Web preview frame"]')).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('link', { name: 'Open link', exact: true }),
  ).toHaveAttribute('href', fixtureUrl);
});
