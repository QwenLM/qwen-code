/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import type {
  SkillConfig,
  SkillLevel,
  ListSkillsOptions,
  SkillValidationResult,
} from './types.js';
import { SkillError, SkillErrorCode } from './types.js';
import type { Config } from '../config/config.js';

const QWEN_CONFIG_DIR = '.qwen';
const SKILLS_CONFIG_DIR = 'skills';
const SKILL_MANIFEST_FILE = 'SKILL.md';

/**
 * Manages skill configurations stored as directories containing SKILL.md files.
 * Provides discovery, parsing, validation, and caching for skills.
 */
export class SkillManager {
  private skillsCache: Map<SkillLevel, SkillConfig[]> | null = null;
  private readonly changeListeners: Set<() => void> = new Set();
  private parseErrors: Map<string, SkillError> = new Map();

  constructor(private readonly config: Config) {}

  /**
   * Adds a listener that will be called when skills change.
   * @returns A function to remove the listener.
   */
  addChangeListener(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Notifies all registered change listeners.
   */
  private notifyChangeListeners(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('Skill change listener threw an error:', error);
      }
    }
  }

  /**
   * Gets any parse errors that occurred during skill loading.
   * @returns Map of skill paths to their parse errors.
   */
  getParseErrors(): Map<string, SkillError> {
    return new Map(this.parseErrors);
  }

  /**
   * Lists all available skills.
   *
   * @param options - Filtering options
   * @returns Array of skill configurations
   */
  async listSkills(options: ListSkillsOptions = {}): Promise<SkillConfig[]> {
    const skills: SkillConfig[] = [];
    const seenNames = new Set<string>();

    const levelsToCheck: SkillLevel[] = options.level
      ? [options.level]
      : ['project', 'user'];

    // Check if we should use cache or force refresh
    const shouldUseCache = !options.force && this.skillsCache !== null;

    // Initialize cache if it doesn't exist or we're forcing a refresh
    if (!shouldUseCache) {
      await this.refreshCache();
    }

    // Collect skills from each level (project takes precedence over user)
    for (const level of levelsToCheck) {
      const levelSkills = this.skillsCache?.get(level) || [];

      for (const skill of levelSkills) {
        // Skip if we've already seen this name (precedence: project > user)
        if (seenNames.has(skill.name)) {
          continue;
        }

        skills.push(skill);
        seenNames.add(skill.name);
      }
    }

    // Sort by name for consistent ordering
    skills.sort((a, b) => a.name.localeCompare(b.name));

    return skills;
  }

  /**
   * Loads a skill configuration by name.
   * If level is specified, only searches that level.
   * If level is omitted, searches project-level first, then user-level.
   *
   * @param name - Name of the skill to load
   * @param level - Optional level to limit search to
   * @returns SkillConfig or null if not found
   */
  async loadSkill(
    name: string,
    level?: SkillLevel,
  ): Promise<SkillConfig | null> {
    if (level) {
      return this.findSkillByNameAtLevel(name, level);
    }

    // Try project level first
    const projectSkill = await this.findSkillByNameAtLevel(name, 'project');
    if (projectSkill) {
      return projectSkill;
    }

    // Try user level
    return this.findSkillByNameAtLevel(name, 'user');
  }

  /**
   * Loads a skill with its full content, ready for runtime use.
   * This includes loading additional files from the skill directory.
   *
   * @param name - Name of the skill to load
   * @param level - Optional level to limit search to
   * @returns SkillConfig or null if not found
   */
  async loadSkillForRuntime(
    name: string,
    level?: SkillLevel,
  ): Promise<SkillConfig | null> {
    const skill = await this.loadSkill(name, level);
    if (!skill) {
      return null;
    }

    return skill;
  }

  /**
   * Validates a skill configuration.
   *
   * @param config - Configuration to validate
   * @returns Validation result
   */
  validateConfig(config: Partial<SkillConfig>): SkillValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (typeof config.name !== 'string') {
      errors.push('Missing or invalid "name" field');
    } else if (config.name.trim() === '') {
      errors.push('"name" cannot be empty');
    }

    if (typeof config.description !== 'string') {
      errors.push('Missing or invalid "description" field');
    } else if (config.description.trim() === '') {
      errors.push('"description" cannot be empty');
    }

    // Validate allowedTools if present
    if (config.allowedTools !== undefined) {
      if (!Array.isArray(config.allowedTools)) {
        errors.push('"allowedTools" must be an array');
      } else {
        for (const tool of config.allowedTools) {
          if (typeof tool !== 'string') {
            errors.push('"allowedTools" must contain only strings');
            break;
          }
        }
      }
    }

    // Warn if body is empty
    if (!config.body || config.body.trim() === '') {
      warnings.push('Skill body is empty');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Refreshes the skills cache by loading all skills from disk.
   */
  async refreshCache(): Promise<void> {
    const skillsCache = new Map<SkillLevel, SkillConfig[]>();
    this.parseErrors.clear();

    const levels: SkillLevel[] = ['project', 'user'];

    for (const level of levels) {
      const levelSkills = await this.listSkillsAtLevel(level);
      skillsCache.set(level, levelSkills);
    }

    this.skillsCache = skillsCache;
    this.notifyChangeListeners();
  }

  /**
   * Parses a SKILL.md file and returns the configuration.
   *
   * @param filePath - Path to the SKILL.md file
   * @param level - Storage level
   * @returns SkillConfig
   * @throws SkillError if parsing fails
   */
  parseSkillFile(filePath: string, level: SkillLevel): Promise<SkillConfig> {
    return this.parseSkillFileInternal(filePath, level);
  }

  /**
   * Internal implementation of skill file parsing.
   */
  private async parseSkillFileInternal(
    filePath: string,
    level: SkillLevel,
  ): Promise<SkillConfig> {
    let content: string;

    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const skillError = new SkillError(
        `Failed to read skill file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SkillErrorCode.FILE_ERROR,
      );
      this.parseErrors.set(filePath, skillError);
      throw skillError;
    }

    return this.parseSkillContent(content, filePath, level);
  }

  /**
   * Parses skill content from a string.
   *
   * @param content - File content
   * @param filePath - File path for error reporting
   * @param level - Storage level
   * @returns SkillConfig
   * @throws SkillError if parsing fails
   */
  parseSkillContent(
    content: string,
    filePath: string,
    level: SkillLevel,
  ): SkillConfig {
    try {
      // Split frontmatter and content
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
      const match = content.match(frontmatterRegex);

      if (!match) {
        throw new Error('Invalid format: missing YAML frontmatter');
      }

      const [, frontmatterYaml, body] = match;

      // Parse YAML frontmatter
      const frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;

      // Extract required fields
      const nameRaw = frontmatter['name'];
      const descriptionRaw = frontmatter['description'];

      if (nameRaw == null || nameRaw === '') {
        throw new Error('Missing "name" in frontmatter');
      }

      if (descriptionRaw == null || descriptionRaw === '') {
        throw new Error('Missing "description" in frontmatter');
      }

      // Convert to strings
      const name = String(nameRaw);
      const description = String(descriptionRaw);

      // Extract optional fields
      const allowedToolsRaw = frontmatter['allowedTools'] as
        | unknown[]
        | undefined;
      let allowedTools: string[] | undefined;

      if (allowedToolsRaw !== undefined) {
        if (Array.isArray(allowedToolsRaw)) {
          allowedTools = allowedToolsRaw.map(String);
        } else {
          throw new Error('"allowedTools" must be an array');
        }
      }

      const config: SkillConfig = {
        name,
        description,
        allowedTools,
        level,
        filePath,
        body: body.trim(),
      };

      // Validate the parsed configuration
      const validation = this.validateConfig(config);
      if (!validation.isValid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }

      return config;
    } catch (error) {
      const skillError = new SkillError(
        `Failed to parse skill file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SkillErrorCode.PARSE_ERROR,
      );
      this.parseErrors.set(filePath, skillError);
      throw skillError;
    }
  }

  /**
   * Gets the base directory for skills at a specific level.
   *
   * @param level - Storage level
   * @returns Absolute directory path
   */
  getSkillsBaseDir(level: SkillLevel): string {
    const baseDir =
      level === 'project'
        ? path.join(
            this.config.getProjectRoot(),
            QWEN_CONFIG_DIR,
            SKILLS_CONFIG_DIR,
          )
        : path.join(os.homedir(), QWEN_CONFIG_DIR, SKILLS_CONFIG_DIR);

    return baseDir;
  }

  /**
   * Lists skills at a specific level.
   *
   * @param level - Storage level to scan
   * @returns Array of skill configurations
   */
  private async listSkillsAtLevel(level: SkillLevel): Promise<SkillConfig[]> {
    const projectRoot = this.config.getProjectRoot();
    const homeDir = os.homedir();
    const isHomeDirectory = path.resolve(projectRoot) === path.resolve(homeDir);

    // If project level is requested but project root is same as home directory,
    // return empty array to avoid conflicts between project and global skills
    if (level === 'project' && isHomeDirectory) {
      return [];
    }

    const baseDir = this.getSkillsBaseDir(level);

    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const skills: SkillConfig[] = [];

      for (const entry of entries) {
        // Only process directories (each skill is a directory)
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(baseDir, entry.name);
        const skillManifest = path.join(skillDir, SKILL_MANIFEST_FILE);

        try {
          // Check if SKILL.md exists
          await fs.access(skillManifest);

          const config = await this.parseSkillFileInternal(
            skillManifest,
            level,
          );
          skills.push(config);
        } catch (error) {
          // Skip directories without valid SKILL.md
          if (error instanceof SkillError) {
            // Parse error was already recorded
            console.warn(
              `Failed to parse skill at ${skillDir}: ${error.message}`,
            );
          }
          continue;
        }
      }

      return skills;
    } catch (_error) {
      // Directory doesn't exist or can't be read
      return [];
    }
  }

  /**
   * Finds a skill by name at a specific level.
   *
   * @param name - Name of the skill to find
   * @param level - Storage level to search
   * @returns SkillConfig or null if not found
   */
  private async findSkillByNameAtLevel(
    name: string,
    level: SkillLevel,
  ): Promise<SkillConfig | null> {
    await this.ensureLevelCache(level);

    const levelSkills = this.skillsCache?.get(level) || [];

    // Find the skill with matching name
    return levelSkills.find((skill) => skill.name === name) || null;
  }

  /**
   * Ensures the cache is populated for a specific level without loading other levels.
   */
  private async ensureLevelCache(level: SkillLevel): Promise<void> {
    if (!this.skillsCache) {
      this.skillsCache = new Map<SkillLevel, SkillConfig[]>();
    }

    if (!this.skillsCache.has(level)) {
      const levelSkills = await this.listSkillsAtLevel(level);
      this.skillsCache.set(level, levelSkills);
    }
  }
}
