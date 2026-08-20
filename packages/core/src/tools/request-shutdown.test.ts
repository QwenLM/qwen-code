/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import { RequestShutdownTool } from './request-shutdown.js';

function makeConfig(requestShutdown?: (to: string) => Promise<void>) {
  return {
    getTeamManager: () => (requestShutdown ? { requestShutdown } : null),
  } as unknown as Config;
}

describe('RequestShutdownTool', () => {
  it('has a control-only schema', () => {
    const tool = new RequestShutdownTool(makeConfig());
    const schema = tool.schema.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };

    expect(tool.name).toBe('request_shutdown');
    expect(Object.keys(schema.properties)).toEqual(['to']);
  });

  it('requests teammate shutdown as the leader', async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const result = await new RequestShutdownTool(makeConfig(requestShutdown))
      .build({ to: 'worker' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('worker');
    expect(requestShutdown).toHaveBeenCalledWith('worker');
  });

  it('rejects teammate callers', async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const invocation = new RequestShutdownTool(
      makeConfig(requestShutdown),
    ).build({ to: 'worker' });
    const result = await runWithTeammateIdentity(
      {
        agentName: 'attacker',
        teamName: 'team',
        agentId: 'attacker@team',
        isTeamLead: false,
      },
      () => invocation.execute(new AbortController().signal),
    );

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('Only the team leader');
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('rejects other subagent-like callers', async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const invocation = new RequestShutdownTool(
      makeConfig(requestShutdown),
    ).build({ to: 'worker' });
    const result = await runWithAgentContext('subagent', () =>
      invocation.execute(new AbortController().signal),
    );

    expect(result.error).toBeDefined();
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('errors when no team is active', async () => {
    const result = await new RequestShutdownTool(makeConfig())
      .build({ to: 'worker' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });
});
