/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { watch as watchFs, type FSWatcher } from 'chokidar';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import type {
  SkillConfig,
  SkillLevel,
  ListSkillsOptions,
  SkillValidationResult,
} from './types.js';
import { SkillError, SkillErrorCode } from './types.js';
import type { Config } from '../config/config.js';
import { validateConfig } from './skill-load.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SKILL_MANAGER');

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
  private readonly watchers: Map<string, FSWatcher> = new Map();
  private watchStarted = false;
  private refreshTimer: NodeJS.Timeout | null = null;

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
        debugLogger.warn('Skill change listener threw an error:', error);
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
    debugLogger.debug(
      `Listing skills${options.level ? ` at level: ${options.level}` : ''}${options.force ? ' (forced refresh)' : ''}`,
    );
    const skills: SkillConfig[] = [];
    const seenNames = new Set<string>();

    const levelsToCheck: SkillLevel[] = options.level
      ? [options.level]
      : ['project', 'user', 'extension'];

    // Check if we should use cache or force refresh
    const shouldUseCache = !options.force && this.skillsCache !== null;

    // Initialize cache if it doesn't exist or we're forcing a refresh
    if (!shouldUseCache) {
      debugLogger.debug('Cache miss or force refresh, reloading skills');
      await this.refreshCache();
    } else {
      debugLogger.debug('Using cached skills');
    }

    // Collect skills from each level (project takes precedence over user over extension)
    for (const level of levelsToCheck) {
      const levelSkills = this.skillsCache?.get(level) || [];
      debugLogger.debug(
        `Processing ${levelSkills.length} ${level} level skills`,
      );

      for (const skill of levelSkills) {
        // Skip if we've already seen this name (precedence: project > user > extension)
        if (seenNames.has(skill.name)) {
          debugLogger.debug(
            `Skipping duplicate skill: ${skill.name} (${level})`,
          );
          continue;
        }

        skills.push(skill);
        seenNames.add(skill.name);
      }
    }

    // Sort by name for consistent ordering
    skills.sort((a, b) => a.name.localeCompare(b.name));

    debugLogger.info(`Listed ${skills.length} unique skills`);
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
    debugLogger.debug(
      `Loading skill: ${name}${level ? ` at level: ${level}` : ''}`,
    );

    if (level) {
      const skill = await this.findSkillByNameAtLevel(name, level);
      if (skill) {
        debugLogger.debug(`Found skill ${name} at ${level} level`);
      } else {
        debugLogger.debug(`Skill ${name} not found at ${level} level`);
      }
      return skill;
    }

    // Try project level first
    const projectSkill = await this.findSkillByNameAtLevel(name, 'project');
    if (projectSkill) {
      debugLogger.debug(`Found skill ${name} at project level`);
      return projectSkill;
    }

    // Try user level first
    const userSkill = await this.findSkillByNameAtLevel(name, 'user');
    if (userSkill) {
      debugLogger.debug(`Found skill ${name} at user level`);
      return userSkill;
    }

    // Try extension level
    const extensionSkill = await this.findSkillByNameAtLevel(name, 'extension');
    if (extensionSkill) {
      debugLogger.debug(`Found skill ${name} at extension level`);
    } else {
      debugLogger.debug(`Skill ${name} not found at any level`);
    }
    return extensionSkill;
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
    debugLogger.debug(
      `Loading skill for runtime: ${name}${level ? ` at level: ${level}` : ''}`,
    );
    const skill = await this.loadSkill(name, level);
    if (!skill) {
      debugLogger.debug(`Skill not found for runtime: ${name}`);
      return null;
    }

    debugLogger.info(
      `Skill loaded for runtime: ${name} from ${skill.filePath}`,
    );
    return skill;
  }

  /**
   * Validates a skill configuration.
   *
   * @param config - Configuration to validate
   * @returns Validation result
   */
  validateConfig(config: Partial<SkillConfig>): SkillValidationResult {
    return validateConfig(config);
  }

  /**
   * Refreshes the skills cache by loading all skills from disk.
   */
  async refreshCache(): Promise<void> {
    debugLogger.info('Refreshing skills cache...');
    const skillsCache = new Map<SkillLevel, SkillConfig[]>();
    this.parseErrors.clear();

    const levels: SkillLevel[] = ['project', 'user', 'extension'];
    let totalSkills = 0;

    for (const level of levels) {
      const levelSkills = await this.listSkillsAtLevel(level);
      skillsCache.set(level, levelSkills);
      totalSkills += levelSkills.length;
      debugLogger.debug(`Loaded ${levelSkills.length} ${level} level skills`);
    }

    this.skillsCache = skillsCache;
    debugLogger.info(
      `Skills cache refreshed: ${totalSkills} total skills loaded`,
    );
    this.notifyChangeListeners();
  }

  /**
   * Starts watching skill directories for changes.
   */
  async startWatching(): Promise<void> {
    if (this.watchStarted) {
      debugLogger.debug('Skill watching already started, skipping');
      return;
    }

    debugLogger.info('Starting skill directory watchers...');
    this.watchStarted = true;
    await this.ensureUserSkillsDir();
    await this.refreshCache();
    this.updateWatchersFromCache();
    debugLogger.info('Skill directory watchers started');
  }

  /**
   * Stops watching skill directories for changes.
   */
  stopWatching(): void {
    debugLogger.info('Stopping skill directory watchers...');
    for (const watcher of this.watchers.values()) {
      void watcher.close().catch((error) => {
        debugLogger.warn('Failed to close skills watcher:', error);
      });
    }
    this.watchers.clear();
    this.watchStarted = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    debugLogger.info('Skill directory watchers stopped');
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
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      debugLogger.error(
        `Failed to read skill file ${filePath}: ${errorMessage}`,
      );
      const skillError = new SkillError(
        `Failed to read skill file: ${errorMessage}`,
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
      const normalizedContent = normalizeSkillFileContent(content);

      // Split frontmatter and content
      const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
      const match = normalizedContent.match(frontmatterRegex);

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

      debugLogger.debug(
        `Successfully parsed skill: ${name} (${level}) from ${filePath}`,
      );
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
      debugLogger.debug(
        'Skipping project-level skills: project root is home directory',
      );
      return [];
    }

    if (level === 'extension') {
      const extensions = this.config.getActiveExtensions();
      const skills: SkillConfig[] = [];
      for (const extension of extensions) {
        extension.skills?.forEach((skill) => {
          skills.push(skill);
        });
      }
      debugLogger.debug(
        `Loaded ${skills.length} extension-level skills from ${extensions.length} extensions`,
      );
      return skills;
    }

    const baseDir = this.getSkillsBaseDir(level);
    debugLogger.debug(`Loading ${level} level skills from: ${baseDir}`);
    const skills = await this.loadSkillsFromDir(baseDir, level);
    debugLogger.debug(`Loaded ${skills.length} ${level} level skills`);
    return skills;
  }

  async loadSkillsFromDir(
    baseDir: string,
    level: SkillLevel,
  ): Promise<SkillConfig[]> {
    debugLogger.debug(`Loading skills from directory: ${baseDir}`);
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const skills: SkillConfig[] = [];
      debugLogger.debug(`Found ${entries.length} entries in ${baseDir}`);

      for (const entry of entries) {
        // Check if it's a directory or a symlink
        const isDirectory = entry.isDirectory();
        const isSymlink = entry.isSymbolicLink();

        if (!isDirectory && !isSymlink) {
          debugLogger.warn(`Skipping non-directory entry: ${entry.name}`);
          continue;
        }

        const skillDir = path.join(baseDir, entry.name);

        // For symlinks, verify the target is a directory
        if (isSymlink) {
          try {
            const targetStat = await fs.stat(skillDir);
            if (!targetStat.isDirectory()) {
              debugLogger.warn(
                `Skipping symlink ${entry.name} that does not point to a directory`,
              );
              continue;
            }
          } catch (error) {
            debugLogger.warn(
              `Skipping invalid symlink ${entry.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            continue;
          }
        }

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
            debugLogger.error(
              `Failed to parse skill at ${skillDir}: ${error.message}`,
            );
          } else {
            debugLogger.debug(
              `No valid SKILL.md found in ${skillDir}, skipping`,
            );
          }
          continue;
        }
      }

      return skills;
    } catch (error) {
      // Directory doesn't exist or can't be read
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      debugLogger.debug(
        `Cannot read skills directory ${baseDir}: ${errorMessage}`,
      );
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

  private updateWatchersFromCache(): void {
    const watchTargets = new Set<string>(
      (['project', 'user'] as const)
        .map((level) => this.getSkillsBaseDir(level))
        .filter((baseDir) => fsSync.existsSync(baseDir)),
    );

    for (const existingPath of this.watchers.keys()) {
      if (!watchTargets.has(existingPath)) {
        void this.watchers
          .get(existingPath)
          ?.close()
          .catch((error) => {
            debugLogger.warn(
              `Failed to close skills watcher for ${existingPath}:`,
              error,
            );
          });
        this.watchers.delete(existingPath);
      }
    }

    for (const watchPath of watchTargets) {
      if (this.watchers.has(watchPath)) {
        continue;
      }

      try {
        const watcher = watchFs(watchPath, {
          ignoreInitial: true,
        })
          .on('all', () => {
            this.scheduleRefresh();
          })
          .on('error', (error) => {
            debugLogger.warn(`Skills watcher error for ${watchPath}:`, error);
          });
        this.watchers.set(watchPath, watcher);
      } catch (error) {
        debugLogger.warn(
          `Failed to watch skills directory at ${watchPath}:`,
          error,
        );
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshCache().then(() => this.updateWatchersFromCache());
    }, 150);
  }

  private async ensureUserSkillsDir(): Promise<void> {
    const baseDir = this.getSkillsBaseDir('user');
    try {
      await fs.mkdir(baseDir, { recursive: true });
    } catch (error) {
      debugLogger.warn(
        `Failed to create user skills directory at ${baseDir}:`,
        error,
      );
    }
  }
}

function normalizeSkillFileContent(content: string): string {
  // Strip UTF-8 BOM to ensure frontmatter starts at the first character.
  let normalized = content.replace(/^\uFEFF/, '');

  // Normalize line endings so skills authored on Windows (CRLF) parse correctly.
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return normalized;
}
