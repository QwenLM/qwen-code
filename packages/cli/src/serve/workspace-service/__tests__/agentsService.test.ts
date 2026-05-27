/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the core module so the service implementation can import it
// without pulling in the full dependency tree (undici via config.ts).
// vi.mock is hoisted — the factory must be self-contained.
vi.mock('@qwen-code/qwen-code-core', () => {
  class SubagentError extends Error {
    code: string;
    subagentName?: string;
    constructor(message: string, code: string, subagentName?: string) {
      super(message);
      this.name = 'SubagentError';
      this.code = code;
      this.subagentName = subagentName;
    }
  }
  const SubagentErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    FILE_ERROR: 'FILE_ERROR',
    ALREADY_EXISTS: 'ALREADY_EXISTS',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INVALID_CONFIG: 'INVALID_CONFIG',
    INVALID_NAME: 'INVALID_NAME',
    TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  } as const;
  return { SubagentError, SubagentErrorCode };
});

// Import SubagentError/SubagentErrorCode from the mock for test assertions.
const { SubagentError, SubagentErrorCode } = (await import(
  '@qwen-code/qwen-code-core'
)) as {
  SubagentError: new (
    message: string,
    code: string,
    name?: string,
  ) => Error & { code: string; subagentName?: string };
  SubagentErrorCode: Record<string, string>;
};

import {
  createAgentsService,
  type AgentsServiceDeps,
} from '../agentsService.js';
import type { WorkspaceRequestContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SubagentConfig shape matching core's interface. */
interface MockSubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  level: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  color?: string;
  background?: boolean;
  approvalMode?: string;
  extensionName?: string;
  filePath?: string;
  isBuiltin?: boolean;
  runConfig?: { max_time_minutes?: number; max_turns?: number };
}

function makeSubagentConfig(
  overrides?: Partial<MockSubagentConfig>,
): MockSubagentConfig {
  return {
    name: 'test-agent',
    description: 'A test agent',
    systemPrompt: 'You are a test agent.',
    level: 'project',
    tools: ['Bash'],
    ...overrides,
  };
}

/** Minimal mock matching SubagentManager's CRUD methods. */
interface MockManager {
  listSubagents: ReturnType<typeof vi.fn>;
  loadSubagent: ReturnType<typeof vi.fn>;
  createSubagent: ReturnType<typeof vi.fn>;
  updateSubagent: ReturnType<typeof vi.fn>;
  deleteSubagent: ReturnType<typeof vi.fn>;
}

