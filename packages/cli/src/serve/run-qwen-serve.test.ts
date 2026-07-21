/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import express from 'express';
import {
  createLazyBridgeProxy,
  extractContextFilename,
  formatChannelWorkerDaemonUrl,
  InvalidPolicyConfigError,
  createDisabledChannelWorkerSupervisor,
  resolveRuntimeStartupTimeoutMs,
  runQwenServe,
  type RunHandle,
  validatePolicyConfig,
  waitForRuntimeStartingForShutdown,
} from './run-qwen-serve.js';
import { isBrowserAutomationMcpAvailable } from './cdp-mcp-command.js';
import { RUNTIME_STARTUP_CANCELLED_MESSAGE } from './runtime-startup-errors.js';
import { isLoopbackBind } from './loopback-binds.js';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import * as qwenCore from '@qwen-code/qwen-code-core';
import * as serverModule from './server.js';
import * as settingsRuntime from '../config/settings.js';
import * as environmentRuntime from '../config/environment.js';
import * as trustedFoldersRuntime from '../config/trustedFolders.js';
import * as workspaceServiceRuntime from './workspace-service/index.js';
import type {
  ChannelWorkerSnapshot,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import type {
  ServiceInfo,
  ServiceInfoWorker,
} from '../commands/channel/pidfile.js';
import { LARGE_PIPE_FRAME_THRESHOLD_BYTES } from './large-pipe-frame-observer.js';
import type { ChannelWebhookEnqueueError } from './channel-webhook-ipc.js';
import {
  workspaceRegistrationId,
  type WorkspaceRegistrationStore,
} from './workspace-registration-store.js';
import { getDeferredRuntimeRequestTiming } from './server/request-helpers.js';

const originalTestRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
const isolatedTestRuntimeDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'qws-run-serve-tests-')),
);
process.env['QWEN_RUNTIME_DIR'] = isolatedTestRuntimeDir;

afterEach(() => {
  process.env['QWEN_RUNTIME_DIR'] = isolatedTestRuntimeDir;
});

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
    eventRingSize: 8000,
    compactedReplayMaxBytes: 4 * 1024 * 1024,
    channelIdleTimeoutMs: 0,
    sessionIdleTimeoutMs: 1_800_000,
  },
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

function makeRuntimeBridge(): HttpAcpBridge {
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
    sessionCount: 0,
    pendingPermissionCount: 0,
    activePromptCount: 0,
    lastActivityAt: null,
    getDaemonStatusSnapshot: vi.fn().mockReturnValue(BASE_BRIDGE_SNAPSHOT),
    isChannelLive: vi.fn().mockReturnValue(true),
  } as unknown as HttpAcpBridge;
}

const mockCreateSpawnChannelFactoryOptions = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

async function getFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

vi.mock('@qwen-code/acp-bridge/spawnChannel', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/acp-bridge/spawnChannel')>();
  return {
    ...actual,
    createSpawnChannelFactory: vi.fn(
      (options: Record<string, unknown> = {}) => {
        mockCreateSpawnChannelFactoryOptions.push(options);
        return actual.createSpawnChannelFactory(options);
      },
    ),
  };
});

describe('workspace skill settings persistence', () => {
  let handle: RunHandle | undefined;
  let workspace = '';
  let qwenHome = '';
  let previousQwenHome: string | undefined;

  afterEach(async () => {
    await handle?.close();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    if (qwenHome) fs.rmSync(qwenHome, { recursive: true, force: true });
    if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = previousQwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    vi.restoreAllMocks();
  });

  it('canonicalizes, deduplicates, preserves orphans, serializes updates, and enforces user locks', async () => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-settings-')),
    );
    qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-home-')),
    );
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: { disabled: ['orphan', ' ReViEw ', 'review'] },
      }),
    );
    fs.writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        skills: {
          disabled: ['locked-skill'],
          defaultDisabled: ['opt-in-skill', 'inherited-opt-in'],
          enabled: ['INHERITED-OPT-IN'],
        },
      }),
    );

    const originalCreateServeApp = serverModule.createServeApp;
    let persistDisabledSkills:
      | NonNullable<
          Parameters<typeof serverModule.createServeApp>[2]
        >['persistDisabledSkills']
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      persistDisabledSkills = args[2]?.persistDisabledSkills;
      return originalCreateServeApp(...args);
    });
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      { bridge: makeRuntimeBridge() },
    );
    await handle.runtimeReady;
    expect(persistDisabledSkills).toBeDefined();
    await expect(
      persistDisabledSkills!(workspace, 'inherited-opt-in', true),
    ).resolves.toEqual({
      changed: false,
      disabled: ['orphan', ' ReViEw ', 'review'],
    });

    await expect(
      persistDisabledSkills!(workspace, 'review', false),
    ).resolves.toEqual({
      changed: true,
      disabled: ['orphan', 'review'],
      settingsChanges: [
        { key: 'skills.disabled', value: ['orphan', 'review'] },
      ],
    });
    await expect(
      persistDisabledSkills!(workspace, 'review', false),
    ).resolves.toEqual({
      changed: false,
      disabled: ['orphan', 'review'],
    });

    await Promise.all([
      persistDisabledSkills!(workspace, 'alpha', false),
      persistDisabledSkills!(workspace, 'beta', false),
    ]);
    await expect(
      persistDisabledSkills!(workspace, 'review', true),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      persistDisabledSkills!(workspace, 'opt-in-skill', true),
    ).resolves.toEqual({
      changed: true,
      disabled: ['orphan', 'alpha', 'beta'],
      settingsChanges: [{ key: 'skills.enabled', value: ['opt-in-skill'] }],
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
    ) as { skills: { disabled: string[]; enabled: string[] } };
    expect(saved.skills.disabled).toEqual(['orphan', 'alpha', 'beta']);
    expect(saved.skills.enabled).toEqual(['opt-in-skill']);
    await expect(
      persistDisabledSkills!(workspace, 'locked-skill', true),
    ).rejects.toMatchObject({ reason: 'locked', lockedScope: 'user' });
  });

  it('produces both skills.disabled and skills.enabled changes when enabling a workspace-hard-disabled default-disabled skill', async () => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-dual-')),
    );
    qwenHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-skill-dual-home-')),
    );
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = qwenHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.qwen', 'settings.json'),
      JSON.stringify({
        skills: { disabled: ['dual-skill'] },
      }),
    );
    fs.writeFileSync(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        skills: { defaultDisabled: ['dual-skill'] },
      }),
    );

    const originalCreateServeApp = serverModule.createServeApp;
    let persistDisabledSkills:
      | NonNullable<
          Parameters<typeof serverModule.createServeApp>[2]
        >['persistDisabledSkills']
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      persistDisabledSkills = args[2]?.persistDisabledSkills;
      return originalCreateServeApp(...args);
    });
    handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      { bridge: makeRuntimeBridge() },
    );
    await handle.runtimeReady;
    expect(persistDisabledSkills).toBeDefined();

    await expect(
      persistDisabledSkills!(workspace, 'dual-skill', true),
    ).resolves.toEqual({
      changed: true,
      disabled: [],
      settingsChanges: [
        { key: 'skills.disabled', value: undefined },
        { key: 'skills.enabled', value: ['dual-skill'] },
      ],
    });

    const saved = JSON.parse(
      fs.readFileSync(path.join(workspace, '.qwen', 'settings.json'), 'utf8'),
    ) as { skills: { disabled?: string[]; enabled: string[] } };
    expect(saved.skills.disabled).toBeUndefined();
    expect(saved.skills.enabled).toEqual(['dual-skill']);
  });
});

/**
 * #4297 fold-in 7 (deepseek S1, addresses #3262690842). Lock the
 * `context.fileName` extraction logic so a regression doesn't
 * silently re-enable the P2-1 bug (init writes default `QWEN.md`
 * even when the workspace configured `AGENTS.md` etc.). The four
 * branches the suggestion called out are exercised explicitly here;
 * the runQwenServe boot path itself stays integration-tested
 * end-to-end via the daemon-process tests in
 * `integration-tests/cli/qwen-serve-routes.test.ts`.
 */
describe('extractContextFilename (#4297 fold-in 7 P2-1 helper)', () => {
  it('returns a trimmed string when given a non-empty string', () => {
    expect(extractContextFilename('AGENTS.md')).toBe('AGENTS.md');
    expect(extractContextFilename('  CUSTOM.md  ')).toBe('CUSTOM.md');
  });

  it('returns undefined for empty / whitespace-only strings', () => {
    expect(extractContextFilename('')).toBeUndefined();
    expect(extractContextFilename('   ')).toBeUndefined();
    expect(extractContextFilename('\n\t')).toBeUndefined();
  });

  it('returns the first non-empty string when given an array', () => {
    expect(extractContextFilename(['AGENTS.md', 'BACKUP.md'])).toBe(
      'AGENTS.md',
    );
    // Skips empty and whitespace entries to find the first valid name.
    expect(extractContextFilename(['', '  ', 'PRIMARY.md', 'OTHER.md'])).toBe(
      'PRIMARY.md',
    );
    // Trims the picked element.
    expect(extractContextFilename(['  CUSTOM.md  '])).toBe('CUSTOM.md');
  });

  it('returns undefined when the array has no string entries', () => {
    expect(extractContextFilename([])).toBeUndefined();
    expect(extractContextFilename(['', '  ', '\n'])).toBeUndefined();
    // Non-string entries are filtered out — when nothing valid remains,
    // the bridge falls back to its own default.
    expect(
      extractContextFilename([null, undefined, 42, { a: 1 }] as unknown[]),
    ).toBeUndefined();
  });

  it('returns undefined for non-string non-array inputs', () => {
    // Hand-edited `settings.json` could land any of these shapes;
    // the helper must NOT coerce (avoids the literal `[object Object]`
    // filename that the previous `String(...)` cast produced).
    expect(extractContextFilename(undefined)).toBeUndefined();
    expect(extractContextFilename(null)).toBeUndefined();
    expect(extractContextFilename(42)).toBeUndefined();
    expect(extractContextFilename(true)).toBeUndefined();
    expect(extractContextFilename({ fileName: 'AGENTS.md' })).toBeUndefined();
  });
});

describe('formatChannelWorkerDaemonUrl', () => {
  it.each(['', '0.0.0.0', '::', '[::]'])(
    'uses loopback when the daemon binds wildcard host %j',
    (host) => {
      expect(formatChannelWorkerDaemonUrl(host, 4170)).toBe(
        'http://127.0.0.1:4170',
      );
    },
  );

  it('formats concrete IPv6 hosts for URLs', () => {
    expect(formatChannelWorkerDaemonUrl('::1', 4170)).toBe('http://[::1]:4170');
  });

  it('preserves and accepts concrete IPv4 loopback hosts in 127/8', () => {
    expect(formatChannelWorkerDaemonUrl('127.0.0.2', 4170)).toBe(
      'http://127.0.0.2:4170',
    );
    expect(isLoopbackBind('127.0.0.2')).toBe(true);
  });
});

/**
 * Wenshao review #4335 / 3272493818 — positive tests for the
 * `validatePolicyConfig` helper. Lock the contract so a future
 * refactor can't silently remove the `InvalidPolicyConfigError`
 * class or the validation paths.
 */
describe('validatePolicyConfig (#4335 boot validation)', () => {
  it('returns undefined for both fields when policyConfig is empty', () => {
    expect(validatePolicyConfig()).toEqual({
      permissionPolicy: undefined,
      permissionConsensusQuorum: undefined,
    });
    expect(validatePolicyConfig({})).toEqual({
      permissionPolicy: undefined,
      permissionConsensusQuorum: undefined,
    });
  });

  it.each([['first-responder'], ['designated'], ['consensus'], ['local-only']])(
    'accepts the %s permissionStrategy literal',
    (literal) => {
      expect(validatePolicyConfig({ permissionStrategy: literal })).toEqual({
        permissionPolicy: literal,
        permissionConsensusQuorum: undefined,
      });
    },
  );

  it('throws InvalidPolicyConfigError for an unknown permissionStrategy', () => {
    expect(() => validatePolicyConfig({ permissionStrategy: 'bogus' })).toThrow(
      InvalidPolicyConfigError,
    );
    expect(() => validatePolicyConfig({ permissionStrategy: 'bogus' })).toThrow(
      /invalid policy.permissionStrategy/,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'throws InvalidPolicyConfigError for non-positive-integer consensusQuorum (%s)',
    (badValue) => {
      expect(() =>
        validatePolicyConfig({
          permissionStrategy: 'consensus',
          consensusQuorum: badValue,
        }),
      ).toThrow(InvalidPolicyConfigError);
    },
  );

  it('accepts a positive-integer consensusQuorum with consensus strategy', () => {
    expect(
      validatePolicyConfig({
        permissionStrategy: 'consensus',
        consensusQuorum: 3,
      }),
    ).toEqual({
      permissionPolicy: 'consensus',
      permissionConsensusQuorum: 3,
    });
  });

  it('warns AND drops consensusQuorum when strategy is not consensus (#4335 / 3273077270)', () => {
    // Wenshao review #4335 / 3273077270 — public contract now
    // matches the warning text: when the operator sets
    // consensusQuorum alongside a non-consensus strategy, the
    // override is dropped (returned as undefined) so the
    // BridgeOptions surface stays consistent with what the warning
    // tells them. Pre-fix the function still propagated the value;
    // the downstream mediator ignored it but the function-level
    // contract contradicted itself.
    const warnings: string[] = [];
    const onWarning = vi.fn((m: string) => warnings.push(m));
    const result = validatePolicyConfig(
      {
        permissionStrategy: 'designated',
        consensusQuorum: 2,
      },
      onWarning,
    );
    expect(result).toEqual({
      permissionPolicy: 'designated',
      permissionConsensusQuorum: undefined,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('consensusQuorum is set');
    expect(warnings[0]).toContain('not "consensus"');
  });

  it('does not warn when consensusQuorum is set with consensus strategy', () => {
    const onWarning = vi.fn();
    validatePolicyConfig(
      { permissionStrategy: 'consensus', consensusQuorum: 2 },
      onWarning,
    );
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('error messages name the field that failed (operator-debugging signal)', () => {
    expect(() => validatePolicyConfig({ permissionStrategy: 'oops' })).toThrow(
      /permissionStrategy/,
    );
    expect(() => validatePolicyConfig({ consensusQuorum: 0 })).toThrow(
      /consensusQuorum/,
    );
  });
});

/**
 * Integration test: verify daemon logger is initialized and written to
 * during `runQwenServe` boot + shutdown. Uses a fake bridge to avoid
 * spawning real `qwen --acp` child processes.
 */
describe('runQwenServe daemon logger wiring', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates a daemon log file at boot and flushes on shutdown', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-dl-')));
    const workspace = tmpDir;
    const debugDir = path.join(tmpDir, 'debug');

    // Minimal fake bridge satisfying the shape runQwenServe expects.
    const fakeBridge: HttpAcpBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
      getSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      publishWorkspaceEvent: vi.fn(),
      getEventRing: vi.fn().mockReturnValue({ getAll: () => [] }),
      resume: vi.fn(),
      preheat: vi.fn().mockResolvedValue(undefined),
    } as unknown as HttpAcpBridge;

    // Point daemon logger at our temp debug dir
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;

    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace,
          maxSessions: 1,
        },
        { bridge: fakeBridge },
      );

      // Daemon log directory should exist
      const daemonDir = path.join(debugDir, 'daemon');
      expect(fs.existsSync(daemonDir)).toBe(true);

      // Find the stable daemon log file.
      const logFiles = fs
        .readdirSync(daemonDir)
        .filter((f) => f.endsWith('.log'));
      expect(logFiles).toContain('daemon.log');

      const logContent = fs.readFileSync(
        path.join(daemonDir, 'daemon.log'),
        'utf8',
      );
      // Should contain the "daemon started" boot line
      expect(logContent).toContain('daemon started');
      expect(logContent).toContain(`pid=${process.pid}`);
      expect(logContent).toContain(
        `workspace=${fs.realpathSync.native(workspace)}`,
      );

      await Promise.all(
        Array.from({ length: 70 }, (_, index) =>
          fetch(`${handle.url}/missing-${index}`),
        ),
      );

      // Close the handle (graceful shutdown)
      await handle.close();

      // close() is intentionally bounded, so the file finalizer may still be
      // draining when it returns under a slow filesystem.
      const logPath = path.join(daemonDir, 'daemon.log');
      let finalContent = '';
      await vi.waitFor(
        () => {
          finalContent = fs.readFileSync(logPath, 'utf8');
          expect(finalContent).toContain('access logs suppressed');
          expect(finalContent).toContain('daemon stopped');
        },
        { timeout: 7_000, interval: 50 },
      );
      expect(finalContent).toContain('daemon started');
      const suppressedIndex = finalContent.indexOf('access logs suppressed');
      const stoppedIndex = finalContent.indexOf('daemon stopped');
      expect(suppressedIndex).toBeGreaterThanOrEqual(0);
      expect(stoppedIndex).toBeGreaterThan(suppressedIndex);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  }, 10_000);
});

