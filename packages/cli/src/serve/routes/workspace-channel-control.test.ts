/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockStateStoreInstance {
  path: string;
  setMany: ReturnType<typeof vi.fn>;
  trySetMany: (names: string[], state: 'active' | 'stopped') => boolean;
}

const mockChannelStateStoreInstances = vi.hoisted(
  () => [] as MockStateStoreInstance[],
);
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn((path: string) => {
    const setMany = vi.fn();
    const instance: MockStateStoreInstance = {
      path,
      setMany,
      // Mirror the real best-effort wrapper so a throwing `setMany` mock
      // still exercises "persistence failure never blocks a stop", and
      // report the persisted boolean the route surfaces to API clients.
      trySetMany: (names: string[], state: 'active' | 'stopped') => {
        try {
          setMany(names, state);
          return true;
        } catch {
          return false;
        }
      },
    };
    mockChannelStateStoreInstances.push(instance);
    return instance;
  }),
);

vi.mock('../../commands/channel/channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
}));

import { daemonChannelRuntimeStatePath } from '../../commands/channel/runtime.js';
import { ChannelWorkerControlError } from '../channel-worker-manager.js';
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
      // What the manager tore down at commit time (#8975).
      stoppedChannels: [
        { workspaceCwd: '/workspace', names: ['telegram', 'feishu'] },
      ],
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
  mockChannelStateStoreInstances.length = 0;
});

