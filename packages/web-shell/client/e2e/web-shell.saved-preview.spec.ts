import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { artifactPreviewDocument } from '../components/artifacts/artifactUtils';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

function savedArtifact(version: number): DaemonSessionArtifact {
  return {
    id: `saved-${version}`,
    title: `Page version ${version}`,
    kind: 'html',
    storage: 'published',
    source: 'tool',
    status: 'available',
    retention: 'restorable',
    clientRetained: false,
    createdAt: `2026-09-07T00:0${version}:00.000Z`,
    updatedAt: `2026-09-07T00:0${version}:00.000Z`,
    toolCallId: `publish-${version}`,
    toolName: 'Artifact',
    url: `file:///runtime/snapshots/${version}/index.html`,
    metadata: {
      artifactType: 'web_preview_snapshot',
      publishedUrl: 'http://127.0.0.1:1/stopped-server',
    },
  };
}

test('@smoke offline HTML remains interactive but cannot navigate out of its parent', async ({
  page,
}) => {
  const requests: string[] = [];
  const target = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.end('Navigation escaped');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  try {
    const address = target.address();
    if (!address || typeof address === 'string')
      throw new Error('No target port');
    const destination = `http://127.0.0.1:${address.port}/leak?content=private`;
    const html = `<style>body{background:rgb(12, 34, 56)}</style><img alt="Embedded" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><audio preload="auto" src="data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=="></audio><button id="count">Count: 0</button><button id="parent">Probe parent</button><button id="navigate">Navigate</button><script>let n=0;document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent='Count: '+(++n);document.querySelector('#parent').onclick=()=>{try{parent.document.body.textContent='Escaped'}catch{document.querySelector('#parent').textContent='Blocked'}};document.querySelector('#navigate').onclick=()=>window['location']['href']=${JSON.stringify(destination)}</script>`;
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy'))
        violations.push(message.text());
    });
    const response = await page.goto('/e2e/composer-layout-harness.html');
    expect(response?.headers()['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(response?.headers()['content-security-policy']).toContain(
      "media-src 'self' data:",
    );
    await page.setContent(
      '<iframe title="Offline preview" sandbox="allow-scripts"></iframe>',
    );
    await page.locator('iframe').evaluate(
      (frame, document) => {
        (frame as HTMLIFrameElement).srcdoc = document;
      },
      artifactPreviewDocument(html, 'Document'),
    );
    const content = page
      .frameLocator('iframe[title="Offline preview"]')
      .frameLocator('iframe');
    await content.getByRole('button', { name: 'Count: 0' }).click();
    await expect(
      content.getByRole('button', { name: 'Count: 1' }),
    ).toBeVisible();
    await expect(content.locator('body')).toHaveCSS(
      'background-color',
      'rgb(12, 34, 56)',
    );
    await expect
      .poll(() =>
        content
          .getByAltText('Embedded')
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await expect
      .poll(() =>
        content
          .locator('audio')
          .evaluate((audio) => (audio as HTMLAudioElement).readyState),
      )
      .toBeGreaterThan(0);
    await content.getByRole('button', { name: 'Probe parent' }).click();
    await expect(
      content.getByRole('button', { name: 'Blocked' }),
    ).toBeVisible();
    await content.getByRole('button', { name: 'Navigate' }).click();
    await expect
      .poll(() => violations.some((message) => message.includes('frame-src')))
      .toBe(true);
    expect(requests).toEqual([]);
    expect(
      page.frames().some((frame) => frame.url().startsWith(destination)),
    ).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('opens each saved delivery after closing and reloading, with inline interaction', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_events', 'session_artifacts'] },
    events: [
      userTextEvent('Build the first page.', { id: 1 }),
      toolCallEvent(
        'publish-1',
        'Artifact',
        { file_path: '/tmp/page.html' },
        { id: 2 },
      ),
      assistantTextEvent('First version saved.', { id: 3 }),
      turnCompleteEvent('first', { id: 4 }),
      userTextEvent('Change it to version two.', { id: 5 }),
      toolCallEvent(
        'publish-2',
        'Artifact',
        { file_path: '/tmp/page.html' },
        { id: 6 },
      ),
      assistantTextEvent('Second version saved.', { id: 7 }),
      turnCompleteEvent('second', { id: 8 }),
    ],
    artifacts: [savedArtifact(1), savedArtifact(2)],
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const reads: string[] = [];
  let missing = false;
  await page.route('**/artifacts/saved-*/content', async (route) => {
    const match = /\/saved-(\d)\/content$/.exec(
      new URL(route.request().url()).pathname,
    );
    expect(route.request().url()).toContain(`/session/${scenario.sessionId}/`);
    reads.push(match![1]!);
    if (missing) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"error":"artifact_snapshot_unavailable"}',
      });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{font:20px system-ui;padding:30px;background:#f5f5f5}</style><h1>Version ${match![1]}</h1><button id="count">Count: 0</button><script>let n=0;document.querySelector('#count').onclick=()=>document.querySelector('#count').textContent='Count: '+(++n)</script>`,
    });
  });
  const liveRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('stopped-server')) liveRequests.push(req.url());
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  const transcript = page.locator('[data-web-shell-message-list]');
  const frame = page
    .frameLocator('iframe[title="Saved webpage version"]')
    .frameLocator('iframe');
  for (const version of [1, 2, 1]) {
    await transcript
      .locator(`[title="Page version ${version}"] > button`)
      .click();
    await expect(frame.getByRole('heading')).toHaveText(`Version ${version}`);
    await frame.getByRole('button', { name: 'Count: 0' }).click();
    await expect(frame.getByRole('button')).toHaveText('Count: 1');
    await expect(page.locator('[data-web-shell-saved-preview]')).toContainText(
      'Saved version',
    );
    if (version === 2) {
      await page.reload();
      await expect(frame.getByRole('heading')).toHaveText('Version 2');
      await expect(frame.getByRole('button')).toHaveText('Count: 0');
    }
    await page
      .getByRole('button', {
        name: `Close Page version ${version}`,
        exact: true,
      })
      .click();
    await expect(
      page.locator('iframe[title="Saved webpage version"]'),
    ).toHaveCount(0);
    await page.reload();
  }
  expect(
    reads.filter((version, index) => reads[index - 1] !== version),
  ).toEqual(['1', '2', '1']);
  expect(reads.length).toBeLessThanOrEqual(8);
  expect(liveRequests).toEqual([]);
  missing = true;
  await transcript.locator('[title="Page version 1"] > button').click();
  await expect(
    page.locator('[data-web-shell-saved-preview] [role="alert"]'),
  ).toContainText('missing or has changed');
  await expect(
    page.locator('iframe[title="Saved webpage version"]'),
  ).toHaveCount(0);
  expect(liveRequests).toEqual([]);
});
