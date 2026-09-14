/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DiscoveredMCPPrompt } from '../tools/mcp-client.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('PROMPT_REGISTRY');

export interface SystemPromptLayer {
  id: string;
  category:
    | 'core_instructions'
    | 'persona'
    | 'tools'
    | 'skills'
    | 'user_memory'
    | 'volatile_context';
  priority: number;
  content: string;
}

export class PromptRegistry {
  private prompts: Map<string, DiscoveredMCPPrompt> = new Map();
  private promptLayers: Map<string, SystemPromptLayer> = new Map();

  /**
   * Registers a prompt definition.
   * @param prompt - The prompt object containing schema and execution logic.
   */
  registerPrompt(prompt: DiscoveredMCPPrompt): void {
    if (this.prompts.has(prompt.name)) {
      const newName = `${prompt.serverName}_${prompt.name}`;
      debugLogger.warn(
        `Prompt with name "${prompt.name}" is already registered. Renaming to "${newName}".`,
      );
      this.prompts.set(newName, { ...prompt, name: newName });
    } else {
      this.prompts.set(prompt.name, prompt);
    }
  }

  /**
   * Registers or updates a system prompt layer.
   * @param layer - The SystemPromptLayer object.
   */
  registerPromptLayer(layer: SystemPromptLayer): void {
    if (!layer.id || !layer.content.trim()) {
      throw new Error(
        'SystemPromptLayer must have a valid non-empty id and content.',
      );
    }
    this.promptLayers.set(layer.id, layer);
  }

  /**
   * Get a specific registered system prompt layer by ID.
   */
  getPromptLayer(id: string): SystemPromptLayer | undefined {
    return this.promptLayers.get(id);
  }

  /**
   * Removes a system prompt layer by ID.
   */
  removePromptLayer(id: string): boolean {
    return this.promptLayers.delete(id);
  }

  /**
   * Assembles all registered prompt layers in category and priority order.
   * Ensures volatile context sections (user_memory, volatile_context) are placed
   * at the end of the system prompt stack to optimize prefix caching.
   */
  assembleLayeredPrompt(): string {
    const layers = Array.from(this.promptLayers.values());
    const categoryOrder: Record<SystemPromptLayer['category'], number> = {
      core_instructions: 10,
      persona: 20,
      tools: 30,
      skills: 40,
      user_memory: 50,
      volatile_context: 60,
    };

    layers.sort((a, b) => {
      const catDelta =
        (categoryOrder[a.category] ?? 100) - (categoryOrder[b.category] ?? 100);
      if (catDelta !== 0) return catDelta;
      return a.priority - b.priority;
    });

    return layers
      .map((layer) => layer.content.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Returns an array of all registered and discovered prompt instances.
   */
  getAllPrompts(): DiscoveredMCPPrompt[] {
    return Array.from(this.prompts.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * Get the definition of a specific prompt.
   */
  getPrompt(name: string): DiscoveredMCPPrompt | undefined {
    return this.prompts.get(name);
  }

  /**
   * Returns an array of prompts registered from a specific MCP server.
   */
  getPromptsByServer(serverName: string): DiscoveredMCPPrompt[] {
    const serverPrompts: DiscoveredMCPPrompt[] = [];
    for (const prompt of this.prompts.values()) {
      if (prompt.serverName === serverName) {
        serverPrompts.push(prompt);
      }
    }
    return serverPrompts.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Clears all the prompts and prompt layers from the registry.
   */
  clear(): void {
    this.prompts.clear();
    this.promptLayers.clear();
  }

  /**
   * Removes all prompts from a specific server.
   */
  removePromptsByServer(serverName: string): void {
    for (const [name, prompt] of this.prompts.entries()) {
      if (prompt.serverName === serverName) {
        this.prompts.delete(name);
      }
    }
  }
}