describe('runQwenServe telemetry validation', () => {
  let tmpDir: string;
  const originalSensitiveSpanAttributeMaxLengthEnv =
    process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSensitiveSpanAttributeMaxLengthEnv === undefined) {
      delete process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'];
    } else {
      process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'] =
        originalSensitiveSpanAttributeMaxLengthEnv;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('wraps invalid daemon telemetry configuration as FatalConfigError', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tv-')));
    process.env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'] = '';

    const run = runQwenServe({
      port: 0,
      hostname: '127.0.0.1',
      mode: 'http-bridge',
      workspace: tmpDir,
      maxSessions: 1,
    });

    await expect(run).rejects.toThrow(qwenCore.FatalConfigError);
    await expect(run).rejects.toThrow(/Invalid telemetry configuration:/);
  });

  it('accepts multiple explicit workspace inputs and advertises workspaces', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const shutdownResolvers: Array<() => void> = [];
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => {
        const bridge = makeRuntimeBridge();
        bridge.shutdown = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              shutdownResolvers.push(resolve);
            }),
        );
        return bridge;
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    let closing: Promise<void> | undefined;
    try {
      const res = await fetch(`${handle.url}/capabilities`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workspaceCwd: string;
        features: string[];
        workspaces: Array<{
          cwd: string;
          primary: boolean;
          removable?: boolean;
        }>;
        limits: { maxTotalSessions: number | null };
      };
      expect(body.workspaceCwd).toBe(canonicalizeWorkspace(primary));
      expect(body.features).toContain('multi_workspace_sessions');
      expect(body.features).toContain('workspace_runtime_removal');
      expect(body.limits.maxTotalSessions).toBe(2);
      expect(body.workspaces).toEqual([
        expect.objectContaining({
          cwd: canonicalizeWorkspace(primary),
          primary: true,
          removable: false,
        }),
        expect.objectContaining({
          cwd: canonicalizeWorkspace(secondary),
          primary: false,
          removable: false,
        }),
      ]);

      closing = handle.close();
      await vi.waitFor(() => expect(shutdownResolvers).toHaveLength(2));
    } finally {
      closing ??= handle.close();
      await vi.waitFor(() => expect(shutdownResolvers).toHaveLength(2));
      for (const resolve of shutdownResolvers) resolve();
      await closing;
    }
    expect(createBridge).toHaveBeenCalledTimes(2);
    for (const result of createBridge.mock.results) {
      expect(result.value.shutdown).toHaveBeenCalledWith({
        reason: 'daemon_shutdown',
      });
    }
  });

  it('invalidates primary voice capabilities when its workspace service publishes settings changes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-voice-capability-')),
    );
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeRuntimeBridge(),
    );
    const originalCreateWorkspaceService =
      workspaceServiceRuntime.createDaemonWorkspaceService;
    let publishWorkspaceEvent:
      | Parameters<
          typeof workspaceServiceRuntime.createDaemonWorkspaceService
        >[0]['publishWorkspaceEvent']
      | undefined;
    vi.spyOn(
      workspaceServiceRuntime,
      'createDaemonWorkspaceService',
    ).mockImplementation((deps) => {
      if (deps.boundWorkspace === canonicalizeWorkspace(workspace)) {
        publishWorkspaceEvent = deps.publishWorkspaceEvent;
      }
      return originalCreateWorkspaceService(deps);
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace,
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      const before = (await (
        await fetch(`${handle.url}/capabilities`)
      ).json()) as { features: string[] };
      expect(before.features).not.toContain('workspace_voice_transcription');

      fs.mkdirSync(path.join(workspace, '.qwen'));
      fs.writeFileSync(
        path.join(workspace, '.qwen', 'settings.json'),
        JSON.stringify({
          modelProviders: {
            openai: [
              {
                id: 'qwen3-asr-flash',
                baseUrl: 'http://127.0.0.1:65535/v1',
              },
            ],
          },
        }),
        'utf8',
      );
      expect(publishWorkspaceEvent).toBeTypeOf('function');
      publishWorkspaceEvent?.({ type: 'settings_changed', data: {} });

      const after = (await (
        await fetch(`${handle.url}/capabilities`)
      ).json()) as { features: string[] };
      expect(after.features).toContain('workspace_voice_transcription');
    } finally {
      await handle.close();
    }
  });

  it('adds, advertises, and hot-removes a dynamic workspace runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-hot-remove-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    const removeByIds = vi.fn().mockResolvedValue(1);
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalizeWorkspace(primary),
        workspaces: [],
      }),
      add: vi.fn().mockResolvedValue(true),
      removeByIds,
    } as unknown as WorkspaceRegistrationStore;
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'hot-remove-token',
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    const headers = {
      Authorization: 'Bearer hot-remove-token',
      'Content-Type': 'application/json',
    };

    try {
      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: secondary, persist: true }),
      });
      expect(added.status).toBe(201);

      const before = (await (
        await fetch(`${handle.url}/capabilities`, { headers })
      ).json()) as {
        features: string[];
        workspaces: Array<{
          id: string;
          cwd: string;
          removable?: boolean;
        }>;
      };
      expect(before.features).toContain('workspace_runtime_removal');
      const removable = before.workspaces.find(
        (workspace) => workspace.cwd === canonicalizeWorkspace(secondary),
      );
      expect(removable).toMatchObject({ removable: true });

      const removed = await fetch(
        `${handle.url}/workspaces/${encodeURIComponent(removable!.id)}`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ force: true }),
        },
      );
      expect(removed.status).toBe(200);
      await expect(removed.json()).resolves.toMatchObject({
        removed: true,
        workspaceId: removable!.id,
        persistedRegistrationRemoved: true,
      });
      expect(removeByIds).toHaveBeenCalledWith(
        expect.arrayContaining([
          workspaceRegistrationId(canonicalizeWorkspace(secondary)),
        ]),
      );
      const dynamicBridge = createBridge.mock.results[1]?.value;
      expect(dynamicBridge?.shutdown).toHaveBeenCalledWith({
        reason: 'workspace_removed',
      });

      const afterResponse = await fetch(`${handle.url}/capabilities`, {
        headers,
      });
      expect(afterResponse.status).toBe(200);
      const after = (await afterResponse.json()) as {
        workspaces?: Array<{ id: string }>;
      };
      expect(
        (after.workspaces ?? []).some(
          (workspace) => workspace.id === removable!.id,
        ),
      ).toBe(false);

      const readded = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: secondary, persist: true }),
      });
      expect(readded.status).toBe(201);
      expect(createBridge).toHaveBeenCalledTimes(3);
      let releaseRemoval!: (count: number) => void;
      removeByIds.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            releaseRemoval = resolve;
          }),
      );
      const pendingRemoval = fetch(
        `${handle.url}/workspaces/${encodeURIComponent(removable!.id)}`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ force: true }),
        },
      );
      await vi.waitFor(() => expect(removeByIds).toHaveBeenCalledTimes(2));
      let closeSettled = false;
      const closing = handle.close().then(() => {
        closeSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closeSettled).toBe(false);

      releaseRemoval(1);
      expect((await pendingRemoval).status).toBe(200);
      await closing;
      expect(closeSettled).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('kills a half-built dynamic bridge when async construction cleanup fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-failure-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);

    const primaryBridge = makeRuntimeBridge();
    const failedBridge = makeRuntimeBridge();
    vi.mocked(failedBridge.shutdown).mockRejectedValue(
      new Error('async cleanup failed'),
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        primaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        failedBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    const originalCreateWorkspaceService =
      workspaceServiceRuntime.createDaemonWorkspaceService;
    const createWorkspaceService = vi.spyOn(
      workspaceServiceRuntime,
      'createDaemonWorkspaceService',
    );
    createWorkspaceService
      .mockImplementationOnce(originalCreateWorkspaceService)
      .mockImplementationOnce(() => {
        throw new Error('workspace service construction failed');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'runtime-failure-token',
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer runtime-failure-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cwd: secondary }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        code: 'runtime_creation_failed',
      });
      expect(failedBridge.shutdown).toHaveBeenCalledWith();
      expect(failedBridge.killAllSync).toHaveBeenCalledOnce();
      expect(primaryBridge.shutdown).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('uses the daemon-wide policy and limits when constructing workspace bridges', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    const primaryBridge = makeRuntimeBridge();
    const secondaryBridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        primaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        secondaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) => {
        const workspaceCwd =
          typeof workspace === 'string' ? canonicalizeWorkspace(workspace) : '';
        return {
          merged:
            workspaceCwd === secondaryCwd
              ? {
                  policy: {
                    permissionStrategy: 'consensus',
                    consensusQuorum: 2,
                  },
                }
              : {},
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        eventRingSize: 1234,
        compactedReplayMaxBytes: 1024,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        bootSettings: { policy: { permissionStrategy: 'local-only' } },
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      await handle.runtimeReady;
      expect(createBridge).toHaveBeenCalledTimes(2);
      expect(createBridge.mock.calls[0]?.[0]).toMatchObject({
        compactedReplayMaxBytes: 1024,
        eventRingSize: 1234,
        permissionPolicy: 'local-only',
      });
      expect(createBridge.mock.calls[1]?.[0]).toMatchObject({
        compactedReplayMaxBytes: 1024,
        eventRingSize: 1234,
        permissionPolicy: 'local-only',
      });
      expect(createBridge.mock.calls[1]?.[0]).not.toHaveProperty(
        'permissionConsensusQuorum',
      );
    } finally {
      await handle.close();
    }
  });

  it('does not validate policy settings for untrusted secondary workspaces', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      )
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) => {
        const workspaceCwd =
          typeof workspace === 'string' ? canonicalizeWorkspace(workspace) : '';
        return {
          merged:
            workspaceCwd === secondaryCwd
              ? { policy: { permissionStrategy: 'bogus' } }
              : {},
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(
      trustedFoldersRuntime,
      'getWorkspaceTrustStatus',
    ).mockImplementation(
      (_settings, workspace) =>
        ({
          effective: {
            state:
              canonicalizeWorkspace(workspace) === secondaryCwd
                ? 'untrusted'
                : 'trusted',
          },
        }) as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        bootSettings: { policy: { permissionStrategy: 'local-only' } },
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      await expect(handle.runtimeReady).resolves.toBeUndefined();
      expect(createBridge).toHaveBeenCalledTimes(2);
      expect(createBridge.mock.calls[1]?.[0]).toMatchObject({
        permissionPolicy: 'local-only',
      });
    } finally {
      await handle.close();
    }
  });

  it('accepts a single workspace array input as the primary workspace', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    const primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      const res = await fetch(`${handle.url}/capabilities`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { workspaceCwd: string }).toMatchObject({
        workspaceCwd: canonicalizeWorkspace(primary),
      });
    } finally {
      await handle.close();
    }
  });

  it('uses a daemon-scoped telemetry service instance id', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tv-')));
    const initializeTelemetry = vi
      .spyOn(qwenCore, 'initializeTelemetry')
      .mockResolvedValue(undefined);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );
    try {
      const runtimeConfig = initializeTelemetry.mock.calls[0]?.[0] as {
        getSessionId(): string;
        getTelemetryResourceAttributes(): Record<string, unknown>;
      };
      expect(runtimeConfig.getSessionId()).toBe(`daemon:${process.pid}`);
      expect(runtimeConfig.getTelemetryResourceAttributes()).toMatchObject({
        'service.instance.id': `daemon:${process.pid}`,
      });
    } finally {
      await handle.close();
    }
  });
});

/**
 * Boot validation for the embedded `runQwenServe` API: a non-finite
 * `permissionResponseTimeoutMs` (e.g. config- or NaN-derived) must fail
 * loud rather than reach the bridge, where it would be treated as the
 * "disabled" sentinel and silently drop the permission deadline.
 */
describe('runQwenServe permissionResponseTimeoutMs validation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-finite permissionResponseTimeoutMs', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pt-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    // Keep the daemon logger inside the temp dir so the boot path before
    // the validation throw doesn't write into the real ~/.qwen.
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            permissionResponseTimeoutMs: Number.NaN,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/permissionResponseTimeoutMs/);
      const log = fs.readFileSync(
        path.join(tmpDir, 'debug', 'daemon', 'daemon.log'),
        'utf8',
      );
      expect(log).toContain('daemon startup failed');
      expect(log).not.toContain('daemon stopped');
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('preserves the startup error and releases the log lease when stderr fails', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-pt-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        if (String(chunk).includes('daemon startup failed')) {
          throw new Error('stderr unavailable');
        }
        return true;
      });

    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            permissionResponseTimeoutMs: Number.NaN,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/permissionResponseTimeoutMs/);
    } finally {
      stderr.mockRestore();
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }

    expect(
      fs.existsSync(
        path.join(tmpDir, 'debug', 'daemon', '.stable-writer.lock'),
      ),
    ).toBe(false);
  });
});

describe('runQwenServe initializeTimeoutMs validation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-positive initializeTimeoutMs', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            initializeTimeoutMs: 0,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/initializeTimeoutMs/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects a non-finite initializeTimeoutMs', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            initializeTimeoutMs: Number.NaN,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/initializeTimeoutMs/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an initializeTimeoutMs above the JS timer ceiling', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const fakeBridge = {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    } as unknown as HttpAcpBridge;

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            initializeTimeoutMs: 2_147_483_648,
          },
          { bridge: fakeBridge },
        ),
      ).rejects.toThrow(/initializeTimeoutMs/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('propagates a valid initializeTimeoutMs to the bridge options', async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-it-')));
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });

    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          initializeTimeoutMs: 30_000,
          serveWebShell: false,
        },
        { resolveOnListen: true },
      );
      try {
        await handle.runtimeReady;
        expect(createBridge.mock.calls[0]?.[0]).toMatchObject({
          initializeTimeoutMs: 30_000,
        });
      } finally {
        await handle.close();
      }
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });
});

// Long-lived self-signed cert (CN=localhost, SAN IP:127.0.0.1) used only
// to exercise the HTTPS listener path. Not a real secret.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUfuVC8Ulq3HIg+1tf36JrjAa6dr4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDYzMDAyMjIxOVoYDzIxMjYw
NjA2MDIyMjE5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCnEk5caJsr2ShJwi4bkAMr1/IzzueiUFbnnqs3XpaB
ANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2MVHoDMH3zx4V36VcXUaeR+/wZbFRN
94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATGJZkzmGT8+M5CqDCW4isHlpGvbn0T
SdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wTAOIM8e8HC1VTMw1OhXDAus6ro7z+
u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7kmYwT9J1Gyw9cQQj8vcipyLq6q3Hz
iMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIYshAYRsKNAgMBAAGjbzBtMB0GA1Ud
DgQWBBSM8bvfq77vXg5fsuhYGXsLuKjqxzAfBgNVHSMEGDAWgBSM8bvfq77vXg5f
suhYGXsLuKjqxzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAGUBgaBYEO119e28j61PTijfhw7mV
Q8AxlUjlv+HHx+IAPR+E8w7jiS97oxvFSIkmbV+FAQOWwTE+oNvrL5qSFlG7cI60
wj+Jxwxr+/SShV5Jm7JlynAGxOvOZ1mfxzyGrlm5cg4hoRvcoWAtB/qtiIyFIz/s
fDAdZiFXRoTaZnpyPWA6iydf3mc0ZOastHib+mlFb+aedKz9by/f2Z1CY6RfckEj
20c9Mar85RYkVtVTIWNSwItASmQVBaoXsXK33y4C0P1NmPoYBzyPSXsOlmIZXui5
WYj2mrPe2DL5gCeNUxMhmzgv0bgoYiksHmdyNjRmO5AQlcdjX/7CHg0zEQ==
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCnEk5caJsr2ShJ
wi4bkAMr1/IzzueiUFbnnqs3XpaBANxpIZxi8WN1gf8MoAOioZteH51Q2nz8Zb2M
VHoDMH3zx4V36VcXUaeR+/wZbFRN94NlzYCXPnzPH+Mw/vle1PTM/boPON8F4ATG
JZkzmGT8+M5CqDCW4isHlpGvbn0TSdmqnmzihNBdaREVVkGJYa7JSFcgRth52+wT
AOIM8e8HC1VTMw1OhXDAus6ro7z+u5XKGpG+JfsCpimNPYzNOPSkIr/QmxuaMq7k
mYwT9J1Gyw9cQQj8vcipyLq6q3HziMhxUXbWp7moi4e6CzxLKyPrWwhuh+3SXqIY
shAYRsKNAgMBAAECggEAQW/tG0qphEog+orAznDgnRqOtfYTScLX1w6RlzVIE60H
p3HPs/1B7HOHNyWxZtCPbxVI47NAAwfCbyVjSL6EhqgeQbI2N173GDmvKzH/7y3D
3GraM+L4tZOSw80KVTdpzqSObInk6IMuu4FceRX2cBLvjrIbne1l1yoFU8Yd3SCM
t8J46vMys7Rh4yR0iOl1hFeLYj8KolTdp6uNYTxaHMt363G7/TcJYRqjrLkpBpXJ
dJiP58a3WulvVKVHBjZYVmHLlkvla7LQ9tPRsk0gUQfzNpLzl6oBacrNrRv1F7Oe
keYqt+Kpy9HhZIHt57ahwKmjhjrfIUpyQadF/me0rQKBgQDVbLV6VngGjMSCPQOQ
VZcAMFZ+y1fgaHeVZwuFeRlCEHBDDmw5eWdUdUQNIRckpqf0IlU39aP/cLgjNZ0W
nmxfUwhdgEMam2aHZ/8eqrOl0HTa+F5PWz8NPLKsQ970vPb1XCsoEtDVXEsMqK+s
4h+zjRzy6lLy2cWvYZrDr/KwywKBgQDIZmitKO0MIJOWeqwI3MQvbBXCz9aEIG+3
0ISQreD/7Z/IEcwrMpDD+z1sOj9OUO2GFflECdhtqo416cv3uo8LLABxuzsYOgug
ZPgW9oPKVRLfqc43/n0JMtIvS+Na/7C/nCNwcZZZU91V+VG4+1rexINQybnCRbQw
cBZLcX8nBwKBgQDMdZhl2vChVbnsCwee/l/qjmROk/9bvLjTKCSheaH46Eaj9u03
IlcbUjwfV9QUCJReDYYWVf0GebXuBS64vIyVxbX93SJsGvPeRILjniT8dPd9zvKK
k5+TztJctaiiTWVJKUMu4NevjvtW5UNnHDnCiS1yiYltnbMEkTzyu1yEgQKBgAYk
pYbRX1rk0MFnJ0jqQ5VUkeIz7taEDAiterLYsbIGvcQrT3/vf+KSHBLqQjCLaIyY
tdhxGNJbzRo3/YmtjV8BTU4vOCOI+/xBvB0wF2AndXmnweuTgI+8oBbVE7YhanCl
P6zdvocke/97shailemISqI6XNhovJpThUtwwj4XAoGATwSvzX0VLRpoWwDl30oi
hxyfpb0iCzGik49j/oL+ZB5C8F8AdBpza8eTXJAeAVP7L5nvWffMgvcXs5sGMF7e
ARaOwZHpfsTw4Aq74yAWUKXumVGFXQpZMRj/QWgQEItTYF7rJVARIssv5miDbHvW
1Qm2tDpPnmCd1BedIYWCnHA=
-----END PRIVATE KEY-----
`;

// A self-signed localhost cert/key whose validity window is entirely in the
// past (notAfter = 2020-01-02). Not a real secret — and doubly worthless
// since it's already expired. Used to exercise the boot-time expiry guard.
const TEST_TLS_CERT_EXPIRED = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUW7rZvmhryKZI3pojRCfl3liQSEMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTIwMDEwMTAwMDAwMFoXDTIwMDEw
MjAwMDAwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAzK9z67IJ0e5QGpnGoqCCY4jr401AKE0EuCx1TVkyGFck
2ESCkBPvV+ikMxvLuCOTdrKhgavlIVsnnrPgyND49WaVX6XrftoEU5hApDrWYtIV
TfHYSC1wWdS5yNL+tdqLnfiC8b1FolEdgChF5cBpv9jQ6jwjUwXDojVhoPv5Rf/+
7zWyCg4hoj4N5veluDp1uUJ3xYjT5bqgu54sSR8lDJ8quq48nei60iOy40QQ1z3N
+sDgoAwkkLDOt74iGnZpUOuKt4w0/v96epC12os40FrcYbbe880/trG0aWT4tvnr
t0WFMtLReBSgV/QPkXTZ4HXUVs+7QrqcDWElET2QXQIDAQABo1MwUTAdBgNVHQ4E
FgQUOy4xvXmhCSs0Msfb6mT3WuCjrwQwHwYDVR0jBBgwFoAUOy4xvXmhCSs0Msfb
6mT3WuCjrwQwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAZA0J
BSNEIrsyS/5MyiEmgZlhpPwdqxOfBGFTsHqD0jha30RSEl85iW4XIuwFH1nKoOKQ
Mw3Ns0FaXVJxsrLS7f+4QjzCtTNQ4jEHsnmkm+bLSXK9qA3XLYG7mogdiRE5qz91
9lwZCTBoWnfiG3phz7/Y/F4jM86JxJG4Fm/IQNhgxSGrNhyrRRfXR3rPOIA8pSpz
yN2OMgOQdMXhgE3IM8v7O/76OAYWhybO3zzNtL9d+mRW42B+Q5TCBIKwZXAALlLf
arfULiZOWgeWfNpoEvfbVqn6VXKNny0F8KDoTwoHzpTm0cb+RzfGiSRm0avJr20t
OmPpuyd1dcPjPSJEAQ==
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY_EXPIRED = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDMr3PrsgnR7lAa
mcaioIJjiOvjTUAoTQS4LHVNWTIYVyTYRIKQE+9X6KQzG8u4I5N2sqGBq+UhWyee
s+DI0Pj1ZpVfpet+2gRTmECkOtZi0hVN8dhILXBZ1LnI0v612oud+ILxvUWiUR2A
KEXlwGm/2NDqPCNTBcOiNWGg+/lF//7vNbIKDiGiPg3m96W4OnW5QnfFiNPluqC7
nixJHyUMnyq6rjyd6LrSI7LjRBDXPc36wOCgDCSQsM63viIadmlQ64q3jDT+/3p6
kLXaizjQWtxhtt7zzT+2sbRpZPi2+eu3RYUy0tF4FKBX9A+RdNngddRWz7tCupwN
YSURPZBdAgMBAAECggEAAUw1eG+TB10y7dA+xaYt3XKvSCwjtX2zg3VosvpXSnc2
+RYKG968fDqx288Xzg2PsEd2patQ0xLQX/209aD5ixjA5q/XG+FG+L603jWvSUYa
s3lOjTqYhUFHgkHwMnf1vaUnM2AnUl2gScE3nDrJkNlPjcSe1rZpJJyhB1PBo1N2
w602QMMMsIOHrPeJ/THm6ENUD6xGvGsuDcYZWDP9Fa/Dj1oMW+B8FRV/lF91JHgh
cP+QLk/E4SZGDIOQQ86v1jst6MGzI+iQVYTxfyDgyuCop9DAc1X9hZpG3qOyp6NS
DwBK14fc2r0S9ImL9I/wOBL319s60sC6h8BdOoSWowKBgQDoDP51obLx4kX3YbFD
1huH64Y072LolopXfaNj+Albk1PaNe1oBp1V80wFIT57l0WpibYWOQM6zDWVjZ/5
83utLHOdPe1PzVt4W1Yrk0CcWBiPybGlVVsBrogkF0lCSDGW8rqzD/Cms6AuLB5k
3ypNZKrk976fXjLSvefA9w2QvwKBgQDhz3BFW4oKvksl7PWyc5fvPgh1+V4K622b
hfjcdnamPynkUT13S0ymwOkjNYW6QzCSpgas59X3EHp8JR6Z6CoWdI4Fixz01qLv
R2n41Cc7lKF4WsXoi2IAq489z8GTuQpxhwWGxRs6uWiexY6CResvIgf7fnG63Rrd
p6Ul8kCJ4wKBgQCTdkZyHEqqGd/agBN1B2fBbTOBCisxoRDS3n1pduMDddFQlvqC
I8nyJ8VEcUbSpWPYhDHZV2us/r6ChliGL2uFtfzWjNb04oxhJLHSySXC9NzO6x5f
8aj+nZnYTY/5dgVFZoSsa9HDLdz52oGKGqM4QWO0U5eokOT9NT9ESfst4wKBgG5K
raGSxmfc7kOF67PPteQKvoMw23gl6ZFO7HByBB3LOCDmdUkxJC1GiBjEaZ7CdpUK
NrR5QA6+o7TDRKETvordPwkCG5CSzV5l2SLKLKdzPzLT01pzydhd80bTlM8cUDeH
JXHgEB6stKboA2Up1WdeDdwOtGn62MZuvcE9A7zVAoGAdediZvzAK+yVIPwaNqpy
eeYB4svm8NxzReLF/SCx+j++LvdQlrZMaCfX5M+zPCjXP7WiMWKlCKFm3kCq0NxV
dfOrXxrzy0bEsqEN1JpFwcVI4sUXm/JQSxO6mI5osX1e9qGF3p12aK6fWrPwaj1T
0qHz65jIzFez4M7YrnWF6Ak=
-----END PRIVATE KEY-----
`;

