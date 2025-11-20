/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

/**
 * Interface for entries in shared memory with metadata
 */
interface MemoryEntry<T = unknown> {
  value: T;
  timestamp: string;
  agentId: string;
  dataType?: string; // Type information for structured data
  version?: number; // Version for tracking updates
}

/**
 * Shared memory system for agent collaboration.
 * Allows agents to store and retrieve information to coordinate their work.
 */
export class AgentSharedMemory {
  private memory: Map<string, MemoryEntry> = new Map();
  private config: Config;
  private readonly maxSize: number;
  private readonly cleanupThreshold: number;
  private readonly maxAgeMs: number;
  private readonly serializationEnabled: boolean;

  constructor(
    config: Config,
    options?: {
      maxSize?: number;
      maxAgeMinutes?: number;
      enableSerialization?: boolean;
    },
  ) {
    this.config = config;
    this.maxSize = options?.maxSize ?? 10000; // Max number of entries
    this.maxAgeMs = (options?.maxAgeMinutes ?? 120) * 60 * 1000; // Default 2 hours in ms
    this.cleanupThreshold = Math.floor(this.maxSize * 0.9); // Start cleanup at 90% capacity
    this.serializationEnabled = options?.enableSerialization ?? true; // Enable advanced serialization

    // Use config to log initialization if needed
    void this.config;
  }

  /**
   * Serialize complex data types to ensure consistent storage
   * @private
   */
  private serializeValue(value: unknown): unknown {
    if (!this.serializationEnabled) {
      return value;
    }

    // Handle complex objects that need special serialization
    if (value instanceof Date) {
      return { __type: 'Date', value: value.toISOString() };
    } else if (value instanceof Map) {
      return { __type: 'Map', value: Array.from(value.entries()) };
    } else if (value instanceof Set) {
      return { __type: 'Set', value: Array.from(value) };
    } else if (value && typeof value === 'object') {
      // Check if it's a plain object before processing
      return value;
    }

    return value;
  }

  /**
   * Deserialize complex data types when retrieving
   * @private
   */
  private deserializeValue(value: unknown): unknown {
    if (
      !this.serializationEnabled ||
      typeof value !== 'object' ||
      value === null
    ) {
      return value;
    }

    // Handle special serialized types
    if ((value as { __type?: string }).__type) {
      const typedValue = value as { __type: string; value: unknown };
      switch (typedValue.__type) {
        case 'Date':
          return new Date(typedValue.value as string);
        case 'Map':
          return new Map(typedValue.value as Array<[unknown, unknown]>);
        case 'Set':
          return new Set(typedValue.value as unknown[]);
        default:
          return value;
      }
    }

    return value;
  }

  /**
   * Store a value in the shared memory
   * @param key The key to store the value under
   * @param value The value to store
   * @param agentId Optional agent ID for tracking
   * @param version Optional version for tracking updates to this value
   */
  async set(
    key: string,
    value: unknown,
    agentId?: string,
    version?: number,
  ): Promise<void> {
    // Perform cleanup if memory is approaching max size
    if (this.memory.size >= this.cleanupThreshold) {
      await this.cleanup();
    }

    const entry: MemoryEntry = {
      value: this.serializeValue(value),
      timestamp: new Date().toISOString(),
      agentId: agentId || 'unknown',
      version,
    };

    // Add data type information for structured data
    if (value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        entry.dataType = 'array';
      } else if (typeof value === 'object') {
        entry.dataType = 'object';
      } else {
        entry.dataType = typeof value;
      }
    }

