/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SendMessageTool } from './send-message.js';

function makeConfig(opts?: {
  teamManager?: {
    sendMessage: (...args: unknown[]) => Promise<void>;
    broadcast: (...args: unknown[]) => Promise<void>;
    requestShutdown?: (...args: unknown[]) => Promise<void>;
  } | null;
}) {
  return {
    getTeamManager: () => opts?.teamManager ?? null,
  } as unknown as import('../config/config.js').Config;
}

describe('SendMessageTool', () => {
  it('has the correct name', () => {
    const tool = new SendMessageTool(makeConfig());
    expect(tool.name).toBe('send_message');
  });

  it('sends a message via TeamManager', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeConfig({
        teamManager: {
          sendMessage,
          broadcast: vi.fn(),
        },
      }),
    );

    const invocation = tool.build({
      to: 'alice',
      message: 'hello',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('alice');
    expect(sendMessage).toHaveBeenCalledWith('alice', 'hello', undefined);
  });

  it('broadcasts with "*"', async () => {
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeConfig({
        teamManager: {
          sendMessage: vi.fn(),
          broadcast,
        },
      }),
    );

    const invocation = tool.build({
      to: '*',
      message: 'hey all',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('broadcast');
    expect(broadcast).toHaveBeenCalledWith('hey all', 'leader');
  });

  it('returns error when no team is active', async () => {
    const tool = new SendMessageTool(makeConfig());
    const invocation = tool.build({
      to: 'alice',
      message: 'hello',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });

  it('routes shutdown_request via requestShutdown', async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeConfig({
        teamManager: {
          sendMessage: vi.fn(),
          broadcast: vi.fn(),
          requestShutdown,
        },
      }),
    );

    const invocation = tool.build({
      to: 'bob',
      message: 'Please shut down.',
      type: 'shutdown_request',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Shutdown');
    expect(result.llmContent).toContain('bob');
    expect(requestShutdown).toHaveBeenCalledWith('bob');
  });

  it('validates required params', () => {
    const tool = new SendMessageTool(makeConfig());
    expect(() => tool.build({} as never)).toThrow();
    expect(() => tool.build({ to: 'alice' } as never)).toThrow();
  });
});
