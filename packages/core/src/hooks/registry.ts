/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookDefinition, HookConfig, HookEventName } from './types.js';

/**
 * Configuration for hook registry
 */
export interface HookRegistryConfig {
  /** Initial hook definitions to load */
  definitions?: HookDefinition[];
  /** Enable validation of hook definitions */
  validate?: boolean;
}

/**
 * HookRegistry manages hook definitions from various sources
 * (project config, extensions, etc.)
 */
export class HookRegistry {
  private definitions: Map<string, HookDefinition> = new Map();
  private eventHooks: Map<HookEventName, HookDefinition[]> = new Map();

  constructor(private config: HookRegistryConfig = {}) {
    if (config.definitions) {
      for (const def of config.definitions) {
        this.register(def);
      }
    }
  }

  /**
   * Register a hook definition
   */
  register(definition: HookDefinition): void {
    if (this.config.validate) {
      this.validateDefinition(definition);
    }

    const key = this.getDefinitionKey(definition);
    this.definitions.set(key, definition);

    // Index by event type if specified in hooks
    for (const _hook of definition.hooks) {
      // Future: Index by event name when hook config supports it
      void _hook; // Intentionally unused for now
    }
  }

  /**
   * Unregister a hook definition
   */
  unregister(definition: HookDefinition): boolean {
    const key = this.getDefinitionKey(definition);
    return this.definitions.delete(key);
  }

  /**
   * Unregister by key
   */
  unregisterByKey(key: string): boolean {
    return this.definitions.delete(key);
  }

  /**
   * Get all registered hook definitions
   */
  getAllDefinitions(): HookDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Get a specific definition by key
   */
  getDefinition(key: string): HookDefinition | undefined {
    return this.definitions.get(key);
  }

  /**
   * Check if a definition exists
   */
  hasDefinition(key: string): boolean {
    return this.definitions.has(key);
  }

  /**
   * Clear all definitions
   */
  clear(): void {
    this.definitions.clear();
    this.eventHooks.clear();
  }

  /**
   * Get count of registered definitions
   */
  get count(): number {
    return this.definitions.size;
  }

  /**
   * Get all hook configs (flattened from all definitions)
   */
  getAllHookConfigs(): HookConfig[] {
    const configs: HookConfig[] = [];
    for (const def of this.definitions.values()) {
      configs.push(...def.hooks);
    }
    return configs;
  }

  /**
   * Find definitions by matcher pattern
   */
  findByMatcher(matcher: string): HookDefinition[] {
    return this.getAllDefinitions().filter((def) => def.matcher === matcher);
  }

  /**
   * Find definitions that match a tool name
   */
  findMatchingTool(toolName: string): HookDefinition[] {
    return this.getAllDefinitions().filter((def) => {
      if (!def.matcher || def.matcher === '*') {
        return true;
      }
      // Simple exact match for now
      if (def.matcher === toolName) {
        return true;
      }
      // Regex match
      try {
        const regex = new RegExp(def.matcher);
        if (regex.test(toolName)) {
          return true;
        }
      } catch {
        // Invalid regex, ignore
      }
      return false;
    });
  }

  /**
   * Validate a hook definition
   */
  private validateDefinition(definition: HookDefinition): void {
    if (!definition.hooks || definition.hooks.length === 0) {
      throw new Error('Hook definition must have at least one hook');
    }

    for (const hook of definition.hooks) {
      this.validateHookConfig(hook);
    }
  }

  /**
   * Validate a hook config
   */
  private validateHookConfig(hook: HookConfig): void {
    if (hook.type === 'command') {
      if (!hook.command || hook.command.trim().length === 0) {
        throw new Error('Command hook must have a non-empty command');
      }
    } else {
      throw new Error(`Unsupported hook type: ${hook.type}`);
    }
  }

  /**
   * Generate a unique key for a definition
   */
  private getDefinitionKey(definition: HookDefinition): string {
    // Use matcher + first hook command as key
    const matcher = definition.matcher ?? '*';
    const firstHook = definition.hooks[0];
    if (firstHook?.type === 'command') {
      return `${matcher}::${firstHook.command}`;
    }
    return `${matcher}::${JSON.stringify(firstHook)}`;
  }

  /**
   * Load definitions from a configuration object
   */
  loadFromConfig(config: { hooks?: HookDefinition[] }): void {
    if (config.hooks) {
      for (const def of config.hooks) {
        this.register(def);
      }
    }
  }

  /**
   * Export current definitions to a configuration object
   */
  exportToConfig(): { hooks: HookDefinition[] } {
    return {
      hooks: this.getAllDefinitions(),
    };
  }

  /**
   * Merge another registry into this one
   */
  merge(other: HookRegistry): void {
    for (const def of other.getAllDefinitions()) {
      this.register(def);
    }
  }
}

/**
 * Create a new hook registry
 */
export function createHookRegistry(config?: HookRegistryConfig): HookRegistry {
  return new HookRegistry(config);
}
