/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolNameMapping } from './HooksSettings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads tool name mappings from a JSON file for Claude Code compatibility.
 * The mapping file allows easy customization of tool name translations.
 */
export class ToolNameMapper {
  private static mapperInstance: ToolNameMapper;
  private mappings: ToolNameMapping = {};
  private readonly configPath: string;

  private constructor() {
    this.configPath = path.join(
      __dirname,
      '../../../config/tool-name-mapping.json',
    );
    this.loadMappings();
  }

  /**
   * Singleton instance to ensure consistent mapping across the app
   */
  static getInstance(): ToolNameMapper {
    if (!ToolNameMapper.mapperInstance) {
      ToolNameMapper.mapperInstance = new ToolNameMapper();
    }
    return ToolNameMapper.mapperInstance;
  }

  /**
   * Load mappings from the JSON configuration file
   */
  private loadMappings(): void {
    try {
      const content = fs.readFileSync(this.configPath, 'utf8');
      const loadedMappings = JSON.parse(content);
      this.mappings = loadedMappings;
    } catch (error) {
      console.warn(
        `Could not load tool name mapping file at ${this.configPath}:`,
        error,
      );
      // No fallback defaults - require explicit configuration
      this.mappings = {};
    }
  }

  /**
   * Save mappings to the configuration file
   */
  saveMappings(mappings: ToolNameMapping): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(mappings, null, 2));
      this.mappings = { ...mappings };
    } catch (error) {
      console.error(
        `Could not save tool name mapping file at ${this.configPath}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get the mapped tool name for a given original name
   */
  getMappedToolName(originalName: string): string {
    return this.mappings[originalName] || originalName;
  }

  /**
   * Get all current mappings
   */
  getMappings(): ToolNameMapping {
    return { ...this.mappings };
  }

  /**
   * Set a specific tool name mapping
   */
  setMapping(originalName: string, newName: string): void {
    this.mappings[originalName] = newName;
  }

  /**
   * Get reverse mapping (Qwen Code name to Claude Code name)
   */
  getReverseMapping(qwenToolName: string): string | undefined {
    for (const [claudeName, qwenName] of Object.entries(this.mappings)) {
      if (qwenName === qwenToolName) {
        return claudeName;
      }
    }
    return undefined;
  }
}
