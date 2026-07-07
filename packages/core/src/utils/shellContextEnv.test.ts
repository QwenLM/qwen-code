/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getShellContextEnvVars } from './shellContextEnv.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';
import { sessionIdContext } from './sessionIdContext.js';
import {
  isShellTracePropagationEnabled,
  getTraceContext,
  formatTraceparent,
} from '../telemetry/trace-context.js';

vi.mock('../telemetry/trace-context.js', () => ({
  isShellTracePropagationEnabled: vi.fn().mockReturnValue(false),
  getTraceContext: vi.fn().mockReturnValue(null),
  formatTraceparent: vi.fn().mockReturnValue('00-aaaa-bbbb-01'),
}));

describe('getShellContextEnvVars', () => {
  let originalSessionId: string | undefined;

  beforeEach(() => {
    originalSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
  });

  afterEach(() => {
    if (originalSessionId !== undefined) {
      process.env['QWEN_CODE_SESSION_ID'] = originalSessionId;
    } else {
      delete process.env['QWEN_CODE_SESSION_ID'];
    }
  });

  it('returns empty strings for agent/prompt when no context is available', () => {
    const env = getShellContextEnvVars();
    expect(env).toEqual({
      QWEN_CODE_AGENT_ID: '',
      QWEN_CODE_PROMPT_ID: '',
    });
  });

  it('returns QWEN_CODE_SESSION_ID when set in process.env', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'test-session-123';
    const env = getShellContextEnvVars();
    expect(env['QWEN_CODE_SESSION_ID']).toBe('test-session-123');
  });

  it('returns QWEN_CODE_AGENT_ID when called within agent context', async () => {
    const env = await runWithAgentContext('my-agent-42', async () =>
      getShellContextEnvVars(),
    );
    expect(env['QWEN_CODE_AGENT_ID']).toBe('my-agent-42');
  });

  it('returns QWEN_CODE_PROMPT_ID when called within prompt context', () => {
    const env = promptIdContext.run('prompt-abc', () =>
      getShellContextEnvVars(),
    );
    expect(env['QWEN_CODE_PROMPT_ID']).toBe('prompt-abc');
  });

  it('returns all vars when all contexts are active', async () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'sess-uuid';
    const env = await runWithAgentContext('agent-xyz', async () =>
      promptIdContext.run('prompt-456', () => getShellContextEnvVars()),
    );
    expect(env).toEqual({
      QWEN_CODE_SESSION_ID: 'sess-uuid',
      QWEN_CODE_AGENT_ID: 'agent-xyz',
      QWEN_CODE_PROMPT_ID: 'prompt-456',
    });
  });

  describe('session ID from AsyncLocalStorage (daemon multi-session)', () => {
    it('prefers sessionIdContext over process.env', () => {
      // Daemon mode: process.env holds the FIRST session's ID forever
      // (constructor guard `sessionEnvClaimed` in config.ts), so a later
      // session must win via its own async context.
      process.env['QWEN_CODE_SESSION_ID'] = 'stale-first-session';
      const env = sessionIdContext.run('current-session', () =>
        getShellContextEnvVars(),
      );
      expect(env['QWEN_CODE_SESSION_ID']).toBe('current-session');
    });

    it('falls back to process.env outside any session context (single-session CLI)', () => {
      process.env['QWEN_CODE_SESSION_ID'] = 'cli-session';
      const env = getShellContextEnvVars();
      expect(env['QWEN_CODE_SESSION_ID']).toBe('cli-session');
    });

    it('isolates concurrent sessions in the same process', async () => {
      // Regression: two daemon sessions interleaving must each see their
      // own ID at spawn time, even though process.env is a single slot.
      process.env['QWEN_CODE_SESSION_ID'] = 'stale-first-session';
      let envSeenByA: Record<string, string> = {};
      let envSeenByB: Record<string, string> = {};

      await Promise.all([
        sessionIdContext.run('session-A', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          envSeenByA = getShellContextEnvVars();
        }),
        sessionIdContext.run('session-B', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          envSeenByB = getShellContextEnvVars();
        }),
      ]);

      expect(envSeenByA['QWEN_CODE_SESSION_ID']).toBe('session-A');
      expect(envSeenByB['QWEN_CODE_SESSION_ID']).toBe('session-B');
    });
  });

  it('sets empty string for agent/prompt to override inherited env', () => {
    // Simulates a nested qwen-code process where parent injected these
    const env = getShellContextEnvVars();
    expect(env['QWEN_CODE_AGENT_ID']).toBe('');
    expect(env['QWEN_CODE_PROMPT_ID']).toBe('');
    // Empty strings will overwrite any stale inherited values in process.env
  });

  describe('TRACEPARENT injection', () => {
    afterEach(() => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(false);
      vi.mocked(getTraceContext).mockReturnValue(null);
    });

    it('does not inject TRACEPARENT when propagation is disabled', () => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(false);
      const env = getShellContextEnvVars();
      expect(env['TRACEPARENT']).toBeUndefined();
    });

    it('injects TRACEPARENT when propagation is enabled and context exists', () => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(true);
      vi.mocked(getTraceContext).mockReturnValue({
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanId: 'bbbbbbbbbbbbbbbb',
        traceFlags: 1,
      });
      vi.mocked(formatTraceparent).mockReturnValue(
        '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      );

      const env = getShellContextEnvVars();
      expect(env['TRACEPARENT']).toBe(
        '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      );
      expect(env['TRACESTATE']).toBe('');
    });

    it('clears TRACEPARENT and TRACESTATE when propagation is enabled but no context', () => {
      vi.mocked(isShellTracePropagationEnabled).mockReturnValue(true);
      vi.mocked(getTraceContext).mockReturnValue(null);

      const env = getShellContextEnvVars();
      expect(env['TRACEPARENT']).toBe('');
      expect(env['TRACESTATE']).toBe('');
    });
  });
});
