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
}
