/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `defaultSpawnChannelFactory`'s security-critical env
 * scrubbing (wenshao #4319 Critical fold-in). The wider 174-test
 * `httpAcpBridge.test.ts` suite uses mock channels and never spawns a
 * real child, so none of those tests exercise `defaultSpawnChannelFactory`
 * or `scrubChildEnv` directly. These tests close that gap.
 *
 * Why this matters: now that `defaultSpawnChannelFactory` is a public
 * export of `@qwen-code/acp-bridge`, channels (`packages/channels/base/
 * AcpBridge.ts`) and the VSCode IDE companion will consume it directly
 * and cannot rely on cli-package integration tests for env-scrubbing
 * guarantees. The scrubbing logic protects against:
 *
 *   - `QWEN_SERVER_TOKEN` (the daemon's own bearer token) leaking into
 *     the spawned agent's environment, where prompt-injection could
 *     turn the agent into an authenticated client of its own daemon.
 *   - `QWEN_CODE_SIMPLE` leaking from the daemon/IDE process into
 *     per-session ACP children, where it would silently suppress skills.
 *   - An `overrides` map smuggling a scrubbed key BACK into the child
 *     env (defense-in-depth — operators / embedders can pass overrides,
 *     but the denylist still wins).
 *   - An `overrides` map with `undefined` value silently failing to
 *     delete a stale inherited var (PR 14 fix #4247 wenshao R5 —
 *     the `run-qwen-serve.ts:216` use case).
 *
 * Each branch listed below is now regression-guarded by an assertion.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

import {
  createSpawnChannelFactory,
  createStderrForwarder,
  getAcpMemoryArgs,
  scrubChildEnv,
} from './spawnChannel.js';

function createFakeChildProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

describe('createSpawnChannelFactory env policy', () => {
  const originalArgv1 = process.argv[1];
  let originalSimple: string | undefined;
  let originalServerToken: string | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    originalSimple = process.env['QWEN_CODE_SIMPLE'];
    originalServerToken = process.env['QWEN_SERVER_TOKEN'];
    process.argv[1] = '/tmp/qwen.js';
    process.env['QWEN_CODE_SIMPLE'] = '1';
    process.env['QWEN_SERVER_TOKEN'] = 'secret';
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    if (originalSimple === undefined) {
      delete process.env['QWEN_CODE_SIMPLE'];
    } else {
      process.env['QWEN_CODE_SIMPLE'] = originalSimple;
    }
    if (originalServerToken === undefined) {
      delete process.env['QWEN_SERVER_TOKEN'];
    } else {
      process.env['QWEN_SERVER_TOKEN'] = originalServerToken;
    }
  });

  it('scrubs daemon-only env vars from the spawned ACP child', async () => {
    mockSpawn.mockReturnValue(createFakeChildProcess());

    const factory = createSpawnChannelFactory();
    await factory('/tmp/project', {
      QWEN_CODE_SIMPLE: '1',
      QWEN_SERVER_TOKEN: 'override-secret',
    });

    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(spawnOptions?.env).not.toHaveProperty('QWEN_CODE_SIMPLE');
    expect(spawnOptions?.env).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(spawnOptions?.env?.['QWEN_CODE_NO_RELAUNCH']).toBe('true');
  });

  it('passes optional child args after --acp', async () => {
    mockSpawn.mockReturnValue(createFakeChildProcess());

    const factory = createSpawnChannelFactory({
      extraArgs: ['--experimental-lsp'],
    });
    await factory('/tmp/project');

    const args = mockSpawn.mock.calls[0]?.[1] as string[] | undefined;
    expect(args?.slice(-2)).toEqual(['--acp', '--experimental-lsp']);
  });
});

describe('createStderrForwarder', () => {
  it('calls onDiagnosticLine for each complete line', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[test] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('hello\nworld\n');
    expect(captured).toEqual([
      { line: '[test] hello', level: 'warn' },
      { line: '[test] world', level: 'warn' },
    ]);
    // Also writes to process.stderr
    expect(stderrSpy).toHaveBeenCalledWith('[test] hello\n');
    expect(stderrSpy).toHaveBeenCalledWith('[test] world\n');
    stderrSpy.mockRestore();
  });

  it('buffers partial lines until newline arrives', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('partial');
    expect(captured).toHaveLength(0); // no newline yet
    forwarder.onData(' more\n');
    expect(captured).toEqual([{ line: '[p] partial more', level: 'warn' }]);
    stderrSpy.mockRestore();
  });

  it('flushes buffered content on end', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('partial');
    expect(captured).toHaveLength(0);
    forwarder.onEnd();
    expect(captured).toEqual([{ line: '[p] partial', level: 'warn' }]);
    stderrSpy.mockRestore();
  });

  it('does not call onDiagnosticLine for empty lines', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[p] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    forwarder.onData('\n\n');
    expect(captured).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  it('force-flushes with [truncated] when buffer exceeds 64 KiB cap', () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[x] ',
      onDiagnosticLine: (l, lvl) => captured.push({ line: l, level: lvl }),
    });
    // Write 65 KiB without a newline — exceeds the 64 KiB cap
    const bigChunk = 'A'.repeat(65 * 1024);
    forwarder.onData(bigChunk);
    // Should have force-flushed the first 64 KiB with [truncated]
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]!.line).toContain('[truncated]');
    expect(captured[0]!.level).toBe('warn');
    // The flushed line should have the prefix
    expect(captured[0]!.line).toMatch(/^\[x\] /);
    stderrSpy.mockRestore();
  });

  it('works without onDiagnosticLine (still writes to stderr)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const forwarder = createStderrForwarder({
      prefix: '[no-cb] ',
    });
    forwarder.onData('line1\n');
    expect(stderrSpy).toHaveBeenCalledWith('[no-cb] line1\n');
    stderrSpy.mockRestore();
  });
});

