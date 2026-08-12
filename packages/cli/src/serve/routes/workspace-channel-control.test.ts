/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockChannelStateStoreSetMany = vi.hoisted(() => vi.fn());
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(() => ({
    readAll: vi.fn(() => ({})),
    get: vi.fn(),
    set: vi.fn(),
    setMany: mockChannelStateStoreSetMany,
  })),
);

vi.mock('../../commands/channel/channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
}));

import type {
  ChannelWorkerControlState,
  ChannelWorkerStopResult,
} from '../channel-worker-manager.js';
import { registerWorkspaceChannelControlRoutes } from './workspace-channel-control.js';

function controlState(
  overrides: Partial<ChannelWorkerControlState> = {},
): ChannelWorkerControlState {
  return {
    enabled: true,
    selection: { mode: 'all' },
    transition: 'idle',
    workers: [
      {
        enabled: true,
        state: 'running',
        channels: ['telegram'],
        requestedChannels: ['telegram', 'feishu'],
        workspaceId: 'primary',
        workspaceCwd: '/workspace',
        primary: true,
      },
    ],
    ...overrides,
  };
}

function setup(options: {
  control?: ChannelWorkerControlState;
  stop?: () => Promise<ChannelWorkerStopResult>;
}) {
  const stopChannelWorker =
    options.stop ??
    vi.fn(async () => ({
      changed: true,
      state: options.control ?? controlState(),
    }));
  const app = express();
  registerWorkspaceChannelControlRoutes(app, {
    getChannelWorkerControl: () => options.control ?? controlState(),
    stopChannelWorker,
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    safeBody: () => ({}),
    sendBridgeError: (res, error) => {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    },
    parseAndValidateClientId: () => 'client-1',
  });
  return { app, stopChannelWorker };
}

beforeEach(() => {
  mockChannelStateStore.mockClear();
  mockChannelStateStoreSetMany.mockClear();
});

describe('DELETE /workspace/channel', () => {
  it('records stopped channels so --channel all does not restart them (#8975)', async () => {
    const { app, stopChannelWorker } = setup({});

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(200);
    expect(stopChannelWorker).toHaveBeenCalledTimes(1);
    // Requested (not just connected) channels are recorded, per workspace.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      expect.stringContaining('channel-state.json'),
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
  });

  it('does not record state when the stop fails (#8975)', async () => {
    const { app } = setup({
      stop: vi.fn(async () => {
        throw Object.assign(new Error('worker would not stop'), {
          code: 'channel_worker_stop_failed',
        });
      }),
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(500);
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });

  it('records nothing when no channels were running', async () => {
    const { app } = setup({
      control: controlState({ enabled: false, selection: null, workers: [] }),
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(200);
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });
});
