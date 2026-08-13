/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  makeTempWorkspace,
  spawnDaemon,
  type SpawnedDaemon,
} from './_daemon-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.resolve(
  __dirname,
  '../fixtures/mock-acp-child/agent.mjs',
);
const CLIENT_ID = 'webui-state-resync-client';

let activeDaemon: SpawnedDaemon | undefined;
let activeWorkspace: string | undefined;
let root: Root | undefined;
let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;
let DaemonSessionProvider: typeof import('@qwen-code/webui/daemon-react-sdk').DaemonSessionProvider;
let useActions: typeof import('@qwen-code/webui/daemon-react-sdk').useActions;
let useConnection: typeof import('@qwen-code/webui/daemon-react-sdk').useConnection;
let useTranscriptBlocks: typeof import('@qwen-code/webui/daemon-react-sdk').useTranscriptBlocks;
const originalGlobalDescriptors = new Map(
  ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  ),
);

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  ({ createRoot } = await import('react-dom/client'));
  ({ DaemonSessionProvider, useActions, useConnection, useTranscriptBlocks } =
    await import('@qwen-code/webui/daemon-react-sdk'));
});

afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  await activeDaemon?.dispose();
  activeDaemon = undefined;
  if (activeWorkspace) {
    fs.rmSync(activeWorkspace, { recursive: true, force: true });
    activeWorkspace = undefined;
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForPromise<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('qwen serve WebUI transactional state resync', () => {
  it('keeps the source visible until an authoritative ring-eviction reload commits', async () => {
    const workspace = makeTempWorkspace('webui-state-resync');
    activeWorkspace = workspace;
    activeDaemon = await spawnDaemon({
      workspaceCwd: workspace,
      extraArgs: ['--event-ring-size', '3'],
      env: {
        QWEN_CLI_ENTRY: MOCK_AGENT_PATH,
        MOCK_ACP_MODE: 'echo',
        MOCK_ACP_EMIT_CHUNKS: '20',
      },
    });
    const created = await activeDaemon.client.createOrAttachSession(
      { sessionScope: 'thread' },
      CLIENT_ID,
    );
    const stableClientId = created.clientId ?? CLIENT_ID;
    await activeDaemon.client.promptNonBlocking(
      created.sessionId,
      { prompt: [{ type: 'text', text: 'seed transcript' }] },
      undefined,
      stableClientId,
    );
    await waitFor(async () => {
      const status = await activeDaemon!.client.daemonStatus('full');
      return (
        status.full?.sessions.some(
          (session) =>
            session.sessionId === created.sessionId &&
            session.hasActivePrompt === false,
        ) === true
      );
    }, 'seed prompt to finish');

    const originalFetch = globalThis.fetch;
    const firstSseController = new AbortController();
    const firstSseReady = deferred();
    const reconnectReady = deferred<number>();
    const releaseReconnect = deferred();
    const recoveryLoadReady = deferred();
    const releaseRecoveryLoad = deferred();
    let eventRequestCount = 0;
    let loadRequestCount = 0;
    let recoveryLoadBody: Record<string, unknown> | undefined;

    try {
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (
          request.method === 'GET' &&
          url.pathname.endsWith(
            `/session/${encodeURIComponent(created.sessionId)}/events`,
          )
        ) {
          eventRequestCount += 1;
          if (eventRequestCount === 1) {
            const response = await originalFetch(
              new Request(request, {
                signal: AbortSignal.any([
                  request.signal,
                  firstSseController.signal,
                ]),
              }),
            );
            firstSseReady.resolve();
            return response;
          }
          if (url.searchParams.get('connectReason') === 'transport_error') {
            const rawCursor = request.headers.get('Last-Event-ID');
            const cursor = rawCursor === null ? NaN : Number(rawCursor);
            if (
              rawCursor === null ||
              rawCursor.length === 0 ||
              !Number.isSafeInteger(cursor) ||
              cursor < 0
            ) {
              throw new Error('Provider reconnect omitted Last-Event-ID');
            }
            reconnectReady.resolve(cursor);
            await releaseReconnect.promise;
          }
        }
        if (
          request.method === 'POST' &&
          url.pathname.endsWith(
            `/session/${encodeURIComponent(created.sessionId)}/load`,
          )
        ) {
          loadRequestCount += 1;
          const body = (await request.clone().json()) as Record<
            string,
            unknown
          >;
          const response = await originalFetch(request);
          if (loadRequestCount === 2) {
            recoveryLoadBody = body;
            recoveryLoadReady.resolve();
            await releaseRecoveryLoad.promise;
          }
          return response;
        }
        return await originalFetch(request);
      };

      let actions: ReturnType<typeof useActions> | undefined;
      let connection: ReturnType<typeof useConnection> | undefined;
      let blocks: readonly DaemonTranscriptBlock[] = [];
      function Harness() {
        actions = useActions();
        connection = useConnection();
        blocks = useTranscriptBlocks();
        return null;
      }
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          // eslint-disable-next-line react/no-children-prop
          createElement(DaemonSessionProvider, {
            autoConnect: true,
            baseUrl: activeDaemon!.base,
            token: activeDaemon!.token,
            sessionId: created.sessionId,
            workspaceCwd: created.workspaceCwd,
            clientId: stableClientId,
            historyPageSize: 100,
            children: createElement(Harness),
          }),
        );
      });
      await waitForPromise(firstSseReady.promise, 'initial SSE response');
      await waitFor(
        () =>
          connection?.status === 'connected' &&
          JSON.stringify(blocks).includes('seed transcript'),
        'initial WebUI attachment',
      );
      const baseline = (
        await activeDaemon.client.daemonStatus('full')
      ).full?.sessions.find(
        (session) => session.sessionId === created.sessionId,
      );
      expect(baseline).toBeDefined();

      firstSseController.abort();
      const reconnectCursor = await waitForPromise(
        reconnectReady.promise,
        'held transport reconnect',
      );
      await activeDaemon.client.promptNonBlocking(
        created.sessionId,
        { prompt: [{ type: 'text', text: 'gap during reconnect' }] },
        undefined,
        stableClientId,
      );
      await waitFor(async () => {
        const status = await activeDaemon!.client.daemonStatus('full');
        const session = status.full?.sessions.find(
          (entry) => entry.sessionId === created.sessionId,
        );
        return (
          session?.hasActivePrompt === false &&
          session.lastEventId >= reconnectCursor + 4
        );
      }, 'event ring to advance beyond the held cursor');

      const resyncLogOffset = activeDaemon.stderrBuf.value.length;
      releaseReconnect.resolve();
      await waitForPromise(
        recoveryLoadReady.promise,
        'held recovery load response',
      );
      expect(recoveryLoadBody).not.toHaveProperty('historyPageSize');
      expect(JSON.stringify(blocks)).toContain('seed transcript');
      expect(JSON.stringify(blocks)).not.toContain('gap during reconnect');
      expect(connection).toMatchObject({
        status: 'connected',
        sessionId: created.sessionId,
        sessionRecoveryRequired: true,
        sessionTransition: { origin: 'recovery', phase: 'preparing' },
      });
      if (!actions) throw new Error('session actions unavailable');
      await expect(
        actions.sendPrompt('blocked while recovering'),
      ).rejects.toThrow('read-only until recovery completes');

      releaseRecoveryLoad.resolve();
      await waitFor(
        () =>
          connection?.sessionRecoveryRequired !== true &&
          connection?.sessionTransition === undefined &&
          JSON.stringify(blocks).includes('seed transcript') &&
          JSON.stringify(blocks).includes('gap during reconnect'),
        'atomic state recovery',
      );
      expect(
        JSON.stringify(blocks).match(/gap during reconnect/g),
      ).toHaveLength(1);
      expect(JSON.stringify(blocks).match(/chunk-0/g)).toHaveLength(2);
      expect(JSON.stringify(blocks).match(/chunk-19/g)).toHaveLength(2);
      const currentActions = actions;
      if (!currentActions) throw new Error('session actions unavailable');
      await act(async () => {
        await currentActions.sendPrompt('after recovery');
      });
      await waitFor(async () => {
        const status = await activeDaemon!.client.daemonStatus('full');
        const session = status.full?.sessions.find(
          (entry) => entry.sessionId === created.sessionId,
        );
        return (
          session?.hasActivePrompt === false &&
          session.clientCount === baseline?.clientCount &&
          session.attachCount === baseline?.attachCount &&
          session.subscriberCount === baseline?.subscriberCount
        );
      }, 'replacement runner and attachment ledger to stabilize');
      expect(activeDaemon.stderrBuf.value.slice(resyncLogOffset)).toContain(
        'ring_evicted',
      );
    } finally {
      globalThis.fetch = originalFetch;
      releaseReconnect.resolve();
      releaseRecoveryLoad.resolve();
    }
  }, 60_000);
});