describe('DELETE /workspace/channel', () => {
  it('records stopped channels from the stop result so --channel all does not restart them (#8975)', async () => {
    const { app, stopChannelWorker } = setup({});

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(200);
    expect(stopChannelWorker).toHaveBeenCalledTimes(1);
    // Requested (not just connected) channels are recorded, per workspace.
    // The daemon (not standalone) state path segment is pinned, so swapping
    // in the standalone helper cannot ship green (#8975).
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      expect.stringContaining(path.join('channels', 'daemon')),
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      expect.stringContaining('channel-state.json'),
    );
    expect(mockChannelStateStoreInstances).toHaveLength(1);
    expect(mockChannelStateStoreInstances[0]!.setMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
    // The record persisted, so the happy-path response shape stays
    // unchanged (the flag only appears on failure) (#8975).
    expect(response.body).not.toHaveProperty('statePersisted');
    // The internal manager→route persistence plumbing must not leak into
    // the HTTP body: the SDK types this response without it, and a raw
    // API client must not start depending on an undocumented field
    // (#8975).
    expect(response.body).not.toHaveProperty('stoppedChannels');
  });

  it('records stops per workspace when the manager reports multiple workspaces (#8975)', async () => {
    const { app } = setup({
      stop: vi.fn(async () => ({
        changed: true,
        state: controlState(),
        stoppedChannels: [
          { workspaceCwd: '/workspace/a', names: ['telegram'] },
          { workspaceCwd: '/workspace/b', names: ['feishu'] },
        ],
      })),
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(200);
    // Each workspace gets its own state file and its own name set.
    expect(mockChannelStateStoreInstances).toHaveLength(2);
    const paths = mockChannelStateStoreInstances.map(
      (instance) => instance.path,
    );
    expect(paths[0]).not.toEqual(paths[1]);
    // Pin the EXACT workspace-derived hash per instance: distinct wrong
    // inputs still hash distinctly, so only the exact path proves the stop
    // write lands where the daemon worker's restore read looks (#8975).
    expect(paths[0]).toBe(daemonChannelRuntimeStatePath('/workspace/a'));
    expect(paths[1]).toBe(daemonChannelRuntimeStatePath('/workspace/b'));
    expect(mockChannelStateStoreInstances[0]!.setMany).toHaveBeenCalledWith(
      ['telegram'],
      'stopped',
    );
    expect(mockChannelStateStoreInstances[1]!.setMany).toHaveBeenCalledWith(
      ['feishu'],
      'stopped',
    );
  });

  it('persists remaining workspaces and reports the loss on partial persistence failure (#8975)', async () => {
    const { app } = setup({
      stop: vi.fn(async () => ({
        changed: true,
        state: controlState(),
        stoppedChannels: [
          { workspaceCwd: '/workspace/a', names: ['telegram'] },
          { workspaceCwd: '/workspace/b', names: ['feishu'] },
        ],
      })),
    });
    // FIRST workspace write fails (disk full / read-only ~/.qwen), second
    // succeeds: the accumulation must still report the stop as NOT fully
    // persisted and keep writing the remaining groups — a
    // last-group-overwrites or early-return-false regression would report
    // full persistence, omit statePersisted:false, and silently resurrect
    // the first workspace's channels on `--channel all` (#8975).
    mockChannelStateStore.mockImplementationOnce((path: string) => {
      const instance: MockStateStoreInstance = {
        path,
        setMany: vi.fn(() => {
          throw new Error('disk full');
        }),
        trySetMany: (names: string[], state: 'active' | 'stopped') => {
          try {
            instance.setMany(names, state);
            return true;
          } catch {
            return false;
          }
        },
      };
      mockChannelStateStoreInstances.push(instance);
      return instance;
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(200);
    expect(response.body.statePersisted).toBe(false);
    expect(mockChannelStateStoreInstances).toHaveLength(2);
    expect(mockChannelStateStoreInstances[1]!.path).toBe(
      daemonChannelRuntimeStatePath('/workspace/b'),
    );
    expect(mockChannelStateStoreInstances[1]!.setMany).toHaveBeenCalledWith(
      ['feishu'],
      'stopped',
    );
  });

  it('records the torn-down channels carried by a failed stop (#8975)', async () => {
    const { app } = setup({
      stop: vi.fn(async () => {
        // A partial multi-workspace failure (or a lease-release failure):
        // the manager already tore some workers down and carries the
        // captured set on the error.
        throw new ChannelWorkerControlError(
          'channel_worker_stop_failed',
          'workspace /workspace/b failed to stop',
          {
            stoppedChannels: [
              { workspaceCwd: '/workspace/a', names: ['telegram'] },
            ],
          },
        );
      }),
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(500);
    // The stop failed overall, but the torn-down channels are still
    // persisted from the error, or they resurrect on `--channel all`.
    expect(mockChannelStateStoreInstances).toHaveLength(1);
    expect(mockChannelStateStoreInstances[0]!.path).toBe(
      daemonChannelRuntimeStatePath('/workspace/a'),
    );
    expect(mockChannelStateStoreInstances[0]!.setMany).toHaveBeenCalledWith(
      ['telegram'],
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
    expect(mockChannelStateStoreInstances).toHaveLength(0);
  });

  it('records nothing when no channels were running', async () => {
    const { app } = setup({
      control: controlState({ enabled: false, selection: null, workers: [] }),
      stop: vi.fn(async () => ({
        changed: false,
        state: controlState({
          enabled: false,
          selection: null,
          workers: [],
        }),
      })),
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(200);
    expect(mockChannelStateStoreInstances).toHaveLength(0);
  });

  it('keeps serving the stop result even when state persistence fails (#8975)', async () => {
    const { app } = setup({});
    mockChannelStateStore.mockImplementationOnce((path: string) => {
      const instance: MockStateStoreInstance = {
        path,
        setMany: vi.fn(() => {
          throw new Error('disk full');
        }),
        trySetMany: (names: string[], state: 'active' | 'stopped') => {
          try {
            instance.setMany(names, state);
            return true;
          } catch {
            return false;
          }
        },
      };
      mockChannelStateStoreInstances.push(instance);
      return instance;
    });

    const response = await request(app).delete('/workspace/channel');

    // The tear-down succeeded, so the stop itself still reports 200 — but
    // the response must carry the persistence failure, or an API client
    // treats the stop as durable and the stopped channels silently
    // resurrect on the next `--channel all` start (#8975).
    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.statePersisted).toBe(false);
  });

  it('surfaces a lost stop record on the failure path too (#8975)', async () => {
    const { app } = setup({
      stop: vi.fn(async () => {
        // A partial multi-workspace failure: some workers were already
        // torn down (carried on the error), and the state write for them
        // ALSO fails (disk full). The 500 body is the client's only
        // signal that the stop record was lost — a stop retry cannot
        // re-capture the names, so without it the torn-down channels
        // resurrect on the next `--channel all` (#8975).
        throw new ChannelWorkerControlError(
          'channel_worker_stop_failed',
          'workspace /workspace/a failed to stop',
          {
            stoppedChannels: [
              { workspaceCwd: '/workspace/a', names: ['telegram'] },
            ],
          },
        );
      }),
    });
    mockChannelStateStore.mockImplementationOnce((path: string) => {
      const instance: MockStateStoreInstance = {
        path,
        setMany: vi.fn(() => {
          throw new Error('disk full');
        }),
        trySetMany: (names: string[], state: 'active' | 'stopped') => {
          try {
            instance.setMany(names, state);
            return true;
          } catch {
            return false;
          }
        },
      };
      mockChannelStateStoreInstances.push(instance);
      return instance;
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('channel_worker_stop_failed');
    expect(response.body.statePersisted).toBe(false);
  });

  it('omits statePersisted from a failed stop whose record persisted (#8975)', async () => {
    const { app } = setup({
      stop: vi.fn(async () => {
        throw new ChannelWorkerControlError(
          'channel_worker_stop_failed',
          'workspace /workspace/a failed to stop',
          {
            stoppedChannels: [
              { workspaceCwd: '/workspace/a', names: ['telegram'] },
            ],
          },
        );
      }),
    });

    const response = await request(app).delete('/workspace/channel');

    expect(response.status).toBe(500);
    // The torn-down record persisted, so the error body keeps its shape.
    expect(response.body).not.toHaveProperty('statePersisted');
    expect(mockChannelStateStoreInstances[0]!.setMany).toHaveBeenCalledWith(
      ['telegram'],
      'stopped',
    );
  });
});
