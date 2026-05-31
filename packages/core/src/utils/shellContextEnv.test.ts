/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { getShellContextEnvVars } from './shellContextEnv.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';

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
    expect(env.QWEN_CODE_SESSION_ID).toBe('test-session-123');
  });

  it('returns QWEN_CODE_AGENT_ID when called within agent context', async () => {
    const env = await runWithAgentContext('my-agent-42', async () => getShellContextEnvVars());
    expect(env.QWEN_CODE_AGENT_ID).toBe('my-agent-42');
  });

  it('returns QWEN_CODE_PROMPT_ID when called within prompt context', () => {
    const env = promptIdContext.run('prompt-abc', () => getShellContextEnvVars());
    expect(env.QWEN_CODE_PROMPT_ID).toBe('prompt-abc');
  });

  it('returns all vars when all contexts are active', async () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'sess-uuid';
    const env = await runWithAgentContext('agent-xyz', async () => promptIdContext.run('prompt-456', () => getShellContextEnvVars()));
    expect(env).toEqual({
      QWEN_CODE_SESSION_ID: 'sess-uuid',
      QWEN_CODE_AGENT_ID: 'agent-xyz',
      QWEN_CODE_PROMPT_ID: 'prompt-456',
    });
  });

  it('sets empty string for agent/prompt to override inherited env', () => {
    // Simulates a nested qwen-code process where parent injected these
    const env = getShellContextEnvVars();
    expect(env.QWEN_CODE_AGENT_ID).toBe('');
    expect(env.QWEN_CODE_PROMPT_ID).toBe('');
    // Empty strings will overwrite any stale inherited values in process.env
  });
});
