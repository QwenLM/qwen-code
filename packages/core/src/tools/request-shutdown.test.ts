/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { RequestShutdownTool } from './request-shutdown.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import type { ApprovalMode, Config } from '../config/config.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';

const DEFAULT_MODE = 'default' as ApprovalMode;

function makeTeamConfig(opts?: {
  teamManager?: {
    requestShutdown: (...args: unknown[]) => Promise<void>;
  } | null;
  approvalMode?: ApprovalMode;
}) {
  return {
    getTeamManager: () => opts?.teamManager ?? null,
    getBackgroundTaskRegistry: () => new BackgroundTaskRegistry(),
    getApprovalMode: () => opts?.approvalMode ?? DEFAULT_MODE,
  } as unknown as Config;
}

describe('RequestShutdownTool', () => {
  it('has the correct name', () => {
    const tool = new RequestShutdownTool(makeTeamConfig());
    expect(tool.name).toBe('request_shutdown');
  });

  it('routes to TeamManager.requestShutdown', async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const tool = new RequestShutdownTool(
      makeTeamConfig({ teamManager: { requestShutdown } }),
    );

    const invocation = tool.build({ to: 'bob' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Shutdown');
    expect(result.llmContent).toContain('bob');
    expect(requestShutdown).toHaveBeenCalledWith('bob');
  });

  it('carries no message field — it is a control action, not content', () => {
    // The whole point of splitting this out of send_message (#9276): this tool
    // cannot carry text, and send_message cannot carry control. Neither can
    // impersonate the other.
    const tool = new RequestShutdownTool(makeTeamConfig());
    const schema = tool.schema.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(['to']);
  });

  it('refuses a teammate caller even if the tool reaches its registry', async () => {
    // Registration already keeps this out of a subagent-context registry, so
    // this path should be unreachable. Kept as defence in depth: reaching it
    // would mean a registry was built without `forSubAgent`, and requestShutdown
    // writes the mailbox entry as `from: LEADER_NAME`.
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const tool = new RequestShutdownTool(
      makeTeamConfig({ teamManager: { requestShutdown } }),
    );

    const invocation = tool.build({ to: 'bob' });
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

  it('errors without an active team', async () => {
    const tool = new RequestShutdownTool(makeTeamConfig());
    const invocation = tool.build({ to: 'bob' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });

  it('surfaces an unknown teammate as a tool error', async () => {
    const requestShutdown = vi
      .fn()
      .mockRejectedValue(new Error('Teammate "ghost" not found.'));
    const tool = new RequestShutdownTool(
      makeTeamConfig({ teamManager: { requestShutdown } }),
    );

    const invocation = tool.build({ to: 'ghost' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not found');
  });
});
