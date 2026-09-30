/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../config/config.js';
import {
  discoveryTimeoutFor,
  runWithTimeout,
} from './mcp-discovery-timeout.js';

// Build a minimal `MCPServerConfig`-shaped object via cast — the
// helper only reads `discoveryTimeoutMs` / `httpUrl` / `url` / `tcp`,
// so a partial test fixture is enough and avoids the 16-positional
// constructor.
function mkCfg(partial: Partial<MCPServerConfig>): MCPServerConfig {
  return partial as MCPServerConfig;
}

describe('discoveryTimeoutFor', () => {
  it('stdio config (no remote fields) defaults to 30s', () => {
    expect(discoveryTimeoutFor(mkCfg({ command: 'node' }))).toBe(30_000);
  });

  it('httpUrl config defaults to 5s (remote)', () => {
    expect(discoveryTimeoutFor(mkCfg({ httpUrl: 'https://api.x' }))).toBe(
      5_000,
    );
  });

  it('url config (sse) defaults to 5s (remote)', () => {
    expect(discoveryTimeoutFor(mkCfg({ url: 'https://api.y' }))).toBe(5_000);
  });

  it('tcp config (websocket) defaults to 5s (remote)', () => {
    expect(discoveryTimeoutFor(mkCfg({ tcp: 'ws://x' }))).toBe(5_000);
  });

  it('honors per-server discoveryTimeoutMs override', () => {
    expect(
      discoveryTimeoutFor(
        mkCfg({ command: 'node', discoveryTimeoutMs: 12_345 }),
      ),
    ).toBe(12_345);
  });

  it('clamps override above MAX (300s)', () => {
    expect(
      discoveryTimeoutFor(
        mkCfg({ command: 'node', discoveryTimeoutMs: 600_000 }),
      ),
    ).toBe(300_000);
  });

  it('clamps override below MIN (100ms)', () => {
    expect(
      discoveryTimeoutFor(mkCfg({ command: 'node', discoveryTimeoutMs: 50 })),
    ).toBe(100);
  });

  it('falls through to default when override is NaN', () => {
    expect(
      discoveryTimeoutFor(
        mkCfg({ command: 'node', discoveryTimeoutMs: Number.NaN }),
      ),
    ).toBe(30_000);
  });

  it('falls through to default when override is Infinity', () => {
    expect(
      discoveryTimeoutFor(
        mkCfg({
          command: 'node',
          discoveryTimeoutMs: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe(30_000);
  });
});

describe('runWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with task value when task settles before timer', async () => {
    const task = Promise.resolve('done');
    const result = await runWithTimeout(task, 1_000, 'test');
    expect(result).toBe('done');
  });

  it('rejects with timeout error when timer fires before task', async () => {
    let resolveTask: (v: string) => void = () => undefined;
    const task = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });
    const promise = runWithTimeout(task, 100, 'test-label');
    // Attach a no-op .catch to the wrapper promise BEFORE advancing
    // timers so the rejection is observed (vitest treats unhandled
    // rejections as test failures). Then assert via a second await.
    const observed = promise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(150);
    const err = await observed;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timed out after 100ms: test-label/);
    // Task settling after timeout doesn't affect the rejection.
    resolveTask('late');
  });

  it('propagates task rejection (clears timer)', async () => {
    const task = Promise.reject(new Error('task failed'));
    await expect(runWithTimeout(task, 1_000, 'test')).rejects.toThrow(
      'task failed',
    );
  });

  it('clears the timer on success (no leaked unref-only timer)', async () => {
    const task = Promise.resolve('ok');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await runWithTimeout(task, 1_000, 'test');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('clears the timer on rejection (no leaked timer)', async () => {
    const task = Promise.reject(new Error('rejected'));
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await runWithTimeout(task, 1_000, 'test');
    } catch {
      // expected
    }
    expect(clearSpy).toHaveBeenCalled();
  });
});
