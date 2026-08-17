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
let root: Root | undefined;
let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;
let DaemonSessionProvider: typeof import('@qwen-code/webui/daemon-react-sdk').DaemonSessionProvider;
let useActions: typeof import('@qwen-code/webui/daemon-react-sdk').useActions;
let useConnection: typeof import('@qwen-code/webui/daemon-react-sdk').useConnection;
let useTranscriptBlocks: typeof import('@qwen-code/webui/daemon-react-sdk').useTranscriptBlocks;
let restoreSessionRequestRecorder: (() => void) | undefined;
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
  restoreSessionRequestRecorder?.();
  restoreSessionRequestRecorder = undefined;
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  await activeDaemon?.dispose();
  activeDaemon = undefined;
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RecordedSessionRequest {
  method: string;
  pathname: string;
  sessionId: string | undefined;
  clientId: string | undefined;
}

function installSessionRequestRecorder(
  respond?: (request: Request) => Response | undefined,
) {
  const originalFetch = globalThis.fetch;
  const requests: RecordedSessionRequest[] = [];
  let recording = true;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/session\/([^/]+)\//);
    if (recording) {
      requests.push({
        method: request.method,
        pathname: url.pathname,
        sessionId: match?.[1] ? decodeURIComponent(match[1]) : undefined,
        clientId: request.headers.get('X-Qwen-Client-Id') ?? undefined,
      });
    }
    return respond?.(request) ?? originalFetch(request);
  };
  const stop = () => {
    if (!recording) return;
    recording = false;
    globalThis.fetch = originalFetch;
    if (restoreSessionRequestRecorder === stop) {
      restoreSessionRequestRecorder = undefined;
    }
  };
  restoreSessionRequestRecorder = stop;
  return {
    requests,
    stop,
  };
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

