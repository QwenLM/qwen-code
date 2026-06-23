/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractContextFilename,
  InvalidPolicyConfigError,
  runQwenServe,
  type RunHandle,
  validatePolicyConfig,
} from './run-qwen-serve.js';
import * as acpBridge from '@qwen-code/acp-bridge/bridge';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import type {
  BridgeDaemonStatusSnapshot,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { Storage } from '@qwen-code/qwen-code-core';
import * as serverModule from './server.js';

const BASE_BRIDGE_SNAPSHOT: BridgeDaemonStatusSnapshot = {
  limits: {
    maxSessions: 20,
    maxPendingPromptsPerSession: 5,
    eventRingSize: 8000,
    channelIdleTimeoutMs: 0,
    sessionIdleTimeoutMs: 1_800_000,
  },
  sessionCount: 0,
  pendingPermissionCount: 0,
  channelLive: true,
  permissionPolicy: 'first-responder',
  sessions: [],
};

const mockCreateSpawnChannelFactoryOptions = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

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

      // Find the log file (pattern: serve-<pid>-<hash>.log)
      const logFiles = fs
        .readdirSync(daemonDir)
        .filter((f) => f.endsWith('.log'));
      expect(logFiles.length).toBeGreaterThanOrEqual(1);

      const logContent = fs.readFileSync(
        path.join(daemonDir, logFiles[0]!),
        'utf8',
      );
      // Should contain the "daemon started" boot line
      expect(logContent).toContain('daemon started');
      expect(logContent).toContain(`pid=${process.pid}`);
      expect(logContent).toContain(
        `workspace=${fs.realpathSync.native(workspace)}`,
      );

      // Close the handle (graceful shutdown)
      await handle.close();

      // The log should still be readable after shutdown
      const finalContent = fs.readFileSync(
        path.join(daemonDir, logFiles[0]!),
        'utf8',
      );
      expect(finalContent).toContain('daemon started');
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
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
    } finally {
      delete process.env['QWEN_RUNTIME_DIR'];
      if (origEnv !== undefined) {
        process.env['QWEN_RUNTIME_DIR'] = origEnv;
      }
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
    ['eventRingSize', 0, /eventRingSize/],
    ['eventRingSize', 1.5, /eventRingSize/],
    ['eventRingSize', Number.POSITIVE_INFINITY, /eventRingSize/],
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

  it('reports bootstrap status and capabilities when fast path resolves on listen', async () => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qws-runtime-fail-')),
    );
    const boundWorkspace = canonicalizeWorkspace(tmpDir);
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
      const capabilitiesRes = await fetch(`${handle.url}/capabilities`, {
        headers: { Origin: handle.url },
      });
      expect(capabilitiesRes.status).toBe(200);
      expect(await capabilitiesRes.json()).toMatchObject({
        v: 1,
        protocolVersions: { current: 'v1', supported: ['v1'] },
        mode: 'http-bridge',
        features: expect.arrayContaining([
          'capabilities',
          'daemon_status',
          'workspace_settings',
          'workspace_reload',
        ]),
        modelServices: [],
        workspaceCwd: boundWorkspace,
        transports: ['rest'],
        policy: { permission: 'first-responder' },
        limits: { maxPendingPromptsPerSession: 5 },
      });

      const res = await fetch(`${handle.url}/daemon/status`);
      const body = (await res.json()) as {
        status?: string;
        issues?: Array<{ code?: string; severity?: string }>;
        runtime?: { loading?: boolean; error?: string };
      };
      expect(body).toMatchObject({
        status: 'error',
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: 'daemon_runtime_failed',
            severity: 'error',
          }),
        ]),
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
        security: { allowOriginMode: 'none' },
        limits: {
          maxSessions: 1,
          maxPendingPromptsPerSession: 5,
          listenerMaxConnections: 256,
          eventRingSize: 8000,
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
    } finally {
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
    Storage.setRuntimeBaseDir(null);
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
    Storage.setRuntimeBaseDir(runtimeBaseDir);
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
      Storage.setRuntimeBaseDir(null);
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
