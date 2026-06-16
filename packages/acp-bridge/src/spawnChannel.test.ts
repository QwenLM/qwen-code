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
 *   - An `overrides` map smuggling a scrubbed key BACK into the child
 *     env (defense-in-depth — operators / embedders can pass overrides,
 *     but the denylist still wins).
 *   - An `overrides` map with `undefined` value silently failing to
 *     delete a stale inherited var (PR 14 fix #4247 wenshao R5 —
 *     the `runQwenServe.ts:216` use case).
 *
 * Each branch listed below is now regression-guarded by an assertion.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createStderrForwarder,
  getAcpMemoryArgs,
  scrubChildEnv,
} from './spawnChannel.js';

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
const SCRUBBED = new Set<string>(['QWEN_SERVER_TOKEN']);

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
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
    ]);
    const source = {
      QWEN_SERVER_TOKEN: 't1',
      AWS_SECRET_ACCESS_KEY: 't2',
      OPENAI_API_KEY: 't3',
      PATH: '/usr/bin',
    };
    const result = scrubChildEnv(source, sandboxScrub);
    expect(result).not.toHaveProperty('QWEN_SERVER_TOKEN');
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
