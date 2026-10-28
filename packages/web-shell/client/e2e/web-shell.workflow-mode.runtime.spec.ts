/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DaemonHttpError,
  type DaemonEvent,
  type DaemonSession,
} from '@qwen-code/sdk';
import {
  startFakeOpenAIServer,
  type FakeOpenAIHandler,
} from '../../../../integration-tests/fake-openai-server.js';
import {
  spawnDaemon,
  type SpawnedDaemon,
} from '../../../../integration-tests/cli/_daemon-harness.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const cliBin = path.join(repoRoot, 'dist/cli.js');
const modeSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Workflow mode', exact: true });

test.skip(
  process.platform === 'win32',
  'The existing daemon harness is POSIX-only.',
);
test.setTimeout(120_000);

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function processTree(pid: number) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              command: match[3]!,
            },
          ]
        : [];
    });
  const owned = new Set([pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => owned.has(row.pid));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function modeRecords(runtime: string, sessionId: string) {
  const filenames = (await fs.readdir(runtime, { recursive: true })).filter(
    (filename) => filename.endsWith(`${sessionId}.jsonl`),
  );
  const records: unknown[] = [];
  for (const filename of filenames) {
    const raw = await fs.readFile(path.join(runtime, filename), 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['subtype'] === 'session_workflow_mode') records.push(record);
    }
  }
  return { filenames, records };
}

function enabledValues(records: unknown[]) {
  return records.map(
    (record) =>
      (record as { systemPayload: { enabled: boolean } }).systemPayload.enabled,
  );
}

function currentTurn(body: Record<string, unknown>, marker: string) {
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
  }>;
  const index = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(marker),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return messages
    .slice(index)
    .filter((message) => message.role === 'user')
    .map((message) => JSON.stringify(message.content))
    .join('\n');
}

