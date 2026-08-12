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
import {
  DaemonHttpError,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe('qwen serve WebUI transactional same-session refresh', () => {
  async function setup() {
    const workspace = makeTempWorkspace('webui-same-session-refresh');
    activeWorkspace = workspace;
    activeDaemon = await spawnDaemon({
      workspaceCwd: workspace,
      env: {
        QWEN_CLI_ENTRY: MOCK_AGENT_PATH,
        MOCK_ACP_MODE: 'echo',
      },
    });
    const source = await activeDaemon.client.createOrAttachSession({
      sessionScope: 'thread',
    });
    const resolvedWorkspace = source.workspaceCwd ?? workspace;
    await activeDaemon.client.prompt(source.sessionId, {
      prompt: [{ type: 'text', text: 'source transcript' }],
    });
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
    const render = async (clientId?: string) => {
      await act(async () => {
        root?.render(
          createElement(
            DaemonSessionProvider,
            {
              autoConnect: true,
              baseUrl: activeDaemon!.base,
              token: activeDaemon!.token,
              sessionId: source.sessionId,
              workspaceCwd: resolvedWorkspace,
              historyPageSize: 100,
              ...(clientId ? { clientId } : {}),
            },
            createElement(Harness),
          ),
        );
      });
    };
    await render();
    await waitFor(
      () =>
        connection?.status === 'connected' &&
        connection.sessionId === source.sessionId &&
        connection.capabilities?.features.includes('client_identity') ===
          true &&
        JSON.stringify(blocks).includes('source transcript'),
      'source session bootstrap',
    );
    return {
      workspace: resolvedWorkspace,
      source,
      render,
      getActions: () => {
        if (!actions) throw new Error('session actions unavailable');
        return actions;
      },
      getConnection: () => connection,
      getBlocks: () => blocks,
    };
  }

  it('merges the live source tail before committing a held load response', async () => {
    const originalFetch = globalThis.fetch;
    const state = await setup();
    const responseReady = deferred();
    const releaseResponse = deferred();
    let refresh: Promise<void> | undefined;
    try {
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const response = await originalFetch(request);
        if (
          request.method === 'POST' &&
          new URL(request.url).pathname.endsWith(
            `/session/${encodeURIComponent(state.source.sessionId)}/load`,
          )
        ) {
          responseReady.resolve();
          await releaseResponse.promise;
        }
        return response;
      };
      act(() => {
        refresh = state.getActions().loadSession(state.source.sessionId, {
          workspaceCwd: state.workspace,
        });
      });
      await responseReady.promise;
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
        sessionTransition: { phase: 'preparing' },
      });

      await activeDaemon!.client.prompt(state.source.sessionId, {
        prompt: [{ type: 'text', text: 'live during refresh' }],
      });
      await waitFor(
        () => JSON.stringify(state.getBlocks()).includes('live during refresh'),
        'live source tail',
      );
      await act(async () => {
        releaseResponse.resolve();
        await refresh;
      });

      const transcript = JSON.stringify(state.getBlocks());
      expect(transcript).toContain('source transcript');
      expect(transcript.match(/live during refresh/g)).toHaveLength(1);
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
      });
    } finally {
      globalThis.fetch = originalFetch;
      releaseResponse.resolve();
      await refresh?.catch(() => undefined);
    }
  }, 30_000);

  it('preserves the source after a structured same-session timeout', async () => {
    const originalFetch = globalThis.fetch;
    const state = await setup();
    const sourceClientId = state.getConnection()?.clientId;
    try {
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (
          request.method === 'POST' &&
          new URL(request.url).pathname.endsWith(
            `/session/${encodeURIComponent(state.source.sessionId)}/load`,
          )
        ) {
          return new Response(
            JSON.stringify({
              code: 'session_restore_timeout',
              error: 'Session restore timed out',
              retryable: true,
            }),
            {
              status: 504,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        return originalFetch(request);
      };
      let restoreError: unknown;
      await act(async () => {
        try {
          await state.getActions().reloadSession(new AbortController().signal);
        } catch (error) {
          restoreError = error;
        }
      });
      expect(restoreError).toBeInstanceOf(DaemonHttpError);
      expect(restoreError).toMatchObject({
        status: 504,
        body: { code: 'session_restore_timeout', retryable: true },
      });
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
        clientId: sourceClientId,
        sessionTransition: {
          phase: 'failed',
          error: { code: 'session_restore_timeout', status: 504 },
        },
      });
      expect(JSON.stringify(state.getBlocks())).toContain('source transcript');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  it('preserves the transcript across a controlled clientId rebind', async () => {
    const state = await setup();
    const rebound = await activeDaemon!.client.resumeSession(
      state.source.sessionId,
      { workspaceCwd: state.workspace },
    );
    const reboundClientId = rebound.clientId;
    expect(reboundClientId).toBeTruthy();
    await state.render(reboundClientId!);
    await waitFor(
      () => state.getConnection()?.clientId === reboundClientId,
      'clientId rebind',
    );
    expect(JSON.stringify(state.getBlocks())).toContain('source transcript');
    await act(async () => {
      await state.getActions().sendPrompt('prompt after rebind');
    });
    await waitFor(
      () => JSON.stringify(state.getBlocks()).includes('prompt after rebind'),
      'prompt after clientId rebind',
    );
  }, 30_000);
});
