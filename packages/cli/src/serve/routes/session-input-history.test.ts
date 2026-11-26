/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Response } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DaemonLogger } from '../daemon-logger.js';
import { registerWorkspaceInputHistoryRoutes } from './workspace-input-history.js';

const historyGate = vi.hoisted(() => ({
  onCall: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
  rejectWith: undefined as Error | undefined,
}));

vi.mock('../workspace-input-history.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../workspace-input-history.js')>();
  return {
    ...actual,
    appendWorkspaceInputHistory: async (
      ...args: Parameters<typeof actual.appendWorkspaceInputHistory>
    ) => {
      historyGate.onCall?.();
      if (historyGate.gate) {
        await historyGate.gate;
      }
      if (historyGate.rejectWith) {
        throw historyGate.rejectWith;
      }
      return actual.appendWorkspaceInputHistory(...args);
    },
  };
});

import { registerSessionRoutes } from './session.js';

const tmpRoot = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'session-input-history-')),
);
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeHarness() {
  const workspaceDir = path.join(tmpRoot, randomUUID());
  const runtimeBaseDir = path.join(tmpRoot, randomUUID());
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(runtimeBaseDir, { recursive: true });
  const sessionId = randomUUID();
  const warn = vi.fn();
  const daemonLog = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  } as unknown as DaemonLogger;

  const bridge = {
    getSessionSummary: vi.fn((requestedId: string) => {
      if (requestedId === sessionId) {
        return {
          sessionId,
          attached: true,
          hasActivePrompt: false,
          currentCwd: workspaceDir,
          lastEventId: 1,
          eventEpoch: 'epoch-1',
        };
      }
      throw new SessionNotFoundError(requestedId);
    }),
    getMidTurnMessages: vi.fn(() => ({
      messages: [],
      settledMessageIds: [],
      promotedMessageIds: [],
    })),
    enqueueMidTurnMessage: vi.fn(
      (_id: string, _text: string, _ctx?: unknown, messageId?: string) => ({
        accepted: true,
        messageId: messageId ?? 'mid-turn-1',
      }),
    ),
    getSessionLastEventId: vi.fn(() => 2),
    getSessionEventEpoch: vi.fn(() => 'epoch-1'),
    getSessionMetadata: vi.fn(() => ({})),
    sendPrompt: vi.fn(
      (
        _id: string,
        _body: unknown,
        _signal?: AbortSignal,
        opts?: { onPromptAdmitted?: () => void },
      ) => {
        opts?.onPromptAdmitted?.();
        return Promise.resolve({ stopReason: 'end_turn' });
      },
    ),
    getPromptReceipt: vi.fn(() => undefined),
  } as unknown as AcpSessionBridge;

  const runtime = {
    workspaceId: randomUUID(),
    workspaceCwd: workspaceDir,
    sessionRuntimeBaseDir: runtimeBaseDir,
    primary: true,
    trusted: true,
    bridge,
    routeFileSystemFactory: {
      forRequest: vi.fn(),
      assertCanWrite: vi.fn(),
    } as WorkspaceFileSystemFactory,
  } as WorkspaceRuntime;

  const app = express();
  app.use(express.json());
  const workspaceRegistry = createWorkspaceRegistry([runtime]);
  registerSessionRoutes(app, {
    boundWorkspace: workspaceDir,
    bridge,
    workspaceRegistry,
    archiveCoordinator: {
      runSharedMany: async (_sessionIds, fn) => await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req, _res, next) => next(),
    sendBridgeError: (res: Response, err: unknown) => {
      res.status(500).json({
        error: 'test bridge error',
        detail:
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    },
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
    daemonLog,
  });
  registerWorkspaceInputHistoryRoutes(app, {
    boundWorkspace: workspaceDir,
    workspaceRegistry,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {},
  });

  return { app, sessionId, warn };
}

describe('session input-history write ordering', () => {
  beforeEach(() => {
    historyGate.onCall = undefined;
    historyGate.gate = undefined;
    historyGate.rejectWith = undefined;
  });

  it('awaits prompt history persistence before POST /session/:id/mid-turn-message returns 200', async () => {
    const { app, sessionId } = makeHarness();
    const called = createDeferred();
    const gate = createDeferred();
    historyGate.onCall = called.resolve;
    historyGate.gate = gate.promise;

    let responded = false;
    const pendingResponse = request(app)
      .post(`/session/${sessionId}/mid-turn-message`)
      .send({ message: '  follow up mid turn  ', messageId: 'msg-order-1' })
      .then((res) => {
        responded = true;
        return res;
      });

    try {
      await called.promise;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(responded).toBe(false);
    } finally {
      gate.resolve();
      await pendingResponse.catch(() => {});
    }
    const res = await pendingResponse;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, messageId: 'msg-order-1' });

    const persisted = await request(app).get(
      '/workspace/input-history?kind=prompt',
    );
    expect(persisted.status).toBe(200);
    expect(persisted.body.entries).toEqual(['follow up mid turn']);
  });

  it('still answers 200 and logs warn when mid-turn history persistence fails', async () => {
    const { app, sessionId, warn } = makeHarness();
    historyGate.rejectWith = new Error('simulated disk failure');

    const res = await request(app)
      .post(`/session/${sessionId}/mid-turn-message`)
      .send({ message: 'best effort mid turn', messageId: 'msg-err-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, messageId: 'msg-err-1' });
    expect(warn).toHaveBeenCalledWith(
      'failed to record workspace input history',
      expect.objectContaining({
        sessionId,
        kind: 'prompt',
        error: 'simulated disk failure',
      }),
    );
  });

  it('awaits prompt history persistence before POST /session/:id/prompt returns 202', async () => {
    const { app, sessionId } = makeHarness();
    const called = createDeferred();
    const gate = createDeferred();
    historyGate.onCall = called.resolve;
    historyGate.gate = gate.promise;

    let responded = false;
    const pendingResponse = request(app)
      .post(`/session/${sessionId}/prompt`)
      .send({ prompt: [{ type: 'text', text: 'prompt before 202' }] })
      .then((res) => {
        responded = true;
        return res;
      });

    try {
      await called.promise;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(responded).toBe(false);
    } finally {
      gate.resolve();
      await pendingResponse.catch(() => {});
    }
    const res = await pendingResponse;
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ promptId: expect.any(String) });

    const persisted = await request(app).get(
      '/workspace/input-history?kind=prompt',
    );
    expect(persisted.status).toBe(200);
    expect(persisted.body.entries).toEqual(['prompt before 202']);
  });

  it('still answers 202 and logs warn when prompt history persistence fails', async () => {
    const { app, sessionId, warn } = makeHarness();
    historyGate.rejectWith = new Error('simulated prompt disk failure');

    const res = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .send({ prompt: [{ type: 'text', text: 'best effort prompt' }] });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ promptId: expect.any(String) });
    expect(warn).toHaveBeenCalledWith(
      'failed to record workspace input history',
      expect.objectContaining({
        sessionId,
        kind: 'prompt',
        error: 'simulated prompt disk failure',
      }),
    );
  });
});
