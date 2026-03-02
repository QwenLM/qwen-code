/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ModeDefinition, ToolName } from './types/mode-definition.js';

/**
 * Custom mode configuration from JSON
 */
export interface CustomModeConfig {
  id: string;
  name: string;
  description: string;
  color?: string;
  icon?: string;
  roleSystemPrompt: string;
  allowedTools: string[];
  excludedTools?: string[];
  useCases?: string[];
  safetyConstraints?: string[];
  priority?: number;
}

/**
 * Loader for custom modes from .qwen/modes/ directory
 */
export class CustomModeLoader {
  private modesDir: string;

  constructor(projectRoot: string) {
    this.modesDir = path.join(projectRoot, '.qwen', 'modes');
  }

  /**
   * Load all custom modes from .qwen/modes/
   */
  async loadCustomModes(): Promise<ModeDefinition[]> {
    const modes: ModeDefinition[] = [];

    // Check if modes directory exists
    if (!fs.existsSync(this.modesDir)) {
      return modes;
    }

    // Read all JSON files in the modes directory
    const files = fs.readdirSync(this.modesDir);

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(this.modesDir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const config: CustomModeConfig = JSON.parse(content);

        // Validate and convert to ModeDefinition
        const mode = this.validateAndConvert(config);
        if (mode) {
          modes.push(mode);
        }
      } catch (error) {
        // Silently skip invalid mode files
      }
    }

    return modes;
  }

  /**
   * Validate custom mode config and convert to ModeDefinition
   */
  private validateAndConvert(config: CustomModeConfig): ModeDefinition | null {
    // Validate required fields
    if (!config.id || !config.name || !config.roleSystemPrompt) {
      return null;
    }

    // Validate ID format
    if (!/^[a-z][a-z0-9-]*$/.test(config.id)) {
      console.warn(`Invalid mode ID: ${config.id}. Must be lowercase alphanumeric with dashes.`);
      return null;
    }

    // Convert tools to ToolName type
    const allowedTools = config.allowedTools as ToolName[];
    const excludedTools = (config.excludedTools || []) as ToolName[];

    return {
      id: config.id,
      name: config.name,
      description: config.description || '',
      color: config.color || '#9CA3AF',
      icon: config.icon || '📄',
      roleSystemPrompt: config.roleSystemPrompt,
      allowedTools,
      excludedTools,
      useCases: config.useCases || [],
      safetyConstraints: config.safetyConstraints || [],
    };
  }

  /**
   * Check if a mode ID is already defined in custom modes
   */
  async hasMode(modeId: string): Promise<boolean> {
    const modes = await this.loadCustomModes();
    return modes.some(m => m.id === modeId);
  }

  /**
   * Get a specific custom mode by ID
   */
  async getMode(modeId: string): Promise<ModeDefinition | null> {
    const modes = await this.loadCustomModes();
    return modes.find(m => m.id === modeId) || null;
  }
}

/**
 * Create custom mode loader for a project
 */
export function createCustomModeLoader(projectRoot: string): CustomModeLoader {
  return new CustomModeLoader(projectRoot);
}