describe('runQwenServe TLS (--tls-cert / --tls-key)', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const minimalBridge = () =>
    ({
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    }) as unknown as HttpAcpBridge;

  it.each([
    ['only --tls-cert', { tlsCert: '/tmp/c.pem' }],
    ['only --tls-key', { tlsKey: '/tmp/k.pem' }],
  ])('rejects %s without its pair', async (_label, tlsOpts) => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            ...tlsOpts,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/--tls-cert and --tls-key must be provided together/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an unreadable cert file', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: path.join(tmpDir, 'does-not-exist.pem'),
            tlsKey: path.join(tmpDir, 'also-missing.pem'),
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/Failed to read --tls-cert/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an unreadable key file', async () => {
    // A readable cert with an unreadable key must hit the key-read catch,
    // not the cert-read one — otherwise the --tls-key error message is
    // never exercised and could regress unnoticed.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: path.join(tmpDir, 'no-key.pem'),
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/Failed to read --tls-key/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an expired certificate at boot', async () => {
    // A cert past its notAfter must fail loud at boot rather than start a
    // listener that rejects every client handshake while /health stays green.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT_EXPIRED);
    fs.writeFileSync(keyPath, TEST_TLS_KEY_EXPIRED);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: keyPath,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/expired on/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects an unparseable certificate at boot', async () => {
    // A readable file whose contents aren't a valid PEM cert must hit the
    // X509Certificate parse catch and surface the framed message rather than
    // a raw OpenSSL string.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, 'not a real certificate');
    fs.writeFileSync(keyPath, TEST_TLS_KEY);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: keyPath,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/is not a valid certificate/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('rejects a cert/key mismatch at boot', async () => {
    // TEST_TLS_CERT and TEST_TLS_KEY_EXPIRED come from different keypairs, so
    // https.createServer's createSecureContext throws a raw OpenSSL
    // key-values-mismatch string. Assert it's wrapped into the actionable
    // "could not be loaded (do they match?)" framing.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY_EXPIRED);
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      await expect(
        runQwenServe(
          {
            port: 0,
            hostname: '127.0.0.1',
            mode: 'http-bridge',
            workspace: tmpDir,
            maxSessions: 1,
            tlsCert: certPath,
            tlsKey: keyPath,
          },
          { bridge: minimalBridge() },
        ),
      ).rejects.toThrow(/could not be loaded/);
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  });

  it('serves over https when both cert and key are valid', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-tls-')),
    );
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');
    fs.writeFileSync(certPath, TEST_TLS_CERT);
    fs.writeFileSync(keyPath, TEST_TLS_KEY);

    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      new Promise<qwenCore.ResolvedTelemetrySettings>((resolve) => {
        resolveTelemetry = resolve;
      }),
    );
    const bridge = {
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
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        tlsCert: certPath,
        tlsKey: keyPath,
      },
      { resolveOnListen: true, runtimeStartupTimeoutMs: 0 },
    );

    try {
      expect(handle.url).toMatch(/^https:\/\//);
      expect(handle.server instanceof https.Server).toBe(true);

      // A successful response over the self-signed listener proves the
      // TLS handshake completed (not just that the URL string says https).
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = https.get(
          `${handle.url}/health`,
          { rejectUnauthorized: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
      });
      expect(typeof statusCode).toBe('number');
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });
});

describe('runQwenServe pre-listen bridge option validation', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['maxSessions', Number.NaN, /maxSessions/],
    ['maxSessions', -1, /maxSessions/],
    ['maxTotalSessions', Number.NaN, /maxTotalSessions/],
    ['maxTotalSessions', -1, /maxTotalSessions/],
    ['maxTotalSessions', 1.5, /maxTotalSessions/],
    ['eventRingSize', 0, /eventRingSize/],
    ['eventRingSize', 1.5, /eventRingSize/],
    ['eventRingSize', Number.POSITIVE_INFINITY, /eventRingSize/],
    ['compactedReplayMaxBytes', 0, /compactedReplayMaxBytes/],
    ['compactedReplayMaxBytes', 1.5, /compactedReplayMaxBytes/],
    [
      'compactedReplayMaxBytes',
      Number.POSITIVE_INFINITY,
      /compactedReplayMaxBytes/,
    ],
  ] as const)(
    'rejects invalid %s=%s before printing the listening line',
    async (optionName, value, message) => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bridge-opt-')),
      );
      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

      await expect(
        runQwenServe({
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          [optionName]: value,
        }),
      ).rejects.toThrow(message);
      expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
    },
  );

  it.each([
    ['rateLimitPrompt', 0, /rateLimitPrompt/],
    ['rateLimitMutation', -1, /rateLimitMutation/],
    ['rateLimitRead', 1.5, /rateLimitRead/],
    ['rateLimitWindowMs', 999, /rateLimitWindowMs/],
  ] as const)(
    'rejects invalid %s=%s before printing the listening line',
    async (optionName, value, message) => {
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'qws-rate-opt-')),
      );
      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

      await expect(
        runQwenServe({
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          rateLimit: true,
          [optionName]: value,
        }),
      ).rejects.toThrow(message);
      expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
    },
  );

  it('rejects an injected bridge with multiple explicit workspaces before listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bridge-opt-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: [primary, secondary],
        },
        { bridge: makeRuntimeBridge() },
      ),
    ).rejects.toThrow(/Injected bridge dependencies/);
    expect(stdoutWrites.join('')).not.toContain('qwen serve listening on');
  });
});

describe('runQwenServe session reaper timeout validation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
    } as unknown as HttpAcpBridge;
  }

  async function runWithReaperOption(
    optionName: 'sessionReapIntervalMs' | 'sessionIdleTimeoutMs',
    value: number,
  ) {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-rt-')));
    const origEnv = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    try {
      return await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          [optionName]: value,
        },
        { bridge: makeFakeBridge() },
      );
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
    }
  }

  it.each([
    ['sessionReapIntervalMs', -1],
    ['sessionReapIntervalMs', 1.5],
    ['sessionReapIntervalMs', Number.NaN],
    ['sessionReapIntervalMs', Number.POSITIVE_INFINITY],
    ['sessionIdleTimeoutMs', -1],
    ['sessionIdleTimeoutMs', 1.5],
    ['sessionIdleTimeoutMs', Number.NaN],
    ['sessionIdleTimeoutMs', Number.POSITIVE_INFINITY],
  ] as const)('rejects invalid %s=%s', async (optionName, value) => {
    await expect(runWithReaperOption(optionName, value)).rejects.toThrow(
      optionName,
    );
  });

  it.each([
    ['sessionReapIntervalMs', 0],
    ['sessionIdleTimeoutMs', 0],
  ] as const)(
    'keeps %s=0 as the disabled sentinel',
    async (optionName, value) => {
      const handle = await runWithReaperOption(optionName, value);
      await handle.close();
    },
  );
});