    this.memory.set(key, entry);
  }

  /**
   * Retrieve a value from the shared memory
   * @param key The key to retrieve the value for
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.memory.get(key);
    if (!entry) return undefined;

    // Check if entry has expired
    const entryTimestamp = new Date(entry.timestamp).getTime();
    if (Date.now() - entryTimestamp > this.maxAgeMs) {
      await this.delete(key); // Clean up expired entry
      return undefined;
    }

    const deserializedValue = this.deserializeValue(entry.value);
    return deserializedValue as T;
  }

  /**
   * Check if a key exists in the shared memory
   * @param key The key to check
   */
  async has(key: string): Promise<boolean> {
    const entry = this.memory.get(key);
    if (!entry) return false;

    // Check if entry has expired
    const entryTimestamp = new Date(entry.timestamp).getTime();
    if (Date.now() - entryTimestamp > this.maxAgeMs) {
      await this.delete(key); // Clean up expired entry
      return false;
    }

    return true;
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
    // Clean up expired entries while getting keys
    const now = Date.now();
    const validKeys: string[] = [];

    for (const [key, entry] of this.memory.entries()) {
      const entryTimestamp = new Date(entry.timestamp).getTime();
      if (now - entryTimestamp <= this.maxAgeMs) {
        validKeys.push(key);
      } else {
        // Remove expired entry
        this.memory.delete(key);
      }
    }

    return validKeys;
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
  async getMetadata(key: string): Promise<{
    timestamp: string;
    agentId: string;
    dataType?: string;
    version?: number;
  } | null> {
    const entry = this.memory.get(key);
    if (!entry) return null;

    // Check if entry has expired
    const entryTimestamp = new Date(entry.timestamp).getTime();
    if (Date.now() - entryTimestamp > this.maxAgeMs) {
      await this.delete(key); // Clean up expired entry
      return null;
    }

    return {
      timestamp: entry.timestamp,
      agentId: entry.agentId,
      dataType: entry.dataType,
      version: entry.version,
    };
  }

  /**
   * Update a value in shared memory by merging with existing data
   * @param key The key to update
   * @param updates Object containing updates to merge
   * @param mergeStrategy Strategy for merging (default is shallow merge)
   */
  async update(
    key: string,
    updates: Record<string, unknown>,
    mergeStrategy: 'shallow' | 'deep' = 'shallow',
  ): Promise<void> {
    const current = await this.get<Record<string, unknown>>(key);
    if (!current) {
      // If no current value, just set the update as the new value
      await this.set(key, updates);
      return;
    }

    let merged: Record<string, unknown>;
    if (mergeStrategy === 'deep') {
      merged = this.deepMerge(current, updates);
    } else {
      merged = { ...current, ...updates };
    }

    await this.set(key, merged);
  }

  /**
   * Deep merge two objects
   * @private
   */
  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const output = { ...target };

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        if (
          source[key] !== null &&
          typeof source[key] === 'object' &&
          !Array.isArray(source[key]) &&
          target[key] !== null &&
          typeof target[key] === 'object' &&
          !Array.isArray(target[key])
        ) {
          output[key] = this.deepMerge(
            target[key] as Record<string, unknown>,
            source[key] as Record<string, unknown>,
          );
        } else {
          output[key] = source[key];
        }
      }
    }

    return output;
  }

  /**
   * Add an item to an array in shared memory
   * @param key The key containing an array
   * @param item The item to add
   * @param unique Whether to ensure the item is unique in the array
   */
  async addItem(
    key: string,
    item: unknown,
    unique: boolean = false,
  ): Promise<void> {
    const current = (await this.get<unknown[]>(key)) || [];
    const updatedArray = [...current];

    if (unique) {
      // Check if item already exists (using JSON string as comparison for complex objects)
      const itemJson = JSON.stringify(item);
      // Only compute JSON strings once for each existing item
      const existingItemJsons = current.map((arrItem) =>
        JSON.stringify(arrItem),
      );
      const itemExists = existingItemJsons.includes(itemJson);
      if (!itemExists) {
        updatedArray.push(item);
      }
    } else {
      updatedArray.push(item);
    }

    await this.set(key, updatedArray);
  }

  /**
   * Remove an item from an array in shared memory
   * @param key The key containing an array
   * @param item The item to remove
   */
  async removeItem(key: string, item: unknown): Promise<void> {
    const current = (await this.get<unknown[]>(key)) || [];
    const itemJson = JSON.stringify(item);
    const itemJsons = current.map((arrItem) => JSON.stringify(arrItem));
    const updatedArray = current.filter(
      (arrItem, index) => itemJsons[index] !== itemJson,
    );
    await this.set(key, updatedArray);
  }

  /**
   * Append multiple items to an array in shared memory
   * @param key The key containing an array
   * @param items The items to append
   */
  async addItems(key: string, items: unknown[]): Promise<void> {
    const current = (await this.get<unknown[]>(key)) || [];
    const updatedArray = [...current, ...items];
    await this.set(key, updatedArray);
  }

  /**
   * Increment a numeric value in shared memory
   * @param key The key containing a number
   * @param increment The amount to increment by (default 1)
   */
  async increment(key: string, increment: number = 1): Promise<number> {
    const currentValue = await this.get<number>(key);
    const newValue = (currentValue || 0) + increment;
    await this.set(key, newValue);
    return newValue;
  }

  /**
   * Decrement a numeric value in shared memory
   * @param key The key containing a number
   * @param decrement The amount to decrement by (default 1)
   */
  async decrement(key: string, decrement: number = 1): Promise<number> {
    const currentValue = await this.get<number>(key);
    const newValue = (currentValue || 0) - decrement;
    await this.set(key, newValue);
    return newValue;
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
        lastUpdated: new Date().toISOString(),
      },
    };

    await this.set(teamKey, teamData);

    // Initialize each member's context with access controls
    for (const member of members) {
      await this.set(`agent:${member.name}:context`, {
        team: teamName,
        role: member.role,
        assignedTasks: [],
        completedTasks: [],
        knowledge: {},
        permissions: ['read', 'write'], // Default permissions
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
          lastUpdated: new Date().toISOString(),
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

  /**
   * Add access controls to a memory entry
   * @param key The key to add access controls for
   * @param allowedAgents List of agents that can access this entry
   * @param accessLevel Level of access (read, write, execute)
   */
  async setAccessControls(
    key: string,
    allowedAgents: string[],
    accessLevel: 'read' | 'write' | 'execute' = 'read',
  ): Promise<void> {
    const metadata = await this.getMetadata(key);
    if (!metadata) {
      throw new Error(`Key ${key} does not exist`);
    }

    // Store access controls in a separate entry to avoid interfering with the original value
    await this.set(`access:${key}`, {
      allowedAgents,
      accessLevel,
      lastUpdated: new Date().toISOString(),
    });
  }

  /**
   * Check if an agent has access to a memory entry
   * @param key The key to check access for
   * @param agentId The agent requesting access
   * @param requiredLevel Required access level
   */
  async hasAccess(
    key: string,
    agentId: string,
    requiredLevel: 'read' | 'write' | 'execute' = 'read',
  ): Promise<boolean> {
    // Get access controls for this key
    const accessControls = await this.get<Record<string, unknown>>(
      `access:${key}`,
    );

    if (!accessControls) {
      // If no specific access controls, allow access by default
      return true;
    }

    const allowedAgents = (accessControls['allowedAgents'] as string[]) || [];
    const accessLevel = (accessControls['accessLevel'] as string) || 'read';

    // Check if agent is in allowed list
    const agentAllowed =
      allowedAgents.includes(agentId) || allowedAgents.includes('*');

    // Check if required access level is satisfied
    const levelMap = { read: 0, write: 1, execute: 2 };
    const requiredLevelValue = levelMap[requiredLevel];
    const availableLevelValue =
      levelMap[accessLevel as 'read' | 'write' | 'execute'];

    return agentAllowed && requiredLevelValue <= availableLevelValue;
  }

  /**
   * Periodic cleanup of expired entries
   * @private
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.memory.entries()) {
      const entryTimestamp = new Date(entry.timestamp).getTime();
      if (now - entryTimestamp > this.maxAgeMs) {
        this.memory.delete(key);
        cleanedCount++;
      }
    }

    // If we still exceed max size, remove oldest entries
    if (this.memory.size > this.maxSize) {
      const entries = Array.from(this.memory.entries())
        .map(([key, value]) => ({
          key,
          timestamp: new Date(value.timestamp).getTime(),
        }))
        .sort((a, b) => a.timestamp - b.timestamp); // Sort by oldest first

      const toRemove = this.memory.size - this.maxSize;
      for (let i = 0; i < toRemove; i++) {
        this.memory.delete(entries[i].key);
        cleanedCount++;
      }
    }

    // Use the cleanedCount variable to avoid ESLint warning
    void cleanedCount;
  }

  /**
   * Get current memory usage statistics
   */
  async getStats(): Promise<{
    size: number;
    maxSize: number;
    usagePercent: number;
    entries: Array<{ key: string; size: number }>;
  }> {
    // Calculate memory usage for each entry (approximated by JSON string length)
    const entries = Array.from(this.memory.entries()).map(([key, entry]) => {
      const jsonString = JSON.stringify(entry);
      return {
        key,
        size: jsonString.length, // Approximate size in bytes
      };
    });

    return {
      size: this.memory.size,
      maxSize: this.maxSize,
      usagePercent: Math.round((this.memory.size / this.maxSize) * 100),
      entries,
    };
  }
}
