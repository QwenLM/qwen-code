/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Issue #17479 B.2 — re-admission after the boot channel downgrade.
 *
 * A `qwen serve` daemon whose settings-derived channel selection conflicts
 * with the channel-service pidfile at boot downgrades to "Continuing
 * without channels" and keeps serving. That decision must stand for the
 * daemon's lifetime: when a non-primary trusted workspace with its own
 * `serve.channels` registers after boot, the late restore must NOT start
 * channel workers (side-effecting polling / outbound API calls) behind the
 * operator's back. Only an explicit operator re-enable or a restart may
 * bring hosting back.
 *
 * The harness mirrors the late-registration fixtures in
 * run-qwen-serve.test.ts: fake bridge, fake per-workspace supervisors and
 * mocked pidfile deps, so no real channel adapter, child process or model
 * credential is involved.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
  type MockInstance,
} from 'vitest';
import { runQwenServe } from './run-qwen-serve.js';
import { resetServeFastPathHomeEnvBootstrapForTesting } from './fast-path-settings.js';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import * as qwenCore from '@qwen-code/qwen-code-core';
import * as settingsRuntime from '../config/settings.js';
import * as trustedFoldersRuntime from '../config/trustedFolders.js';
import type {
  ChannelWorkerSnapshot,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import type { ServiceInfo } from '../commands/channel/pidfile.js';
import type { WorkspaceRegistrationStore } from './workspace-registration-store.js';

// Same isolation as run-qwen-serve.test.ts: discovery records must never
// land in the ambient runtime root (this suite may run under a live daemon).
const originalTestRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
const isolatedTestRuntimeDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-readmission-')),
);
process.env['QWEN_RUNTIME_DIR'] = isolatedTestRuntimeDir;

afterAll(() => {
  if (originalTestRuntimeDir === undefined) {
    delete process.env['QWEN_RUNTIME_DIR'];
  } else {
    process.env['QWEN_RUNTIME_DIR'] = originalTestRuntimeDir;
  }
  fs.rmSync(isolatedTestRuntimeDir, { recursive: true, force: true });
});

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
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

function makeFakeBridge(): HttpAcpBridge {
  return {
    spawnOrAttach: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    killAllSync: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn().mockReturnValue([]),
    publishWorkspaceEvent: vi.fn(),
    getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
    resume: vi.fn(),
    preheat: vi.fn().mockResolvedValue(undefined),
    getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
    isChannelLive: vi.fn().mockReturnValue(true),
  } as unknown as HttpAcpBridge;
}

function makeWorker(snapshot: ChannelWorkerSnapshot) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(snapshot),
    killAllSync: vi.fn(),
    snapshot: vi.fn(() => snapshot),
    enqueueWebhookTask: vi
      .fn()
      .mockRejectedValue(new Error('Channel worker is not running.')),
    deliverChannelMessage: vi
      .fn()
      .mockRejectedValue(new Error('Channel worker is not running.')),
  };
}

function makePerWorkspaceWorkerFactory() {
  const workers = new Map<string, ReturnType<typeof makeWorker>>();
  const factory = vi.fn((opts: CreateChannelWorkerSupervisorOptions) => {
    const channels =
      opts.selection.mode === 'names' ? [...opts.selection.names] : [];
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      channels,
      requestedChannels: channels,
    });
    worker.start.mockImplementation(async () => {
      opts.onReady?.(worker.snapshot());
    });
    workers.set(opts.workspace, worker);
    return worker;
  });
  return { factory, workers };
}

function makePidfileDeps() {
  return {
    readServiceInfo: vi.fn<() => ServiceInfo | null>(() => null),
    writeServeServiceInfo: vi.fn(),
    reserveServeServiceInfo: vi.fn(),
    removeServiceInfo: vi.fn(),
    removeServeServiceInfo: vi.fn(() => true),
  };
}

function writeWorkspaceSettings(
  workspace: string,
  settings: Record<string, unknown>,
) {
  fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.qwen', 'settings.json'),
    JSON.stringify(settings),
  );
}

const HOLDER: ServiceInfo = {
  owner: 'serve',
  pid: 9999,
  startedAt: new Date().toISOString(),
  channels: ['telegram'],
  servePid: 9999,
};

