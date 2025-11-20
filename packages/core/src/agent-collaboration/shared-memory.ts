/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

/**
 * Shared memory system for agent collaboration.
 * Allows agents to store and retrieve information to coordinate their work.
 */
export class AgentSharedMemory {
  private memory: Map<string, unknown> = new Map();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    // Use config to log initialization if needed
    void this.config;
  }

  /**
   * Store a value in the shared memory
   * @param key The key to store the value under
   * @param value The value to store
   * @param agentId Optional agent ID for tracking
   */
  async set(key: string, value: unknown, agentId?: string): Promise<void> {
    const entry = {
      value,
      timestamp: new Date().toISOString(),
      agentId: agentId || 'unknown',
    };
    this.memory.set(key, entry);
  }

  /**
   * Retrieve a value from the shared memory
   * @param key The key to retrieve the value for
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.memory.get(key);
    return entry ? (entry as { value: T }).value : undefined;
  }

  /**
   * Check if a key exists in the shared memory
   * @param key The key to check
   */
  async has(key: string): Promise<boolean> {
    return this.memory.has(key);
  }

  /**
   * Delete a key from the shared memory
   * @param key The key to delete
   */
  async delete(key: string): Promise<boolean> {
    return this.memory.delete(key);
  }

  /**
   * List all keys in the shared memory
   */
  async keys(): Promise<string[]> {
    return Array.from(this.memory.keys());
  }

  /**
   * Clear the entire shared memory
   */
  async clear(): Promise<void> {
    this.memory.clear();
  }

  /**
   * Get metadata about a stored value
   * @param key The key to get metadata for
   */
  async getMetadata(
    key: string,
  ): Promise<{ timestamp: string; agentId: string } | null> {
    const entry = this.memory.get(key);
    if (!entry) return null;

    const metadata = entry as { timestamp: string; agentId: string };
    return {
      timestamp: metadata.timestamp,
      agentId: metadata.agentId,
    };
  }

  /**
   * Update a value in shared memory by merging with existing data
   * @param key The key to update
   * @param updates Object containing updates to merge
   */
  async update(key: string, updates: Record<string, unknown>): Promise<void> {
    const current = (await this.get<Record<string, unknown>>(key)) || {};
    const merged = { ...current, ...updates };
    await this.set(key, merged);
  }

  /**
   * Add an item to an array in shared memory
   * @param key The key containing an array
   * @param item The item to add
   */
  async addItem(key: string, item: unknown): Promise<void> {
    const current = (await this.get<unknown[]>(key)) || [];
    current.push(item);
    await this.set(key, current);
  }

  /**
   * Initialize a team collaboration workspace
   * @param teamName Name of the team
   * @param members List of team members
   * @param task The main task for the team
   */
  async initializeTeamWorkspace(
    teamName: string,
    members: Array<{ name: string; role: string }>,
    task: string,
  ): Promise<void> {
    const teamKey = `team:${teamName}`;
    const teamData = {
      name: teamName,
      members,
      task,
      created: new Date().toISOString(),
      status: 'active',
      completedTasks: [],
      sharedContext: {
        initialTask: task,
        currentPhase: 'initial',
        progress: 0,
        results: {},
        communications: [],
      },
    };

    await this.set(teamKey, teamData);

    // Initialize each member's context
    for (const member of members) {
      await this.set(`agent:${member.name}:context`, {
        team: teamName,
        role: member.role,
        assignedTasks: [],
        completedTasks: [],
        knowledge: {},
        lastInteraction: new Date().toISOString(),
      });
    }
  }

  /**
   * Update team progress
   * @param teamName Name of the team
   * @param progress Current progress percentage
   * @param phase Current phase of the project
   * @param results Latest results
   */
  async updateTeamProgress(
    teamName: string,
    progress: number,
    phase: string,
    results?: Record<string, unknown>,
  ): Promise<void> {
    const teamKey = `team:${teamName}`;
    const teamData = await this.get<Record<string, unknown>>(teamKey);

    if (teamData) {
      const teamDataRecord = teamData as Record<string, unknown>;
      const sharedContext = teamDataRecord['sharedContext'] as Record<
        string,
        unknown
      >;
      const updatedData = {
        ...teamData,
        sharedContext: {
          ...sharedContext,
          progress,
          currentPhase: phase,
          results: results
            ? {
                ...(typeof sharedContext['results'] === 'object' &&
                sharedContext['results'] !== null
                  ? (sharedContext['results'] as Record<string, unknown>)
                  : {}),
                ...results,
              }
            : sharedContext['results'] || {},
        },
      };

      await this.set(teamKey, updatedData);
    }
  }
}
