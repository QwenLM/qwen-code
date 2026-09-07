/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Turning a roster entry into the persona its own process runs as.
 *
 * An agent session is spawned with nothing but its identity — the bridge's
 * spawn request has no persona field — so the child resolves the rest here,
 * from the same workspace files the dispatcher reads. Doing it in the child
 * rather than passing a persona across the wire keeps one source of truth: the
 * agent definition on disk, read at the moment the body starts, which is also
 * what makes definition drift observable (§9.4) rather than frozen at spawn.
 */

import type { Config } from '../../config/config.js';
import type { SubagentConfig } from '../../subagents/types.js';
import { DEFAULT_BUILTIN_SUBAGENT_TYPE } from '../../subagents/builtin-agents.js';
import { buildAgentToolConfig } from './capability.js';
import { readWorkspaceAgents } from './store.js';
import type { WorkspaceAgent } from './types.js';

export type AgentPersonaResolution =
  | {
      status: 'resolved';
      agent: WorkspaceAgent;
      definition: SubagentConfig;
      systemPrompt: string;
      toolConfig: ReturnType<typeof buildAgentToolConfig>;
    }
  | { status: 'unknown_agent'; error: string }
  | { status: 'unavailable'; error: string };

/**
 * Resolves what this process should be, from the id it was spawned with.
 *
 * Fails closed in both directions that matter. An id with no roster entry means
 * the agent was deleted while its session was starting; a definition that will
 * not load means the workspace is misconfigured. Neither may fall back to a
 * generic persona — an agent that quietly becomes "some assistant" would still
 * post under its name, and every guard in the capability boundary is derived
 * from the definition it would have skipped.
 */
export async function resolveAgentPersona(
  config: Config,
  agentId: string,
): Promise<AgentPersonaResolution> {
  const projectRoot = config.getProjectRoot();
  let agent: WorkspaceAgent | undefined;
  try {
    agent = (await readWorkspaceAgents(projectRoot)).find(
      (candidate) => candidate.id === agentId,
    );
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!agent) {
    return {
      status: 'unknown_agent',
      error: `No agent "${agentId}" in this workspace's roster.`,
    };
  }
  if (agent.enabled === false) {
    return {
      status: 'unavailable',
      error: `Agent "${agent.name}" is disabled.`,
    };
  }

  const manager = config.getSubagentManager();
  const agentType = agent.agentType ?? DEFAULT_BUILTIN_SUBAGENT_TYPE;
  try {
    const loaded = await manager.loadSubagent(agentType);
    if (!loaded) {
      return {
        status: 'unavailable',
        error: `Agent definition "${agentType}" is unavailable.`,
      };
    }
    // The roster's model overrides the definition's: it is the field a person
    // set for this identity, and the definition is shared across identities.
    const definition = agent.model ? { ...loaded, model: agent.model } : loaded;
    const runtime = await manager.convertToRuntimeConfig(definition, config);
    return {
      status: 'resolved',
      agent,
      definition,
      systemPrompt:
        runtime.promptConfig.systemPrompt ??
        runtime.promptConfig.renderedSystemPrompt ??
        '',
      // The read-only ceiling is applied here, in the process that will run the
      // tools, so a session cannot be started with a wider surface than the
      // boundary allows and then narrowed afterwards.
      toolConfig: buildAgentToolConfig(runtime.toolConfig),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