describe('issue #17479 B.2: boot channel downgrade vs late workspace registration', () => {
  let tmpDir: string | undefined;
  let qwenHome: string | undefined;
  let previousQwenHome: string | undefined;

  beforeEach(() => {
    previousQwenHome = process.env['QWEN_HOME'];
    qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-home-')),
    );
    process.env['QWEN_HOME'] = qwenHome;
    resetServeFastPathHomeEnvBootstrapForTesting();
    settingsRuntime.resetHomeEnvBootstrapForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    if (qwenHome) {
      fs.rmSync(qwenHome, { recursive: true, force: true });
      qwenHome = undefined;
    }
    if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = previousQwenHome;
    previousQwenHome = undefined;
    resetServeFastPathHomeEnvBootstrapForTesting();
    settingsRuntime.resetHomeEnvBootstrapForTesting();
  });

  // The primary workspace configures channels so boot actually attempts the
  // settings-derived reservation; the secondary workspace is the one that
  // registers after boot with its own serve.channels.
  function makeDowngradedDaemon(pidfile: ReturnType<typeof makePidfileDeps>) {
    const primary = path.join(tmpDir!, 'primary');
    const secondary = path.join(tmpDir!, 'secondary');
    writeWorkspaceSettings(primary, {
      channels: { telegram: { type: 'telegram' } },
      serve: { channels: ['telegram'] },
    });
    writeWorkspaceSettings(secondary, {
      channels: { feishu: { type: 'feishu' } },
      serve: { channels: ['feishu'] },
    });
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeFakeBridge(),
    );
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalizeWorkspace(primary),
        workspaces: [],
      }),
      add: vi.fn().mockResolvedValue(true),
      removeById: vi.fn().mockResolvedValue(true),
      removeByIds: vi.fn().mockResolvedValue(1),
    } as unknown as WorkspaceRegistrationStore;
    const { factory, workers } = makePerWorkspaceWorkerFactory();
    return {
      primary,
      secondary,
      factory,
      workers,
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      start: () =>
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: primary,
            token: 'secret',
            serveWebShell: false,
          },
          {
            preheatBridge: false,
            daemonLogBaseDir: path.join(tmpDir!, 'debug'),
            channelWorkerSupervisorFactory: factory,
            channelServicePidfile: pidfile,
            workspaceRegistrationStore: store,
          },
        ),
    };
  }

  async function expectBootDowngrade(
    daemon: ReturnType<typeof makeDowngradedDaemon>,
    handle: Awaited<ReturnType<typeof runQwenServe>>,
    stderr: MockInstance<typeof process.stderr.write>,
    pidfile: ReturnType<typeof makePidfileDeps>,
  ) {
    await handle.runtimeReady;
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain(
      'workspace serve.channels was not restored: Channel service is already running under qwen serve (PID 9999).',
    );
    expect(written).toContain('Continuing without channels.');
    expect(daemon.factory).not.toHaveBeenCalled();
    expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
    const control = await fetch(`${handle.url}/workspace/channel`, {
      headers: daemon.headers,
    });
    expect(await control.json()).toMatchObject({
      enabled: false,
      selection: null,
    });
  }

  // The registration hook skips a declined restore before consuming the
  // workspace's once-per-run mark; the skip log is the deterministic settle
  // marker for the absence assertions below.
  async function waitForDeclineSkip(workspace: string) {
    await vi.waitFor(() => {
      const skip = fs
        .readFileSync(
          path.join(tmpDir!, 'debug', 'daemon', 'daemon.log'),
          'utf8',
        )
        .split('\n')
        .find((line) =>
          line.includes(
            'skipping serve.channels for a workspace registered after boot: channel hosting was declined at boot',
          ),
        );
      expect(skip).toContain(
        `workspaceCwd=${canonicalizeWorkspace(workspace)}`,
      );
      // The skip restates the boot decline reason (the conflicting holder's
      // PID) so it stays diagnosable after the boot warn rotates out.
      expect(skip).toContain('PID 9999');
    });
  }

  it('does not start channel workers when a workspace registers after a boot pidfile-conflict downgrade', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-readmit-')),
    );
    const pidfile = makePidfileDeps();
    // The holder owns the pidfile when boot reads it, forcing the conflict
    // downgrade. By the time a workspace registers after boot the record no
    // longer blocks (the holder exited or its record was swept) — exactly
    // the window in which the incident's duplicate daemon admitted workers.
    pidfile.readServiceInfo.mockReturnValueOnce(HOLDER);
    const daemon = makeDowngradedDaemon(pidfile);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await expectBootDowngrade(daemon, handle, stderr, pidfile);

      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      // Registration answers before the hook runs; settle on the skip marker
      // so the absence assertions cannot pass before the gate is exercised.
      await waitForDeclineSkip(daemon.secondary);

      // The boot decision stands: no supervisor may be created for any
      // workspace, and the channel-service lease must not be taken.
      expect(daemon.factory).not.toHaveBeenCalled();
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
      const control = await fetch(`${handle.url}/workspace/channel`, {
        headers: daemon.headers,
      });
      expect(await control.json()).toMatchObject({
        enabled: false,
        selection: null,
      });
    } finally {
      await handle.close();
    }
  });

  it('keeps refusing the late restore while the conflicting holder still owns the pidfile', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-holder-')),
    );
    const pidfile = makePidfileDeps();
    // Boundary control: the refusal stands while the holder's record
    // persists too — the gate does not depend on the pidfile's current
    // state. The runtime lease re-check on its own is pinned separately
    // (no boot downgrade) below.
    pidfile.readServiceInfo.mockReturnValue(HOLDER);
    const daemon = makeDowngradedDaemon(pidfile);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await expectBootDowngrade(daemon, handle, stderr, pidfile);

      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      await waitForDeclineSkip(daemon.secondary);
      expect(daemon.factory).not.toHaveBeenCalled();
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('still late-restores after a downgrade that was not a lease conflict', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-nonconflict-')),
    );
    const pidfile = makePidfileDeps();
    // A transient pidfile write failure downgrades the settings restore too,
    // but it is not a single-instance conflict: the boot decision must not
    // gate later restores. The runtime reservation retry succeeds.
    pidfile.reserveServeServiceInfo.mockImplementationOnce(() => {
      throw Object.assign(new Error('pidfile write denied'), {
        code: 'EACCES',
      });
    });
    const daemon = makeDowngradedDaemon(pidfile);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await handle.runtimeReady;
      const written = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(written).toContain('Continuing without channels.');
      expect(daemon.factory).not.toHaveBeenCalled();

      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      await vi.waitFor(() =>
        expect(daemon.factory).toHaveBeenCalledWith(
          expect.objectContaining({
            workspace: canonicalizeWorkspace(daemon.secondary),
            selection: { mode: 'names', names: ['feishu'] },
          }),
        ),
      );
    } finally {
      await handle.close();
    }
  });

  it('lets an explicit operator selection commit clear the conflict gate', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-override-')),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValueOnce(HOLDER);
    const daemon = makeDowngradedDaemon(pidfile);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await expectBootDowngrade(daemon, handle, stderr, pidfile);

      // The operator explicitly chooses to host on this daemon; the holder
      // record is gone, so the commit takes the lease and clears the gate.
      const put = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: daemon.headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(put.status).toBeLessThan(300);
      await vi.waitFor(() =>
        expect(daemon.factory).toHaveBeenCalledWith(
          expect.objectContaining({
            workspace: canonicalizeWorkspace(daemon.primary),
            selection: { mode: 'names', names: ['telegram'] },
          }),
        ),
      );

      // With the gate cleared, a registering workspace late-restores again.
      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      await vi.waitFor(() =>
        expect(daemon.factory).toHaveBeenCalledWith(
          expect.objectContaining({
            workspace: canonicalizeWorkspace(daemon.secondary),
            selection: { mode: 'names', names: ['feishu'] },
          }),
        ),
      );
    } finally {
      await handle.close();
    }
  });

  it('runtime lease re-check refuses a late restore when no boot downgrade happened', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-recheck-')),
    );
    const pidfile = makePidfileDeps();
    // No boot selection (primary configures no channels), so no downgrade
    // and no gate: the refusal must come from the runtime lease re-check
    // alone, which sees the holder that appeared after boot.
    pidfile.readServiceInfo.mockReturnValue(HOLDER);
    const daemon = makeDowngradedDaemon(pidfile);
    writeWorkspaceSettings(daemon.primary, {});
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await handle.runtimeReady;
      expect(
        stderr.mock.calls.map(([chunk]) => String(chunk)).join(''),
      ).not.toContain('Continuing without channels.');
      expect(daemon.factory).not.toHaveBeenCalled();

      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      await vi.waitFor(() => {
        const failure = fs
          .readFileSync(
            path.join(tmpDir!, 'debug', 'daemon', 'daemon.log'),
            'utf8',
          )
          .split('\n')
          .find((line) =>
            line.includes(
              'serve.channels for a workspace registered after boot were not restored',
            ),
          );
        expect(failure).toContain(
          `workspaceCwd=${canonicalizeWorkspace(daemon.secondary)}`,
        );
      });
      expect(daemon.factory).not.toHaveBeenCalled();
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('gives a refused workspace its restore back after an explicit commit clears the gate', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-token-')),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValueOnce(HOLDER);
    const daemon = makeDowngradedDaemon(pidfile);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await expectBootDowngrade(daemon, handle, stderr, pidfile);

      // Refused during the decline — without consuming the once-per-run mark.
      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      const workspaceId = ((await added.json()) as { id: string }).id;
      await waitForDeclineSkip(daemon.secondary);
      expect(daemon.factory).not.toHaveBeenCalled();

      // The operator's explicit commit takes the lease (the holder record is
      // gone) and clears the gate.
      const put = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: daemon.headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(put.status).toBeLessThan(300);
      await vi.waitFor(() =>
        expect(daemon.factory).toHaveBeenCalledWith(
          expect.objectContaining({
            workspace: canonicalizeWorkspace(daemon.primary),
            selection: { mode: 'names', names: ['telegram'] },
          }),
        ),
      );

      // Leaving and coming back must restore the workspace's own channels:
      // the refusal did not spend its once-per-run token.
      const removed = await fetch(`${handle.url}/workspaces/${workspaceId}`, {
        method: 'DELETE',
        headers: daemon.headers,
      });
      expect(removed.status).toBe(200);
      const readded = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(readded.status).toBe(201);
      await vi.waitFor(() =>
        expect(daemon.factory).toHaveBeenCalledWith(
          expect.objectContaining({
            workspace: canonicalizeWorkspace(daemon.secondary),
            selection: { mode: 'names', names: ['feishu'] },
          }),
        ),
      );
    } finally {
      await handle.close();
    }
  });

  it('keeps the gate when an explicit selection commit fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-failedput-')),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValueOnce(HOLDER);
    const daemon = makeDowngradedDaemon(pidfile);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const handle = await daemon.start();

    try {
      await expectBootDowngrade(daemon, handle, stderr, pidfile);

      // The holder record is gone, but a selection naming a channel no
      // workspace defines cannot commit — a failed PUT must not clear the
      // gate (cleared after the commit, not before).
      const put = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: daemon.headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['ghost'] },
        }),
      });
      expect(put.status).toBeGreaterThanOrEqual(400);

      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: daemon.headers,
        body: JSON.stringify({ cwd: daemon.secondary }),
      });
      expect(added.status).toBe(201);
      await waitForDeclineSkip(daemon.secondary);
      expect(daemon.factory).not.toHaveBeenCalled();
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  // Pins the serve-boot wiring of the log identity (issue #17479 B.3): the
  // port in the file log must be the actual listening port, not the requested
  // one — this fixture boots with port: 0.
  it('attributes post-listen file records with the actual listening port', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-17479-port-')),
    );
    const pidfile = makePidfileDeps();
    const daemon = makeDowngradedDaemon(pidfile);
    const handle = await daemon.start();

    try {
      await handle.runtimeReady;
      const port = Number(new URL(handle.url).port);
      expect(port).toBeGreaterThan(0);
      await fetch(`${handle.url}/daemon/status`, { headers: daemon.headers });
      const logPath = path.join(tmpDir!, 'debug', 'daemon', 'daemon.log');
      await vi.waitFor(() => {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        expect(
          lines.some(
            (line) =>
              line.includes(`port=${port}`) &&
              line.includes('request completed'),
          ),
        ).toBe(true);
      });
      const boot = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .find((line) => line.endsWith('daemon started'));
      expect(boot).toBeDefined();
      expect(boot).not.toContain('port=');
    } finally {
      await handle.close();
    }
  });
});
