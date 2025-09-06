/**
 * @license
 * Copyright 2025 Google LLC
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
import {
  SubagentConfig,
  SubagentRuntimeConfig,
  SubagentLevel,
  ListSubagentsOptions,
  CreateSubagentOptions,
  SubagentError,
  SubagentErrorCode,
} from './types.js';
import { SubagentValidator } from './validation.js';
import {
  SubAgentScope,
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../core/subagent.js';
import { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';

const QWEN_CONFIG_DIR = '.qwen';
const AGENT_CONFIG_DIR = 'agents';

/**
 * Manages subagent configurations stored as Markdown files with YAML frontmatter.
 * Provides CRUD operations, validation, and integration with the runtime system.
 */
export class SubagentManager {
  private readonly validator: SubagentValidator;

  constructor(
    private readonly projectRoot: string,
    private readonly toolRegistry?: ToolRegistry,
  ) {
    this.validator = new SubagentValidator(toolRegistry);
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
    // Validate the configuration
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
   * If level is omitted, searches project-level first, then user-level.
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
      const path = this.getSubagentPath(name, level);
      try {
        const config = await this.parseSubagentFile(path);
        return config;
      } catch (_error) {
        return null;
      }
    }

    // Try project level first
    const projectPath = this.getSubagentPath(name, 'project');
    try {
      const config = await this.parseSubagentFile(projectPath);
      return config;
    } catch (_error) {
      // Continue to user level
    }

    // Try user level
    const userPath = this.getSubagentPath(name, 'user');
    try {
      const config = await this.parseSubagentFile(userPath);
      return config;
    } catch (_error) {
      // Not found at either level
      return null;
    }
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

    // Merge updates with existing configuration
    const updatedConfig = this.mergeConfigurations(existing, updates);

    // Validate the updated configuration
    this.validator.validateOrThrow(updatedConfig);

    // Write the updated configuration
    const content = this.serializeSubagent(updatedConfig);

    try {
      await fs.writeFile(existing.filePath, content, 'utf8');
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
    const levelsToCheck: SubagentLevel[] = level
      ? [level]
      : ['project', 'user'];
    let deleted = false;

    for (const currentLevel of levelsToCheck) {
      const filePath = this.getSubagentPath(name, currentLevel);

      try {
        await fs.unlink(filePath);
        deleted = true;
      } catch (_error) {
        // File might not exist at this level, continue
      }
    }

    if (!deleted) {
      throw new SubagentError(
        `Subagent "${name}" not found`,
        SubagentErrorCode.NOT_FOUND,
        name,
      );
    }
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
      : ['project', 'user'];

    // Collect subagents from each level (project takes precedence)
    for (const level of levelsToCheck) {
      const levelSubagents = await this.listSubagentsAtLevel(level);

      for (const subagent of levelSubagents) {
        // Skip if we've already seen this name (project takes precedence)
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
          case 'level':
            // Project comes before user
            comparison =
              a.level === 'project' ? -1 : b.level === 'project' ? 1 : 0;
            break;
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
  async parseSubagentFile(filePath: string): Promise<SubagentConfig> {
    let content: string;

    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      throw new SubagentError(
        `Failed to read subagent file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        SubagentErrorCode.FILE_ERROR,
      );
    }

    return this.parseSubagentContent(content, filePath);
  }

  /**
   * Parses subagent content from a string.
   *
   * @param content - File content
   * @param filePath - File path for error reporting
   * @returns SubagentConfig
   * @throws SubagentError if parsing fails
   */
  parseSubagentContent(content: string, filePath: string): SubagentConfig {
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

      // Extract required fields
      const name = frontmatter['name'] as string;
      const description = frontmatter['description'] as string;

      if (!name || typeof name !== 'string') {
        throw new Error('Missing or invalid "name" in frontmatter');
      }

      if (!description || typeof description !== 'string') {
        throw new Error('Missing or invalid "description" in frontmatter');
      }

      // Extract optional fields
      const tools = frontmatter['tools'] as string[] | undefined;
      const modelConfig = frontmatter['modelConfig'] as
        | Record<string, unknown>
        | undefined;
      const runConfig = frontmatter['runConfig'] as
        | Record<string, unknown>
        | undefined;
      const backgroundColor = frontmatter['backgroundColor'] as
        | string
        | undefined;

      // Determine level from file path
      // Project level paths contain the project root, user level paths are in home directory
      const isProjectLevel =
        filePath.includes(this.projectRoot) &&
        filePath.includes(`/${QWEN_CONFIG_DIR}/${AGENT_CONFIG_DIR}/`);
      const level: SubagentLevel = isProjectLevel ? 'project' : 'user';

      const config: SubagentConfig = {
        name,
        description,
        tools,
        systemPrompt: systemPrompt.trim(),
        level,
        filePath,
        modelConfig: modelConfig as Partial<
          import('../core/subagent.js').ModelConfig
        >,
        runConfig: runConfig as Partial<
          import('../core/subagent.js').RunConfig
        >,
        backgroundColor,
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

    if (config.modelConfig) {
      frontmatter['modelConfig'] = config.modelConfig;
    }

    if (config.runConfig) {
      frontmatter['runConfig'] = config.runConfig;
    }

    if (config.backgroundColor && config.backgroundColor !== 'auto') {
      frontmatter['backgroundColor'] = config.backgroundColor;
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
      toolConfig = {
        tools: config.tools,
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
    const baseDir =
      level === 'project'
        ? path.join(this.projectRoot, QWEN_CONFIG_DIR, AGENT_CONFIG_DIR)
        : path.join(os.homedir(), QWEN_CONFIG_DIR, AGENT_CONFIG_DIR);

    return path.join(baseDir, `${name}.md`);
  }

  /**
   * Lists subagents at a specific level.
   *
   * @param level - Storage level to check
   * @returns Array of subagent metadata
   */
  private async listSubagentsAtLevel(
    level: SubagentLevel,
  ): Promise<SubagentConfig[]> {
    const baseDir =
      level === 'project'
        ? path.join(this.projectRoot, QWEN_CONFIG_DIR, AGENT_CONFIG_DIR)
        : path.join(os.homedir(), QWEN_CONFIG_DIR, AGENT_CONFIG_DIR);

    try {
      const files = await fs.readdir(baseDir);
      const subagents: SubagentConfig[] = [];

      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(baseDir, file);

        try {
          const config = await this.parseSubagentFile(filePath);
          subagents.push(config);
        } catch (error) {
          // Skip invalid files but log the error
          console.warn(
            `Skipping invalid subagent file ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }

      return subagents;
    } catch (_error) {
      // Directory doesn't exist or can't be read
      return [];
    }
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

  /**
   * Gets available tools from the tool registry.
   * Useful for validation and UI purposes.
   *
   * @returns Array of available tool names
   */
  getAvailableTools(): string[] {
    if (!this.toolRegistry) {
      return [];
    }

    // This would need to be implemented in ToolRegistry
    // For now, return empty array
    return [];
  }
}