describe('runQwenServe runtime startup failures', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function readBrowserMcpFeatureFlagsForEnv(
    raw: string | undefined,
    origin = 'chrome-extension://qwen-test-extension',
    cdpMcpCommand?: string,
  ) {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    const originalClientMcpOverWs =
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    const originalCdpTunnelOverWs =
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    const originalCdpMcpCommand = process.env['QWEN_CDP_MCP_COMMAND'];
    if (raw === undefined) {
      delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    } else {
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = raw;
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = raw;
    }
    if (cdpMcpCommand === undefined) {
      delete process.env['QWEN_CDP_MCP_COMMAND'];
    } else {
      process.env['QWEN_CDP_MCP_COMMAND'] = cdpMcpCommand;
    }
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        allowOrigins: [origin],
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      const capabilitiesRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: origin },
      });
      expect(capabilitiesRes.status).toBe(200);
      return ((await capabilitiesRes.json()) as { features: string[] })
        .features;
    } finally {
      if (originalClientMcpOverWs === undefined) {
        delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = originalClientMcpOverWs;
      }
      if (originalCdpTunnelOverWs === undefined) {
        delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = originalCdpTunnelOverWs;
      }
      if (originalCdpMcpCommand === undefined) {
        delete process.env['QWEN_CDP_MCP_COMMAND'];
      } else {
        process.env['QWEN_CDP_MCP_COMMAND'] = originalCdpMcpCommand;
      }
      await handle.close();
    }
  }

  it('rejects the embedded run handle by default when the runtime fails to mount', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    await expect(
      runQwenServe({
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      }),
    ).rejects.toThrow('runtime boom');
  });

  it('closes the listener before rejecting when resolveOnListen is false and runtime startup fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-close-')),
    );
    const port = await getFreeLoopbackPort();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    await expect(
      runQwenServe({
        port,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      }),
    ).rejects.toThrow('runtime boom');

    await expect(
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['0', false],
    ['false', false],
    ['FALSE', false],
    [' 0 ', false],
    ['1', true],
    ['true', true],
    ['anything', true],
  ] as const)(
    'normalizes browser MCP env flag %j',
    async (raw, shouldEnable) => {
      const features = await readBrowserMcpFeatureFlagsForEnv(raw);

      if (shouldEnable) {
        expect(features).toEqual(
          expect.arrayContaining(['client_mcp_over_ws', 'cdp_tunnel_over_ws']),
        );
      } else {
        expect(features).not.toContain('client_mcp_over_ws');
        expect(features).not.toContain('cdp_tunnel_over_ws');
      }
    },
  );

  it('auto-enables only the CDP tunnel for Chrome extension origins when the env flag is unset', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(undefined);

    expect(features).toContain('cdp_tunnel_over_ws');
    expect(features).not.toContain('client_mcp_over_ws');
    expect(features).not.toContain('browser_automation_mcp');
  });

  it('advertises browser automation MCP when the external CDP adapter command is set', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(
      undefined,
      'chrome-extension://qwen-test-extension',
      '/opt/qwen-cdp-mcp-adapter',
    );

    expect(features).toContain('cdp_tunnel_over_ws');
    expect(features).toContain('browser_automation_mcp');
    expect(features).not.toContain('client_mcp_over_ws');
  });

  it('does not advertise browser automation MCP without an active CDP tunnel', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(
      undefined,
      'https://example.com',
      '/opt/qwen-cdp-mcp-adapter',
    );

    expect(features).not.toContain('browser_automation_mcp');
  });

  it('does not enable browser automation MCP on bearer-protected endpoints', () => {
    expect(
      isBrowserAutomationMcpAvailable(
        {
          cdpTunnelOverWs: true,
          token: 'secret-token',
        },
        {},
      ),
    ).toBe(false);
  });

  it('forwards auto-enabled CDP tunnel state to the ACP child env', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-child-env-')),
    );
    const originalClientMcpOverWs =
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    const originalCdpTunnelOverWs =
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        allowOrigins: ['chrome-extension://qwen-test-extension'],
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      const bridgeOptions = createBridge.mock.calls[0]?.[0] as
        | { childEnvOverrides?: Record<string, string | undefined> }
        | undefined;
      expect(bridgeOptions?.childEnvOverrides).toMatchObject({
        QWEN_SERVE_CDP_TUNNEL_OVER_WS: '1',
      });
    } finally {
      if (originalClientMcpOverWs === undefined) {
        delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = originalClientMcpOverWs;
      }
      if (originalCdpTunnelOverWs === undefined) {
        delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = originalCdpTunnelOverWs;
      }
      await handle.close();
    }
  });

  it('rebuilds runtime env from the immutable daemon base after workspace reload', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-env-reload-')),
    );
    const originalBase = process.env['QWEN_TEST_BOOT_BASE'];
    const originalLeak = process.env['QWEN_TEST_RELOAD_LEAK'];
    const originalRemoved = process.env['QWEN_TEST_REMOVED_FROM_DOTENV'];
    process.env['QWEN_TEST_BOOT_BASE'] = 'base';
    process.env['QWEN_TEST_REMOVED_FROM_DOTENV'] = 'stale';
    delete process.env['QWEN_TEST_RELOAD_LEAK'];

    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (...args: Parameters<typeof settingsRuntime.loadSettings>) => {
        const options = args[1];
        const isReload =
          typeof options === 'object' && options?.skipLoadEnvironment === true;
        return {
          merged: {
            env: {
              QWEN_TEST_RUNTIME_VALUE: isReload ? 'reloaded' : 'boot',
            },
          },
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(settingsRuntime, 'reloadEnvironment').mockImplementation(() => {
      process.env['QWEN_TEST_RELOAD_LEAK'] = 'workspace-a';
      delete process.env['QWEN_TEST_REMOVED_FROM_DOTENV'];
      return {
        updatedKeys: ['QWEN_TEST_RELOAD_LEAK'],
        removedKeys: ['QWEN_TEST_REMOVED_FROM_DOTENV'],
      };
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const buildRuntimeEnvironment = vi.spyOn(
      environmentRuntime,
      'buildRuntimeEnvironment',
    );
    let workspace:
      | {
          reload(ctx: {
            route: string;
            workspaceCwd: string;
          }): Promise<unknown>;
        }
      | undefined;
    let primaryRuntimeEnv:
      | {
          effectiveEnv?: NodeJS.ProcessEnv;
        }
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        workspace = deps?.workspace as typeof workspace;
        primaryRuntimeEnv = deps?.primaryRuntimeEnv as typeof primaryRuntimeEnv;
        return express();
      },
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(workspace).toBeDefined();
      expect(primaryRuntimeEnv?.effectiveEnv).toBeDefined();
      const capturedRuntimeEnv = primaryRuntimeEnv!.effectiveEnv!;
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('boot');

      await workspace!.reload({
        route: 'POST /workspace/reload',
        workspaceCwd: tmpDir,
      });

      const reloadBaseEnv = buildRuntimeEnvironment.mock.calls.at(-1)?.[2];
      expect(reloadBaseEnv?.['QWEN_TEST_BOOT_BASE']).toBe('base');
      expect(reloadBaseEnv?.['QWEN_TEST_REMOVED_FROM_DOTENV']).toBe('stale');
      expect(reloadBaseEnv?.['QWEN_TEST_RELOAD_LEAK']).toBeUndefined();
      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('reloaded');
      expect(capturedRuntimeEnv['QWEN_TEST_REMOVED_FROM_DOTENV']).toBe('stale');
      expect(capturedRuntimeEnv['QWEN_TEST_RELOAD_LEAK']).toBeUndefined();
    } finally {
      if (originalBase === undefined) {
        delete process.env['QWEN_TEST_BOOT_BASE'];
      } else {
        process.env['QWEN_TEST_BOOT_BASE'] = originalBase;
      }
      if (originalLeak === undefined) {
        delete process.env['QWEN_TEST_RELOAD_LEAK'];
      } else {
        process.env['QWEN_TEST_RELOAD_LEAK'] = originalLeak;
      }
      if (originalRemoved === undefined) {
        delete process.env['QWEN_TEST_REMOVED_FROM_DOTENV'];
      } else {
        process.env['QWEN_TEST_REMOVED_FROM_DOTENV'] = originalRemoved;
      }
      await handle.close();
    }
  });

  it('preserves previous runtime env and marks fallback when reload env rebuild fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-env-fallback-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (...args: Parameters<typeof settingsRuntime.loadSettings>) => {
        const options = args[1];
        const isReload =
          typeof options === 'object' && options?.skipLoadEnvironment === true;
        return {
          merged: {
            env: {
              QWEN_TEST_RUNTIME_VALUE: isReload ? 'reloaded' : 'boot',
            },
          },
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(settingsRuntime, 'reloadEnvironment').mockReturnValue({
      updatedKeys: [],
      removedKeys: [],
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const buildRuntimeEnvironmentActual =
      environmentRuntime.buildRuntimeEnvironment;
    let failReloadBuild = false;
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (
        ...args: Parameters<typeof environmentRuntime.buildRuntimeEnvironment>
      ) => {
        if (failReloadBuild) {
          throw new Error('runtime env rebuild failed');
        }
        return buildRuntimeEnvironmentActual(...args);
      },
    );
    let workspace:
      | {
          reload(ctx: {
            route: string;
            workspaceCwd: string;
          }): Promise<unknown>;
        }
      | undefined;
    let primaryRuntimeEnv:
      | {
          effectiveEnv?: NodeJS.ProcessEnv;
          fallbackReason?: string;
        }
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        workspace = deps?.workspace as typeof workspace;
        primaryRuntimeEnv = deps?.primaryRuntimeEnv as typeof primaryRuntimeEnv;
        return express();
      },
    );

    const logBaseDir = path.join(tmpDir, 'debug');
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: logBaseDir,
        resolveOnListen: true,
      },
    );

    let closed = false;
    try {
      await handle.runtimeReady;
      expect(workspace).toBeDefined();
      expect(primaryRuntimeEnv?.effectiveEnv).toBeDefined();
      const capturedRuntimeEnv = primaryRuntimeEnv!.effectiveEnv!;
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('boot');

      failReloadBuild = true;
      await workspace!.reload({
        route: 'POST /workspace/reload',
        workspaceCwd: tmpDir,
      });

      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('boot');
      expect(primaryRuntimeEnv!.fallbackReason).toBe(
        'runtime env rebuild failed',
      );

      failReloadBuild = false;
      await workspace!.reload({
        route: 'POST /workspace/reload',
        workspaceCwd: tmpDir,
      });
      expect(primaryRuntimeEnv!.effectiveEnv).toBe(capturedRuntimeEnv);
      expect(capturedRuntimeEnv['QWEN_TEST_RUNTIME_VALUE']).toBe('reloaded');
      expect(primaryRuntimeEnv!.fallbackReason).toBeUndefined();

      await handle.close();
      closed = true;
      const logPath = path.join(logBaseDir, 'daemon', 'daemon.log');
      const log = fs.readFileSync(logPath, 'utf8');
      expect(log).toContain(
        'failed to rebuild runtime env snapshot after daemon env reload; preserving previous runtime env',
      );
    } finally {
      if (!closed) {
        await handle.close();
      }
    }
  });

  it('updates secondary runtime env metadata in place after workspace reload', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-secondary-env-reload-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (...args: Parameters<typeof settingsRuntime.loadSettings>) => {
        const workspace = args[0];
        const options = args[1];
        const isReload =
          typeof options === 'object' && options?.skipLoadEnvironment === true;
        const isSecondary = workspace === secondary;
        return {
          merged: {
            env: {
              [isSecondary
                ? 'QWEN_TEST_SECONDARY_ENV'
                : 'QWEN_TEST_PRIMARY_ENV']: isReload ? 'reloaded' : 'boot',
            },
          },
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(settingsRuntime, 'reloadEnvironment').mockReturnValue({
      updatedKeys: ['QWEN_TEST_SECONDARY_ENV'],
      removedKeys: [],
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      )
      .mockReturnValueOnce(
        makeRuntimeBridge() as ReturnType<
          typeof acpBridge.createAcpSessionBridge
        >,
      );
    let workspaceRegistry:
      | import('./workspace-registry.js').WorkspaceRegistry
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        workspaceRegistry = deps?.workspaceRegistry;
        return express();
      },
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      const secondaryRuntime = workspaceRegistry
        ?.list()
        .find((runtime) => runtime.workspaceCwd === secondary);
      expect(secondaryRuntime).toBeDefined();
      const env = secondaryRuntime!.env;
      const overlayKeys = env.overlayKeys;
      const envFilePaths = env.envFilePaths;
      const envFileReadFailures = env.envFileReadFailures;
      expect(env.effectiveEnv?.['QWEN_TEST_SECONDARY_ENV']).toBe('boot');

      await secondaryRuntime!.workspaceService.reload({
        route: 'POST /workspace/reload',
        workspaceCwd: secondary,
      });

      expect(env.overlayKeys).toBe(overlayKeys);
      expect(env.envFilePaths).toBe(envFilePaths);
      expect(env.envFileReadFailures).toBe(envFileReadFailures);
      expect(env.effectiveEnv?.['QWEN_TEST_SECONDARY_ENV']).toBe('reloaded');
    } finally {
      await handle.close();
    }
  });

  it('restores persisted workspaces through the normal secondary runtime path', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-restored-workspace-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const explicitSecondary = path.join(tmpDir, 'explicit-secondary');
    const restoredSecondary = path.join(tmpDir, 'restored-secondary');
    const nestedSecondary = path.join(explicitSecondary, 'nested');
    fs.mkdirSync(primary);
    fs.mkdirSync(explicitSecondary);
    fs.mkdirSync(restoredSecondary);
    fs.mkdirSync(nestedSecondary);
    const restoredSecondaryAlias = path.join(
      tmpDir,
      'restored-secondary-alias',
    );
    fs.symlinkSync(
      restoredSecondary,
      restoredSecondaryAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const canonicalPrimary = canonicalizeWorkspace(primary);
    const canonicalExplicitSecondary = canonicalizeWorkspace(explicitSecondary);
    const canonicalRestoredSecondary = canonicalizeWorkspace(restoredSecondary);
    const missingPersistedWorkspace = path.join(tmpDir, 'missing-secondary');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    let restoredCwds: string[] = [];
    let restoredDisplayNames: Array<string | undefined> = [];
    let restoredRemovable: Array<boolean | undefined> = [];
    let restoredRegistrationIds: Array<readonly string[] | undefined> = [];
    let advertisedMaxTotalSessions: number | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (opts, _getPort, deps) => {
        restoredCwds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.workspaceCwd) ?? [];
        restoredDisplayNames =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.displayName) ?? [];
        restoredRemovable =
          deps?.workspaceRegistry?.list().map((runtime) => runtime.removable) ??
          [];
        restoredRegistrationIds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.registrationIds) ?? [];
        advertisedMaxTotalSessions = opts.maxTotalSessions;
        return express();
      },
    );
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalPrimary,
        workspaces: [
          missingPersistedWorkspace,
          canonicalExplicitSecondary,
          nestedSecondary,
          restoredSecondaryAlias,
          canonicalRestoredSecondary,
        ],
        displayNames: {
          [workspaceRegistrationId(canonicalExplicitSecondary)]:
            'Explicit workspace',
          [workspaceRegistrationId(restoredSecondaryAlias)]:
            'Restored workspace',
          [workspaceRegistrationId(canonicalRestoredSecondary)]:
            'Later alias name',
        },
      }),
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, explicitSecondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(store.read).toHaveBeenCalledTimes(1);
      expect(restoredCwds).toEqual([
        canonicalPrimary,
        canonicalExplicitSecondary,
        canonicalRestoredSecondary,
      ]);
      expect(restoredDisplayNames).toEqual([
        undefined,
        'Explicit workspace',
        'Restored workspace',
      ]);
      expect(restoredRemovable).toEqual([false, false, true]);
      expect(restoredRegistrationIds).toEqual([
        [],
        [workspaceRegistrationId(canonicalExplicitSecondary)],
        [
          workspaceRegistrationId(restoredSecondaryAlias),
          workspaceRegistrationId(canonicalRestoredSecondary),
        ],
      ]);
      expect(createBridge).toHaveBeenCalledTimes(3);
      expect(advertisedMaxTotalSessions).toBe(3);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes(
            `skipping persisted workspace registration ${JSON.stringify(
              missingPersistedWorkspace,
            )}`,
          ),
        ),
      ).toBe(true);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes('path nests with an explicit'),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('continues with explicit workspaces when the registration store read fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-restored-read-error-')),
    );
    const primary = path.join(tmpDir, 'primary');
    fs.mkdirSync(primary);
    const canonicalPrimary = canonicalizeWorkspace(primary);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    let restoredCwds: string[] = [];
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        restoredCwds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.workspaceCwd) ?? [];
        return express();
      },
    );
    const store = {
      read: vi.fn().mockRejectedValue(new Error('store unavailable')),
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(restoredCwds).toEqual([canonicalPrimary]);
      expect(createBridge).toHaveBeenCalledTimes(1);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes(
            'failed to read persisted workspace registrations',
          ),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('skips persisted workspaces after the runtime limit is reached', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-restored-limit-')),
    );
    const explicitWorkspaces = Array.from({ length: 25 }, (_, index) => {
      const workspace = path.join(tmpDir, `explicit-${index}`);
      fs.mkdirSync(workspace);
      return workspace;
    });
    const overflow = path.join(tmpDir, 'persisted-overflow');
    fs.mkdirSync(overflow);
    const canonicalExplicit = explicitWorkspaces.map((workspace) =>
      canonicalizeWorkspace(workspace),
    );
    const canonicalOverflow = canonicalizeWorkspace(overflow);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    let restoredCwds: string[] = [];
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(
      (_opts, _getPort, deps) => {
        restoredCwds =
          deps?.workspaceRegistry
            ?.list()
            .map((runtime) => runtime.workspaceCwd) ?? [];
        return express();
      },
    );
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: canonicalExplicit[0],
        workspaces: [canonicalOverflow],
      }),
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: explicitWorkspaces,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        workspaceRegistrationStore: store,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(restoredCwds).toEqual(canonicalExplicit);
      expect(createBridge).toHaveBeenCalledTimes(25);
      expect(
        stderrWrite.mock.calls.some(([message]) =>
          String(message).includes('workspace limit reached'),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('filters secondary workspace roots before constructing the bridge filesystem', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const trustedSecondary = path.join(tmpDir, 'trusted-secondary');
    const untrustedSecondary = path.join(tmpDir, 'untrusted-secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(trustedSecondary);
    fs.mkdirSync(untrustedSecondary);
    const roots = [primary, trustedSecondary, untrustedSecondary].map((root) =>
      canonicalizeWorkspace(root),
    );
    const bridgeFsBoundWorkspaces: string[][] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(
      trustedFoldersRuntime,
      'getWorkspaceTrustStatus',
    ).mockImplementation(
      (_settings, workspace) =>
        ({
          effective: {
            state: workspace === untrustedSecondary ? 'untrusted' : 'trusted',
          },
        }) as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>,
    );
    vi.spyOn(
      serverModule,
      'resolveBoundWorkspacesFromIdeEnv',
    ).mockImplementation((_primary, _ide, includeWorkspace) =>
      includeWorkspace === undefined ? roots : roots.filter(includeWorkspace),
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        bridgeFsBoundWorkspaces.push([...input.boundWorkspaces]);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bridgeFsBoundWorkspaces[0]).toEqual([roots[0], roots[1]]);
    } finally {
      await handle.close();
    }
  });

  it('keeps trusted child roots when an untrusted parent is filtered out', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const untrustedParent = path.join(tmpDir, 'parent');
    const trustedChild = path.join(untrustedParent, 'trusted-child');
    fs.mkdirSync(primary);
    fs.mkdirSync(trustedChild, { recursive: true });
    const roots = [primary, untrustedParent, trustedChild].map((root) =>
      canonicalizeWorkspace(root),
    );
    const originalIdeWorkspacePath =
      process.env['QWEN_CODE_IDE_WORKSPACE_PATH'];
    process.env['QWEN_CODE_IDE_WORKSPACE_PATH'] = JSON.stringify(roots);
    const bridgeFsBoundWorkspaces: string[][] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(
      trustedFoldersRuntime,
      'getWorkspaceTrustStatus',
    ).mockImplementation(
      (_settings, workspace) =>
        ({
          effective: {
            state: workspace === roots[1] ? 'untrusted' : 'trusted',
          },
        }) as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>,
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        bridgeFsBoundWorkspaces.push([...input.boundWorkspaces]);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bridgeFsBoundWorkspaces[0]).toEqual([roots[0], roots[2]]);
    } finally {
      if (originalIdeWorkspacePath === undefined) {
        delete process.env['QWEN_CODE_IDE_WORKSPACE_PATH'];
      } else {
        process.env['QWEN_CODE_IDE_WORKSPACE_PATH'] = originalIdeWorkspacePath;
      }
      await handle.close();
    }
  });

  it('shares one path lock registry across bridge and REST filesystem factories', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const roots = [primary, secondary].map((root) =>
      canonicalizeWorkspace(root),
    );
    const pathLocks: unknown[] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(
      serverModule,
      'resolveBoundWorkspacesFromIdeEnv',
    ).mockImplementation((_primary, _ide, includeWorkspace) =>
      includeWorkspace === undefined ? roots : roots.filter(includeWorkspace),
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        pathLocks.push(input.pathLocks);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(pathLocks).toHaveLength(2);
      expect(pathLocks[0]).toBeDefined();
      expect(pathLocks[0]).toBe(pathLocks[1]);
    } finally {
      await handle.close();
    }
  });

  it('excludes secondary workspace roots when runtime trust settings are unavailable', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-roots-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const roots = [primary, secondary].map((root) =>
      canonicalizeWorkspace(root),
    );
    const bridgeFsBoundWorkspaces: string[][] = [];
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus');
    vi.spyOn(
      serverModule,
      'resolveBoundWorkspacesFromIdeEnv',
    ).mockImplementation((_primary, _ide, includeWorkspace) =>
      includeWorkspace === undefined ? roots : roots.filter(includeWorkspace),
    );
    vi.spyOn(serverModule, 'resolveBridgeFsFactory').mockImplementation(
      (input) => {
        bridgeFsBoundWorkspaces.push([...input.boundWorkspaces]);
        return {} as ReturnType<typeof serverModule.resolveBridgeFsFactory>;
      },
    );
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue(express());

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeRuntimeBridge(),
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        resolveOnListen: true,
      },
    );

    try {
      await handle.runtimeReady;
      expect(bridgeFsBoundWorkspaces[0]).toEqual([roots[0]]);
      expect(
        trustedFoldersRuntime.getWorkspaceTrustStatus,
      ).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('keeps browser MCP features disabled for non-extension origins when the env flag is unset', async () => {
    const features = await readBrowserMcpFeatureFlagsForEnv(
      undefined,
      'https://example.com',
    );

    expect(features).not.toContain('client_mcp_over_ws');
    expect(features).not.toContain('cdp_tunnel_over_ws');
  });

  it('bounds shutdown waiting when runtime startup never settles', async () => {
    const daemonLog = { warn: vi.fn() };

    await expect(
      waitForRuntimeStartingForShutdown(
        new Promise<void>(() => {}),
        daemonLog,
        1,
      ),
    ).resolves.toBeUndefined();

    expect(daemonLog.warn).toHaveBeenCalledWith(
      '1ms runtime-startup wait reached during shutdown; continuing listener close',
    );
  });

  it('proxies bridge access only after the runtime bridge is ready', async () => {
    const holder: { bridge?: HttpAcpBridge } = {};
    let runtimeStartupError: string | undefined;
    const proxy = createLazyBridgeProxy(
      () => holder.bridge,
      () => runtimeStartupError,
    );

    expect(() => proxy.getDaemonStatusSnapshot()).toThrow(
      'Daemon bridge runtime is still starting.',
    );

    runtimeStartupError = 'runtime boom';
    expect(() => proxy.getDaemonStatusSnapshot()).toThrow(
      'Daemon bridge runtime is not available: runtime boom',
    );

    const getDaemonStatusSnapshot = vi.fn(function (this: HttpAcpBridge) {
      return this === holder.bridge
        ? BASE_BRIDGE_SNAPSHOT
        : {
            ...BASE_BRIDGE_SNAPSHOT,
            channelLive: false,
          };
    });
    runtimeStartupError = undefined;
    holder.bridge = { getDaemonStatusSnapshot } as unknown as HttpAcpBridge;

    expect(proxy.getDaemonStatusSnapshot()).toBe(BASE_BRIDGE_SNAPSHOT);
    expect(getDaemonStatusSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 120_000],
    ['', 120_000],
    ['5000', 5000],
    ['0', 0],
    ['abc', 120_000],
    [String(Number.MAX_SAFE_INTEGER + 1), 120_000],
  ])(
    'resolves QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS=%s to %s',
    (envValue, expected) => {
      const originalEnv = process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'];
      try {
        if (envValue === undefined) {
          delete process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'];
        } else {
          process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'] = envValue;
        }

        expect(resolveRuntimeStartupTimeoutMs(undefined)).toBe(expected);
      } finally {
        if (originalEnv === undefined) {
          delete process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'];
        } else {
          process.env['QWEN_SERVE_RUNTIME_STARTUP_TIMEOUT_MS'] = originalEnv;
        }
      }
    },
  );

  it('returns bootstrap 503 for unknown routes while runtime is still starting', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-starting-route-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true, runtimeStartupTimeoutMs: 0 },
    );

    try {
      const res = await fetch(`${handle.url}/unknown-route`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: 'Daemon runtime is still starting',
        code: 'daemon_runtime_starting',
      });
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });

  it('returns bootstrap 503 for multi-workspace capabilities until runtime routes mount', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-starting-caps-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeRuntimeBridge());
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: {},
    } as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        runtimeStartupTimeoutMs: 0,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    try {
      const bootstrapRes = await fetch(`${handle.url}/capabilities`);
      expect(bootstrapRes.status).toBe(503);
      expect(bootstrapRes.headers.get('retry-after')).toBe('1');
      expect(await bootstrapRes.json()).toMatchObject({
        error: 'Daemon runtime is still starting',
        code: 'daemon_runtime_starting',
      });
      expect(createBridge).not.toHaveBeenCalled();

      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.runtimeReady;
      const runtimeRes = await fetch(`${handle.url}/capabilities`);
      expect(runtimeRes.status).toBe(200);
      const runtimeBody = (await runtimeRes.json()) as { features: string[] };
      expect(runtimeBody.features).toContain('multi_workspace_sessions');
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });

  it('keeps health responsive before starting deferred runtime work', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-first-')),
    );
    const logBaseDir = path.join(tmpDir, 'debug');
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockResolvedValue({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        daemonLogBaseDir: logBaseDir,
      },
    );

    let closed = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(resolveTelemetrySettings).not.toHaveBeenCalled();
      expect(createBridge).not.toHaveBeenCalled();
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ status: 'ok' });

      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      expect(resolveTelemetrySettings).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
      await handle.close();
      closed = true;

      const daemonDir = path.join(logBaseDir, 'daemon');
      const [logFile] = fs
        .readdirSync(daemonDir)
        .filter((fileName) => fileName.endsWith('.log'));
      expect(logFile).toBeDefined();
      const logContent = fs.readFileSync(
        path.join(daemonDir, logFile!),
        'utf8',
      );
      expect(logContent).toContain(
        'deferred runtime: health timer fired, starting',
      );
    } finally {
      if (!closed) {
        await handle.close();
      }
    }
  });

  it('returns retryable bootstrap deep health while starting deferred runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-deep-first-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const bootstrapRes = await fetch(`${handle.url}/health?deep=1`);
      expect(bootstrapRes.status).toBe(503);
      expect(bootstrapRes.headers.get('retry-after')).toBe('1');
      expect(await bootstrapRes.json()).toEqual({
        status: 'degraded',
        reason: 'bootstrap',
      });

      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      await expect(handle.runtimeReady).resolves.toBeUndefined();

      const runtimeRes = await fetch(`${handle.url}/health?deep=1`);
      expect(runtimeRes.status).toBe(200);
      expect(await runtimeRes.json()).toMatchObject({
        status: 'ok',
        workspaceCount: 1,
        sessions: 0,
      });
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime once for duplicate health probes', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-dedupe-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const [firstHealthRes, secondHealthRes] = await Promise.all([
        fetch(`${handle.url}/health`),
        fetch(`${handle.url}/health`),
      ]);
      expect(firstHealthRes.status).toBe(200);
      expect(secondHealthRes.status).toBe(200);
      expect(await firstHealthRes.json()).toEqual({ status: 'ok' });
      expect(await secondHealthRes.json()).toEqual({ status: 'ok' });

      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 500,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime for the first runtime route and serves that request', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-route-start-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockReturnValue(telemetryPromise);
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/session', (req, res) => {
        const timing = getDeferredRuntimeRequestTiming(req);
        res.status(201).json({
          sessionId: 'session-1',
          runtimePath: timing?.path,
          runtimeWaitMs: timing?.waitMs,
        });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    let sessionRequestCount = 0;
    let resolveSecondSessionRequest: (() => void) | undefined;
    const secondSessionRequest = new Promise<void>((resolve) => {
      resolveSecondSessionRequest = resolve;
    });
    const observeSessionRequest = (req: { method?: string; url?: string }) => {
      if (req.method !== 'POST' || req.url !== '/session') return;
      sessionRequestCount += 1;
      if (sessionRequestCount === 2) resolveSecondSessionRequest?.();
    };
    handle.server.on('request', observeSessionRequest);

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const firstResponse = fetch(`${handle.url}/session`, { method: 'POST' });
      await vi.waitFor(() =>
        expect(resolveTelemetrySettings).toHaveBeenCalledOnce(),
      );
      const joinedResponse = fetch(`${handle.url}/session`, {
        method: 'POST',
      });
      await secondSessionRequest;
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });

      const [first, joined] = await Promise.all([
        firstResponse,
        joinedResponse,
      ]);
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({
        sessionId: 'session-1',
        runtimePath: 'started_on_request',
        runtimeWaitMs: expect.any(Number),
      });
      expect(joined.status).toBe(201);
      expect(await joined.json()).toEqual({
        sessionId: 'session-1',
        runtimePath: 'joined',
        runtimeWaitMs: expect.any(Number),
      });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      handle.server.off('request', observeSessionRequest);
      await handle.close();
    }
  });

  it('rejects unauthenticated deferred runtime routes before starting runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-route-auth-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/session', (_req, res) => {
        res.status(201).json({ sessionId: 'session-1' });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/session`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(createBridge).not.toHaveBeenCalled();

      const authorizedRes = await fetch(`${handle.url}/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(authorizedRes.status).toBe(201);
      expect(await authorizedRes.json()).toEqual({ sessionId: 'session-1' });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime for webhook routes without bearer auth', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-webhook-start-')),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousWebhookSecret = process.env['QWEN_DEFERRED_WEBHOOK_SECRET'];
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qws-runtime-webhook-home-'),
    );
    process.env['QWEN_HOME'] = tempHome;
    process.env['QWEN_DEFERRED_WEBHOOK_SECRET'] = 'global-secret';
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.writeFileSync(
      path.join(tempHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'dingtalk-main': {
            type: 'dingtalk',
            webhooks: {
              sources: {
                'github ci': {
                  secretEnv: 'QWEN_DEFERRED_WEBHOOK_SECRET',
                  targets: {
                    default: {
                      chatId: 'group-1',
                      senderId: 'webhook:github ci',
                    },
                  },
                },
              },
            },
          },
        },
      }),
      'utf8',
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (_settings, _workspace, baseEnv) => ({
        effectiveEnv: Object.freeze({
          ...baseEnv,
          QWEN_DEFERRED_WEBHOOK_SECRET: 'workspace-secret',
        }),
        overlayKeys: Object.freeze(['QWEN_DEFERRED_WEBHOOK_SECRET']),
        envFilePaths: Object.freeze([]),
        envFileReadFailed: false,
        envFileReadFailures: Object.freeze([]),
      }),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
        channelSelection: {
          mode: 'names',
          names: ['dingtalk-main'],
        },
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        trustedWorkspace: true,
        channelWorkerSupervisorFactory: (options) => {
          const workerSnapshot: ChannelWorkerSnapshot = {
            enabled: true,
            state: 'running',
            pid: 1234,
            channels: ['dingtalk-main'],
          };
          return {
            start: vi.fn(async () => {
              options.onReady?.(workerSnapshot);
            }),
            stop: vi.fn(async () => {}),
            restart: vi.fn(async () => workerSnapshot),
            killAllSync: vi.fn(),
            snapshot: vi.fn(() => workerSnapshot),
            enqueueWebhookTask: vi.fn(async () => ({
              accepted: true as const,
            })),
          };
        },
        channelServicePidfile: {
          readServiceInfo: vi.fn(() => null),
          writeServeServiceInfo: vi.fn(),
          reserveServeServiceInfo: vi.fn(),
          removeServiceInfo: vi.fn(),
          removeServeServiceInfo: vi.fn(() => true),
        },
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      const res = await fetch(
        `${handle.url}/channels/dingtalk-main/webhooks/github%20ci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'workspace-secret',
          },
          body: JSON.stringify({
            eventType: 'ci_failed',
            targetRef: 'default',
            title: 'CI failed',
          }),
        },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (previousQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = previousQwenHome;
      }
      if (previousWebhookSecret === undefined) {
        delete process.env['QWEN_DEFERRED_WEBHOOK_SECRET'];
      } else {
        process.env['QWEN_DEFERRED_WEBHOOK_SECRET'] = previousWebhookSecret;
      }
      settingsRuntime.resetHomeEnvBootstrapForTesting();
    }
  });

  it('rejects bad-secret deferred webhook routes before starting runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-webhook-auth-')),
    );
    const logBaseDir = path.join(tmpDir, 'debug');
    const previousQwenHome = process.env['QWEN_HOME'];
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qws-runtime-webhook-home-'),
    );
    process.env['QWEN_HOME'] = tempHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    fs.writeFileSync(
      path.join(tempHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'dingtalk-main': {
            type: 'dingtalk',
            webhooks: {
              sources: {
                'github-ci': {
                  secret: 'webhook-secret',
                  targets: {
                    default: {
                      chatId: 'group-1',
                      senderId: 'webhook:github-ci',
                    },
                  },
                },
              },
            },
          },
        },
      }),
      'utf8',
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/channels/:channelName/webhooks/:source', (_req, res) => {
        res.status(202).json({ accepted: true });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        daemonLogBaseDir: logBaseDir,
      },
    );

    let closed = false;
    try {
      const res = await fetch(
        `${handle.url}/channels/dingtalk-main/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'wrong',
          },
          body: JSON.stringify({
            eventType: 'ci_failed',
            targetRef: 'default',
            title: 'CI failed',
          }),
        },
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid webhook secret' });
      expect(createBridge).not.toHaveBeenCalled();
      await handle.close();
      closed = true;

      const log = fs.readFileSync(
        path.join(logBaseDir, 'daemon', 'daemon.log'),
        'utf8',
      );
      expect(log).toContain('deferred webhook auth failed');
      expect(log).toContain('channelName=dingtalk-main');
      expect(log).toContain('source=github-ci');
      expect(log).toContain('reason="secret mismatch"');
    } finally {
      if (!closed) {
        await handle.close();
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (previousQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = previousQwenHome;
      }
      settingsRuntime.resetHomeEnvBootstrapForTesting();
    }
  });

  it('logs deferred webhook secret lookup failures before starting runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-webhook-log-')),
    );
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousSecret = process.env['QWEN_MISSING_WEBHOOK_SECRET'];
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qws-runtime-webhook-home-'),
    );
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    delete process.env['QWEN_MISSING_WEBHOOK_SECRET'];
    process.env['QWEN_HOME'] = tempHome;
    settingsRuntime.resetHomeEnvBootstrapForTesting();
    fs.writeFileSync(
      path.join(tempHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'dingtalk-main': {
            type: 'dingtalk',
            webhooks: {
              sources: {
                'github\nci': {
                  secretEnv: 'QWEN_MISSING_WEBHOOK_SECRET',
                  targets: {
                    default: {
                      chatId: 'group-1',
                      senderId: 'webhook:github-ci',
                    },
                  },
                },
              },
            },
          },
        },
      }),
      'utf8',
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const app = express();
      app.post('/channels/:channelName/webhooks/:source', (_req, res) => {
        res.status(202).json({ accepted: true });
      });
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(
        `${handle.url}/channels/dingtalk-main/webhooks/github%0Aci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'webhook-secret',
          },
          body: JSON.stringify({ eventType: 'ci_failed' }),
        },
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid webhook secret' });
      expect(createBridge).not.toHaveBeenCalled();
      expect(stderrWrites.join('')).toContain(
        '[webhook-secret] failed to read deferred webhook secret for dingtalk-main/github\\nci:',
      );
      expect(stderrWrites.join('')).not.toContain('github\nci');
      expect(stderrWrites.join('')).toContain(
        'webhooks.sources.github\\nci.secretEnv',
      );
    } finally {
      await handle.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
      if (previousSecret === undefined) {
        delete process.env['QWEN_MISSING_WEBHOOK_SECRET'];
      } else {
        process.env['QWEN_MISSING_WEBHOOK_SECRET'] = previousSecret;
      }
      if (previousQwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = previousQwenHome;
      }
      settingsRuntime.resetHomeEnvBootstrapForTesting();
    }
  });

  it('allows deferred runtime CORS preflight without auth or runtime startup', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-preflight-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        token: 'secret-token',
        allowOrigins: ['http://localhost:5173'],
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/session/foo/prompt`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:5173',
      );
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('does not start deferred runtime for unsupported bootstrap route methods', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bootstrap-method-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/health`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        code: 'daemon_runtime_starting',
      });
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('serves trailing-slash bootstrap health without waiting for deferred runtime', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-bootstrap-trailing-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await Promise.race([
        fetch(`${handle.url}/health/`),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Trailing-slash health timed out')),
            200,
          ),
        ),
      ]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(createBridge).not.toHaveBeenCalled();
    } finally {
      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await handle.close();
    }
  });

  it('reports deferred runtime startup failure for the triggering runtime route', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-route-fail-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => {
        throw new Error('runtime boom');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const res = await fetch(`${handle.url}/session`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'Daemon runtime failed to start',
        code: 'daemon_runtime_failed',
      });
      expect(createBridge).toHaveBeenCalledTimes(1);
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
    } finally {
      await handle.close();
    }
  });

  it('starts deferred runtime on fallback when no health probe arrives', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-fallback-')),
    );
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      expect(createBridge).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledTimes(1), {
        timeout: 1500,
      });
      await expect(handle.runtimeReady).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('does not start deferred runtime after close before first health', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-')),
    );
    const logBaseDir = path.join(tmpDir, 'debug');
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
        daemonLogBaseDir: logBaseDir,
      },
    );

    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(createBridge).not.toHaveBeenCalled();
    await expect(handle.runtimeReady).rejects.toThrow(
      RUNTIME_STARTUP_CANCELLED_MESSAGE,
    );
    const daemonDir = path.join(logBaseDir, 'daemon');
    const [logFile] = fs
      .readdirSync(daemonDir)
      .filter((fileName) => fileName.endsWith('.log'));
    expect(logFile).toBeDefined();
    const logContent = fs.readFileSync(path.join(daemonDir, logFile!), 'utf8');
    expect(logContent).toContain(
      'deferred runtime: cancelled, server closed before startup',
    );
  });

  it('does not start deferred runtime after close following first health', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-after-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    const healthRes = await fetch(`${handle.url}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });

    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(createBridge).not.toHaveBeenCalled();
    await expect(handle.runtimeReady).rejects.toThrow(
      RUNTIME_STARTUP_CANCELLED_MESSAGE,
    );
  });

  it('stops the deferred runtime extension reconciler during close', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-reconciler-close-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const stopExtensionGenerationReconciler = vi.fn();
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const runtimeApp = express();
      runtimeApp.locals['stopExtensionGenerationReconciler'] =
        stopExtensionGenerationReconciler;
      return runtimeApp;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(200);
      await handle.runtimeReady;
    } finally {
      await handle.close();
    }

    expect(stopExtensionGenerationReconciler).toHaveBeenCalledOnce();
    expect(
      stopExtensionGenerationReconciler.mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(bridge.shutdown).mock.invocationCallOrder[0]!);
  });

  it('does not cancel deferred runtime once startup is already running', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-running-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockReturnValue(telemetryPromise);
    const bridge = makeRuntimeBridge();
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValue(
        bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    const healthRes = await fetch(`${handle.url}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });
    await vi.waitFor(
      () => expect(resolveTelemetrySettings).toHaveBeenCalledTimes(1),
      { timeout: 500 },
    );

    const closePromise = handle.close();
    resolveTelemetry?.({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    await closePromise;

    expect(createBridge).toHaveBeenCalledTimes(1);
    await expect(handle.runtimeReady).rejects.toThrow(
      'Daemon runtime stopped before mounting.',
    );
  });

  it('disposes a deferred runtime app that finishes after the shutdown wait', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-close-late-app-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    const resolveTelemetrySettings = vi
      .spyOn(qwenCore, 'resolveTelemetrySettings')
      .mockReturnValue(telemetryPromise);
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const stopExtensionGenerationReconciler = vi.fn();
    const stopScheduledTaskKeepalive = vi.fn(() => {
      throw new Error('keepalive dispose failed');
    });
    const stopWorkspaceGitState = vi.fn();
    const stopSubSession = vi.fn();
    const disposeEventLoopMonitor = vi.fn();
    vi.spyOn(qwenCore, 'startEventLoopLagMonitor').mockReturnValueOnce({
      snapshot: () => ({
        meanMs: 0,
        p50Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      }),
      dispose: disposeEventLoopMonitor,
    });
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      const runtimeApp = express();
      runtimeApp.locals['stopExtensionGenerationReconciler'] =
        stopExtensionGenerationReconciler;
      runtimeApp.locals['stopScheduledTaskKeepalive'] =
        stopScheduledTaskKeepalive;
      runtimeApp.locals['stopWorkspaceGitState'] = stopWorkspaceGitState;
      let subSessionStoppers: Array<() => void> = [];
      Object.defineProperty(runtimeApp.locals, 'subSessionStoppers', {
        configurable: true,
        get: () => subSessionStoppers,
        set: (stoppers: Array<() => void>) => {
          stoppers.push(stopSubSession);
          subSessionStoppers = stoppers;
        },
      });
      return runtimeApp;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    const healthRes = await fetch(`${handle.url}/health`);
    expect(healthRes.status).toBe(200);
    await vi.waitFor(
      () => expect(resolveTelemetrySettings).toHaveBeenCalledTimes(1),
      { timeout: 500 },
    );

    const nativeSetTimeout = globalThis.setTimeout;
    let acceleratedRuntimeWait = false;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (!acceleratedRuntimeWait && delay === 5_000) {
          acceleratedRuntimeWait = true;
          return nativeSetTimeout(callback, 0, ...args);
        }
        return nativeSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
    try {
      await handle.close();
    } finally {
      setTimeoutSpy.mockRestore();
    }
    expect(stopExtensionGenerationReconciler).not.toHaveBeenCalled();

    resolveTelemetry?.({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });

    await vi.waitFor(
      () => expect(stopExtensionGenerationReconciler).toHaveBeenCalledOnce(),
      { timeout: 1_000 },
    );
    expect(stopScheduledTaskKeepalive).toHaveBeenCalledOnce();
    expect(stopWorkspaceGitState).toHaveBeenCalledOnce();
    expect(stopSubSession).toHaveBeenCalledOnce();
    expect(disposeEventLoopMonitor).toHaveBeenCalledOnce();
    expect(bridge.shutdown).toHaveBeenCalledOnce();
    await expect(handle.runtimeReady).rejects.toThrow(
      'Daemon runtime stopped before mounting.',
    );
  });

  it('does not retry deferred runtime after startup failure and later health probe', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-health-fail-once-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => {
        throw new Error('runtime boom');
      });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        resolveOnListen: true,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const firstHealthRes = await fetch(`${handle.url}/health`);
      expect(firstHealthRes.status).toBe(200);
      expect(await firstHealthRes.json()).toEqual({ status: 'ok' });
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      expect(createBridge).toHaveBeenCalledTimes(1);

      const secondHealthRes = await fetch(`${handle.url}/health`);
      expect(secondHealthRes.status).toBe(503);
      expect(await secondHealthRes.json()).toMatchObject({
        status: 'degraded',
        error: 'runtime boom',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(createBridge).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('flushes runtime startup failures to the daemon log when closing', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-log-')),
    );
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      await handle.close();
      const daemonDir = path.join(tmpDir, 'debug', 'daemon');
      const logFile = fs
        .readdirSync(daemonDir)
        .find((file) => file.endsWith('.log'));
      expect(logFile).toBeDefined();
      const logContent = fs.readFileSync(
        path.join(daemonDir, logFile!),
        'utf8',
      );
      expect(logContent).toContain('runtime startup failed');
      expect(logContent).toContain('runtime boom');
    } finally {
      if (handle.server.listening) {
        await handle.close();
      }
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('does not block shutdown on pending metrics flush', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-flush-pending-')),
    );
    const forceFlushMetrics = vi.spyOn(qwenCore, 'forceFlushMetrics');
    forceFlushMetrics.mockReturnValue(new Promise<void>(() => {}));
    const bridge = {
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
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    await expect(handle.runtimeReady).resolves.toBeUndefined();
    let timeout: NodeJS.Timeout | undefined;
    const closeResult = await Promise.race([
      handle.close().then(() => 'closed'),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), 1_000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(closeResult).toBe('closed');
    expect(forceFlushMetrics).toHaveBeenCalledTimes(1);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('accumulates prompt queue wait stats in daemon status perf data', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-queue-wait-')),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    const telemetry: ReturnType<typeof qwenCore.createDaemonBridgeTelemetry> = {
      captureContext() {
        return undefined;
      },
      runWithContext(_captured, fn) {
        return fn();
      },
      withSpan(_operation, _attributes, fn) {
        return fn();
      },
      event: vi.fn(),
      injectPromptContext(request) {
        return request;
      },
    };
    vi.spyOn(qwenCore, 'createDaemonBridgeTelemetry').mockReturnValue(
      telemetry,
    );
    const recordPromptQueueWait = vi.spyOn(
      qwenCore,
      'recordDaemonPromptQueueWait',
    );
    const bridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await handle.runtimeReady;
      telemetry.metrics?.promptQueueWait(10);
      telemetry.metrics?.promptQueueWait(30);
      telemetry.metrics?.promptQueueWait(5);

      const res = await fetch(`${handle.url}/daemon/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runtime?: {
          perf?: {
            promptQueueWait?: {
              count: number;
              meanMs: number;
              maxMs: number;
              lastMs: number | null;
            };
          };
        };
      };
      expect(body.runtime?.perf?.promptQueueWait).toEqual({
        count: 3,
        meanMs: 15,
        maxMs: 30,
        lastMs: 5,
      });
      expect(recordPromptQueueWait).toHaveBeenNthCalledWith(1, 10);
      expect(recordPromptQueueWait).toHaveBeenNthCalledWith(2, 30);
      expect(recordPromptQueueWait).toHaveBeenNthCalledWith(3, 5);
    } finally {
      await handle.close();
    }
  });

  it('fails runtimeReady and health when runtime startup times out', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-timeout-')),
    );
    let resolveTelemetry:
      | ((settings: qwenCore.ResolvedTelemetrySettings) => void)
      | undefined;
    const telemetryPromise = new Promise<qwenCore.ResolvedTelemetrySettings>(
      (resolve) => {
        resolveTelemetry = resolve;
      },
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockReturnValue(
      telemetryPromise,
    );
    const bridge = {
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
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true, runtimeStartupTimeoutMs: 1 },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow(
        'Daemon runtime startup timed out after 1ms.',
      );
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(503);
      expect(await healthRes.json()).toMatchObject({
        status: 'degraded',
        error: 'Daemon runtime startup timed out after 1ms.',
      });
      expect(() => handle.bridge.getDaemonStatusSnapshot()).toThrow(
        'Daemon bridge runtime is not available: Daemon runtime startup timed out after 1ms.',
      );

      resolveTelemetry?.({
        enabled: false,
        sensitiveSpanAttributeMaxLength: 1024 * 1024,
      });
      await vi.waitFor(() => {
        expect(bridge.shutdown).toHaveBeenCalledTimes(1);
      });
    } finally {
      await handle.close();
    }
  });

  it('reports bootstrap status and capabilities when fast path resolves on listen', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    const originalClientMcpOverWs =
      process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    const originalCdpTunnelOverWs =
      process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
    delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
    const boundWorkspace = canonicalizeWorkspace(tmpDir);
    const blockedLogBaseDir = path.join(tmpDir, 'blocked-log-base');
    fs.writeFileSync(blockedLogBaseDir, 'not a directory');
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() => {
      throw new Error('runtime boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true, daemonLogBaseDir: blockedLogBaseDir },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime boom');
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(503);
      expect(await healthRes.json()).toMatchObject({
        status: 'degraded',
        error: 'runtime boom',
      });
      const unknownRes = await fetch(`${handle.url}/unknown-route`);
      expect(unknownRes.status).toBe(503);
      expect(await unknownRes.json()).toMatchObject({
        error: 'Daemon runtime failed to start',
        code: 'daemon_runtime_failed',
      });

      const capabilitiesRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: handle.url },
      });
      expect(capabilitiesRes.status).toBe(200);
      const capabilitiesBody = await capabilitiesRes.json();
      expect(capabilitiesBody).toMatchObject({
        v: 1,
        protocolVersions: { current: 'v1', supported: ['v1'] },
        mode: 'http-bridge',
        features: expect.arrayContaining([
          'capabilities',
          'daemon_status',
          'workspace_settings',
          'workspace_reload',
          'workspace_acp_preheat',
          'workspace_acp_status',
          'persistent_workspace_registration',
          'workspace_runtime_removal',
        ]),
        modelServices: [],
        workspaceCwd: boundWorkspace,
        transports: ['rest'],
        policy: { permission: 'first-responder' },
        limits: { maxPendingPromptsPerSession: 5 },
      });
      expect(capabilitiesBody.features).not.toContain('client_mcp_over_ws');
      expect(capabilitiesBody.features).not.toContain('cdp_tunnel_over_ws');

      const port = new URL(handle.url).port;
      for (const origin of [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://[::1]:${port}`,
        `http://host.docker.internal:${port}`,
      ]) {
        const sameOriginRes = await fetch(`${handle.url}/capabilities`, {
          headers: { Origin: origin },
        });
        expect(sameOriginRes.status).toBe(200);
      }

      const crossOriginRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: 'http://example.com' },
      });
      expect(crossOriginRes.status).toBe(403);

      const res = await fetch(`${handle.url}/daemon/status`);
      const body = (await res.json()) as {
        status?: string;
        issues?: Array<{ code?: string; severity?: string }>;
        daemon?: {
          runId?: string;
          logMode?: string;
          logHealth?: string;
        };
        runtime?: { loading?: boolean; error?: string };
      };
      expect(body).toMatchObject({
        status: 'error',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'daemon_runtime_failed',
            severity: 'error',
          }),
          expect.objectContaining({
            code: 'daemon_log_degraded',
            severity: 'warning',
          }),
        ]),
        daemon: {
          runId: expect.stringMatching(/^[0-9a-f]{32}$/),
          logMode: 'stderr-only',
          logHealth: 'degraded',
        },
        runtime: { loading: false, error: 'runtime boom' },
      });

      const sameOriginRes = await fetch(
        `${handle.url}/daemon/status?detail=full`,
        {
          headers: { Origin: handle.url },
        },
      );
      expect(sameOriginRes.status).toBe(200);
      const sameOriginBody = await sameOriginRes.json();
      expect(sameOriginBody).toMatchObject({
        v: 1,
        detail: 'full',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'daemon_log_degraded',
            severity: 'warning',
          }),
        ]),
        daemon: {
          runId: body.daemon?.runId,
          logMode: 'stderr-only',
          logHealth: 'degraded',
          logIssues: ['init_failed'],
          logDroppedRecords: 0,
          logDroppedBytes: 0,
        },
        security: { allowOriginMode: 'none' },
        limits: {
          maxSessions: 1,
          maxPendingPromptsPerSession: 5,
          listenerMaxConnections: 256,
          eventRingSize: 8000,
          compactedReplayMaxBytes: 4 * 1024 * 1024,
          promptDeadlineMs: null,
          writerIdleTimeoutMs: null,
          channelIdleTimeoutMs: 0,
          sessionIdleTimeoutMs: 1_800_000,
          acpConnectionCap: null,
        },
        capabilities: {
          protocolVersions: { current: 'v1', supported: ['v1'] },
          features: expect.arrayContaining(['daemon_status']),
        },
        runtime: {
          loading: false,
          error: 'runtime boom',
          sessions: { active: 0 },
          permissions: { pending: 0, policy: 'first-responder' },
          channel: { live: false },
          transport: {
            restSseActive: 0,
            acp: { enabled: false },
          },
          rateLimit: {
            enabled: false,
            rejectedSinceStart: { prompt: 0, mutation: 0, read: 0 },
          },
        },
        full: {
          sessions: [],
          acpConnections: [],
          workspace: {},
          auth: {
            supportedDeviceFlowProviders: [],
            pendingDeviceFlowCount: 0,
          },
        },
      });
      expect(sameOriginBody.daemon).not.toHaveProperty('logPath');
    } finally {
      if (originalClientMcpOverWs === undefined) {
        delete process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CLIENT_MCP_OVER_WS'] = originalClientMcpOverWs;
      }
      if (originalCdpTunnelOverWs === undefined) {
        delete process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'];
      } else {
        process.env['QWEN_SERVE_CDP_TUNNEL_OVER_WS'] = originalCdpTunnelOverWs;
      }
      await handle.close();
    }
  });

  it('shuts down a bridge when runtime mounting fails after bridge creation', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-partial-fail-')),
    );
    const bridge = {
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
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      throw new Error('runtime app boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime app boom');
      expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shuts down all workspace bridges when multi-workspace runtime mounting fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-partial-fail-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const primaryBridge = makeRuntimeBridge();
    const secondaryBridge = makeRuntimeBridge();
    vi.spyOn(acpBridge, 'createAcpSessionBridge')
      .mockReturnValueOnce(
        primaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      )
      .mockReturnValueOnce(
        secondaryBridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
      );
    vi.spyOn(serverModule, 'createServeApp').mockImplementation(() => {
      throw new Error('runtime app boom');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('runtime app boom');
      expect(primaryBridge.shutdown).toHaveBeenCalledTimes(1);
      expect(secondaryBridge.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
    expect(primaryBridge.shutdown).toHaveBeenCalledTimes(1);
    expect(secondaryBridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('cleans up runtime locals when closed immediately after listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-close-')),
    );
    const bridge = {
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
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const dispose = vi.fn();
    const attachServer = vi.fn();
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      app.locals['acpHandle'] = {
        attachServer,
        dispose,
        getSnapshot: () => ({
          connectionCount: 0,
          connectionStreams: 0,
          sessionStreams: 0,
          sseStreams: 0,
          wsStreams: 0,
          pendingClientRequests: 0,
          mounts: [],
          connections: [],
        }),
        registry: { getSnapshot: () => undefined },
      };
      return app;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    await handle.close();

    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the daemon event loop monitor when closed after listening', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-monitor-close-')),
    );
    const bridge = {
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
    } as unknown as HttpAcpBridge;
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    const dispose = vi.fn();
    vi.spyOn(qwenCore, 'startEventLoopLagMonitor').mockReturnValueOnce({
      snapshot: () => ({
        meanMs: 0,
        p50Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      }),
      dispose,
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { resolveOnListen: true },
    );

    await handle.close();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('runQwenServe Web Shell signals on RunHandle', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
    } as unknown as HttpAcpBridge;
  }

  async function bootHandle(extra: {
    serveWebShell?: boolean;
    token?: string;
    experimentalLsp?: boolean;
  }) {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qws-ws-')));
    return runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        ...extra,
      },
      { bridge: makeFakeBridge() },
    );
  }

  it('reports webShellMounted=false when serveWebShell is false (--no-web)', async () => {
    const handle = await bootHandle({ serveWebShell: false });
    try {
      expect(handle.webShellMounted).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('exposes the trimmed bearer token as resolvedToken', async () => {
    const handle = await bootHandle({ token: '  secret-token  ' });
    try {
      expect(handle.resolvedToken).toBe('secret-token');
    } finally {
      await handle.close();
    }
  });

  it('leaves resolvedToken undefined when no token is configured', async () => {
    const handle = await bootHandle({});
    try {
      expect(handle.resolvedToken).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('passes --experimental-lsp to spawned ACP children only when opted in', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;

    const defaultHandle = await bootHandle({ serveWebShell: false });
    await defaultHandle.close();
    expect(mockCreateSpawnChannelFactoryOptions.at(-1)).not.toHaveProperty(
      'extraArgs',
    );

    const lspHandle = await bootHandle({
      serveWebShell: false,
      experimentalLsp: true,
    });
    await lspHandle.close();
    expect(mockCreateSpawnChannelFactoryOptions.at(-1)).toMatchObject({
      extraArgs: ['--experimental-lsp'],
    });
  });

  it('wires the pipe message observer without changing existing pipe stats', async () => {
    mockCreateSpawnChannelFactoryOptions.length = 0;

    const handle = await bootHandle({ serveWebShell: false });
    try {
      await handle.runtimeReady;
      const pipeHooks = mockCreateSpawnChannelFactoryOptions.at(-1)?.[
        'pipeHooks'
      ] as
        | {
            onMessageSent?: (bytes: number) => void;
            onMessageReceived?: (bytes: number) => void;
            onMessageObserved?: (observation: {
              direction: 'sent' | 'received';
              bytes: number;
              message: unknown;
            }) => void;
          }
        | undefined;

      expect(pipeHooks?.onMessageObserved).toEqual(expect.any(Function));
      pipeHooks?.onMessageSent?.(123);
      pipeHooks?.onMessageReceived?.(456);
      pipeHooks?.onMessageObserved?.({
        direction: 'sent',
        bytes: LARGE_PIPE_FRAME_THRESHOLD_BYTES,
        message: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk' } },
        },
      });

      const res = await fetch(`${handle.url}/daemon/status`);
      const body = (await res.json()) as {
        runtime?: {
          perf?: {
            pipe?: {
              inbound?: { count?: number; totalBytes?: number };
              outbound?: { count?: number; totalBytes?: number };
            };
          };
        };
      };

      expect(body.runtime?.perf?.pipe).toMatchObject({
        inbound: { count: 1, totalBytes: 456 },
        outbound: { count: 1, totalBytes: 123 },
      });
    } finally {
      await handle.close();
    }
  });
});

describe('runQwenServe channel worker supervisor', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeFakeBridge(onShutdown?: () => void): HttpAcpBridge {
    return {
      spawnOrAttach: vi.fn(),
      shutdown: vi.fn().mockImplementation(async () => {
        onShutdown?.();
      }),
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
    };
  }

  function makeReadyWorkerFactory(worker: ReturnType<typeof makeWorker>) {
    return vi.fn((opts: CreateChannelWorkerSupervisorOptions) => {
      worker.start.mockImplementation(async () => {
        opts.onReady?.(worker.snapshot());
      });
      return worker;
    });
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

  it('rejects webhook tasks when the channel worker is disabled', async () => {
    const supervisor = createDisabledChannelWorkerSupervisor();

    await expect(
      supervisor.enqueueWebhookTask({
        channelName: 'telegram',
        source: 'github-ci',
        eventType: 'check_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: { runId: 123 },
      }),
    ).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Channel worker is not running.',
    } satisfies Partial<ChannelWebhookEnqueueError>);
  });

  it('forwards webhook tasks through the channel worker group', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-webhook-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    worker.enqueueWebhookTask.mockResolvedValueOnce({ accepted: true });
    const originalCreateServeApp = serverModule.createServeApp;
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );
    const task = {
      channelName: 'telegram',
      source: 'github-ci',
      eventType: 'check_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: { runId: 123 },
    };

    try {
      await handle.runtimeReady;
      expect(capturedDeps?.enqueueChannelWebhookTask).toEqual(
        expect.any(Function),
      );
      await expect(
        capturedDeps!.enqueueChannelWebhookTask!(task),
      ).resolves.toEqual({ accepted: true });
      expect(worker.enqueueWebhookTask).toHaveBeenCalledWith(task);
    } finally {
      await handle.close();
    }
  });

  it('keeps webhook enqueue available when no worker is selected', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-webhook-disabled-')),
    );
    const originalCreateServeApp = serverModule.createServeApp;
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
      },
      { bridge: makeFakeBridge() },
    );

    try {
      await handle.runtimeReady;
      expect(capturedDeps?.enqueueChannelWebhookTask).toEqual(
        expect.any(Function),
      );
      await expect(
        capturedDeps!.enqueueChannelWebhookTask!({
          channelName: 'telegram',
          source: 'github-ci',
          eventType: 'check_failed',
          targetRef: 'default',
          title: 'CI failed',
          payload: { runId: 123 },
        }),
      ).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
    } finally {
      await handle.close();
    }
  });

  it('enables, queries, idempotently reapplies, and stops channels after boot', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-control-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const workerFactory = makeReadyWorkerFactory(worker);
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );
    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    };

    try {
      expect(workerFactory).not.toHaveBeenCalled();
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();

      const beforeCaps = await fetch(`${handle.url}/capabilities`, { headers });
      expect(await beforeCaps.json()).toMatchObject({
        features: expect.arrayContaining(['channel_control']),
      });

      const enable = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(enable.status).toBe(201);
      expect(await enable.json()).toMatchObject({
        changed: true,
        replaced: false,
        state: {
          enabled: true,
          selection: { mode: 'names', names: ['telegram'] },
          transition: 'idle',
        },
      });
      expect(workerFactory).toHaveBeenCalledTimes(1);
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
      });

      const afterCaps = await fetch(`${handle.url}/capabilities`, { headers });
      expect(await afterCaps.json()).toMatchObject({
        features: expect.arrayContaining(['channel_control', 'channel_reload']),
      });

      worker.start.mockClear();
      const same = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(same.status).toBe(200);
      expect(await same.json()).toMatchObject({ changed: false });
      expect(worker.start).not.toHaveBeenCalled();
      expect(workerFactory).toHaveBeenCalledTimes(1);

      const stop = await fetch(`${handle.url}/workspace/channel`, {
        method: 'DELETE',
        headers,
      });
      expect(stop.status).toBe(200);
      expect(await stop.json()).toMatchObject({
        changed: true,
        state: { enabled: false, selection: null, workers: [] },
      });
      expect(worker.stop).toHaveBeenCalledTimes(1);
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);

      const stoppedCaps = await fetch(`${handle.url}/capabilities`, {
        headers,
      });
      const stoppedFeatures = (await stoppedCaps.json()) as {
        features: string[];
      };
      expect(stoppedFeatures.features).toContain('channel_control');
      expect(stoppedFeatures.features).not.toContain('channel_reload');
    } finally {
      await handle.close();
    }
  });

  it('single-flights concurrent first PUTs through one manager and worker', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-race-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const workerFactory = makeReadyWorkerFactory(worker);
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );
    const requestOptions = {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selection: { mode: 'names', names: ['telegram'] },
      }),
    };

    try {
      const responses = await Promise.all([
        fetch(`${handle.url}/workspace/channel`, requestOptions),
        fetch(`${handle.url}/workspace/channel`, requestOptions),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 201,
      ]);
      expect(workerFactory).toHaveBeenCalledTimes(1);
      expect(worker.start).toHaveBeenCalledTimes(1);
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('orders DELETE behind a first PUT that is still creating the manager', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-fifo-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      const setting = capturedDeps!.setChannelWorkerSelection!({
        mode: 'names',
        names: ['telegram'],
      });
      const stopping = capturedDeps!.stopChannelWorker!();

      await expect(setting).resolves.toMatchObject({ changed: true });
      await expect(stopping).resolves.toMatchObject({
        changed: true,
        state: { enabled: false },
      });
      expect(worker.start).toHaveBeenCalledTimes(1);
      expect(worker.stop).toHaveBeenCalledTimes(1);
      expect(capturedDeps!.getChannelWorkerControl!()).toMatchObject({
        enabled: false,
        selection: null,
        workers: [],
      });
    } finally {
      await handle.close();
    }
  });

  it('rejects channel mutations once shutdown starts before manager creation', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-drain-')),
    );
    let capturedDeps:
      | Parameters<typeof serverModule.createServeApp>[2]
      | undefined;
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      capturedDeps = args[2];
      return originalCreateServeApp(...args);
    });
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: makePidfileDeps(),
      },
    );

    const closing = handle.close();
    await expect(
      capturedDeps!.setChannelWorkerSelection!({ mode: 'all' }),
    ).rejects.toMatchObject({ code: 'daemon_draining' });
    await expect(capturedDeps!.stopChannelWorker!()).rejects.toMatchObject({
      code: 'daemon_draining',
    });
    await expect(capturedDeps!.reloadChannelWorker!()).rejects.toMatchObject({
      code: 'daemon_draining',
    });
    await closing;
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('rejects an unknown runtime selection before reserving or starting', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-unknown-')),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['missing'],
      }),
    );
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selection: { mode: 'names', names: ['missing'] },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'channel_workspace_mismatch',
      });
      expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('reports a standalone service conflict on the first runtime PUT', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-conflict-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 9988,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'channel_service_conflict',
        owner: 'channel',
        pid: 9988,
      });
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('reports a typed conflict when a concurrent runtime lease stays busy', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-runtime-race-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );
    const pidfile = makePidfileDeps();
    const eexist = new Error('EEXIST') as NodeJS.ErrnoException;
    eexist.code = 'EEXIST';
    pidfile.reserveServeServiceInfo.mockImplementation(() => {
      throw eexist;
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      const response = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selection: { mode: 'names', names: ['telegram'] },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'channel_service_conflict',
      });
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledTimes(2);
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('closes the listener when worker startup fails after resolveOnListen', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fail-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      channels: ['telegram'],
      error: 'worker boom',
    });
    const startupOrder: string[] = [];
    worker.start.mockImplementationOnce(async () => {
      startupOrder.push('worker');
      throw new Error('worker boom');
    });
    const attachServer = vi.fn(() => startupOrder.push('runtime'));
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      const acpHandle = app.locals['acpHandle'] as
        | { attachServer?: (server: unknown) => void }
        | undefined;
      if (acpHandle) acpHandle.attachServer = attachServer;
      return app;
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: makePidfileDeps(),
        resolveOnListen: true,
      },
    );

    try {
      await expect(handle.runtimeReady).rejects.toThrow('worker boom');
      expect(handle.server.listening).toBe(false);
      expect(attachServer).toHaveBeenCalledTimes(1);
      expect(startupOrder).toEqual(['runtime', 'worker']);
    } finally {
      await handle.close();
    }
  });

  it('reloads through a forced settings reconcile', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-reload-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { telegram: { type: 'telegram' } } }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        token: 'secret',
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      worker.start.mockClear();
      worker.stop.mockClear();
      const response = await fetch(`${handle.url}/workspace/channel/reload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(response.status).toBe(200);
      expect(worker.restart).not.toHaveBeenCalled();
      expect(worker.start).toHaveBeenCalledTimes(1);
      expect(worker.stop).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it('rejects ambiguous multi-workspace channel ownership before exposing a handle', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-plan-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockReturnValue({
      merged: { channels: { telegram: { type: 'telegram' } } },
    } as unknown as ReturnType<typeof settingsRuntime.loadSettings>);
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeFakeBridge(),
    );
    const supervisorFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        channels: ['telegram'],
      }),
    );

    const outcome = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: [primary, secondary],
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        resolveOnListen: true,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        channelWorkerSupervisorFactory: supervisorFactory,
        channelServicePidfile: makePidfileDeps(),
      },
    ).then(
      (handle) => ({ handle }),
      (error: unknown) => ({ error }),
    );

    if ('handle' in outcome) {
      await outcome.handle.runtimeReady.catch(() => {});
      await outcome.handle.close();
    }
    expect(outcome).toMatchObject({
      error: {
        code: 'ambiguous_channel_workspace',
      },
    });
    expect(supervisorFactory).not.toHaveBeenCalled();
  });

  it('records a secondary-only worker added to a primary-only daemon', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-dynamic-worker-pidfile-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const primaryCwd = canonicalizeWorkspace(primary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) =>
        ({
          merged: {
            channels:
              canonicalizeWorkspace(String(workspace)) === secondaryCwd
                ? { feishu: { type: 'feishu' } }
                : { telegram: { type: 'telegram' } },
          },
        }) as unknown as ReturnType<typeof settingsRuntime.loadSettings>,
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockImplementation(() =>
      makeFakeBridge(),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 5678,
      channels: ['feishu'],
    });
    const workerFactory = makeReadyWorkerFactory(worker);
    const pidfile = makePidfileDeps();
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: primaryCwd,
        workspaces: [],
      }),
      add: vi.fn().mockResolvedValue(true),
    } as unknown as WorkspaceRegistrationStore;
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'dynamic-worker-token',
        serveWebShell: false,
      },
      {
        preheatBridge: false,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        channelWorkerSupervisorFactory: workerFactory,
        channelServicePidfile: pidfile,
        workspaceRegistrationStore: store,
      },
    );
    const headers = {
      Authorization: 'Bearer dynamic-worker-token',
      'Content-Type': 'application/json',
    };

    try {
      await handle.runtimeReady;
      const added = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: secondary }),
      });
      expect(added.status).toBe(201);

      const enabled = await fetch(`${handle.url}/workspace/channel`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          selection: { mode: 'names', names: ['feishu'] },
        }),
      });
      expect(enabled.status).toBe(201);
      expect(workerFactory).toHaveBeenCalledOnce();
      expect(workerFactory).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: secondaryCwd }),
      );
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith({
        channels: ['feishu'],
        servePid: process.pid,
        workers: [
          expect.objectContaining({
            workspaceCwd: secondaryCwd,
            channels: ['feishu'],
            workerPid: 5678,
          }),
        ],
      });
    } finally {
      await handle.close();
    }
  });

  it('orchestrates, persists, and hot-removes distinct workspace workers', async () => {
    const previousSharedSecret = process.env['QWEN_SHARED_WEBHOOK_SECRET'];
    process.env['QWEN_SHARED_WEBHOOK_SECRET'] = 'primary-secret';
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-groups-')),
    );
    const primary = path.join(tmpDir, 'primary');
    const secondary = path.join(tmpDir, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);
    const primaryCwd = canonicalizeWorkspace(primary);
    const secondaryCwd = canonicalizeWorkspace(secondary);
    const secondaryChannelConfig = {
      type: 'feishu',
      webhooks: {
        sources: {
          'github-ci': {
            secretEnv: 'QWEN_SHARED_WEBHOOK_SECRET',
            targets: {
              default: {
                chatId: 'group-1',
                senderId: 'webhook:github-ci',
              },
            },
          },
        },
      },
    };
    fs.mkdirSync(path.join(secondary, '.qwen'));
    fs.writeFileSync(
      path.join(secondary, '.qwen', 'settings.json'),
      JSON.stringify({ channels: { feishu: secondaryChannelConfig } }),
    );
    vi.spyOn(qwenCore, 'resolveTelemetrySettings').mockResolvedValue({
      enabled: false,
      sensitiveSpanAttributeMaxLength: 1024 * 1024,
    });
    vi.spyOn(settingsRuntime, 'loadSettings').mockImplementation(
      (workspace) => {
        const workspaceCwd =
          typeof workspace === 'string' ? canonicalizeWorkspace(workspace) : '';
        return {
          merged: {
            channels:
              workspaceCwd === secondaryCwd
                ? { feishu: secondaryChannelConfig }
                : { telegram: { type: 'telegram' } },
          },
        } as unknown as ReturnType<typeof settingsRuntime.loadSettings>;
      },
    );
    vi.spyOn(environmentRuntime, 'buildRuntimeEnvironment').mockImplementation(
      (_settings, workspace, baseEnv) => ({
        effectiveEnv: Object.freeze({
          ...baseEnv,
          QWEN_SHARED_WEBHOOK_SECRET:
            canonicalizeWorkspace(workspace ?? process.cwd()) === secondaryCwd
              ? 'secondary-secret'
              : 'primary-secret',
        }),
        overlayKeys: Object.freeze(['QWEN_SHARED_WEBHOOK_SECRET']),
        envFilePaths: Object.freeze([]),
        envFileReadFailed: false,
        envFileReadFailures: Object.freeze([]),
      }),
    );
    vi.spyOn(trustedFoldersRuntime, 'getWorkspaceTrustStatus').mockReturnValue({
      effective: { state: 'trusted' },
    } as ReturnType<typeof trustedFoldersRuntime.getWorkspaceTrustStatus>);
    const createBridge = vi
      .spyOn(acpBridge, 'createAcpSessionBridge')
      .mockImplementation(() => makeFakeBridge());

    const snapshots = new Map<string, ChannelWorkerSnapshot>();
    const workerOptions = new Map<
      string,
      CreateChannelWorkerSupervisorOptions
    >();
    const workerSupervisors = new Map<string, ReturnType<typeof makeWorker>>();
    const webhookEnqueues = new Map<string, ReturnType<typeof vi.fn>>();
    const supervisorFactory = vi.fn(
      (options: CreateChannelWorkerSupervisorOptions) => {
        const pid = options.workspace === primaryCwd ? 1234 : 5678;
        const channels =
          options.selection.mode === 'names' ? options.selection.names : [];
        snapshots.set(options.workspace, {
          enabled: true,
          state: 'running',
          pid,
          channels: [...channels],
        });
        workerOptions.set(options.workspace, options);
        const enqueueWebhookTask = vi.fn(async () => ({
          accepted: true as const,
        }));
        webhookEnqueues.set(options.workspace, enqueueWebhookTask);
        const supervisor = {
          start: vi.fn(async () => {
            const capabilitiesResponse = await fetch(
              `${options.daemonUrl}/capabilities`,
              {
                headers: { Authorization: 'Bearer worker-remove-token' },
              },
            );
            expect(capabilitiesResponse.status).toBe(200);
            expect(await capabilitiesResponse.json()).toMatchObject({
              workspaces: expect.arrayContaining([
                expect.objectContaining({
                  cwd: primaryCwd,
                  trusted: true,
                }),
                expect.objectContaining({
                  cwd: secondaryCwd,
                  trusted: true,
                }),
              ]),
            });
            options.onReady?.(snapshots.get(options.workspace)!);
          }),
          stop: vi.fn().mockResolvedValue(undefined),
          restart: vi.fn(async () => snapshots.get(options.workspace)!),
          killAllSync: vi.fn(),
          snapshot: vi.fn(() => snapshots.get(options.workspace)!),
          enqueueWebhookTask,
        };
        workerSupervisors.set(
          options.workspace,
          supervisor as ReturnType<typeof makeWorker>,
        );
        return supervisor;
      },
    );
    const pidfile = makePidfileDeps();
    const removeByIds = vi.fn().mockResolvedValue(1);
    const workspaceRegistrationStore = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: primaryCwd,
        workspaces: [secondaryCwd],
      }),
      removeByIds,
    } as unknown as WorkspaceRegistrationStore;

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: primary,
        token: 'worker-remove-token',
        serveWebShell: false,
        channelSelection: {
          mode: 'names',
          names: ['telegram', 'feishu'],
        },
      },
      {
        resolveOnListen: true,
        bootSettings: {},
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
        channelWorkerSupervisorFactory: supervisorFactory,
        channelServicePidfile: pidfile,
        workspaceRegistrationStore,
        deferRuntimeUntilFirstHealth: true,
        runtimeStartupTimeoutMs: 0,
      },
    );

    try {
      const crossWorkspaceSecretResponse = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'primary-secret',
          },
          body: JSON.stringify({ eventType: 'check_failed' }),
        },
      );
      expect(crossWorkspaceSecretResponse.status).toBe(401);

      const webhookResponse = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer worker-remove-token',
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'secondary-secret',
          },
          body: JSON.stringify({
            eventType: 'check_failed',
            targetRef: 'default',
            title: 'CI failed',
          }),
        },
      );
      expect(webhookResponse.status).toBe(202);
      expect(await webhookResponse.json()).toEqual({ accepted: true });
      await handle.runtimeReady;
      expect(supervisorFactory).toHaveBeenCalledTimes(2);
      expect(workerOptions.get(primaryCwd)).toMatchObject({
        workspace: primaryCwd,
        selection: { mode: 'names', names: ['telegram'] },
      });
      expect(workerOptions.get(secondaryCwd)).toMatchObject({
        workspace: secondaryCwd,
        selection: { mode: 'names', names: ['feishu'] },
      });
      expect(webhookEnqueues.get(primaryCwd)).not.toHaveBeenCalled();
      expect(webhookEnqueues.get(secondaryCwd)).toHaveBeenCalledWith({
        channelName: 'feishu',
        source: 'github-ci',
        eventType: 'check_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: {},
      });
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith({
        channels: ['telegram', 'feishu'],
        servePid: process.pid,
        workerPid: 1234,
        workers: [
          expect.objectContaining({
            workspaceCwd: primaryCwd,
            channels: ['telegram'],
            workerPid: 1234,
          }),
          expect.objectContaining({
            workspaceCwd: secondaryCwd,
            channels: ['feishu'],
            workerPid: 5678,
          }),
        ],
      });

      const capabilities = (await (
        await fetch(`${handle.url}/capabilities`, {
          headers: { Authorization: 'Bearer worker-remove-token' },
        })
      ).json()) as {
        workspaces: Array<{ id: string; cwd: string; removable?: boolean }>;
      };
      const secondaryRuntime = capabilities.workspaces.find(
        (workspace) => workspace.cwd === secondaryCwd,
      );
      expect(secondaryRuntime).toMatchObject({ removable: true });
      const removalUrl = `${handle.url}/workspaces/${encodeURIComponent(
        secondaryRuntime!.id,
      )}`;
      const busyRemoval = await fetch(removalUrl, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer worker-remove-token' },
      });
      expect(busyRemoval.status).toBe(409);
      await expect(busyRemoval.json()).resolves.toMatchObject({
        code: 'workspace_busy',
        activity: { channelWorkers: 1 },
      });
      expect(workerSupervisors.get(secondaryCwd)!.stop).not.toHaveBeenCalled();

      const forcedRemoval = await fetch(removalUrl, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer worker-remove-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ force: true }),
      });
      expect(forcedRemoval.status).toBe(200);
      await expect(forcedRemoval.json()).resolves.toMatchObject({
        removed: true,
        activity: { channelWorkers: 1 },
      });
      expect(removeByIds).toHaveBeenCalledWith([
        workspaceRegistrationId(secondaryCwd),
      ]);
      const removedSupervisor = workerSupervisors.get(secondaryCwd)!;
      const removedWorkerOptions = workerOptions.get(secondaryCwd)!;
      expect(removedSupervisor.stop).toHaveBeenCalledOnce();
      expect(workerSupervisors.get(primaryCwd)!.stop).not.toHaveBeenCalled();
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
        workerPid: 1234,
        workers: [
          expect.objectContaining({
            workspaceCwd: primaryCwd,
            channels: ['telegram'],
            workerPid: 1234,
          }),
        ],
      });

      const removedWebhook = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer worker-remove-token',
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'secondary-secret',
          },
          body: JSON.stringify({ eventType: 'check_failed' }),
        },
      );
      expect(removedWebhook.status).not.toBe(202);

      const failedSecondary: ChannelWorkerSnapshot = {
        enabled: true,
        state: 'failed',
        channels: ['feishu'],
        error: 'worker stopped',
      };
      snapshots.set(secondaryCwd, failedSecondary);
      removedWorkerOptions.onExit?.(failedSecondary);
      expect(pidfile.writeServeServiceInfo).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workerPid: 1234,
          workers: [
            expect.objectContaining({
              workspaceCwd: primaryCwd,
              channels: ['telegram'],
            }),
          ],
        }),
      );
      expect(
        pidfile.writeServeServiceInfo.mock.calls
          .at(-1)?.[0]
          .workers?.find(
            (worker: ServiceInfoWorker) => worker.workspaceCwd === secondaryCwd,
          ),
      ).toBeUndefined();

      snapshots.set(secondaryCwd, {
        enabled: true,
        state: 'running',
        pid: 6789,
        channels: ['feishu'],
      });
      const readded = await fetch(`${handle.url}/workspaces`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer worker-remove-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cwd: secondaryCwd }),
      });
      expect(readded.status).toBe(201);
      expect(supervisorFactory).toHaveBeenCalledTimes(3);
      expect(createBridge).toHaveBeenCalledTimes(3);
      const replacementSupervisor = workerSupervisors.get(secondaryCwd)!;
      expect(replacementSupervisor).not.toBe(removedSupervisor);
      expect(replacementSupervisor.start).toHaveBeenCalledOnce();

      const readdedWebhook = await fetch(
        `${handle.url}/channels/feishu/webhooks/github-ci`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer worker-remove-token',
            'content-type': 'application/json',
            'x-qwen-webhook-secret': 'secondary-secret',
          },
          body: JSON.stringify({
            eventType: 'check_failed',
            targetRef: 'default',
            title: 'CI failed again',
          }),
        },
      );
      expect(readdedWebhook.status).toBe(202);
      expect(webhookEnqueues.get(secondaryCwd)).toHaveBeenCalledWith(
        expect.objectContaining({
          channelName: 'feishu',
          title: 'CI failed again',
        }),
      );

      snapshots.set(secondaryCwd, failedSecondary);
      workerOptions.get(secondaryCwd)!.onExit?.(failedSecondary);
      const failedWorkerPidfile =
        pidfile.writeServeServiceInfo.mock.calls.at(-1)?.[0];
      expect(
        failedWorkerPidfile?.workers?.find(
          (worker: ServiceInfoWorker) => worker.workspaceCwd === secondaryCwd,
        ),
      ).toMatchObject({
        workspaceCwd: secondaryCwd,
        channels: ['feishu'],
      });
      expect(
        failedWorkerPidfile?.workers?.find(
          (worker: ServiceInfoWorker) => worker.workspaceCwd === secondaryCwd,
        )?.workerPid,
      ).toBeUndefined();

      const removeReplacement = await fetch(removalUrl, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer worker-remove-token' },
      });
      expect(removeReplacement.status).toBe(200);
      expect(replacementSupervisor.stop).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
      if (previousSharedSecret === undefined) {
        delete process.env['QWEN_SHARED_WEBHOOK_SECRET'];
      } else {
        process.env['QWEN_SHARED_WEBHOOK_SECRET'] = previousSharedSecret;
      }
    }
  });

  it('starts the channel worker after runtime mount and stops it before bridge shutdown', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-')),
    );
    const order: string[] = [];
    const bridge = makeFakeBridge(() => order.push('bridge'));
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const startupOrder: string[] = [];
    const originalCreateServeApp = serverModule.createServeApp;
    vi.spyOn(serverModule, 'createServeApp').mockImplementation((...args) => {
      const app = originalCreateServeApp(...args);
      const acpHandle = app.locals['acpHandle'] as
        | { attachServer?: (server: unknown) => void }
        | undefined;
      if (acpHandle) {
        acpHandle.attachServer = vi.fn(() => startupOrder.push('runtime'));
      }
      return app;
    });
    worker.stop.mockImplementation(async () => {
      order.push('worker');
    });
    const pidfile = makePidfileDeps();

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          worker.start.mockImplementation(async () => {
            startupOrder.push('worker');
            opts.onReady?.(worker.snapshot());
          });
          return worker;
        }),
        channelServicePidfile: pidfile,
      },
    );
    startupOrder.push('runtime-ready');

    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(startupOrder).toEqual(['runtime', 'worker', 'runtime-ready']);
    expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
    });
    expect(pidfile.writeServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
      workerPid: 1234,
    });

    await handle.close();

    expect(order).toEqual(['worker', 'bridge']);
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('force-kills channel worker, bridge, and pidfile on a second shutdown signal', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-force-')),
    );
    let finishBridgeShutdown!: () => void;
    const bridge = makeFakeBridge();
    vi.mocked(bridge.shutdown).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishBridgeShutdown = resolve;
        }),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      const signalListener = process
        .rawListeners('SIGTERM')
        .find(
          (listener) =>
            !existingSigtermListeners.has(listener) &&
            listener.name === 'onSignal',
        ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
      expect(signalListener).toBeDefined();

      const firstSignal = signalListener!('SIGTERM');
      await Promise.resolve();
      const secondSignal = signalListener!('SIGTERM');
      await secondSignal;

      expect(worker.killAllSync).toHaveBeenCalled();
      expect(bridge.killAllSync).toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
      expect(exitSpy).toHaveBeenCalledWith(1);

      finishBridgeShutdown();
      await firstSignal;
    } finally {
      finishBridgeShutdown?.();
      await handle.close();
      exitSpy.mockRestore();
    }
  });

  it('retries graceful shutdown after an unconfirmed channel worker exit', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-stuck-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const pidfile = makePidfileDeps();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));

    await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    const signalListener = process
      .rawListeners('SIGTERM')
      .find(
        (listener) =>
          !existingSigtermListeners.has(listener) &&
          listener.name === 'onSignal',
      ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    try {
      expect(signalListener).toBeDefined();
      await signalListener!('SIGTERM');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(worker.killAllSync).not.toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalled();
      const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
      expect(fs.readFileSync(logPath, 'utf8')).not.toContain('daemon stopped');

      await signalListener!('SIGTERM');
      expect(worker.stop).toHaveBeenCalledTimes(2);
      expect(worker.killAllSync).not.toHaveBeenCalled();
      expect(bridge.killAllSync).not.toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(fs.readFileSync(logPath, 'utf8')).toContain('daemon stopped');
    } finally {
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('bounds the logger flush before allowing a retryable close to reject', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-log-stuck-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const pidfile = makePidfileDeps();
    const logPath = path.join(tmpDir, 'debug', 'daemon', 'daemon.log');
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
        daemonLogBaseDir: path.join(tmpDir, 'debug'),
      },
    );

    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalAppendFile = fs.promises.appendFile.bind(fs.promises);
    const appendSpy = vi
      .spyOn(fs.promises, 'appendFile')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === logPath) await appendGate;
        return originalAppendFile(...args);
      });
    let closeOutcome:
      | Promise<{ kind: 'resolved' } | { kind: 'rejected'; error: unknown }>
      | undefined;

    try {
      const response = await fetch(`${handle.url}/blocked-access-log`);
      await response.text();
      closeOutcome = handle.close().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      let timeout: NodeJS.Timeout | undefined;
      const firstOutcome = await Promise.race([
        closeOutcome,
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: 'timeout' }), 1_500);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      expect(firstOutcome.kind).toBe('rejected');
      if (firstOutcome.kind === 'rejected') {
        expect(firstOutcome.error).toEqual(
          expect.objectContaining({
            message: 'Channel worker did not exit after SIGKILL.',
          }),
        );
      }
    } finally {
      releaseAppend();
      appendSpy.mockRestore();
      await closeOutcome;
      await handle.close();
    }

    expect(worker.stop).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('daemon stopped');
  });

  it('retries bridge shutdown when channel and bridge teardown fail together', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-bridge-stuck-')),
    );
    const bridge = makeFakeBridge();
    vi.mocked(bridge.shutdown)
      .mockRejectedValueOnce(new Error('bridge still draining'))
      .mockResolvedValueOnce(undefined);
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
      error: 'Channel worker did not exit after SIGKILL.',
    });
    worker.stop
      .mockRejectedValueOnce(
        new Error('Channel worker did not exit after SIGKILL.'),
      )
      .mockResolvedValueOnce(undefined);
    const pidfile = makePidfileDeps();

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge,
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    await expect(handle.close()).rejects.toThrow('bridge still draining');
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalled();

    await expect(handle.close()).resolves.toBeUndefined();
    expect(worker.stop).toHaveBeenCalledTimes(2);
    expect(bridge.shutdown).toHaveBeenCalledTimes(2);
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('removes serve-owned pidfile through the legacy fallback cleanup path', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fallback-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    delete (pidfile as Partial<typeof pidfile>).removeServeServiceInfo;
    pidfile.readServiceInfo.mockReturnValueOnce(null).mockReturnValue({
      owner: 'serve',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
      servePid: process.pid,
    });
    pidfile.removeServiceInfo.mockImplementation(() => {
      pidfile.readServiceInfo.mockReturnValue(null);
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    await handle.close();

    expect(pidfile.removeServiceInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps non-serve-owned pidfiles in the legacy fallback cleanup path', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fallback-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    delete (pidfile as Partial<typeof pidfile>).removeServeServiceInfo;
    pidfile.readServiceInfo.mockReturnValueOnce(null).mockReturnValue({
      owner: 'channel',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    await handle.close();

    expect(pidfile.removeServiceInfo).not.toHaveBeenCalled();
  });

  it('keeps serve running when worker pidfile metadata cannot be written', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-pidfile-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    pidfile.writeServeServiceInfo.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      await handle.runtimeReady;
      expect(worker.start).toHaveBeenCalled();
      expect(pidfile.writeServeServiceInfo).toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('updates the serve-owned pidfile when a restarted worker becomes ready', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-ready-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 5678,
      channels: ['telegram'],
    });
    let onReady: CreateChannelWorkerSupervisorOptions['onReady'];
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          onReady = opts.onReady;
          return worker;
        }),
        channelServicePidfile: pidfile,
      },
    );

    try {
      pidfile.writeServeServiceInfo.mockClear();
      onReady?.({
        enabled: true,
        state: 'running',
        pid: 5678,
        channels: ['telegram'],
        requestedChannels: ['telegram'],
        restartCount: 1,
      });

      expect(pidfile.writeServeServiceInfo).toHaveBeenCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
        workerPid: 5678,
      });
    } finally {
      await handle.close();
    }
  });

  it('forwards channel worker log and exit details into the daemon log', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-log-')),
    );
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = tmpDir;
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    let onLog: CreateChannelWorkerSupervisorOptions['onLog'];
    let onExit: CreateChannelWorkerSupervisorOptions['onExit'];

    try {
      const handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge: makeFakeBridge(),
          channelWorkerSupervisorFactory: vi.fn((opts) => {
            onLog = opts.onLog;
            onExit = opts.onExit;
            return worker;
          }),
          channelServicePidfile: makePidfileDeps(),
        },
      );

      try {
        onLog?.({ stream: 'stderr', line: 'adapter failed with <redacted>' });
        onExit?.({
          enabled: true,
          state: 'exited',
          pid: 1234,
          channels: ['telegram'],
          exitCode: 1,
          signal: null,
          error: 'ipc failed',
          restartCount: 2,
          nextRestartAt: '2026-07-01T01:00:05.000Z',
          staleHeartbeatAt: '2026-07-01T01:00:00.000Z',
        });
      } finally {
        await handle.close();
      }

      const daemonDir = path.join(tmpDir, 'debug', 'daemon');
      const logContent = fs
        .readdirSync(daemonDir)
        .filter((file) => file.endsWith('.log'))
        .map((file) => fs.readFileSync(path.join(daemonDir, file), 'utf8'))
        .join('\n');

      expect(logContent).toContain(
        'channel worker stderr: adapter failed with <redacted>',
      );
      expect(logContent).toContain(
        'channel worker exited (state=exited, pid=1234, code=1, signal=null, error=ipc failed, restartCount=2, nextRestartAt=2026-07-01T01:00:05.000Z, staleHeartbeatAt=2026-07-01T01:00:00.000Z)',
      );
      expect(logContent).not.toContain('secret-token');
    } finally {
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('passes a loopback daemon URL to workers when serve binds a wildcard host', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-loopback-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    let workerOptions: CreateChannelWorkerSupervisorOptions | undefined;
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '0.0.0.0',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        token: 'test-token',
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          workerOptions = opts;
          return worker;
        }),
        channelServicePidfile: makePidfileDeps(),
      },
    );

    try {
      const port = new URL(handle.url).port;
      expect(workerOptions?.daemonUrl).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await handle.close();
    }
  });

  it('does not write a worker pidfile after runtime startup already timed out', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-timeout-')),
    );
    let releaseStart!: () => void;
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn((opts) => {
          worker.start.mockImplementation(
            () =>
              new Promise<void>((resolve) => {
                releaseStart = () => {
                  opts.onReady?.(worker.snapshot());
                  resolve();
                };
              }),
          );
          return worker;
        }),
        channelServicePidfile: pidfile,
        resolveOnListen: true,
        runtimeStartupTimeoutMs: 1,
      },
    );

    try {
      await expect(
        Promise.race([
          handle.runtimeReady,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('runtimeReady did not settle')),
              1000,
            ),
          ),
        ]),
      ).rejects.toThrow('Daemon runtime startup timed out after 1ms.');
      await vi.waitFor(() => {
        expect(handle.server.listening).toBe(false);
      });
      releaseStart();
      await new Promise((resolve) => setImmediate(resolve));
      expect(pidfile.writeServeServiceInfo).not.toHaveBeenCalled();
    } finally {
      releaseStart?.();
      await handle.close();
    }
  });

  it('reports a warning when the ready channel worker exits', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-status-')),
    );
    const snapshot: ChannelWorkerSnapshot = {
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    };
    const worker = makeWorker(snapshot);
    let onExit: CreateChannelWorkerSupervisorOptions['onExit'];
    const channelWorkerSupervisorFactory = vi.fn(
      (opts: CreateChannelWorkerSupervisorOptions) => {
        onExit = opts.onExit;
        return worker;
      },
    );
    const pidfile = makePidfileDeps();
    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory,
        channelServicePidfile: pidfile,
      },
    );

    try {
      Object.assign(snapshot, {
        state: 'exited',
        exitCode: 1,
        signal: null,
        error: 'ipc failed',
      });
      onExit?.(snapshot);
      const res = await fetch(`${handle.url}/daemon/status`);
      const body = await res.json();

      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalledWith(
        process.pid,
      );
      const lastPidfileWrite =
        pidfile.writeServeServiceInfo.mock.calls.at(-1)?.[0];
      expect(lastPidfileWrite).toMatchObject({
        channels: ['telegram'],
        servePid: process.pid,
      });
      expect(lastPidfileWrite?.workerPid).toBeUndefined();
      expect(body).toMatchObject({
        status: 'warning',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'channel_worker_exited',
            severity: 'warning',
            message: 'Channel worker is exited (pid=1234, code=1): ipc failed.',
          }),
        ]),
        runtime: {
          channelWorker: {
            enabled: true,
            state: 'exited',
            pid: 1234,
            channels: ['telegram'],
            exitCode: 1,
            error: 'ipc failed',
          },
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('fails serve startup when the worker exits before ready', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-fail-')),
    );
    const bridge = makeFakeBridge();
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      channels: ['telegram'],
      exitCode: 1,
    });
    worker.start.mockRejectedValueOnce(new Error('worker failed before ready'));

    const pidfile = makePidfileDeps();
    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge,
          channelWorkerSupervisorFactory: vi.fn(() => worker),
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toThrow('worker failed before ready');

    expect(worker.stop).toHaveBeenCalled();
    expect(bridge.shutdown).toHaveBeenCalled();
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('keeps the serve owner alive when failed startup cannot confirm worker exit', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-retained-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'failed',
      pid: 1234,
      channels: ['telegram'],
    });
    worker.start.mockRejectedValue(new Error('worker failed before ready'));
    worker.stop.mockRejectedValue(
      new Error('Channel worker did not exit after SIGKILL.'),
    );
    const pidfile = makePidfileDeps();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const existingSigintListeners = new Set(process.rawListeners('SIGINT'));
    const existingSigtermListeners = new Set(process.rawListeners('SIGTERM'));
    let settled = false;

    const running = runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledTimes(4));
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(settled).toBe(false);
      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalled();

      const signalListener = process
        .rawListeners('SIGTERM')
        .find(
          (listener) =>
            !existingSigtermListeners.has(listener) &&
            listener.name === 'onSignal',
        ) as ((signal: NodeJS.Signals) => Promise<void>) | undefined;
      expect(signalListener).toBeDefined();
      worker.stop.mockResolvedValue(undefined);
      await signalListener!('SIGTERM');

      expect(worker.stop).toHaveBeenCalledTimes(5);
      expect(worker.killAllSync).not.toHaveBeenCalled();
      expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      for (const listener of process.rawListeners('SIGINT')) {
        if (!existingSigintListeners.has(listener)) {
          process.removeListener('SIGINT', listener as never);
        }
      }
      for (const listener of process.rawListeners('SIGTERM')) {
        if (!existingSigtermListeners.has(listener)) {
          process.removeListener('SIGTERM', listener as never);
        }
      }
      exitSpy.mockRestore();
    }
  });

  it('refuses to start when another channel service is already running', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-busy-')),
    );
    const workerFactory = vi.fn(() =>
      makeWorker({
        enabled: true,
        state: 'running',
        pid: 1234,
        channels: ['telegram'],
      }),
    );
    const pidfile = makePidfileDeps();
    pidfile.readServiceInfo.mockReturnValueOnce({
      owner: 'serve',
      pid: 9999,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
      servePid: 9999,
    });

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge: makeFakeBridge(),
          channelWorkerSupervisorFactory: workerFactory,
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toThrow('Channel service is already running under qwen serve');

    expect(workerFactory).not.toHaveBeenCalled();
    expect(pidfile.reserveServeServiceInfo).not.toHaveBeenCalled();
  });

  it('retries channel pidfile reservation after an EEXIST stale file cleanup', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-stale-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const eexist = new Error('EEXIST') as NodeJS.ErrnoException;
    eexist.code = 'EEXIST';
    pidfile.reserveServeServiceInfo
      .mockImplementationOnce(() => {
        throw eexist;
      })
      .mockImplementationOnce(() => undefined);
    pidfile.readServiceInfo.mockReturnValueOnce(null).mockReturnValueOnce(null);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: makeReadyWorkerFactory(worker),
        channelServicePidfile: pidfile,
      },
    );

    await handle.close();

    expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledTimes(2);
    expect(pidfile.writeServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
      workerPid: 1234,
    });
  });

  it('removes the channel pidfile reservation when listener startup fails', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-listen-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();

    await expect(
      runQwenServe(
        {
          port: -1,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
          channelSelection: { mode: 'names', names: ['telegram'] },
        },
        {
          bridge: makeFakeBridge(),
          channelWorkerSupervisorFactory: vi.fn(() => worker),
          channelServicePidfile: pidfile,
        },
      ),
    ).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });

    expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
      channels: ['telegram'],
      servePid: process.pid,
    });
    expect(pidfile.removeServeServiceInfo).toHaveBeenCalledWith(process.pid);
  });

  it('retries the next port on EADDRINUSE and succeeds', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port-retry-')),
    );
    const portsAttempted: number[] = [];
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
      listen: vi.fn((port, _host, cb) => {
        portsAttempted.push(port);
        const srv = createServer();
        if (portsAttempted.length === 1) {
          const err = new Error('address in use') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          setImmediate(() => srv.emit('error', err));
        } else {
          srv.listen(0, '127.0.0.1', () => {
            setImmediate(() => {
              srv.emit('listening');
              if (typeof cb === 'function') cb();
            });
          });
        }
        return srv;
      }),
    } as unknown as express.Application);

    const handle = await runQwenServe(
      {
        port: 4170,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        resolveOnListen: true,
      },
    );

    try {
      stderrSpy.mockRestore();
      expect(portsAttempted).toEqual([4170, 4171]);
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.url).not.toContain(':4170');
      expect(
        stderrWrites.some((w) =>
          w.includes('port 4170 is in use, trying 4171'),
        ),
      ).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('does not retry on non-EADDRINUSE listen errors', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port-no-retry-')),
    );
    const portsAttempted: number[] = [];
    const listenError = new Error('permission denied') as NodeJS.ErrnoException;
    listenError.code = 'EACCES';
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
      listen: vi.fn((port, _host, _cb) => {
        portsAttempted.push(port);
        const srv = createServer();
        setImmediate(() => srv.emit('error', listenError));
        return srv;
      }),
    } as unknown as express.Application);

    await expect(
      runQwenServe(
        {
          port: 4170,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      ),
    ).rejects.toBe(listenError);

    expect(portsAttempted).toEqual([4170]);
  });

  it('rejects after exhausting all port retry attempts', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port-exhaust-')),
    );
    const portsAttempted: number[] = [];
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
    const listenError = new Error('address in use') as NodeJS.ErrnoException;
    listenError.code = 'EADDRINUSE';
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
      listen: vi.fn((port) => {
        portsAttempted.push(port);
        const srv = createServer();
        setImmediate(() => srv.emit('error', listenError));
        return srv;
      }),
    } as unknown as express.Application);

    await expect(
      runQwenServe(
        {
          port: 4170,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      ),
    ).rejects.toBe(listenError);

    stderrSpy.mockRestore();
    expect(portsAttempted).toEqual(
      Array.from({ length: 10 }, (_, i) => 4170 + i),
    );
    expect(
      stderrWrites.some((w) => w.includes('all ports 4170–4179 are in use')),
    ).toBe(true);
  });

  it('does not retry EADDRINUSE when port is 0 (ephemeral)', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-port0-no-retry-')),
    );
    const portsAttempted: number[] = [];
    const listenError = new Error('address in use') as NodeJS.ErrnoException;
    listenError.code = 'EADDRINUSE';
    vi.spyOn(serverModule, 'createServeApp').mockReturnValue({
      locals: {},
      listen: vi.fn((port) => {
        portsAttempted.push(port);
        const srv = createServer();
        setImmediate(() => srv.emit('error', listenError));
        return srv;
      }),
    } as unknown as express.Application);

    await expect(
      runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      ),
    ).rejects.toBe(listenError);

    expect(portsAttempted).toEqual([0]);
  });

  it('does not remove the channel pidfile reservation for handled uncaught exceptions', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-crash-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const existingMonitorListeners = new Set(
      process.rawListeners('uncaughtExceptionMonitor'),
    );
    const uncaughtExceptionHandler = () => {};
    process.on('uncaughtException', uncaughtExceptionHandler);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      expect(pidfile.reserveServeServiceInfo).toHaveBeenCalledWith({
        channels: ['telegram'],
        servePid: process.pid,
      });
      const monitorListeners = process.rawListeners(
        'uncaughtExceptionMonitor',
      ) as Array<(error: Error, origin: 'uncaughtException') => void>;
      const newMonitorListeners = monitorListeners.filter(
        (listener) => !existingMonitorListeners.has(listener),
      );
      expect(newMonitorListeners).toHaveLength(1);
      for (const listener of newMonitorListeners) {
        listener(new Error('boom'), 'uncaughtException');
      }

      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalledWith(
        process.pid,
      );
    } finally {
      process.removeListener('uncaughtException', uncaughtExceptionHandler);
      await handle.close();
    }
  });

  it('preserves the channel pidfile reservation until an unhandled-exit worker is confirmed gone', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-channel-worker-unhandled-')),
    );
    const worker = makeWorker({
      enabled: true,
      state: 'running',
      pid: 1234,
      channels: ['telegram'],
    });
    const pidfile = makePidfileDeps();
    const existingMonitorListeners = new Set(
      process.rawListeners('uncaughtExceptionMonitor'),
    );
    const originalListenerCount = process.listenerCount.bind(process);
    const listenerCountSpy = vi
      .spyOn(process, 'listenerCount')
      .mockImplementation(
        (...args: Parameters<typeof process.listenerCount>) => {
          const [eventName] = args;
          if (eventName === 'uncaughtException') {
            return 0;
          }
          return originalListenerCount(...args);
        },
      );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        serveWebShell: false,
        channelSelection: { mode: 'names', names: ['telegram'] },
      },
      {
        bridge: makeFakeBridge(),
        channelWorkerSupervisorFactory: vi.fn(() => worker),
        channelServicePidfile: pidfile,
      },
    );

    try {
      const monitorListeners = process.rawListeners(
        'uncaughtExceptionMonitor',
      ) as Array<(error: Error, origin: 'uncaughtException') => void>;
      const newMonitorListeners = monitorListeners.filter(
        (listener) => !existingMonitorListeners.has(listener),
      );
      expect(newMonitorListeners).toHaveLength(1);
      for (const listener of newMonitorListeners) {
        listener(new Error('boom'), 'uncaughtException');
      }

      expect(pidfile.removeServeServiceInfo).not.toHaveBeenCalledWith(
        process.pid,
      );
    } finally {
      listenerCountSpy.mockRestore();
      await handle.close();
    }
  });
});

describe('runQwenServe startup observability', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
    } as unknown as HttpAcpBridge;
  }

  async function readStartup(handle: Pick<RunHandle, 'url' | 'resolvedToken'>) {
    const res = await fetch(`${handle.url}/daemon/status`, {
      headers: handle.resolvedToken
        ? { Authorization: `Bearer ${handle.resolvedToken}` }
        : undefined,
    });
    const body = (await res.json()) as {
      daemon?: {
        startup?: {
          processStartedAt?: string;
          listenerReadyAt?: string;
          processToListenMs?: number;
          runQwenServeToListenMs?: number;
          preheat?: {
            status?: string;
            durationMs?: number;
            error?: string;
          };
        };
      };
    };
    return body.daemon?.startup;
  }

  async function waitForPreheatStatus(
    handle: Pick<RunHandle, 'url' | 'runtimeReady'>,
    status: string,
  ) {
    await handle.runtimeReady;
    for (let i = 0; i < 20; i++) {
      const startup = await readStartup(handle);
      if (startup?.preheat?.status === status) return startup.preheat;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`preheat status did not become ${status}`);
  }

  function installInternalBridge(preheat: () => Promise<void>): HttpAcpBridge {
    const bridge = makeFakeBridge();
    vi.mocked(bridge.preheat).mockImplementation(preheat);
    vi.spyOn(acpBridge, 'createAcpSessionBridge').mockReturnValue(
      bridge as ReturnType<typeof acpBridge.createAcpSessionBridge>,
    );
    return bridge;
  }

  it('keeps the stdout listening contract and exposes startup timing on stderr and status', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-')),
    );
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
        allowOrigins: ['chrome-extension://qwen-test-extension'],
      },
      { bridge: makeFakeBridge() },
    );

    try {
      expect(stdoutWrites).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^qwen serve listening on http:\/\/127\.0\.0\.1:\d+ \(mode=http-bridge, workspace=/,
          ),
        ]),
      );
      expect(stderrWrites.join('')).toMatch(
        /qwen serve: startup timing: processToListenMs=\d+ runQwenServeToListenMs=\d+/,
      );
      expect(stderrWrites.join('')).not.toContain(
        'qwen serve: client-hosted MCP tools are accepted over the WebSocket without auth.',
      );

      expect(await readStartup(handle)).toMatchObject({
        processStartedAt: expect.any(String),
        listenerReadyAt: expect.any(String),
        processToListenMs: expect.any(Number),
        runQwenServeToListenMs: expect.any(Number),
        preheat: { status: 'external_bridge' },
      });
    } finally {
      await handle.close();
    }
  });

  it('uses boot runtimeOutputDir for daemon logs', async () => {
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-runtime-dir-')),
    );
    const boundWorkspace = canonicalizeWorkspace(tmpDir);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    let handle: RunHandle | undefined;
    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        {
          bridge: makeFakeBridge(),
          bootSettings: {
            advanced: { runtimeOutputDir: '.qwen-runtime' },
          },
        },
      );
      const expectedDaemonDir = path.join(
        boundWorkspace,
        '.qwen-runtime',
        'debug',
        'daemon',
      );
      expect(stderrWrites.join('')).toContain(
        `qwen serve: daemon log → ${expectedDaemonDir}`,
      );
      expect(fs.existsSync(expectedDaemonDir)).toBe(true);
    } finally {
      await handle?.close();
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('uses explicit daemonLogBaseDir when provided by an embedder', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-log-dep-')),
    );
    const logBaseDir = path.join(tmpDir, 'explicit-debug');
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      {
        bridge: makeFakeBridge(),
        daemonLogBaseDir: logBaseDir,
      },
    );

    try {
      const expectedDaemonDir = path.join(logBaseDir, 'daemon');
      expect(stderrWrites.join('')).toContain(
        `qwen serve: daemon log → ${expectedDaemonDir}`,
      );
      expect(fs.existsSync(expectedDaemonDir)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('preserves Storage runtime base dir for default exported callers', async () => {
    const originalRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_RUNTIME_DIR'];
    qwenCore.Storage.setRuntimeBaseDir(null);
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-storage-dir-')),
    );
    fs.mkdirSync(path.join(tmpDir, '.qwen'));
    fs.writeFileSync(
      path.join(tmpDir, '.qwen', 'settings.json'),
      JSON.stringify({
        advanced: { runtimeOutputDir: '.settings-runtime' },
      }),
    );
    const runtimeBaseDir = path.join(tmpDir, 'storage-runtime');
    qwenCore.Storage.setRuntimeBaseDir(runtimeBaseDir);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    let handle: RunHandle | undefined;
    try {
      handle = await runQwenServe(
        {
          port: 0,
          hostname: '127.0.0.1',
          mode: 'http-bridge',
          workspace: tmpDir,
          maxSessions: 1,
          serveWebShell: false,
        },
        { bridge: makeFakeBridge() },
      );
      const expectedDaemonDir = path.join(runtimeBaseDir, 'debug', 'daemon');
      expect(stderrWrites.join('')).toContain(
        `qwen serve: daemon log → ${expectedDaemonDir}`,
      );
      expect(fs.existsSync(expectedDaemonDir)).toBe(true);
    } finally {
      await handle?.close();
      qwenCore.Storage.setRuntimeBaseDir(null);
      if (originalRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = originalRuntimeDir;
      }
    }
  });

  it('tracks preheat running and succeeded states for an internally-created bridge', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-preheat-')),
    );
    let resolvePreheat!: () => void;
    const preheatPromise = new Promise<void>((resolve) => {
      resolvePreheat = resolve;
    });
    const bridge = installInternalBridge(() => preheatPromise);

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { preheatBridge: true },
    );

    try {
      await waitForPreheatStatus(handle, 'running');
      expect(bridge.preheat).toHaveBeenCalledTimes(1);
      expect((await readStartup(handle))?.preheat).toMatchObject({
        status: 'running',
      });

      resolvePreheat();
      expect(await waitForPreheatStatus(handle, 'succeeded')).toMatchObject({
        status: 'succeeded',
        durationMs: expect.any(Number),
      });
    } finally {
      await handle.close();
    }
  });

  it('tracks preheat failed state and error message for an internally-created bridge', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-startup-preheat-')),
    );
    const bridge = installInternalBridge(() =>
      Promise.reject(new Error('preheat boom')),
    );

    const handle = await runQwenServe(
      {
        port: 0,
        hostname: '127.0.0.1',
        mode: 'http-bridge',
        workspace: tmpDir,
        maxSessions: 1,
        serveWebShell: false,
      },
      { preheatBridge: true },
    );

    try {
      await waitForPreheatStatus(handle, 'failed');
      expect(bridge.preheat).toHaveBeenCalledTimes(1);
      expect(await waitForPreheatStatus(handle, 'failed')).toMatchObject({
        status: 'failed',
        durationMs: expect.any(Number),
        error: 'preheat boom',
      });
    } finally {
      await handle.close();
    }
  });
});
