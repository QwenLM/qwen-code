/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { runQwenServe, type RunHandle } from './run-qwen-serve.js';
import * as refreshModule from './server/session-pr-refresh.js';
import type {
  ChannelWorkerSnapshot,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import * as settingsModule from '../config/settings.js';

// The sibling run-qwen-serve.test.ts mocks the refresh chunk to throw for its
// degradation cases, so the ordered-stop wiring is pinned here instead.

const SNAPSHOT: BridgeDaemonStatusSnapshot = {
  limits: {
    maxSessions: 20,
    maxPendingPromptsPerSession: 5,
    eventRingSize: 8_000,
    eventRingMaxBytes: 8 * 1024 * 1024,
    compactedReplayMaxBytes: 4 * 1024 * 1024,
    maxJournalEvents: 10_000,
    maxJournalBytes: 8 * 1024 * 1024,
    journalGrowth: null,
    channelIdleTimeoutMs: 0,
    sessionIdleTimeoutMs: 1_800_000,
    sessionPromptSettledCloseGraceMs: 0,
  },
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

function bridge(): HttpAcpBridge {
  return {
    mandatoryLeaseAttested: true,
    spawnOrAttach: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    killAllSync: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn().mockReturnValue([]),
    publishWorkspaceEvent: vi.fn(),
    getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
    resume: vi.fn(),
    preheat: vi.fn().mockResolvedValue(undefined),
    invokeWorkspaceCommand: vi.fn().mockResolvedValue({ configsFailed: 0 }),
    sessionCount: 0,
    pendingPermissionCount: 0,
    activePromptCount: 0,
    activeWork: false,
    activeWorkCoverage: {
      total: 0,
      covered: 0,
      onNegotiatedChannel: 0,
      oldestCoveredReportAt: null,
    },
    lastActivityAt: null,
    getDaemonStatusSnapshot: vi.fn().mockReturnValue(SNAPSHOT),
    isChannelLive: vi.fn().mockReturnValue(true),
  } as unknown as HttpAcpBridge;
}

describe('runQwenServe PR-watch shutdown wiring', () => {
  let tmpDir: string;
  let handle: RunHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stops the watch through the lifecycle drain when the daemon closes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pr-watch-stop-')),
    );
    const workspace = path.join(tmpDir, 'project');
    fs.mkdirSync(workspace);
    const stopWatch = vi.fn(async () => {});
    const dispose = vi.fn();
    const drainNow = vi.fn(async () => {});
    const start = vi
      .spyOn(refreshModule, 'startSessionPrRefreshTimer')
      .mockReturnValue({ dispose, stopWatch, drainNow });
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(
      () => bridge() as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        maxSessions: 1,
        token: 'secret-token',
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );
    // The first health schedules the runtime build, which starts the timer.
    await fetch(`${handle.url}/health`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    await expect(handle.runtimeReady).resolves.toBeUndefined();
    // The refresh chunk loads asynchronously inside the runtime build, so it
    // can land after runtimeReady; vi.waitFor's default 1s budget is independent
    // of testTimeout and too tight for a cold module graph on a loaded runner.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), {
      timeout: 15_000,
    });
    expect(stopWatch).not.toHaveBeenCalled();
    await handle.close();
    // The event-loop-monitor cleanup disposes and clears the timer handle
    // before the lifecycle close runs its drains, so the drain has to reach
    // the stop through its own reference.
    expect(stopWatch).toHaveBeenCalledTimes(1);
  });

  it('loads hosted channel settings with env injection disabled', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pr-watch-env-')),
    );
    const workspace = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    // The selected github entry is the positive control: its host can enter the
    // allowed set only if the hosted-URL loop really ran and really read this
    // workspace's settings. The unselected one must NOT enter it — the daemon
    // was never asked to host that channel.
    fs.writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        channels: {
          github: {
            type: 'github',
            baseUrl: 'https://ghe.fixture.example.com',
          },
          'github-unselected': {
            type: 'github',
            baseUrl: 'https://unselected.fixture.example.com',
          },
        },
      }),
    );
    const evilGhDir = path.join(tmpDir, 'gh-evil');
    fs.mkdirSync(evilGhDir);
    fs.writeFileSync(
      path.join(evilGhDir, 'hosts.yml'),
      'evil.fixture.example.com:\n    oauth_token: fixture\n',
    );
    // Only a trusted workspace's .env is read at all, and loadEnvironment is
    // no-override — so the key has to start absent for an injection to be
    // observable. A pre-set value would survive even with the defect.
    fs.writeFileSync(
      path.join(workspace, '.env'),
      `GH_CONFIG_DIR=${evilGhDir}\n`,
    );
    vi.stubEnv('GH_CONFIG_DIR', undefined);
    const loadSettingsSpy = vi.spyOn(settingsModule, 'loadSettings');

    const snapshot: ChannelWorkerSnapshot = {
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['github'],
    };
    const worker = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(snapshot),
      killAllSync: vi.fn(),
      snapshot: vi.fn(() => snapshot),
      enqueueWebhookTask: vi.fn(),
      deliverChannelMessage: vi.fn(),
    };
    const factory = vi.fn((opts: CreateChannelWorkerSupervisorOptions) => {
      worker.start.mockImplementation(async () => {
        opts.onReady?.(worker.snapshot());
      });
      return worker;
    });
    let timerOptions:
      | Parameters<typeof refreshModule.startSessionPrRefreshTimer>[0]
      | undefined;
    vi.spyOn(refreshModule, 'startSessionPrRefreshTimer').mockImplementation(
      (options) => {
        timerOptions = options;
        return {
          dispose: vi.fn(),
          stopWatch: vi.fn(async () => {}),
          drainNow: vi.fn(async () => {}),
        };
      },
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(
      () => bridge() as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        maxSessions: 1,
        token: 'secret-token',
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['github'] },
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        trustedWorkspace: true,
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: {
          readServiceInfo: vi.fn(() => null),
          writeServeServiceInfo: vi.fn(),
          reserveServeServiceInfo: vi.fn(),
          removeServiceInfo: vi.fn(),
          removeServeServiceInfo: vi.fn(() => true),
        },
      },
    );
    await fetch(`${handle.url}/health`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    await expect(handle.runtimeReady).resolves.toBeUndefined();
    await vi.waitFor(() => expect(timerOptions).toBeDefined(), {
      timeout: 15_000,
    });
    // Startup already loaded this workspace's settings through the daemon's
    // own env-reload path, so only the calls made while the builder resolves
    // are attributable to this seam.
    loadSettingsSpy.mockClear();
    // One resolve of the serve root's builder: it reads the hosted channel
    // URLs first, then builds the allowed set from the daemon's own env.
    let allowedHosts: ReadonlySet<string> | undefined;
    await vi.waitFor(
      () => {
        allowedHosts = timerOptions?.getPrWatchDeps?.()?.allowedHosts;
        expect(allowedHosts).toBeDefined();
      },
      { timeout: 15_000 },
    );
    // The daemon's own startup env-reload already injects this workspace's
    // .env into process.env, so the resulting env and allowed set measure the
    // same with and without this seam's settings argument (A/B, both arms).
    // What this seam owns is the argument itself: every settings load it
    // triggers must opt out of env injection, like the grouping's call sites.
    const seamCalls = loadSettingsSpy.mock.calls.filter(
      ([cwd]) => cwd === workspace,
    );
    expect(seamCalls.length).toBeGreaterThan(0);
    for (const [, options] of seamCalls) {
      // loadSettings takes `boolean | LoadSettingsOptions`. The boolean form
      // carries no env opt-out, so it has to fail this assertion too.
      const opts = typeof options === 'object' ? options : undefined;
      expect(opts?.skipLoadEnvironment).toBe(true);
    }
    // Positive control: the hosted github entry really reached the allowed
    // set, so the loop ran instead of iterating an empty group list.
    expect(allowedHosts?.has('ghe.fixture.example.com')).toBe(true);
    // Only the selected channel contributes. The workspace also configures a
    // github channel this daemon was never asked to host; its host must not
    // widen the allowed set.
    expect(allowedHosts?.has('unselected.fixture.example.com')).toBe(false);
  });

  it('rebuilds the watch deps when a hosted channel changes, keeping the locks', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pr-watch-rebuild-')),
    );
    const workspace = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    const settingsPath = path.join(workspace, '.qwen', 'settings.json');
    const writeChannels = (baseUrl: string): void => {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          channels: { github: { type: 'github', baseUrl } },
        }),
      );
    };
    writeChannels('https://first.fixture.example.com');

    const snapshot: ChannelWorkerSnapshot = {
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['github'],
    };
    const worker = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(snapshot),
      killAllSync: vi.fn(),
      snapshot: vi.fn(() => snapshot),
      enqueueWebhookTask: vi.fn(),
      deliverChannelMessage: vi.fn(),
    };
    const factory = vi.fn((opts: CreateChannelWorkerSupervisorOptions) => {
      worker.start.mockImplementation(async () => {
        opts.onReady?.(worker.snapshot());
      });
      return worker;
    });
    let timerOptions:
      | Parameters<typeof refreshModule.startSessionPrRefreshTimer>[0]
      | undefined;
    vi.spyOn(refreshModule, 'startSessionPrRefreshTimer').mockImplementation(
      (options) => {
        timerOptions = options;
        return {
          dispose: vi.fn(),
          stopWatch: vi.fn(async () => {}),
          drainNow: vi.fn(async () => {}),
        };
      },
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(
      () => bridge() as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        maxSessions: 1,
        token: 'secret-token',
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['github'] },
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        trustedWorkspace: true,
        channelWorkerSupervisorFactory: factory,
        channelServicePidfile: {
          readServiceInfo: vi.fn(() => null),
          writeServeServiceInfo: vi.fn(),
          reserveServeServiceInfo: vi.fn(),
          removeServiceInfo: vi.fn(),
          removeServeServiceInfo: vi.fn(() => true),
        },
      },
    );
    await fetch(`${handle.url}/health`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    await expect(handle.runtimeReady).resolves.toBeUndefined();
    await vi.waitFor(() => expect(timerOptions).toBeDefined(), {
      timeout: 15_000,
    });

    type WatchDeps = NonNullable<
      ReturnType<
        NonNullable<NonNullable<typeof timerOptions>['getPrWatchDeps']>
      >
    >;
    let first: WatchDeps | undefined;
    await vi.waitFor(
      () => {
        first = timerOptions?.getPrWatchDeps?.();
        expect(first).toBeDefined();
      },
      { timeout: 15_000 },
    );
    expect(first?.allowedHosts.has('first.fixture.example.com')).toBe(true);

    // Unchanged config: the same build is reused, so the observation and the
    // drain keep sharing one lock registry.
    expect(timerOptions?.getPrWatchDeps?.()).toBe(first);

    // A channel committing later must reach the allowed set — the deps are
    // built before the channels commit at listen, so a one-shot build would
    // freeze the set empty.
    writeChannels('https://second.fixture.example.com');
    let rebuilt: WatchDeps | undefined;
    await vi.waitFor(
      () => {
        rebuilt = timerOptions?.getPrWatchDeps?.();
        expect(rebuilt?.allowedHosts.has('second.fixture.example.com')).toBe(
          true,
        );
      },
      { timeout: 15_000 },
    );
    expect(rebuilt).not.toBe(first);
    // The rebuild must carry the registry over: a fresh one would hand the
    // observation and the drain different in-process locks for the same files
    // if a rebuild landed between their two reads.
    expect(rebuilt?.locks).toBe(first?.locks);
    const drainDeps = timerOptions?.getPrDrainDeps?.();
    expect(drainDeps?.locks).toBe(rebuilt?.locks);
  });
});
