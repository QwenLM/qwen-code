/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadAgentDirectory,
  type AgentProvider,
  type AgentProviderContribution,
} from './agentProvider.js';

export class ProjectAgentProvider implements AgentProvider {
  readonly id = 'project' as const;

  constructor(private readonly agentsDir: string) {}

  load(): Promise<AgentProviderContribution> {
    return loadAgentDirectory(this.agentsDir, this.id);
  }
}
