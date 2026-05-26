/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentsService — workspace agent CRUD delegating to SubagentManager.
 *
 * Validates `originatorClientId` on mutations (create/update/delete)
 * against `deps.knownClientIds()` and publishes workspace events
 * after successful state changes.
 */

import {
  SubagentError,
  SubagentErrorCode,
  type SubagentConfig,
  type SubagentLevel,
  type SubagentManager,
} from '@qwen-code/qwen-code-core';

import {
  STATUS_SCHEMA_VERSION,
  type ServeWorkspaceAgentDetail,
  type ServeWorkspaceAgentSummary,
  type ServeWorkspaceAgentsStatus,
} from '@qwen-code/acp-bridge/status';

import type {
  AgentsService,
  CreateAgentParams,
  UpdateAgentParams,
  WorkspaceRequestContext,
} from './types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AgentsServiceDeps {
  /** The daemon-scoped SubagentManager instance. */
  subagentManager: SubagentManager;
  /** Absolute path to the workspace root. */
  boundWorkspace: string;
  /** Publish a workspace-wide event to all sessions' SSE buses. */
  publishWorkspaceEvent: (event: {
    type: string;
    data: unknown;
    originatorClientId?: string;
  }) => void;
  /** Set of all currently known client ids across live sessions. */
  knownClientIds: () => ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentsService(deps: AgentsServiceDeps): AgentsService {
  const { subagentManager, boundWorkspace, publishWorkspaceEvent, knownClientIds } = deps;

  function validateClientId(ctx: WorkspaceRequestContext): void {
    const clientId = ctx.originatorClientId;
    if (clientId === undefined) return;
    if (!knownClientIds().has(clientId)) {
      throw new Error(
        `Client id "${clientId}" is not registered for this workspace`,
      );
    }
  }

  function toSummary(config: SubagentConfig): ServeWorkspaceAgentSummary {
    const summary: ServeWorkspaceAgentSummary = {
      kind: 'agent',
      name: config.name,
      description: config.description,
      level: config.level,
      isBuiltin: config.isBuiltin === true || config.level === 'builtin',
      hasTools: Array.isArray(config.tools) && config.tools.length > 0,
    };
    if (config.model) summary.model = config.model;
    if (config.color) summary.color = config.color;
    if (config.background !== undefined) summary.background = config.background;
    if (config.approvalMode) summary.approvalMode = config.approvalMode;
    if (config.extensionName) summary.extensionName = config.extensionName;
    if (config.filePath) summary.filePath = config.filePath;
    return summary;
  }

  function toDetail(config: SubagentConfig): ServeWorkspaceAgentDetail {
    const detail: ServeWorkspaceAgentDetail = {
      ...toSummary(config),
      systemPrompt: config.systemPrompt,
    };
    if (config.tools) detail.tools = [...config.tools];
    if (config.disallowedTools) {
      detail.disallowedTools = [...config.disallowedTools];
    }
    if (config.runConfig) {
      const runConfig: ServeWorkspaceAgentDetail['runConfig'] = {};
      if (typeof config.runConfig.max_time_minutes === 'number') {
        runConfig.max_time_minutes = config.runConfig.max_time_minutes;
      }
      if (typeof config.runConfig.max_turns === 'number') {
        runConfig.max_turns = config.runConfig.max_turns;
      }
      detail.runConfig = runConfig;
    }
    return detail;
  }

  return {
    async listAgents(ctx: WorkspaceRequestContext): Promise<ServeWorkspaceAgentsStatus> {
      const agents = await subagentManager.listSubagents({ force: true });
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        agents: agents.map(toSummary),
      };
    },

    async getAgent(
      ctx: WorkspaceRequestContext,
      agentName: string,
    ): Promise<ServeWorkspaceAgentDetail | undefined> {
      const config = await subagentManager.loadSubagent(agentName);
      if (!config) return undefined;
      return toDetail(config);
    },

    async createAgent(
      ctx: WorkspaceRequestContext,
      params: CreateAgentParams,
    ): Promise<ServeWorkspaceAgentDetail> {
      validateClientId(ctx);

      const level: SubagentLevel = params.level === 'user' ? 'user' : 'project';

      const config: SubagentConfig = {
        name: params.name,
        description: params.description,
        systemPrompt: params.systemPrompt,
        level,
      };
      if (params.tools) config.tools = params.tools;
      if (params.disallowedTools) config.disallowedTools = params.disallowedTools;
      if (params.model) config.model = params.model;
      if (params.color) config.color = params.color;
      if (params.background !== undefined) config.background = params.background;
      if (params.approvalMode) config.approvalMode = params.approvalMode;
      if (params.runConfig) config.runConfig = params.runConfig;

      await subagentManager.createSubagent(config, { level });

      const created = await subagentManager.loadSubagent(params.name, level);
      if (!created) {
        throw new Error('Agent creation succeeded but reload failed');
      }

      publishWorkspaceEvent({
        type: 'agent_created',
        data: { agentName: params.name },
        ...(ctx.originatorClientId ? { originatorClientId: ctx.originatorClientId } : {}),
      });

      return toDetail(created);
    },

    async updateAgent(
      ctx: WorkspaceRequestContext,
      agentName: string,
      params: UpdateAgentParams,
    ): Promise<ServeWorkspaceAgentDetail> {
      validateClientId(ctx);

      const existing = await subagentManager.loadSubagent(agentName);
      if (!existing) {
        throw new SubagentError(
          `Subagent "${agentName}" not found`,
          SubagentErrorCode.NOT_FOUND,
          agentName,
        );
      }

      const updates: Partial<SubagentConfig> = {};
      if (params.description !== undefined) updates.description = params.description;
      if (params.systemPrompt !== undefined) updates.systemPrompt = params.systemPrompt;
      if (params.tools !== undefined) updates.tools = params.tools;
      if (params.disallowedTools !== undefined) updates.disallowedTools = params.disallowedTools;
      if (params.model !== undefined) updates.model = params.model;
      if (params.color !== undefined) updates.color = params.color;
      if (params.background !== undefined) updates.background = params.background;
      if (params.approvalMode !== undefined) updates.approvalMode = params.approvalMode;
      if (params.runConfig !== undefined) updates.runConfig = params.runConfig;

      await subagentManager.updateSubagent(agentName, updates, existing.level);

      const updated = await subagentManager.loadSubagent(agentName, existing.level);
      if (!updated) {
        throw new Error('Agent update succeeded but reload failed');
      }

      publishWorkspaceEvent({
        type: 'agent_updated',
        data: { agentName },
        ...(ctx.originatorClientId ? { originatorClientId: ctx.originatorClientId } : {}),
      });

      return toDetail(updated);
    },

    async deleteAgent(
      ctx: WorkspaceRequestContext,
      agentName: string,
    ): Promise<{ deleted: boolean }> {
      validateClientId(ctx);

      try {
        await subagentManager.deleteSubagent(agentName);
      } catch (err) {
        if (
          err instanceof SubagentError &&
          err.code === SubagentErrorCode.NOT_FOUND
        ) {
          return { deleted: false };
        }
        throw err;
      }

      publishWorkspaceEvent({
        type: 'agent_deleted',
        data: { agentName },
        ...(ctx.originatorClientId ? { originatorClientId: ctx.originatorClientId } : {}),
      });

      return { deleted: true };
    },
  };
}