async function fixture(
  testInfo: TestInfo,
  respond: FakeOpenAIHandler = () => ({ content: 'DW04B complete' }),
) {
  const sha = createHash('sha256')
    .update(await fs.readFile(cliBin))
    .digest('hex');
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'dw04b-browser-')),
  );
  const fixtureHome = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const secondary = path.join(root, 'secondary');
  const runtime = path.join(root, 'runtime');
  await Promise.all(
    [fixtureHome, workspace, secondary, runtime].map((directory) =>
      fs.mkdir(directory),
    ),
  );
  const settingsPath = path.join(fixtureHome, 'settings.json');
  const settings = {
    tools: { workflowsEnabled: true },
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: true },
    },
    memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
    general: { enableAutoUpdate: false },
    ui: { enableFollowupSuggestions: false },
    telemetry: { enabled: false },
    model: { skipNextSpeakerCheck: true },
  };
  await fs.writeFile(settingsPath, JSON.stringify(settings));
  await fs.writeFile(
    path.join(fixtureHome, 'trustedFolders.json'),
    JSON.stringify({
      [workspace]: 'TRUST_FOLDER',
      [secondary]: 'TRUST_FOLDER',
    }),
  );
  await fs.writeFile(path.join(root, 'system.json'), '{}');
  const server = await startFakeOpenAIServer(respond);
  const env: Record<string, string> = Object.fromEntries(
    Object.keys(process.env).map((key) => [key, '']),
  );
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, {
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    QWEN_HOME: fixtureHome,
    QWEN_RUNTIME_DIR: runtime,
    TEST_CLI_PATH: cliBin,
    QWEN_CLI_ENTRY: cliBin,
    QWEN_SANDBOX: 'false',
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'system.json'),
    QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(
      fixtureHome,
      'trustedFolders.json',
    ),
    QWEN_CODE_DISABLE_WORKFLOWS: '0',
    QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP: '0',
    QWEN_CODE_DISABLE_CRON: '1',
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: server.baseUrl,
    OPENAI_MODEL: 'fake-model',
    QWEN_MODEL: 'fake-model',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
  const processes: ReturnType<typeof processTree>[] = [];
  const cleanups: Array<{ pids: number[]; allExited: boolean }> = [];
  let daemon: SpawnedDaemon | undefined;
  const logFiles: Array<{ stdout: string; stderr: string }> = [];
  async function stop() {
    if (!daemon) return;
    const owned = processTree(daemon.daemon.pid!);
    processes.push(owned);
    await daemon.dispose();
    logFiles.push({
      stdout: daemon.stdoutBuf.value,
      stderr: daemon.stderrBuf.value,
    });
    await expect
      .poll(() => owned.filter((row) => alive(row.pid)), { timeout: 15_000 })
      .toEqual([]);
    cleanups.push({ pids: owned.map((row) => row.pid), allExited: true });
    daemon = undefined;
  }
  async function start() {
    daemon = await spawnDaemon({
      cliBin,
      workspaceCwd: workspace,
      extraArgs: ['--workspace', secondary],
      env,
      bootTimeoutMs: 30_000,
    });
    await expect
      .poll(
        async () => {
          try {
            return (await daemon!.client.capabilities()).workspaces?.some(
              (item) => item.cwd === secondary,
            );
          } catch (error) {
            if (
              error instanceof DaemonHttpError &&
              error.status === 503 &&
              typeof error.body === 'object' &&
              error.body !== null &&
              'code' in error.body &&
              error.body.code === 'daemon_runtime_starting'
            )
              return false;
            throw error;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    return daemon;
  }
  return {
    root,
    workspace,
    secondary,
    runtime,
    settings,
    settingsPath,
    server,
    start,
    stop,
    async close() {
      try {
        await stop();
      } finally {
        await server.close();
        const finalSha = createHash('sha256')
          .update(await fs.readFile(cliBin))
          .digest('hex');
        await fs.writeFile(
          testInfo.outputPath('runtime-evidence.json'),
          JSON.stringify(
            {
              cliBin,
              root,
              runtime,
              workspace,
              secondary,
              cliSha256: sha,
              finalCliSha256: finalSha,
              node: process.execPath,
              nodeVersion: process.version,
              processes,
              cleanups,
              logs: logFiles,
              requests: server.requests.map(({ body, transport }) => ({
                body,
                transport,
              })),
            },
            null,
            2,
          ),
        );
        await fs.rm(root, { recursive: true, force: true });
        expect(finalSha).toBe(sha);
      }
    },
  };
}

async function openBrowser(
  browser: Browser,
  daemon: SpawnedDaemon,
  session: DaemonSession,
  testInfo: TestInfo,
  label: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const requests: Array<{
    path: string;
    method: string;
    body: unknown;
    clientId?: string;
  }> = [];
  const assets: Array<{ url: string; sha256: string }> = [];
  const assetReads: Promise<void>[] = [];
  const responses: Array<{ path: string; status: number; body: unknown }> = [];
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('response', (response) => {
    if (
      response.url().startsWith(daemon.base) &&
      /\.js(?:\?|$)/.test(response.url())
    ) {
      assetReads.push(
        response.body().then((body) => {
          assets.push({
            url: response.url(),
            sha256: createHash('sha256').update(body).digest('hex'),
          });
        }),
      );
    }
    if (
      response.url().startsWith(daemon.base) &&
      /\/(?:context|config-option)$/.test(new URL(response.url()).pathname)
    ) {
      assetReads.push(
        response.json().then((body: unknown) => {
          responses.push({
            path: new URL(response.url()).pathname,
            status: response.status(),
            body,
          });
        }),
      );
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === daemon.base && /\/session\//.test(url.pathname)) {
      requests.push({
        path: url.pathname,
        method: request.method(),
        body: request.postData(),
        clientId: request.headers()['x-qwen-client-id'],
      });
    }
  });
  try {
    await page.goto(
      `${daemon.base}/session/${session.sessionId}#token=${encodeURIComponent(daemon.token)}`,
    );
    await expect(modeSwitch(page)).toBeEnabled();
    await Promise.all(assetReads);
    expect(assets.length).toBeGreaterThan(0);
  } catch (error) {
    await context.close();
    throw error;
  }
  return {
    page,
    requests,
    async close() {
      try {
        await fs.writeFile(
          testInfo.outputPath(`${label}-http.json`),
          JSON.stringify(requests, null, 2),
        );
        await Promise.all(assetReads);
        await fs.writeFile(
          testInfo.outputPath(`${label}-assets.json`),
          JSON.stringify(assets, null, 2),
        );
        await fs.writeFile(
          testInfo.outputPath(`${label}-responses.json`),
          JSON.stringify(responses, null, 2),
        );
        await fs.writeFile(
          testInfo.outputPath(`${label}-page-errors.json`),
          JSON.stringify(browserErrors),
        );
      } finally {
        await context.close();
      }
    },
  };
}

async function send(page: Page, marker: string) {
  await page
    .locator('[data-web-shell-composer-editor] .cm-content')
    .fill(marker);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

async function observeEvents(
  daemon: SpawnedDaemon,
  session: DaemonSession,
  testInfo: TestInfo,
) {
  const controller = new AbortController();
  const events: DaemonEvent[] = [];
  const ready = barrier();
  const collecting = (async () => {
    try {
      for await (const event of daemon.client.subscribeEvents(
        session.sessionId,
        {
          clientId: session.clientId,
          signal: controller.signal,
          onSseStreamAccepted: () => ready.release(),
        },
      )) {
        events.push(event);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  await Promise.race([ready.promise, collecting]);
  return async () => {
    controller.abort();
    await collecting;
    await fs.writeFile(
      testInfo.outputPath('events.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n'),
    );
  };
}

test('real browsers share owner mode while a turn runs and persist only that session', async ({
  browser,
}, testInfo) => {
  const hold = barrier();
  let first = true;
  const runtime = await fixture(testInfo, ({ body }) => {
    if (first && body['stream'] === true) {
      first = false;
      return {
        contentChunks: ['DW04B held stream', ' completed'],
        holdAfterChunks: 1,
        holdUntil: hold.promise,
      };
    }
    return { content: 'DW04B complete' };
  });
  const clients: Awaited<ReturnType<typeof openBrowser>>[] = [];
  let stopObserving: (() => Promise<void>) | undefined;
  try {
    const daemon = await runtime.start();
    const owner = await daemon.client.createOrAttachSession({
      workspaceCwd: runtime.workspace,
      sessionScope: 'thread',
    });
    const other = await daemon.client.createOrAttachSession({
      workspaceCwd: runtime.secondary,
      sessionScope: 'thread',
    });
    stopObserving = await observeEvents(daemon, owner, testInfo);
    const firstClient = await openBrowser(
      browser,
      daemon,
      owner,
      testInfo,
      'first',
    );
    clients.push(firstClient);
    const secondClient = await openBrowser(
      browser,
      daemon,
      owner,
      testInfo,
      'second',
    );
    clients.push(secondClient);
    const draft = 'DW04B preserved composer draft';
    await secondClient.page
      .locator('[data-web-shell-composer-editor] .cm-content')
      .fill(draft);
    const beforeToggle = runtime.server.requests.length;
    await modeSwitch(firstClient.page).click();
    await expect(modeSwitch(firstClient.page)).toBeChecked();
    await expect(modeSwitch(secondClient.page)).toBeChecked();
    await expect(
      secondClient.page.locator('[data-web-shell-composer-editor] .cm-content'),
    ).toHaveText(draft);
    expect(runtime.server.requests).toHaveLength(beforeToggle);
    const marker = `DW04B_${randomUUID()}`;
    await send(firstClient.page, marker);
    await expect(
      firstClient.page.getByText('DW04B held stream', { exact: false }).first(),
    ).toBeVisible();
    const heldRequest = runtime.server.requests.find(
      ({ body }) =>
        body['stream'] === true && JSON.stringify(body).includes(marker),
    );
    expect(heldRequest).toBeDefined();
    expect(currentTurn(heldRequest!.body, marker)).toContain(
      'Workflow mode is enabled for this session.',
    );
    expect(
      currentTurn(heldRequest!.body, marker).match(
        /Workflow mode is enabled for this session\./g,
      ),
    ).toHaveLength(1);
    await modeSwitch(secondClient.page).click();
    await expect(modeSwitch(firstClient.page)).not.toBeChecked();
    await expect(modeSwitch(secondClient.page)).not.toBeChecked();
    expect(heldRequest!.transport.closedAt).toBeUndefined();
    hold.release();
    await expect(
      firstClient.page.getByRole('button', {
        name: 'Send message',
        exact: true,
      }),
    ).toBeVisible();
    const exitMarker = `DW04B_${randomUUID()}`;
    await send(firstClient.page, exitMarker);
    await expect
      .poll(() =>
        runtime.server.requests.some(
          ({ body }) =>
            body['stream'] === true &&
            JSON.stringify(body).includes(exitMarker),
        ),
      )
      .toBe(true);
    await expect(
      firstClient.page.getByRole('button', {
        name: 'Send message',
        exact: true,
      }),
    ).toBeVisible();
    const finalMarker = `DW04B_${randomUUID()}`;
    await send(firstClient.page, finalMarker);
    await expect
      .poll(() =>
        runtime.server.requests.some(
          ({ body }) =>
            body['stream'] === true &&
            JSON.stringify(body).includes(finalMarker),
        ),
      )
      .toBe(true);
    await expect(
      firstClient.page.getByRole('button', {
        name: 'Send message',
        exact: true,
      }),
    ).toBeVisible();
    const exit = runtime.server.requests.find(
      ({ body }) =>
        body['stream'] === true && currentTurnIfPresent(body, exitMarker),
    );
    const final = runtime.server.requests.find(
      ({ body }) =>
        body['stream'] === true && currentTurnIfPresent(body, finalMarker),
    );
    expect(currentTurn(exit!.body, exitMarker)).toContain(
      'Workflow mode is off for this session.',
    );
    expect(
      currentTurn(exit!.body, exitMarker).match(
        /Workflow mode is off for this session\./g,
      ),
    ).toHaveLength(1);
    expect(currentTurn(final!.body, finalMarker)).not.toContain(
      'Workflow mode is',
    );
    const records = await modeRecords(runtime.runtime, owner.sessionId);
    expect(enabledValues(records.records)).toEqual([true, false]);
    expect(
      (await modeRecords(runtime.runtime, other.sessionId)).records,
    ).toEqual([]);
    const otherContext = await daemon.client.sessionContext(
      other.sessionId,
      other.clientId,
    );
    expect(otherContext.state.configOptions).toContainEqual(
      expect.objectContaining({ id: 'workflow_mode', currentValue: 'off' }),
    );
    const leases = clients.map(
      ({ requests }) =>
        requests.find((request) => request.path.endsWith('/config-option'))
          ?.clientId,
    );
    expect(leases[0]).toBeTruthy();
    expect(leases[1]).toBeTruthy();
    expect(leases[0]).not.toBe(leases[1]);
    expect(
      clients
        .flatMap(({ requests }) => requests)
        .filter((request) => /\/cancel$/.test(request.path)),
    ).toHaveLength(0);
    const modeWritesBeforeNavigation = firstClient.requests.filter((request) =>
      request.path.endsWith('/config-option'),
    ).length;
    const sidebar = firstClient.page.locator('[data-sidebar-shell]');
    await sidebar
      .getByText(other.sessionId.slice(0, 8), { exact: true })
      .first()
      .click();
    await expect(modeSwitch(firstClient.page)).toBeEnabled();
    await expect(modeSwitch(firstClient.page)).not.toBeChecked();
    await sidebar.getByText(marker, { exact: true }).first().click();
    await expect(modeSwitch(firstClient.page)).toBeEnabled();
    await expect(modeSwitch(firstClient.page)).not.toBeChecked();
    expect(
      firstClient.requests.filter((request) =>
        request.path.endsWith('/config-option'),
      ),
    ).toHaveLength(modeWritesBeforeNavigation);
    await fs.writeFile(
      testInfo.outputPath('mode-records.json'),
      JSON.stringify(records, null, 2),
    );
    await firstClient.page.screenshot({
      path: testInfo.outputPath('real-owner-off.png'),
    });
  } finally {
    hold.release();
    try {
      await Promise.all([
        stopObserving?.(),
        ...clients.map((client) => client.close()),
      ]);
    } finally {
      await runtime.close();
    }
  }
});

function currentTurnIfPresent(body: Record<string, unknown>, marker: string) {
  return JSON.stringify(body['messages']).includes(marker);
}

test('real browser restores requested mode after child restart and can disable unavailable mode', async ({
  browser,
}, testInfo) => {
  const runtime = await fixture(testInfo);
  let client: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    let daemon = await runtime.start();
    const session = await daemon.client.createOrAttachSession({
      workspaceCwd: runtime.workspace,
      sessionScope: 'thread',
    });
    client = await openBrowser(
      browser,
      daemon,
      session,
      testInfo,
      'before-restart',
    );
    await modeSwitch(client.page).click();
    await expect(modeSwitch(client.page)).toBeChecked();
    const marker = `DW04B_restore_${randomUUID()}`;
    await send(client.page, marker);
    await expect
      .poll(() =>
        runtime.server.requests.some(
          ({ body }) =>
            body['stream'] === true && currentTurnIfPresent(body, marker),
        ),
      )
      .toBe(true);
    await expect(
      client.page.getByRole('button', { name: 'Send message', exact: true }),
    ).toBeVisible();
    const requestsBeforeRestore = runtime.server.requests.length;
    expect(
      enabledValues(
        (await modeRecords(runtime.runtime, session.sessionId)).records,
      ),
    ).toEqual([true]);
    const before = processTree(daemon.daemon.pid!);
    expect(
      before.filter(
        (row) => row.command.includes(cliBin) && row.command.includes('--acp'),
      ).length,
    ).toBeGreaterThan(0);
    await client.close();
    client = undefined;
    await runtime.stop();
    daemon = await runtime.start();
    const restored = await daemon.client.resumeSession(session.sessionId, {
      workspaceCwd: runtime.workspace,
    });
    client = await openBrowser(
      browser,
      daemon,
      restored,
      testInfo,
      'cold-restored',
    );
    await expect(modeSwitch(client.page)).toBeChecked();
    expect(
      client.requests.filter((request) =>
        request.path.endsWith('/config-option'),
      ),
    ).toHaveLength(0);
    expect(runtime.server.requests).toHaveLength(requestsBeforeRestore);
    const after = processTree(daemon.daemon.pid!);
    expect(
      after.filter(
        (row) => row.command.includes(cliBin) && row.command.includes('--acp'),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      before.some((row) => after.some((next) => row.pid === next.pid)),
    ).toBe(false);
    await client.page.screenshot({
      path: testInfo.outputPath('cold-restored-on.png'),
    });
    await client.close();
    client = undefined;
    await runtime.stop();
    runtime.settings.tools.workflowsEnabled = false;
    await fs.writeFile(runtime.settingsPath, JSON.stringify(runtime.settings));
    daemon = await runtime.start();
    const unavailable = await daemon.client.resumeSession(session.sessionId, {
      workspaceCwd: runtime.workspace,
    });
    client = await openBrowser(
      browser,
      daemon,
      unavailable,
      testInfo,
      'unavailable',
    );
    await expect(modeSwitch(client.page)).toBeChecked();
    const status = await daemon.client.sessionContext(
      unavailable.sessionId,
      unavailable.clientId,
    );
    expect(status.state.configOptions).toContainEqual(
      expect.objectContaining({
        id: 'workflow_mode',
        currentValue: 'on',
        _meta: {
          'qwen.workflowMode': expect.objectContaining({
            available: false,
            effective: false,
          }),
        },
      }),
    );
    await modeSwitch(client.page).click();
    await expect(modeSwitch(client.page)).not.toBeChecked();
    await expect(modeSwitch(client.page)).toBeDisabled();
    const records = await modeRecords(runtime.runtime, session.sessionId);
    expect(enabledValues(records.records)).toEqual([true, false]);
    expect(runtime.server.requests).toHaveLength(requestsBeforeRestore);
    await fs.writeFile(
      testInfo.outputPath('restored-mode-records.json'),
      JSON.stringify(records, null, 2),
    );
    await client.page.screenshot({
      path: testInfo.outputPath('unavailable-off.png'),
    });
  } finally {
    try {
      await client?.close();
    } finally {
      await runtime.close();
    }
  }
});
