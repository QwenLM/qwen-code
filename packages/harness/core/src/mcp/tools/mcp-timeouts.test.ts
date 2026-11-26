/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_MCP_TOOL_IDLE_TIMEOUT,
  McpToolIdleWatchdog,
  MCP_REMOTE_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC,
  MCP_REQUEST_TIMEOUT_DEFAULT_MSEC,
  MCP_STDIO_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC,
  MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC,
  MCP_TOOL_TIMEOUT_MAX_MSEC,
  resolveMcpRequestTimeoutMs,
  resolveMcpToolHardTimeoutMs,
  resolveMcpToolIdleTimeoutMs,
} from './mcp-timeouts.js';

function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return values;
}

describe('MCP timeout policy', () => {
  describe('request timeout', () => {
    it('uses a 30 second default and accepts a positive MCP_TIMEOUT', () => {
      expect(resolveMcpRequestTimeoutMs(env())).toBe(
        MCP_REQUEST_TIMEOUT_DEFAULT_MSEC,
      );
      expect(resolveMcpRequestTimeoutMs(env({ MCP_TIMEOUT: '45000' }))).toBe(
        45_000,
      );
    });

    it('ignores non-positive and invalid MCP_TIMEOUT values', () => {
      expect(resolveMcpRequestTimeoutMs(env({ MCP_TIMEOUT: '0' }))).toBe(
        MCP_REQUEST_TIMEOUT_DEFAULT_MSEC,
      );
      expect(resolveMcpRequestTimeoutMs(env({ MCP_TIMEOUT: 'invalid' }))).toBe(
        MCP_REQUEST_TIMEOUT_DEFAULT_MSEC,
      );
    });
  });

  describe('tool hard timeout', () => {
    it('prefers a valid server timeout over MCP_TOOL_TIMEOUT', () => {
      expect(
        resolveMcpToolHardTimeoutMs(
          { timeout: 1_500 },
          env({ MCP_TOOL_TIMEOUT: '2000' }),
        ),
      ).toBe(1_500);
    });

    it('ignores a server timeout below one second', () => {
      expect(resolveMcpToolHardTimeoutMs({ timeout: 999 }, env())).toBe(
        MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC,
      );
      expect(
        resolveMcpToolHardTimeoutMs(
          { timeout: 999 },
          env({ MCP_TOOL_TIMEOUT: '2000' }),
        ),
      ).toBe(2_000);
    });

    it('uses MCP_TOOL_TIMEOUT and otherwise falls back to the long default', () => {
      expect(
        resolveMcpToolHardTimeoutMs(
          undefined,
          env({ MCP_TOOL_TIMEOUT: '2000' }),
        ),
      ).toBe(2_000);
      expect(resolveMcpToolHardTimeoutMs(undefined, env())).toBe(
        MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC,
      );
      expect(
        resolveMcpToolHardTimeoutMs(
          undefined,
          env({ MCP_TOOL_TIMEOUT: '0' }),
        ),
      ).toBe(MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC);
    });

    it('clamps the hard timeout to the Node timer range', () => {
      expect(
        resolveMcpToolHardTimeoutMs(
          { timeout: MCP_TOOL_TIMEOUT_MAX_MSEC + 100_000 },
          env(),
        ),
      ).toBe(MCP_TOOL_TIMEOUT_MAX_MSEC);
    });
  });

  describe('tool idle timeout', () => {
    it('uses transport-specific defaults', () => {
      expect(
        resolveMcpToolIdleTimeoutMs({ command: 'server' }, env()),
      ).toBe(MCP_STDIO_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC);
      expect(
        resolveMcpToolIdleTimeoutMs(
          { type: 'http', url: 'https://example.com/mcp' },
          env(),
        ),
      ).toBe(MCP_REMOTE_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC);
    });

    it('lets a valid server timeout extend idle but caps it at hard timeout', () => {
      expect(
        resolveMcpToolIdleTimeoutMs(
          {
            type: 'http',
            url: 'https://example.com/mcp',
            timeout: 1_200_000,
          },
          env(),
        ),
      ).toBe(1_200_000);
      expect(
        resolveMcpToolIdleTimeoutMs(
          { type: 'http', url: 'https://example.com/mcp', timeout: 1_500 },
          env(),
        ),
      ).toBe(1_500);
    });

    it('supports a global override and zero disables idle timeout', () => {
      expect(
        resolveMcpToolIdleTimeoutMs(
          { type: 'http', url: 'https://example.com/mcp' },
          env({ [ENV_MCP_TOOL_IDLE_TIMEOUT]: '600000' }),
        ),
      ).toBe(600_000);
      expect(
        resolveMcpToolIdleTimeoutMs(
          { type: 'http', url: 'https://example.com/mcp' },
          env({ [ENV_MCP_TOOL_IDLE_TIMEOUT]: '0' }),
        ),
      ).toBe(0);
      expect(
        resolveMcpToolIdleTimeoutMs(
          { type: 'http', url: 'https://example.com/mcp' },
          env({ [ENV_MCP_TOOL_IDLE_TIMEOUT]: '-1' }),
        ),
      ).toBe(MCP_REMOTE_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC);
    });

    it('disables idle timeout for in-process SDK servers', () => {
      expect(resolveMcpToolIdleTimeoutMs({ type: 'sdk' }, env())).toBe(0);
    });
  });
});

describe('McpToolIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts after an idle interval', async () => {
    const watchdog = new McpToolIdleWatchdog(1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(watchdog.signal.aborted).toBe(true);
    expect(String(watchdog.signal.reason)).toContain('MCP tool idle timeout');
  });

  it('resets on progress', async () => {
    const watchdog = new McpToolIdleWatchdog(1_000);

    await vi.advanceTimersByTimeAsync(900);
    watchdog.touch();
    await vi.advanceTimersByTimeAsync(900);
    expect(watchdog.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(watchdog.signal.aborted).toBe(true);
  });

  it('pauses during elicitation and restarts a full interval on resume', async () => {
    const watchdog = new McpToolIdleWatchdog(1_000);

    await vi.advanceTimersByTimeAsync(900);
    watchdog.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchdog.signal.aborted).toBe(false);

    watchdog.resume();
    await vi.advanceTimersByTimeAsync(999);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watchdog.signal.aborted).toBe(true);
  });
});
