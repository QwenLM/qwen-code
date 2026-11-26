/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadAgentsFromDirectory } from '../agentLoader.js';
import type {
  AgentResourceDefinition,
  AgentResourceLoadError,
  AgentResourceSource,
} from '../types.js';

export interface AgentProviderContribution {
  source: Extract<AgentResourceSource, 'user' | 'project'>;
  agents: AgentResourceDefinition[];
  loadErrors: AgentResourceLoadError[];
}

export interface AgentProvider {
  readonly id: Extract<AgentResourceSource, 'user' | 'project'>;
  load(): Promise<AgentProviderContribution>;
}

export async function loadAgentDirectory(
  agentsDir: string,
  source: Extract<AgentResourceSource, 'user' | 'project'>,
): Promise<AgentProviderContribution> {
  const result = await loadAgentsFromDirectory(agentsDir, { source });
  return {
    source,
    agents: result.agents,
    loadErrors: result.errors,
  };
}
