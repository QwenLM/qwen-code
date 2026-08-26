import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

test('configures and publishes an HTML artifact through Aliyun OSS', async ({
  page,
}, testInfo) => {
  const artifactPath = 'output/demo.html';
  const html = '<!doctype html><title>Artifact sharing</title>';
  const ossSetup = {
    provider: 'oss',
    stage: 'install',
    cliInstalled: false,
    authenticated: false,
    linked: false,
    configured: false,
    oss: {
      bucket: '',
      endpoint: '',
      keyPrefix: 'artifacts',
      publicBaseUrl: '',
      credentialsSource: 'none',
    },
  } as const;
  const readyOssSetup = {
    ...ossSetup,
    stage: 'ready',
    cliInstalled: true,
    authenticated: true,
    linked: true,
    configured: true,
    project: {
      id: 'oss-target',
      name: 'qwen-artifacts',
      url: 'https://artifacts.example.com',
      accountName: 'oss-cn-hangzhou.aliyuncs.com',
    },
    oss: {
      bucket: 'qwen-artifacts',
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      keyPrefix: 'artifacts',
      publicBaseUrl: 'https://artifacts.example.com',
      credentialsSource: 'memory',
    },
  } as const;
  const scenario = createWebShellDaemonScenario({
    capabilities: { features: ['session_artifacts'] },
    events: [
      userTextEvent('Create a shareable HTML demo.', { id: 1 }),
      toolCallEvent(
        'call-record-html',
        'record_artifact',
        { title: 'Artifact sharing demo', workspacePath: artifactPath },
        { id: 2, rawOutput: { recorded: true } },
      ),
      assistantTextEvent('The HTML artifact is ready.', { id: 3 }),
      turnCompleteEvent('prompt-artifact', { id: 4 }),
    ],
    artifacts: [
      {
        id: 'artifact-html',
        kind: 'html',
        storage: 'workspace',
        source: 'tool',
        status: 'available',
        title: 'Artifact sharing demo',
        workspacePath: artifactPath,
        mimeType: 'text/html',
        sizeBytes: html.length,
        retention: 'restorable',
        clientRetained: false,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        toolCallId: 'call-record-html',
        toolName: 'record_artifact',
      },
    ],
    workspaceFiles: { [artifactPath]: html },
    artifactPublishConfig: {
      v: 1,
      workspaceCwd: '/workspace',
      providers: [
        { kind: 'cloudflare', configured: false },
        { kind: 'vercel', configured: false },
        { kind: 'netlify', configured: false },
        { kind: 'oss', configured: false },
      ],
      setups: {
        cloudflare: {
          provider: 'cloudflare',
          stage: 'install',
          cliInstalled: false,
          authenticated: false,
          linked: false,
          configured: false,
        },
        oss: ossSetup,
      },
    },
    artifactProviderSetupResult: {
      v: 1,
      workspaceCwd: '/workspace',
      providers: [{ kind: 'oss', configured: true }],
      setups: { oss: readyOssSetup },
      provider: 'oss',
      setup: readyOssSetup,
    },
    artifactPublishResult: {
      v: 1,
      workspaceCwd: '/workspace',
      provider: 'oss',
      id: 'artifact-html',
      url: 'https://artifacts.example.com/artifacts/artifact-html/index.html',
      reused: false,
      recorded: true,
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await page.setViewportSize({ width: 1440, height: 1600 });
  await gotoSession(page, scenario, daemon);
  await page
    .locator('[data-web-shell-message-list]')
    .getByRole('button', { name: 'Share', exact: true })
    .click();
  await page.locator('[data-share-provider="oss"]').click();

  await page
    .locator('#share-oss-endpoint')
    .fill('oss-cn-hangzhou.aliyuncs.com');
  await page.locator('#share-oss-bucket').fill('qwen-artifacts');
  await page
    .locator('#share-oss-public-base-url')
    .fill('https://artifacts.example.com');
  await page.locator('#share-oss-access-key-id').fill('temporary-id');
  await page.locator('#share-oss-access-key-secret').fill('temporary-secret');
  await page.locator('[data-share-action="configure-oss"]').click();

  await expect
    .poll(() =>
      daemon.requests.find((request) =>
        request.path.endsWith('/artifact/oss/setup'),
      ),
    )
    .toMatchObject({
      method: 'POST',
      body: {
        action: 'connect',
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        bucket: 'qwen-artifacts',
        publicBaseUrl: 'https://artifacts.example.com',
        keyPrefix: 'artifacts',
        accessKeyId: 'temporary-id',
        accessKeySecret: 'temporary-secret',
      },
    });
  await expect(page.locator('#share-oss-access-key-secret')).toHaveValue('');
  await expect(
    page.locator('[data-share-action="configure-oss"]'),
  ).toBeEnabled();
  await expect(page.locator('[data-share-action="publish"]')).toBeEnabled();
  const dialog = page.getByRole('dialog');
  await dialog
    .locator(':scope > div:last-child')
    .evaluate((content) => content.scrollTo({ top: 0 }));
  await dialog.screenshot({
    path: testInfo.outputPath('artifact-share-oss-ready.png'),
  });

  await page.locator('[data-share-action="publish"]').click();
  await expect(
    page.getByRole('link', { name: 'Open link', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://artifacts.example.com/artifacts/artifact-html/index.html',
  );
  await expect
    .poll(
      () =>
        daemon.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path.endsWith('/artifact/publish'),
        )?.body,
    )
    .toMatchObject({ path: artifactPath, provider: 'oss' });
});

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}
