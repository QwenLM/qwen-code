/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contextual information for the currently executing agent.
 * Used to propagate agent identity into hook inputs.
 */
export interface AgentContext {
  /** The unique ID of the agent. */
  agentId: string;
  /** The type/name of the agent (e.g., agent definition name). */
  agentType: string;
  /** Human-readable owner name used by shared task lists. */
  agentName?: string;
  /** Team identifier shared by cooperating agents. */
  teamName?: string;
}

/**
 * AsyncLocalStorage instance for agent context.
 */
const agentContext = new AsyncLocalStorage<AgentContext>();

/**
 * Runs a function within an agent context.
 *
 * @param context The agent context to set.
 * @param fn The function to run.
 * @returns The result of the function.
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContext.run(context, fn);
}

/**
 * Runs a function detached from any inherited agent context.
 *
 * @param fn The function to run without agent context.
 * @returns The result of the function.
 */
export function runWithoutAgentContext<T>(fn: () => T): T {
  return agentContext.exit(fn);
}

/**
 * Retrieves the current agent context.
 *
 * @returns The current AgentContext, or undefined if not in a subagent context.
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContext.getStore();
}