describe('qwen serve WebUI transactional session switching', () => {
  async function setup() {
    const workspace = makeTempWorkspace('webui-session-switching');
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
    const target = await activeDaemon.client.createOrAttachSession({
      sessionScope: 'thread',
    });
    await activeDaemon.client.prompt(target.sessionId, {
      prompt: [{ type: 'text', text: 'target transcript' }],
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
          },
          createElement(Harness),
        ),
      );
    });
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
      target,
      getActions: () => {
        if (!actions) throw new Error('session actions unavailable');
        return actions;
      },
      getConnection: () => connection,
      getBlocks: () => blocks,
    };
  }

  async function setupActiveSource(options?: { targetLoadTimeout?: boolean }) {
    const workspace = makeTempWorkspace('webui-session-switching-active');
    activeDaemon = await spawnDaemon({
      workspaceCwd: workspace,
      env: {
        QWEN_CLI_ENTRY: MOCK_AGENT_PATH,
        MOCK_ACP_MODE: 'hang',
      },
    });
    const source = await activeDaemon.client.createOrAttachSession({
      sessionScope: 'thread',
    });
    const target = await activeDaemon.client.createOrAttachSession({
      sessionScope: 'thread',
    });
    const resolvedWorkspace = source.workspaceCwd ?? workspace;
    const recorder = installSessionRequestRecorder((request) => {
      if (
        options?.targetLoadTimeout === true &&
        request.method === 'POST' &&
        new URL(request.url).pathname.endsWith(
          `/session/${encodeURIComponent(target.sessionId)}/load`,
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
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '5',
            },
          },
        );
      }
      return undefined;
    });
    let actions: ReturnType<typeof useActions> | undefined;
    let connection: ReturnType<typeof useConnection> | undefined;
    function Harness() {
      actions = useActions();
      connection = useConnection();
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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
          },
          createElement(Harness),
        ),
      );
    });
    await waitFor(
      () =>
        connection?.status === 'connected' &&
        connection.sessionId === source.sessionId &&
        connection.capabilities?.features.includes('client_identity') === true,
      'active source bootstrap',
    );
    const admitted = deferred();
    let promptSettled = false;
    let promptOutcome!: Promise<unknown>;
    act(() => {
      promptOutcome = actions!
        .sendPrompt('source remains active', {
          onAdmitted: () => admitted.resolve(),
        })
        .then(
          (result) => {
            promptSettled = true;
            return result;
          },
          (error: unknown) => {
            promptSettled = true;
            return error;
          },
        );
    });
    await admitted.promise;
    expect(
      (await activeDaemon.client.sessionStatus(source.sessionId))
        .hasActivePrompt,
    ).toBe(true);
    return {
      workspace: resolvedWorkspace,
      source,
      target,
      recorder,
      container,
      promptOutcome,
      isPromptSettled: () => promptSettled,
      getActions: () => {
        if (!actions) throw new Error('session actions unavailable');
        return actions;
      },
      getConnection: () => connection,
    };
  }

  async function cleanupActiveSource(
    state: Awaited<ReturnType<typeof setupActiveSource>>,
  ) {
    state.recorder.stop();
    try {
      await act(async () => {
        await state.getActions().cancel();
        await state.promptOutcome;
      });
    } finally {
      if (root) {
        await act(async () => root?.unmount());
        root = undefined;
      }
      state.container.remove();
      await activeDaemon?.dispose();
      activeDaemon = undefined;
      fs.rmSync(state.workspace, { recursive: true, force: true });
    }
  }

  function executionRequests(requests: readonly RecordedSessionRequest[]) {
    return requests.filter(
      (request) =>
        request.method === 'POST' &&
        /\/(?:prompt|cancel|continue|mid-turn-message)$/.test(request.pathname),
    );
  }

  it('keeps an active source running across A to B to A navigation', async () => {
    const state = await setupActiveSource();
    try {
      await act(async () => {
        await state.getActions().loadSession(state.target.sessionId, {
          workspaceCwd: state.workspace,
        });
      });
      await expect(state.promptOutcome).resolves.toEqual({
        stopReason: 'cancelled',
      });
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.target.sessionId,
      });
      expect(
        (await activeDaemon!.client.sessionStatus(state.source.sessionId))
          .hasActivePrompt,
      ).toBe(true);

      await act(async () => {
        await state.getActions().loadSession(state.source.sessionId, {
          workspaceCwd: state.workspace,
        });
      });
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
      });
      expect(
        (await activeDaemon!.client.sessionStatus(state.source.sessionId))
          .hasActivePrompt,
      ).toBe(true);
      expect(executionRequests(state.recorder.requests)).toEqual([
        expect.objectContaining({
          pathname: `/session/${state.source.sessionId}/prompt`,
          sessionId: state.source.sessionId,
        }),
      ]);
    } finally {
      await cleanupActiveSource(state);
    }
  }, 30_000);

  it('keeps an active source and its waiter after a target 504', async () => {
    const state = await setupActiveSource({ targetLoadTimeout: true });
    try {
      let restoreError: unknown;
      await act(async () => {
        try {
          await state.getActions().loadSession(state.target.sessionId, {
            workspaceCwd: state.workspace,
          });
        } catch (error) {
          restoreError = error;
        }
      });
      expect(restoreError).toMatchObject({
        status: 504,
        body: {
          code: 'session_restore_timeout',
          retryable: true,
        },
      });
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
        sessionTransition: { phase: 'failed' },
      });
      expect(state.isPromptSettled()).toBe(false);
      expect(
        (await activeDaemon!.client.sessionStatus(state.source.sessionId))
          .hasActivePrompt,
      ).toBe(true);
      expect(executionRequests(state.recorder.requests)).toEqual([
        expect.objectContaining({
          pathname: `/session/${state.source.sessionId}/prompt`,
          sessionId: state.source.sessionId,
        }),
      ]);
    } finally {
      await cleanupActiveSource(state);
    }
  }, 30_000);

  it('keeps the source usable until a completed target response is released', async () => {
    const originalFetch = globalThis.fetch;
    const state = await setup();
    const responseReady = deferred();
    const releaseResponse = deferred();
    let loadOutcome: Promise<unknown> | undefined;
    try {
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const response = await originalFetch(request);
        if (
          request.method === 'POST' &&
          new URL(request.url).pathname.endsWith(
            `/session/${encodeURIComponent(state.target.sessionId)}/load`,
          )
        ) {
          responseReady.resolve();
          await releaseResponse.promise;
        }
        return response;
      };
      act(() => {
        loadOutcome = state
          .getActions()
          .loadSession(state.target.sessionId, {
            workspaceCwd: state.workspace,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
      });
      await responseReady.promise;

      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
        sessionTransition: { phase: 'preparing' },
      });
      await expect(state.getActions().cancel()).resolves.toBeUndefined();
      await activeDaemon!.client.prompt(state.source.sessionId, {
        prompt: [{ type: 'text', text: 'source remains live' }],
      });
      await waitFor(
        () => JSON.stringify(state.getBlocks()).includes('source remains live'),
        'source event while target response is held',
      );

      await act(async () => {
        releaseResponse.resolve();
        expect(await loadOutcome).toBeUndefined();
      });
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.target.sessionId,
      });
      expect(JSON.stringify(state.getBlocks())).toContain('target transcript');
      expect(JSON.stringify(state.getBlocks())).not.toContain(
        'source remains live',
      );
    } finally {
      globalThis.fetch = originalFetch;
      releaseResponse.resolve();
      await loadOutcome?.catch(() => undefined);
      if (root) {
        await act(async () => root?.unmount());
        root = undefined;
      }
      await activeDaemon?.dispose();
      activeDaemon = undefined;
      fs.rmSync(state.workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('serializes non-equivalent load and resume requests for one target', async () => {
    const originalFetch = globalThis.fetch;
    const state = await setup();
    const loadResponseReady = deferred();
    const releaseLoadResponse = deferred();
    let loadRequests = 0;
    let resumeRequests = 0;
    let targetDetachRequests = 0;
    let staleClientId: string | undefined;
    const detachedClientIds: Array<string | null> = [];
    let loadOutcome: Promise<unknown> | undefined;
    let resumeOutcome: Promise<void> | undefined;
    try {
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const pathname = new URL(request.url).pathname;
        const targetPath = `/session/${encodeURIComponent(state.target.sessionId)}`;
        if (
          request.method === 'POST' &&
          pathname.endsWith(`${targetPath}/resume`)
        ) {
          resumeRequests += 1;
        }
        if (
          request.method === 'POST' &&
          pathname.endsWith(`${targetPath}/detach`)
        ) {
          targetDetachRequests += 1;
          detachedClientIds.push(request.headers.get('X-Qwen-Client-Id'));
        }
        const response = await originalFetch(request);
        if (
          request.method === 'POST' &&
          pathname.endsWith(`${targetPath}/load`)
        ) {
          loadRequests += 1;
          const payload = (await response.clone().json()) as {
            clientId?: unknown;
          };
          staleClientId =
            typeof payload.clientId === 'string' ? payload.clientId : undefined;
          loadResponseReady.resolve();
          await releaseLoadResponse.promise;
        }
        return response;
      };
      act(() => {
        loadOutcome = state
          .getActions()
          .loadSession(state.target.sessionId, {
            workspaceCwd: state.workspace,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
      });
      await loadResponseReady.promise;

      act(() => {
        resumeOutcome = state
          .getActions()
          .resumeSession(state.target.sessionId, {
            workspaceCwd: state.workspace,
          });
      });
      expect(await loadOutcome).toMatchObject({ name: 'AbortError' });
      expect(loadRequests).toBe(1);
      expect(resumeRequests).toBe(0);
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
        sessionTransition: { phase: 'queued', operation: 'resume' },
      });

      await activeDaemon!.client.prompt(state.source.sessionId, {
        prompt: [{ type: 'text', text: 'source remains live while queued' }],
      });
      await waitFor(
        () =>
          JSON.stringify(state.getBlocks()).includes(
            'source remains live while queued',
          ),
        'source event while resume is queued',
      );

      await act(async () => {
        releaseLoadResponse.resolve();
        await resumeOutcome;
      });
      expect(resumeRequests).toBe(1);
      await waitFor(
        () => targetDetachRequests === 1,
        'stale target attachment cleanup',
      );
      expect(staleClientId).toBeTruthy();
      expect(detachedClientIds).toEqual([staleClientId]);
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.target.sessionId,
      });
      expect(state.getConnection()?.clientId).toBeTruthy();
      expect(state.getConnection()?.clientId).not.toBe(staleClientId);
    } finally {
      globalThis.fetch = originalFetch;
      releaseLoadResponse.resolve();
      await loadOutcome?.catch(() => undefined);
      await resumeOutcome?.catch(() => undefined);
      if (root) {
        await act(async () => root?.unmount());
        root = undefined;
      }
      await activeDaemon?.dispose();
      activeDaemon = undefined;
      fs.rmSync(state.workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves the source after a structured target timeout', async () => {
    const originalFetch = globalThis.fetch;
    const state = await setup();
    try {
      globalThis.fetch = async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (
          request.method === 'POST' &&
          new URL(request.url).pathname.endsWith(
            `/session/${encodeURIComponent(state.target.sessionId)}/load`,
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
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '5',
              },
            },
          );
        }
        return originalFetch(request);
      };
      let restoreError: unknown;
      await act(async () => {
        try {
          await state.getActions().loadSession(state.target.sessionId, {
            workspaceCwd: state.workspace,
          });
        } catch (error) {
          restoreError = error;
        }
      });
      expect(restoreError).toBeInstanceOf(DaemonHttpError);
      expect(restoreError).toMatchObject({
        status: 504,
        body: {
          code: 'session_restore_timeout',
          retryable: true,
        },
      });
      expect(state.getConnection()).toMatchObject({
        status: 'connected',
        sessionId: state.source.sessionId,
        sessionTransition: {
          phase: 'failed',
          error: { code: 'session_restore_timeout', status: 504 },
        },
      });
      expect(JSON.stringify(state.getBlocks())).toContain('source transcript');
      await activeDaemon!.client.prompt(state.source.sessionId, {
        prompt: [{ type: 'text', text: 'source after timeout' }],
      });
      await waitFor(
        () =>
          JSON.stringify(state.getBlocks()).includes('source after timeout'),
        'source event after target timeout',
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (root) {
        await act(async () => root?.unmount());
        root = undefined;
      }
      await activeDaemon?.dispose();
      activeDaemon = undefined;
      fs.rmSync(state.workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
