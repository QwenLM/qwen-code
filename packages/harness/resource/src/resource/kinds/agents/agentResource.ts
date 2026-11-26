/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentProviderContribution } from './providers/agentProvider.js';
import type {
  AgentResourceDefinition,
  AgentResourceLoadError,
} from './types.js';
import type {
  AgentResourceView,
  AgentResourceSnapshot,
} from '../../core/resourceViews.js';
export interface AgentResourceOptions {
  load: () => Promise<AgentProviderContribution>;
  /** Join an active read or enqueue a fresh read. */
  reloadMode: 'join' | 'queue';
  disposedError?: string;
}

/** Agent candidates and explicit refresh state for one scope. */
export class AgentResource implements AgentResourceView {
  private snapshot: AgentResourceSnapshot = {
    discoveredAgents: [],
    loadErrors: [],
  };
  private loaded?: AgentProviderContribution;
  private reading?: Promise<AgentProviderContribution>;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly options: AgentResourceOptions) {}

  private assertActive(): void {
    if (this.stopped)
      throw new Error(this.options.disposedError ?? 'AgentResource is disposed');
  }

  initialize(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error(this.options.disposedError ?? 'AgentResource is disposed'));
    return this.options.reloadMode === 'queue'
      ? this.reload()
      : this.read(false).then((contribution) => {
          this.assertActive();
          this.commit(contribution);
        });
  }

  reload(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new Error(this.options.disposedError ?? 'AgentResource is disposed'));
    const refresh =
      this.options.reloadMode === 'queue'
        ? this.queue
            .then(() => {
              this.assertActive();
              return this.read(true);
            })
            .then((contribution) => {
              this.assertActive();
              this.commit(contribution);
            })
        : this.read(true).then((contribution) => {
            this.assertActive();
            this.commit(contribution);
          });
    this.queue = refresh.catch(() => undefined);
    return refresh;
  }

  private read(reload: boolean): Promise<AgentProviderContribution> {
    if (this.stopped)
      return Promise.reject(new Error(this.options.disposedError ?? 'AgentResource is disposed'));
    if (this.reading) return this.reading;
    if (!reload && this.loaded) return Promise.resolve(this.loaded);
    const reading = this.options.load().then((snapshot) => {
      if (!this.stopped && this.options.reloadMode === 'join') this.loaded = snapshot;
      return snapshot;
    });
    this.reading = reading;
    void reading
      .finally(() => {
        if (this.reading === reading) this.reading = undefined;
      })
      .catch(() => undefined);
    return reading;
  }

  private commit(contribution: AgentProviderContribution): void {
    this.snapshot = {
      discoveredAgents: contribution.agents.map(cloneAgentDefinition),
      loadErrors: contribution.loadErrors.map((error) => ({ ...error })),
    };
  }

  getAllDiscoveredAgents(): AgentResourceDefinition[] {
    return this.snapshot.discoveredAgents.map(cloneAgentDefinition);
  }
  getLoadErrors(): readonly AgentResourceLoadError[] {
    return this.snapshot.loadErrors.map((error) => ({ ...error }));
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.queue, this.reading?.catch(() => undefined)]);
  }
}

function cloneAgentDefinition(
  agent: AgentResourceDefinition,
): AgentResourceDefinition {
  return {
    ...agent,
    tools: agent.tools ? [...agent.tools] : undefined,
    disallowedTools: agent.disallowedTools
      ? [...agent.disallowedTools]
      : undefined,
    mcpServers: agent.mcpServers?.map((server) =>
      typeof server === 'string'
        ? server
        : Object.fromEntries(
            Object.entries(server).map(([name, config]) => [
              name,
              {
                ...config,
                args: config.args ? [...config.args] : undefined,
                env: config.env ? { ...config.env } : undefined,
                headers: config.headers ? { ...config.headers } : undefined,
                include_tools: config.include_tools
                  ? [...config.include_tools]
                  : undefined,
                exclude_tools: config.exclude_tools
                  ? [...config.exclude_tools]
                  : undefined,
              },
            ]),
          ),
    ),
    skills: agent.skills ? [...agent.skills] : undefined,
    hooks: agent.hooks
      ? Object.fromEntries(
          Object.entries(agent.hooks).map(([event, groups]) => [
            event,
            groups.map((group) => ({
              ...group,
              hooks: group.hooks.map((hook) => ({
                ...hook,
                ...('args' in hook && hook.args
                  ? { args: [...hook.args] }
                  : {}),
                ...('headers' in hook && hook.headers
                  ? { headers: { ...hook.headers } }
                  : {}),
                ...('allowedEnvVars' in hook && hook.allowedEnvVars
                  ? { allowedEnvVars: [...hook.allowedEnvVars] }
                  : {}),
              })),
            })),
          ]),
        )
      : undefined,
    metadata: { ...agent.metadata },
  };
}