// Decoupled canary: we deliberately hand-roll the test set instead of
// importing `SCRUBBED_CHILD_ENV_KEYS` from `spawnChannel.ts` so the
// helper's behavior (clone + scrub + override + denylist-wins ordering)
// is tested as a pure function with parameterized input, independent
// of any current production denylist. The multi-key test below
// forward-guards expansion when a future sandboxed-agent mode grows
// the production set per the WARNING on `SCRUBBED_CHILD_ENV_KEYS`.
const SCRUBBED = new Set<string>(['QWEN_SERVER_TOKEN', 'QWEN_CODE_SIMPLE']);

describe('scrubChildEnv (defaultSpawnChannelFactory env policy)', () => {
  it('shallow-clones source — never aliases into the live process.env', () => {
    const source = { FOO: 'bar' };
    const result = scrubChildEnv(source, SCRUBBED);
    result['MUTATED'] = 'yes';
    expect(source).not.toHaveProperty('MUTATED');
  });

  it('strips QWEN_SERVER_TOKEN from the child env', () => {
    const source = { QWEN_SERVER_TOKEN: 'super-secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('strips QWEN_CODE_SIMPLE from the child env', () => {
    const source = { QWEN_CODE_SIMPLE: '1', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_CODE_SIMPLE');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('passes through non-scrubbed env vars unchanged', () => {
    const source = {
      OPENAI_API_KEY: 'sk-test',
      DASHSCOPE_API_KEY: 'ds-test',
      HOME: '/home/user',
    };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).toEqual(source);
  });

  it('overrides with a string value ADD the key', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { NEW_KEY: 'new-value' });
    expect(result['NEW_KEY']).toBe('new-value');
  });

  it('overrides with a string value REPLACE an existing key', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { PATH: '/override/bin' });
    expect(result['PATH']).toBe('/override/bin');
  });

  it('overrides with undefined value DELETE the key from the child env (PR 14 fix #4247 wenshao R5)', () => {
    const source = { STALE_VAR: 'leftover', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, { STALE_VAR: undefined });
    expect(result).not.toHaveProperty('STALE_VAR');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('overrides CANNOT re-introduce a scrubbed key (defense in depth)', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'sneaky-attempt-via-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('overrides CANNOT re-introduce QWEN_CODE_SIMPLE', () => {
    const source = { PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_CODE_SIMPLE: '1',
    });
    expect(result).not.toHaveProperty('QWEN_CODE_SIMPLE');
  });

  it('overrides CANNOT undo the scrub by setting undefined for a scrubbed key', () => {
    // Edge case: `undefined` value would normally delete; but for a
    // scrubbed key, the `continue` in the loop short-circuits BEFORE
    // the undefined-vs-string check. The key stays deleted (by the
    // earlier scrub pass) regardless of what overrides says.
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: undefined,
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('overrides are applied AFTER scrub — the denylist always wins', () => {
    // Verifies the documented ordering invariant: even if the scrub
    // and override touch the same key in conflicting ways, scrub wins.
    const source = { QWEN_SERVER_TOKEN: 'from-process-env' };
    const result = scrubChildEnv(source, SCRUBBED, {
      QWEN_SERVER_TOKEN: 'from-override',
    });
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
  });

  it('empty overrides leaves scrub-only behavior intact', () => {
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED, {});
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('no overrides arg works the same as empty overrides', () => {
    const source = { QWEN_SERVER_TOKEN: 'secret', PATH: '/usr/bin' };
    const result = scrubChildEnv(source, SCRUBBED);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result['PATH']).toBe('/usr/bin');
  });

  it('multi-key scrub set strips every listed key', () => {
    // Forward-compat: if a future sandboxed-agent mode expands the
    // denylist (as the WARNING comment on SCRUBBED_CHILD_ENV_KEYS
    // anticipates), this verifies the loop handles multiple keys.
    const sandboxScrub = new Set<string>([
      'QWEN_SERVER_TOKEN',
      'QWEN_CODE_SIMPLE',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
    ]);
    const source = {
      QWEN_SERVER_TOKEN: 't1',
      QWEN_CODE_SIMPLE: 't2',
      AWS_SECRET_ACCESS_KEY: 't3',
      OPENAI_API_KEY: 't4',
      PATH: '/usr/bin',
    };
    const result = scrubChildEnv(source, sandboxScrub);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(result).not.toHaveProperty('QWEN_CODE_SIMPLE');
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result['PATH']).toBe('/usr/bin');
  });
});

describe('getAcpMemoryArgs', () => {
  it('always includes --expose-gc and optionally --max-old-space-size', () => {
    const args = getAcpMemoryArgs();
    expect(args).toContain('--expose-gc');
    const heapArg = args.find((a) => a.startsWith('--max-old-space-size='));
    if (heapArg) {
      const sizeMB = Number(heapArg.split('=')[1]);
      expect(sizeMB).toBeGreaterThan(0);
      expect(sizeMB).toBeLessThanOrEqual(16_384);
    }
  });

  it('respects the 16GB cap', () => {
    const args = getAcpMemoryArgs();
    const heapArg = args.find((a) => a.startsWith('--max-old-space-size='));
    if (heapArg) {
      const sizeMB = Number(heapArg.split('=')[1]);
      expect(sizeMB).toBeLessThanOrEqual(16_384);
    }
  });
});
