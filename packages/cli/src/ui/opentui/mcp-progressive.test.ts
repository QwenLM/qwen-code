/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { appEvents } from '../../utils/events.js';
import {
  startMcpProgressiveDiscovery,
  MCP_BATCH_FLUSH_MS,
} from './mcp-progressive.js';

function makeConfig(setTools: () => Promise<void>): Config {
  return {
    getGeminiClient: () => ({ setTools }),
  } as unknown as Config;
}

describe('startMcpProgressiveDiscovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appEvents.removeAllListeners('mcp-client-update');
  });

  afterEach(() => {
    vi.useRealTimers();
    appEvents.removeAllListeners('mcp-client-update');
  });

  it('coalesces rapid updates into one setTools call', async () => {
    const setTools = vi.fn().mockResolvedValue(undefined);
    const dispose = startMcpProgressiveDiscovery(makeConfig(setTools));

    appEvents.emit('mcp-client-update', new Map());
    appEvents.emit('mcp-client-update', new Map());
    appEvents.emit('mcp-client-update', new Map());

    // Before the flush window nothing has run.
    expect(setTools).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MCP_BATCH_FLUSH_MS);
    await Promise.resolve();
    expect(setTools).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('flushes again for a later batch', async () => {
    const setTools = vi.fn().mockResolvedValue(undefined);
    const dispose = startMcpProgressiveDiscovery(makeConfig(setTools));

    appEvents.emit('mcp-client-update', new Map());
    vi.advanceTimersByTime(MCP_BATCH_FLUSH_MS);
    await Promise.resolve();
    expect(setTools).toHaveBeenCalledTimes(1);

    appEvents.emit('mcp-client-update', new Map());
    vi.advanceTimersByTime(MCP_BATCH_FLUSH_MS);
    await Promise.resolve();
    expect(setTools).toHaveBeenCalledTimes(2);

    dispose();
  });

  it('stops emitting after dispose', async () => {
    const setTools = vi.fn().mockResolvedValue(undefined);
    const dispose = startMcpProgressiveDiscovery(makeConfig(setTools));
    dispose();

    appEvents.emit('mcp-client-update', new Map());
    vi.advanceTimersByTime(MCP_BATCH_FLUSH_MS * 3);
    await Promise.resolve();
    expect(setTools).not.toHaveBeenCalled();
  });

  it('routes setTools failures to the error sink', async () => {
    const onError = vi.fn();
    const setTools = vi.fn().mockRejectedValue(new Error('nope'));
    const dispose = startMcpProgressiveDiscovery(makeConfig(setTools), {
      onError,
    });

    appEvents.emit('mcp-client-update', new Map());
    vi.advanceTimersByTime(MCP_BATCH_FLUSH_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();

    dispose();
  });

  it('returns a no-op disposer without a config', () => {
    const dispose = startMcpProgressiveDiscovery(undefined);
    expect(() => dispose()).not.toThrow();
  });
});