function makeMockManager(): MockManager {
  return {
    listSubagents: vi.fn().mockResolvedValue([makeSubagentConfig()]),
    loadSubagent: vi.fn().mockResolvedValue(makeSubagentConfig()),
    createSubagent: vi.fn().mockResolvedValue(undefined),
    updateSubagent: vi.fn().mockResolvedValue(undefined),
    deleteSubagent: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(
  overrides?: Partial<Record<string, unknown>>,
): AgentsServiceDeps {
  const base = {
    subagentManager: makeMockManager(),
    boundWorkspace: '/workspace',
    publishWorkspaceEvent: vi.fn(),
    knownClientIds: () => new Set(['client-1', 'client-2']),
    ...overrides,
  };
  return base as unknown as AgentsServiceDeps;
}

function makeCtx(
  overrides?: Partial<WorkspaceRequestContext>,
): WorkspaceRequestContext {
  return {
    originatorClientId: 'client-1',
    route: 'POST /workspace/agents',
    workspaceCwd: '/workspace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentsService', () => {
  describe('listAgents', () => {
    it('delegates to subagentManager.listSubagents with force: true', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx();

      const result = await svc.listAgents(ctx);

      expect(deps.subagentManager.listSubagents).toHaveBeenCalledWith({
        force: true,
      });
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.name).toBe('test-agent');
      expect(result.workspaceCwd).toBe('/workspace');
    });

    it('maps SubagentConfig to ServeWorkspaceAgentSummary correctly', async () => {
      const config = makeSubagentConfig({
        model: 'gpt-4',
        color: 'blue',
        background: true,
        approvalMode: 'auto-edit',
        extensionName: 'ext-1',
        filePath: '/workspace/.qwen/agents/test.md',
      });
      const manager = makeMockManager();
      (manager.listSubagents as ReturnType<typeof vi.fn>).mockResolvedValue([
        config,
      ]);
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      const result = await svc.listAgents(makeCtx());
      const agent = result.agents[0]!;

      expect(agent.kind).toBe('agent');
      expect(agent.name).toBe('test-agent');
      expect(agent.description).toBe('A test agent');
      expect(agent.level).toBe('project');
      expect(agent.isBuiltin).toBe(false);
      expect(agent.hasTools).toBe(true);
      expect(agent.model).toBe('gpt-4');
      expect(agent.color).toBe('blue');
      expect(agent.background).toBe(true);
      expect(agent.approvalMode).toBe('auto-edit');
      expect(agent.extensionName).toBe('ext-1');
      expect(agent.filePath).toBe('/workspace/.qwen/agents/test.md');
    });
  });

  describe('getAgent', () => {
    it('delegates to subagentManager.loadSubagent', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);

      const result = await svc.getAgent(makeCtx(), 'test-agent');

      expect(deps.subagentManager.loadSubagent).toHaveBeenCalledWith(
        'test-agent',
      );
      expect(result).toBeDefined();
      expect(result!.name).toBe('test-agent');
      expect(result!.systemPrompt).toBe('You are a test agent.');
    });

    it('returns undefined when agent not found', async () => {
      const manager = makeMockManager();
      (manager.loadSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      const result = await svc.getAgent(makeCtx(), 'nonexistent');

      expect(result).toBeUndefined();
    });

    it('returns detail including tools and runConfig', async () => {
      const config = makeSubagentConfig({
        tools: ['Bash', 'Read'],
        disallowedTools: ['Write'],
        runConfig: { max_time_minutes: 10, max_turns: 5 },
      });
      const manager = makeMockManager();
      (manager.loadSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(
        config,
      );
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      const result = await svc.getAgent(makeCtx(), 'test-agent');

      expect(result!.tools).toEqual(['Bash', 'Read']);
      expect(result!.disallowedTools).toEqual(['Write']);
      expect(result!.runConfig).toEqual({ max_time_minutes: 10, max_turns: 5 });
    });
  });

  describe('createAgent', () => {
    it('validates clientId before creating', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'unknown-client' });

      await expect(
        svc.createAgent(ctx, {
          name: 'new-agent',
          description: 'desc',
          systemPrompt: 'prompt',
        }),
      ).rejects.toThrow('not registered');

      expect(deps.subagentManager.createSubagent).not.toHaveBeenCalled();
    });

    it('allows mutation when clientId is undefined', async () => {
      const deps = makeDeps();
      const manager = deps.subagentManager as unknown as MockManager;
      // collision preflight returns null, post-create reload returns config
      (manager.loadSubagent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSubagentConfig());
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      const result = await svc.createAgent(ctx, {
        name: 'test-agent',
        description: 'desc',
        systemPrompt: 'prompt',
      });

      expect(result.name).toBe('test-agent');
      expect(deps.subagentManager.createSubagent).toHaveBeenCalled();
    });

    it('allows mutation when clientId is in knownClientIds', async () => {
      const deps = makeDeps();
      const manager = deps.subagentManager as unknown as MockManager;
      (manager.loadSubagent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSubagentConfig());
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-1' });

      const result = await svc.createAgent(ctx, {
        name: 'test-agent',
        description: 'desc',
        systemPrompt: 'prompt',
      });

      expect(result.name).toBe('test-agent');
    });

    it('delegates to subagentManager.createSubagent with correct config', async () => {
      const deps = makeDeps();
      const manager = deps.subagentManager as unknown as MockManager;
      (manager.loadSubagent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeSubagentConfig({ name: 'new-agent', level: 'user' }),
        );
      const svc = createAgentsService(deps);
      const ctx = makeCtx();

      await svc.createAgent(ctx, {
        name: 'new-agent',
        description: 'A new agent',
        systemPrompt: 'Do things',
        level: 'user',
        tools: ['Bash'],
        model: 'gpt-4',
      });

      expect(deps.subagentManager.createSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'new-agent',
          description: 'A new agent',
          systemPrompt: 'Do things',
          level: 'user',
          tools: ['Bash'],
          model: 'gpt-4',
        }),
        { level: 'user' },
      );
    });

    it('publishes agent_changed event after successful creation', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-1' });

      // loadSubagent is called twice: once for collision preflight (return null),
      // once for post-create reload (return config).
      const manager = deps.subagentManager as unknown as MockManager;
      (manager.loadSubagent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null) // collision preflight
        .mockResolvedValueOnce(makeSubagentConfig()); // post-create reload

      await svc.createAgent(ctx, {
        name: 'test-agent',
        description: 'desc',
        systemPrompt: 'prompt',
      });

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent_changed',
        data: { change: 'created', name: 'test-agent', level: 'project' },
        originatorClientId: 'client-1',
      });
    });

    it('does not include originatorClientId in event when undefined', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      // loadSubagent: collision preflight (null) + post-create reload
      const manager = deps.subagentManager as unknown as MockManager;
      (manager.loadSubagent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSubagentConfig());

      await svc.createAgent(ctx, {
        name: 'test-agent',
        description: 'desc',
        systemPrompt: 'prompt',
      });

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent_changed',
        data: { change: 'created', name: 'test-agent', level: 'project' },
      });
    });

    it('throws when agent already exists at target level', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      // loadSubagent returns an existing config for collision preflight
      const manager = deps.subagentManager as unknown as MockManager;
      (manager.loadSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSubagentConfig(),
      );

      await expect(
        svc.createAgent(makeCtx(), {
          name: 'test-agent',
          description: 'desc',
          systemPrompt: 'prompt',
        }),
      ).rejects.toThrow('agent_already_exists');

      expect(manager.createSubagent).not.toHaveBeenCalled();
    });

    it('defaults level to project when not specified', async () => {
      const deps = makeDeps();
      const manager = deps.subagentManager as unknown as MockManager;
      (manager.loadSubagent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeSubagentConfig());
      const svc = createAgentsService(deps);

      await svc.createAgent(makeCtx(), {
        name: 'test-agent',
        description: 'desc',
        systemPrompt: 'prompt',
      });

      expect(deps.subagentManager.createSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'project' }),
        { level: 'project' },
      );
    });
  });

  describe('updateAgent', () => {
    it('validates clientId before updating', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'unknown-client' });

      await expect(
        svc.updateAgent(ctx, 'test-agent', { description: 'updated' }),
      ).rejects.toThrow('not registered');

      expect(deps.subagentManager.updateSubagent).not.toHaveBeenCalled();
    });

    it('allows mutation when clientId is undefined', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      const result = await svc.updateAgent(ctx, 'test-agent', {
        description: 'updated',
      });

      expect(result.name).toBe('test-agent');
    });

    it('throws NOT_FOUND when agent does not exist', async () => {
      const manager = makeMockManager();
      (manager.loadSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      await expect(
        svc.updateAgent(makeCtx(), 'nonexistent', { description: 'x' }),
      ).rejects.toThrow('not found');
    });

    it('delegates to subagentManager.updateSubagent with correct params', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);

      await svc.updateAgent(makeCtx(), 'test-agent', {
        description: 'updated desc',
        systemPrompt: 'new prompt',
      });

      expect(deps.subagentManager.updateSubagent).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          description: 'updated desc',
          systemPrompt: 'new prompt',
        }),
        'project', // existing.level
      );
    });

    it('publishes agent_changed event after successful update', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-2' });

      await svc.updateAgent(ctx, 'test-agent', { description: 'updated' });

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent_changed',
        data: { change: 'updated', name: 'test-agent', level: 'project' },
        originatorClientId: 'client-2',
      });
    });
  });

  describe('deleteAgent', () => {
    it('validates clientId before deleting', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'unknown-client' });

      await expect(svc.deleteAgent(ctx, 'test-agent')).rejects.toThrow(
        'not registered',
      );

      expect(deps.subagentManager.deleteSubagent).not.toHaveBeenCalled();
    });

    it('allows mutation when clientId is undefined', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: undefined });

      const result = await svc.deleteAgent(ctx, 'test-agent');

      expect(result.deleted).toBe(true);
    });

    it('returns deleted: true on successful deletion', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);

      const result = await svc.deleteAgent(makeCtx(), 'test-agent');

      expect(result.deleted).toBe(true);
      expect(deps.subagentManager.deleteSubagent).toHaveBeenCalledWith(
        'test-agent',
      );
    });

    it('returns deleted: false when agent not found', async () => {
      const manager = makeMockManager();
      (manager.deleteSubagent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SubagentError(
          'not found',
          SubagentErrorCode['NOT_FOUND'],
          'missing',
        ),
      );
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      const result = await svc.deleteAgent(makeCtx(), 'missing');

      expect(result.deleted).toBe(false);
    });

    it('publishes agent_changed event after successful deletion', async () => {
      const deps = makeDeps();
      const svc = createAgentsService(deps);
      const ctx = makeCtx({ originatorClientId: 'client-1' });

      await svc.deleteAgent(ctx, 'test-agent');

      expect(deps.publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'agent_changed',
        data: { change: 'deleted', name: 'test-agent' },
        originatorClientId: 'client-1',
      });
    });

    it('does not publish event when agent not found', async () => {
      const manager = makeMockManager();
      (manager.deleteSubagent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SubagentError(
          'not found',
          SubagentErrorCode['NOT_FOUND'],
          'missing',
        ),
      );
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      await svc.deleteAgent(makeCtx(), 'missing');

      expect(deps.publishWorkspaceEvent).not.toHaveBeenCalled();
    });

    it('re-throws non-NOT_FOUND errors', async () => {
      const manager = makeMockManager();
      (manager.deleteSubagent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SubagentError(
          'file error',
          SubagentErrorCode['FILE_ERROR'],
          'test-agent',
        ),
      );
      const deps = makeDeps({ subagentManager: manager });
      const svc = createAgentsService(deps);

      await expect(svc.deleteAgent(makeCtx(), 'test-agent')).rejects.toThrow(
        'file error',
      );
    });
  });
});
