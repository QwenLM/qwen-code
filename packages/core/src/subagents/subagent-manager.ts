/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
// Note: yaml package would need to be added as a dependency
// For now, we'll use a simple YAML parser implementation
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';
import type {
  SubagentConfig,
  SubagentRuntimeConfig,
  SubagentLevel,
  ListSubagentsOptions,
  CreateSubagentOptions,
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from './types.js';
import { SubagentError, SubagentErrorCode } from './types.js';
import { SubagentValidator } from './validation.js';
import { SubAgentScope } from './subagent.js';
import type { Config } from '../config/config.js';
import { BuiltinAgentRegistry } from './builtin-agents.js';
import { ToolDisplayNamesMigration } from '../tools/tool-names.js';

const QWEN_CONFIG_DIR = '.qwen';
const AGENT_CONFIG_DIR = 'agents';

/**
 * Manages subagent configurations stored as Markdown files with YAML frontmatter.
 * Provides CRUD operations, validation, and integration with the runtime system.
 */
export class SubagentManager {
  private readonly validator: SubagentValidator;
  private subagentsCache: Map<SubagentLevel, SubagentConfig[]> | null = null;
  private readonly changeListeners: Set<() => void> = new Set();

  constructor(private readonly config: Config) {
    this.validator = new SubagentValidator();
  }

  addChangeListener(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChangeListeners(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('Subagent change listener threw an error:', error);
      }
    }
  }

  /**
   * Creates a new subagent configuration.
   *
   * @param config - Subagent configuration to create
   * @param options - Creation options
   * @throws SubagentError if creation fails
   */
  async createSubagent(
    config: SubagentConfig,
    options: CreateSubagentOptions,
  ): Promise<void> {
    this.validator.validateOrThrow(config);

    // Determine file path
    const filePath =
      options.customPath || this.getSubagentPath(config.name, options.level);

    // Check if file already exists
    if (!options.overwrite) {
      try {
        await fs.access(filePath);
        throw new SubagentError(
          `Subagent "${config.name}" already exists at ${filePath}`,
          SubagentErrorCode.ALREADY_EXISTS,
          config.name,
        );
      } catch (error) {
        if (error instanceof SubagentError) throw error;
        // File doesn't exist, which is what we want
      }
    }

    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Update config with actual file path and level
    const finalConfig: SubagentConfig = {
      ...config,
      level: options.level,
      filePath,
    };

    // Serialize and write the file
    const content = this.serializeSubagent(finalConfig);

    try {
      await fs.writeFile(filePath, content, 'utf8');
      // Refresh cache after successful creation
      await this.refreshCache();
    } catch (error) {
      throw new SubagentError(
        `Failed to write subagent file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SubagentErrorCode.FILE_ERROR,
        config.name,
      );
    }
  }

  /**
   * Loads a subagent configuration by name.
   * If level is specified, only searches that level.
   * If level is omitted, searches project-level first, then user-level, then built-in.
   *
   * @param name - Name of the subagent to load
   * @param level - Optional level to limit search to specific level
   * @returns SubagentConfig or null if not found
   */
  async loadSubagent(
    name: string,
    level?: SubagentLevel,
  ): Promise<SubagentConfig | null> {
    if (level) {
      // Search only the specified level
      if (level === 'builtin') {
        return BuiltinAgentRegistry.getBuiltinAgent(name);
      }

      return this.findSubagentByNameAtLevel(name, level);
    }

    // Try project level first
    const projectConfig = await this.findSubagentByNameAtLevel(name, 'project');
    if (projectConfig) {
      return projectConfig;
    }

    // Try user level
    const userConfig = await this.findSubagentByNameAtLevel(name, 'user');
    if (userConfig) {
      return userConfig;
    }

    // Try built-in agents as fallback
    return BuiltinAgentRegistry.getBuiltinAgent(name);
  }

  /**
   * Updates an existing subagent configuration.
   *
   * @param name - Name of the subagent to update
   * @param updates - Partial configuration updates
   * @throws SubagentError if subagent not found or update fails
   */
  async updateSubagent(
    name: string,
    updates: Partial<SubagentConfig>,
    level?: SubagentLevel,
  ): Promise<void> {
    const existing = await this.loadSubagent(name, level);
    if (!existing) {
      throw new SubagentError(
        `Subagent "${name}" not found`,
        SubagentErrorCode.NOT_FOUND,
        name,
      );
    }

    // Prevent updating built-in agents
    if (existing.isBuiltin) {
      throw new SubagentError(
        `Cannot update built-in subagent "${name}"`,
        SubagentErrorCode.INVALID_CONFIG,
        name,
      );
    }

    // Merge updates with existing configuration
    const updatedConfig = this.mergeConfigurations(existing, updates);

    // Validate the updated configuration
    this.validator.validateOrThrow(updatedConfig);

    // Write the updated configuration
    const content = this.serializeSubagent(updatedConfig);

    try {
      await fs.writeFile(existing.filePath, content, 'utf8');
      // Refresh cache after successful update
      await this.refreshCache();
    } catch (error) {
      throw new SubagentError(
        `Failed to update subagent file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SubagentErrorCode.FILE_ERROR,
        name,
      );
    }
  }

  /**
   * Deletes a subagent configuration.
   *
   * @param name - Name of the subagent to delete
   * @param level - Specific level to delete from, or undefined to delete from both
   * @throws SubagentError if deletion fails
   */
  async deleteSubagent(name: string, level?: SubagentLevel): Promise<void> {
    // Check if it's a built-in agent first
    if (BuiltinAgentRegistry.isBuiltinAgent(name)) {
      throw new SubagentError(
        `Cannot delete built-in subagent "${name}"`,
        SubagentErrorCode.INVALID_CONFIG,
        name,
      );
    }

    const levelsToCheck: SubagentLevel[] = level
      ? [level]
      : ['project', 'user'];
    let deleted = false;

    for (const currentLevel of levelsToCheck) {
      // Skip builtin level for deletion
      if (currentLevel === 'builtin') {
        continue;
      }

      // Find the actual subagent file by scanning and parsing
      const config = await this.findSubagentByNameAtLevel(name, currentLevel);
      if (config && config.filePath) {
        try {
          await fs.unlink(config.filePath);
          deleted = true;
        } catch (_error) {
          // File might not exist or be accessible, continue
        }
      }
    }

    if (!deleted) {
      throw new SubagentError(
        `Subagent "${name}" not found`,
        SubagentErrorCode.NOT_FOUND,
        name,
      );
    }

    // Refresh cache after successful deletion
    await this.refreshCache();
  }

  /**
   * Lists all available subagents.
   *
   * @param options - Filtering and sorting options
   * @returns Array of subagent metadata
   */
  async listSubagents(
    options: ListSubagentsOptions = {},
  ): Promise<SubagentConfig[]> {
    const subagents: SubagentConfig[] = [];
    const seenNames = new Set<string>();

    const levelsToCheck: SubagentLevel[] = options.level
      ? [options.level]
      : ['project', 'user', 'builtin'];

    // Check if we should use cache or force refresh
    const shouldUseCache = !options.force && this.subagentsCache !== null;

    // Initialize cache if it doesn't exist or we're forcing a refresh
    if (!shouldUseCache) {
      await this.refreshCache();
    }

    // Collect subagents from each level (project takes precedence over user, user takes precedence over builtin)
    for (const level of levelsToCheck) {
      const levelSubagents = this.subagentsCache?.get(level) || [];

      for (const subagent of levelSubagents) {
        // Skip if we've already seen this name (precedence: project > user > builtin)
        if (seenNames.has(subagent.name)) {
          continue;
        }

        // Apply tool filter if specified
        if (
          options.hasTool &&
          (!subagent.tools || !subagent.tools.includes(options.hasTool))
        ) {
          continue;
        }

        subagents.push(subagent);
        seenNames.add(subagent.name);
      }
    }

    // Sort results
    if (options.sortBy) {
      subagents.sort((a, b) => {
        let comparison = 0;

        switch (options.sortBy) {
          case 'name':
            comparison = a.name.localeCompare(b.name);
            break;
          case 'level': {
            // Project comes before user, user comes before builtin
            const levelOrder = { project: 0, user: 1, builtin: 2 };
            comparison = levelOrder[a.level] - levelOrder[b.level];
            break;
          }
          default:
            comparison = 0;
            break;
        }

        return options.sortOrder === 'desc' ? -comparison : comparison;
      });
    }

    return subagents;
  }

  /**
   * Refreshes the subagents cache by loading all subagents from disk.
   * This method is called automatically when cache is null or when force=true.
   *
   * @private
   */
  private async refreshCache(): Promise<void> {
    const subagentsCache = new Map();

    const levels: SubagentLevel[] = ['project', 'user', 'builtin'];

    for (const level of levels) {
      const levelSubagents = await this.listSubagentsAtLevel(level);
      subagentsCache.set(level, levelSubagents);
    }

    this.subagentsCache = subagentsCache;
    this.notifyChangeListeners();
  }

  /**
   * Finds a subagent by name and returns its metadata.
   *
   * @param name - Name of the subagent to find
   * @returns SubagentConfig or null if not found
   */
  async findSubagentByName(
    name: string,
    level?: SubagentLevel,
  ): Promise<SubagentConfig | null> {
    const config = await this.loadSubagent(name, level);
    if (!config) {
      return null;
    }

    return config;
  }

  /**
   * Parses a subagent file and returns the configuration.
   *
   * @param filePath - Path to the subagent file
   * @returns SubagentConfig
   * @throws SubagentError if parsing fails
   */
  async parseSubagentFile(
    filePath: string,
    level: SubagentLevel,
  ): Promise<SubagentConfig> {
    let content: string;

    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      throw new SubagentError(
        `Failed to read subagent file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SubagentErrorCode.FILE_ERROR,
      );
    }

    return this.parseSubagentContent(content, filePath, level);
  }

  /**
   * Parses subagent content from a string.
   *
   * @param content - File content
   * @param filePath - File path for error reporting
   * @returns SubagentConfig
   * @throws SubagentError if parsing fails
   */
  parseSubagentContent(
    content: string,
    filePath: string,
    level: SubagentLevel,
  ): SubagentConfig {
    try {
      // Split frontmatter and content
      const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
      const match = content.match(frontmatterRegex);

      if (!match) {
        throw new Error('Invalid format: missing YAML frontmatter');
      }

      const [, frontmatterYaml, systemPrompt] = match;

      // Parse YAML frontmatter
      const frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;

      // Extract required fields and convert to strings
      const nameRaw = frontmatter['name'];
      const descriptionRaw = frontmatter['description'];

      if (nameRaw == null || nameRaw === '') {
        throw new Error('Missing "name" in frontmatter');
      }

      if (descriptionRaw == null || descriptionRaw === '') {
        throw new Error('Missing "description" in frontmatter');
      }

      // Convert to strings (handles numbers, booleans, etc.)
      const name = String(nameRaw);
      const description = String(descriptionRaw);

      // Extract optional fields
      const tools = frontmatter['tools'] as string[] | undefined;
      const modelConfig = frontmatter['modelConfig'] as
        | Record<string, unknown>
        | undefined;
      const runConfig = frontmatter['runConfig'] as
        | Record<string, unknown>
        | undefined;
      const color = frontmatter['color'] as string | undefined;

      const config: SubagentConfig = {
        name,
        description,
        tools,
        systemPrompt: systemPrompt.trim(),
        filePath,
        modelConfig: modelConfig as Partial<ModelConfig>,
        runConfig: runConfig as Partial<RunConfig>,
        color,
        level,
      };

      // Validate the parsed configuration
      const validation = this.validator.validateConfig(config);
      if (!validation.isValid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }

      return config;
    } catch (error) {
      throw new SubagentError(
        `Failed to parse subagent file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SubagentErrorCode.INVALID_CONFIG,
      );
    }
  }

  /**
   * Serializes a subagent configuration to Markdown format.
   *
   * @param config - Configuration to serialize
   * @returns Markdown content with YAML frontmatter
   */
  serializeSubagent(config: SubagentConfig): string {
    // Build frontmatter object
    const frontmatter: Record<string, unknown> = {
      name: config.name,
      description: config.description,
    };

    if (config.tools && config.tools.length > 0) {
      frontmatter['tools'] = config.tools;
    }

    // No outputs section

    if (config.modelConfig) {
      frontmatter['modelConfig'] = config.modelConfig;
    }

    if (config.runConfig) {
      frontmatter['runConfig'] = config.runConfig;
    }

    if (config.color && config.color !== 'auto') {
      frontmatter['color'] = config.color;
    }

    // Serialize to YAML
    const yamlContent = stringifyYaml(frontmatter, {
      lineWidth: 0, // Disable line wrapping
      minContentWidth: 0,
    }).trim();

    // Combine frontmatter and system prompt
    return `---\n${yamlContent}\n---\n\n${config.systemPrompt}\n`;
  }

  /**
   * Creates a SubAgentScope from a subagent configuration.
   *
   * @param config - Subagent configuration
   * @param runtimeContext - Runtime context
   * @returns Promise resolving to SubAgentScope
   */
  async createSubagentScope(
    config: SubagentConfig,
    runtimeContext: Config,
    options?: {
      eventEmitter?: import('./subagent-events.js').SubAgentEventEmitter;
      hooks?: import('./subagent-hooks.js').SubagentHooks;
    },
  ): Promise<SubAgentScope> {
    try {
      const runtimeConfig = this.convertToRuntimeConfig(config);

      return await SubAgentScope.create(
        config.name,
        runtimeContext,
        runtimeConfig.promptConfig,
        runtimeConfig.modelConfig,
        runtimeConfig.runConfig,
        runtimeConfig.toolConfig,
        options?.eventEmitter,
        options?.hooks,
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new SubagentError(
          `Failed to create SubAgentScope: ${error.message}`,
          SubagentErrorCode.INVALID_CONFIG,
          config.name,
        );
      }
      throw error;
    }
  }

  /**
   * Converts a file-based SubagentConfig to runtime configuration
   * compatible with SubAgentScope.create().
   *
   * @param config - File-based subagent configuration
   * @returns Runtime configuration for SubAgentScope
   */
  convertToRuntimeConfig(config: SubagentConfig): SubagentRuntimeConfig {
    // Build prompt configuration
    const promptConfig: PromptConfig = {
      systemPrompt: config.systemPrompt,
    };

    // Build model configuration
    const modelConfig: ModelConfig = {
      ...config.modelConfig,
    };

    // Build run configuration
    const runConfig: RunConfig = {
      ...config.runConfig,
    };

    // Build tool configuration if tools are specified
    let toolConfig: ToolConfig | undefined;
    if (config.tools && config.tools.length > 0) {
      // Transform tools array to ensure all entries are tool names (not display names)
      const toolNames = this.transformToToolNames(config.tools);
      toolConfig = {
        tools: toolNames,
      };
    }

    return {
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
    };
  }

  /**
   * Transforms a tools array that may contain tool names or display names
   * into an array containing only tool names.
   *
   * @param tools - Array of tool names or display names
   * @returns Array of tool names
   * @private
   */
  private transformToToolNames(tools: string[]): string[] {
    const toolRegistry = this.config.getToolRegistry();
    if (!toolRegistry) {
      return tools;
    }

    const allTools = toolRegistry.getAllTools();

    const result: string[] = [];
    for (const toolIdentifier of tools) {
      // First, try to find an exact match by tool name (highest priority)
      const exactNameMatch = allTools.find(
        (tool) => tool.name === toolIdentifier,
      );
      if (exactNameMatch) {
        result.push(exactNameMatch.name);
        continue;
      }

      // If no exact name match, try to find by display name
      const displayNameMatch = allTools.find(
        (tool) =>
          tool.displayName === toolIdentifier ||
          tool.displayName ===
            (ToolDisplayNamesMigration[
              toolIdentifier as keyof typeof ToolDisplayNamesMigration
            ] as string | undefined),
      );
      if (displayNameMatch) {
        result.push(displayNameMatch.name);
        continue;
      }

      // If no match found, preserve the original identifier as-is
      // This allows for tools that might not be registered yet or custom tools
      result.push(toolIdentifier);
      console.warn(
        `Tool "${toolIdentifier}" not found in tool registry, preserving as-is`,
      );
    }

    return result;
  }

  /**
   * Merges partial configurations with defaults, useful for updating
   * existing configurations.
   *
   * @param base - Base configuration
   * @param updates - Partial updates to apply
   * @returns New configuration with updates applied
   */
  mergeConfigurations(
    base: SubagentConfig,
    updates: Partial<SubagentConfig>,
  ): SubagentConfig {
    return {
      ...base,
      ...updates,
      // Handle nested objects specially
      modelConfig: updates.modelConfig
        ? { ...base.modelConfig, ...updates.modelConfig }
        : base.modelConfig,
      runConfig: updates.runConfig
        ? { ...base.runConfig, ...updates.runConfig }
        : base.runConfig,
    };
  }

  /**
   * Gets the file path for a subagent at a specific level.
   *
   * @param name - Subagent name
   * @param level - Storage level
   * @returns Absolute file path
   */
  getSubagentPath(name: string, level: SubagentLevel): string {
    if (level === 'builtin') {
      return `<builtin:${name}>`;
    }

    const baseDir =
      level === 'project'
        ? path.join(
            this.config.getProjectRoot(),
            QWEN_CONFIG_DIR,
            AGENT_CONFIG_DIR,
          )
        : path.join(os.homedir(), QWEN_CONFIG_DIR, AGENT_CONFIG_DIR);

    return path.join(baseDir, `${name}.md`);
  }

  /**
   * Lists subagent files at a specific level.
   * Handles both builtin agents and file-based agents.
   *
   * @param level - Storage level to scan
   * @returns Array of subagent configurations
   */
  private async listSubagentsAtLevel(
    level: SubagentLevel,
  ): Promise<SubagentConfig[]> {
    // Handle built-in agents
    if (level === 'builtin') {
      return BuiltinAgentRegistry.getBuiltinAgents();
    }

    const projectRoot = this.config.getProjectRoot();
    const homeDir = os.homedir();
    const isHomeDirectory = path.resolve(projectRoot) === path.resolve(homeDir);

    // If project level is requested but project root is same as home directory,
    // return empty array to avoid conflicts between project and global agents
    if (level === 'project' && isHomeDirectory) {
      return [];
    }

    let baseDir = level === 'project' ? projectRoot : homeDir;
    baseDir = path.join(baseDir, QWEN_CONFIG_DIR, AGENT_CONFIG_DIR);

    try {
      const files = await fs.readdir(baseDir);
      const subagents: SubagentConfig[] = [];

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(baseDir, file);

        try {
          const config = await this.parseSubagentFile(filePath, level);
          subagents.push(config);
        } catch (_error) {
          // Ignore invalid files
          continue;
        }
      }

      return subagents;
    } catch (_error) {
      // Directory doesn't exist or can't be read
      return [];
    }
  }

  /**
   * Finds a subagent by name at a specific level by scanning all files.
   * This method ensures we find subagents even if the filename doesn't match the name.
   *
   * @param name - Name of the subagent to find
   * @param level - Storage level to search
   * @returns SubagentConfig or null if not found
   */
  private async findSubagentByNameAtLevel(
    name: string,
    level: SubagentLevel,
  ): Promise<SubagentConfig | null> {
    const allSubagents = await this.listSubagentsAtLevel(level);

    // Find the subagent with matching name
    for (const subagent of allSubagents) {
      if (subagent.name === name) {
        return subagent;
      }
    }

    return null;
  }

  /**
   * Validates that a subagent name is available (not already in use).
   *
   * @param name - Name to check
   * @param level - Level to check, or undefined to check both
   * @returns True if name is available
   */
  async isNameAvailable(name: string, level?: SubagentLevel): Promise<boolean> {
    const existing = await this.loadSubagent(name, level);

    if (!existing) {
      return true; // Name is available
    }

    if (level && existing.level !== level) {
      return true; // Name is available at the specified level
    }

    return false; // Name is already in use
  }
}
