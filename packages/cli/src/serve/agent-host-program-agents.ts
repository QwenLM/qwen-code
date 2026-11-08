/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview One workspace agent per program a joined Host offers.
 *
 * When a Host first reports an available program (session-multi-agent design §3.5 / decision 4),
 * the coordinator adds an agent named `<program>-<host name>` that runs that
 * program on that Host, unless the roster already has one for the pair. A
 * retired agent still counts, so deleting an auto-created agent sticks.
 * Agents and squads share one @-name space, so a name a squad holds gets a
 * suffix too.
 */

import type { SessionSquad } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { updateWorkspaceAgentsWithSquads } from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import {
  generateAgentId,
  isValidAgentName,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import {
  hostAvailablePrograms,
  type AgentHostView,
  type AgentProgram,
  type WorkspaceAgent,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';

const MAX_AGENT_NAME = 48;

/** `[A-Za-z0-9_-]` only: agent names cannot hold `@` or `.`. */
export function sanitizeHostNameForAgent(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return cleaned || 'host';
}

function hasAgentFor(
  agents: readonly WorkspaceAgent[],
  hostId: string,
  program: AgentProgram,
): boolean {
  return agents.some(
    (agent) =>
      agent.execution?.mode === 'managed-host' &&
      agent.execution.hostIds.includes(hostId) &&
      // No provider means "the host's default", which is qwen when offered
      // (`programForAgent` in the orchestrator).
      (agent.execution.provider ?? 'qwen') === program,
  );
}

/** A free name for `base`, or undefined if 99 suffixes are all taken. */
function uniqueAgentName(
  base: string,
  agents: readonly WorkspaceAgent[],
  squads: ReadonlyArray<Pick<SessionSquad, 'name'>>,
): string | undefined {
  // Retired agents and squads keep their names (the create route refuses
  // them too).
  const taken = new Set(
    [...agents, ...squads].map((entry) => entry.name.toLowerCase()),
  );
  const trimmed = base.slice(0, MAX_AGENT_NAME).replace(/[-_]+$/, '');
  if (isValidAgentName(trimmed) && !taken.has(trimmed.toLowerCase())) {
    return trimmed;
  }
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base
      .slice(0, MAX_AGENT_NAME - suffix.length)
      .replace(/[-_]+$/, '')}${suffix}`;
    if (isValidAgentName(candidate) && !taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The agents to add for `programs` on `host`, given the current roster and
 * squads. Pure, so the naming rules are testable without a store.
 */
export function planHostProgramAgents(
  agents: readonly WorkspaceAgent[],
  host: Pick<AgentHostView, 'id' | 'name'>,
  programs: readonly AgentProgram[],
  options: {
    now?: number;
    newId?: () => string;
    squads?: ReadonlyArray<Pick<SessionSquad, 'name'>>;
  } = {},
): WorkspaceAgent[] {
  const added: WorkspaceAgent[] = [];
  const hostPart = sanitizeHostNameForAgent(host.name);
  for (const program of programs) {
    const roster = [...agents, ...added];
    if (hasAgentFor(roster, host.id, program)) continue;
    const name = uniqueAgentName(
      `${program}-${hostPart}`,
      roster,
      options.squads ?? [],
    );
    if (!name) continue;
    added.push({
      id: (options.newId ?? generateAgentId)(),
      name,
      createdAt: options.now ?? Date.now(),
      execution: {
        mode: 'managed-host',
        hostIds: [host.id],
        provider: program,
      },
    });
  }
  return added;
}

/**
 * Remembers, per (workspace, host), which programs were already ensured, so
 * the roster transaction runs only when a Host reports a new program — not on
 * every 5 s heartbeat.
 */
export function createHostProgramAgentEnsurer(
  update: typeof updateWorkspaceAgentsWithSquads = updateWorkspaceAgentsWithSquads,
): (workspaceCwd: string, host: AgentHostView) => Promise<WorkspaceAgent[]> {
  const ensured = new Map<string, Set<AgentProgram>>();
  return async (workspaceCwd, host) => {
    const key = `${workspaceCwd}\0${host.id}`;
    const known = ensured.get(key) ?? new Set<AgentProgram>();
    const missing = hostAvailablePrograms(host).filter(
      (program) => !known.has(program),
    );
    if (missing.length === 0) return [];
    let added: WorkspaceAgent[] = [];
    await update(workspaceCwd, (agents, squads) => {
      added = planHostProgramAgents(agents, host, missing, { squads });
      return added.length > 0 ? [...agents, ...added] : agents;
    });
    for (const program of missing) known.add(program);
    ensured.set(key, known);
    return added;
  };
}
