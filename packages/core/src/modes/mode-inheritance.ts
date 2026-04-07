/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Inheritance — resolve inherited fields from parent modes.
 *
 * Modes can inherit from other modes, overriding only specific fields.
 * This allows creating custom modes based on built-in ones without
 * duplicating the entire configuration.
 */

import type { ModeConfig } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_INHERITANCE');

/**
 * Deep merge two objects, with source overriding target.
 */
function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      // Deep merge nested objects
      (result as any)[key] = deepMerge(targetValue, sourceValue);
    } else if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
      // Arrays: source replaces target
      (result as any)[key] = sourceValue;
    } else if (sourceValue !== undefined) {
      // Primitive: source overrides target
      (result as any)[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Resolve a mode's full configuration by inheriting from its parent.
 *
 * @param mode - The mode config (may have inheritedFrom)
 * @param availableModes - Map of all available modes
 * @returns Fully resolved mode config with all inherited fields filled in
 * @throws Error if parent mode not found or circular inheritance detected
 */
export function resolveInheritedMode(
  mode: ModeConfig,
  availableModes: Map<string, ModeConfig>,
): ModeConfig {
  if (!mode.inheritedFrom) {
    return mode;
  }

  const visited = new Set<string>();
  return resolveInheritanceChain(mode, availableModes, visited);
}

/**
 * Recursively resolve the inheritance chain.
 */
function resolveInheritanceChain(
  mode: ModeConfig,
  availableModes: Map<string, ModeConfig>,
  visited: Set<string>,
): ModeConfig {
  // Check for circular inheritance
  if (visited.has(mode.name)) {
    throw new Error(
      `Circular inheritance detected: ${Array.from(visited).join(' → ')} → ${mode.name}`,
    );
  }
  visited.add(mode.name);

  // If no parent, return mode as-is
  if (!mode.inheritedFrom) {
    return mode;
  }

  // Find parent mode
  const parentMode = availableModes.get(mode.inheritedFrom);
  if (!parentMode) {
    throw new Error(
      `Parent mode "${mode.inheritedFrom}" not found for mode "${mode.name}"`,
    );
  }

  // Recursively resolve parent (may have its own parent)
  const resolvedParent = resolveInheritanceChain(
    parentMode,
    availableModes,
    new Set(visited),
  );

  // Merge: child overrides parent
  const merged: ModeConfig = {
    // Start with parent values
    name: mode.name, // Always use child's name
    displayName: mode.displayName || resolvedParent.displayName,
    description: mode.description || resolvedParent.description,
    icon: mode.icon || resolvedParent.icon,
    level: mode.level, // Always use child's level
    systemPrompt: mode.systemPrompt || resolvedParent.systemPrompt,
  };

  // Merge optional fields
  if (resolvedParent.allowedTools && !mode.allowedTools) {
    merged.allowedTools = resolvedParent.allowedTools;
  } else if (mode.allowedTools) {
    merged.allowedTools = mode.allowedTools;
  }

  if (resolvedParent.deniedTools && !mode.deniedTools) {
    merged.deniedTools = resolvedParent.deniedTools;
  } else if (mode.deniedTools) {
    merged.deniedTools = mode.deniedTools;
  }

  if (resolvedParent.approvalMode && !mode.approvalMode) {
    merged.approvalMode = resolvedParent.approvalMode;
  } else if (mode.approvalMode) {
    merged.approvalMode = mode.approvalMode;
  }

  if (resolvedParent.allowedSubagents && !mode.allowedSubagents) {
    merged.allowedSubagents = resolvedParent.allowedSubagents;
  } else if (mode.allowedSubagents) {
    merged.allowedSubagents = mode.allowedSubagents;
  }

  if (resolvedParent.allowedSkills && !mode.allowedSkills) {
    merged.allowedSkills = resolvedParent.allowedSkills;
  } else if (mode.allowedSkills) {
    merged.allowedSkills = mode.allowedSkills;
  }

  // Merge modelConfig
  if (resolvedParent.modelConfig || mode.modelConfig) {
    merged.modelConfig = {
      ...resolvedParent.modelConfig,
      ...mode.modelConfig,
    };
  }

  // Merge runConfig
  if (resolvedParent.runConfig || mode.runConfig) {
    merged.runConfig = {
      ...resolvedParent.runConfig,
      ...mode.runConfig,
    };
  }

  // Inheritance-specific fields
  merged.filePath = mode.filePath || resolvedParent.filePath;
  merged.color = mode.color || resolvedParent.color;
  merged.inheritedFrom = mode.inheritedFrom;
  merged.supportsParallel =
    mode.supportsParallel ?? resolvedParent.supportsParallel;
  merged.maxParallelTasks =
    mode.maxParallelTasks ?? resolvedParent.maxParallelTasks;

  debugLogger.debug(
    `Resolved inheritance for "${mode.name}" from "${resolvedParent.name}"`,
  );

  return merged;
}

/**
 * Get the full inheritance chain for a mode.
 *
 * @param mode - Mode config
 * @param availableModes - Map of all available modes
 * @returns Array of mode names in the inheritance chain (child → parent → grandparent)
 */
export function getInheritanceChain(
  mode: ModeConfig,
  availableModes: Map<string, ModeConfig>,
): string[] {
  const chain: string[] = [mode.name];
  let current = mode;

  while (current.inheritedFrom) {
    const parent = availableModes.get(current.inheritedFrom);
    if (!parent) break;
    chain.push(parent.name);
    current = parent;
  }

  return chain;
}

/**
 * Check if a mode inherits (directly or indirectly) from another mode.
 *
 * @param mode - Mode config
 * @param ancestorName - Potential ancestor mode name
 * @param availableModes - Map of all available modes
 * @returns True if mode inherits from ancestorName
 */
export function isInheritedFrom(
  mode: ModeConfig,
  ancestorName: string,
  availableModes: Map<string, ModeConfig>,
): boolean {
  if (!mode.inheritedFrom) return false;
  if (mode.inheritedFrom === ancestorName) return true;

  const parent = availableModes.get(mode.inheritedFrom);
  if (!parent) return false;

  return isInheritedFrom(parent, ancestorName, availableModes);
}

/**
 * Find all modes that inherit from a given mode.
 *
 * @param ancestorName - Ancestor mode name
 * @param availableModes - Map of all available modes
 * @returns Array of modes that inherit from ancestorName
 */
export function findDescendants(
  ancestorName: string,
  availableModes: Map<string, ModeConfig>,
): ModeConfig[] {
  const descendants: ModeConfig[] = [];

  for (const mode of availableModes.values()) {
    if (isInheritedFrom(mode, ancestorName, availableModes)) {
      descendants.push(mode);
    }
  }

  return descendants;
}
