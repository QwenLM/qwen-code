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
  validatePolicyConfig,
} from './run-qwen-serve.js';
import type { HttpAcpBridge } from './acp-session-bridge.js';

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
});
