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
} from './types.js';
import type {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../agents/runtime/agent-types.js';
import { SubagentError, SubagentErrorCode } from './types.js';
import { SubagentValidator } from './validation.js';
import { AgentHeadless } from '../agents/runtime/agent-headless.js';
import type {
  AgentEventEmitter,
  AgentHooks,
} from '../agents/runtime/agent-events.js';
import type { Config } from '../config/config.js';
import { APPROVAL_MODES } from '../config/config.js';
import {
  type AuthType,
  type ContentGenerator,
  type ContentGeneratorConfig,
  createContentGenerator,
} from '../core/contentGenerator.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';
import { parseSubagentModelSelection } from './model-selection.js';
const debugLogger = createDebugLogger('SUBAGENT_MANAGER');
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
        debugLogger.warn('Subagent change listener threw an error:', error);
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

    // Prevent creating session-level agents
    if (options.level === 'session') {
      throw new SubagentError(
        `Cannot create session-level subagent "${config.name}". Session agents are read-only and provided at runtime.`,
        SubagentErrorCode.INVALID_CONFIG,
        config.name,
      );
    }

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
    const lowerName = name.toLowerCase();

    if (level) {
      // Search only the specified level
      if (level === 'builtin') {
        return BuiltinAgentRegistry.getBuiltinAgent(name);
      }

      if (level === 'session') {
        const sessionSubagents = this.subagentsCache?.get('session') || [];
        return (
          sessionSubagents.find(
            (agent) => agent.name.toLowerCase() === lowerName,
          ) || null
        );
      }

      return this.findSubagentByNameAtLevel(name, level);
    }

    // Try session level first (highest priority for runtime)
    const sessionSubagents = this.subagentsCache?.get('session') || [];
    const sessionConfig = sessionSubagents.find(
      (agent) => agent.name.toLowerCase() === lowerName,
    );
    if (sessionConfig) {
      return sessionConfig;
    }

    // Try project level
    const projectConfig = await this.findSubagentByNameAtLevel(name, 'project');
    if (projectConfig) {
      return projectConfig;
    }

    // Try user level
    const userConfig = await this.findSubagentByNameAtLevel(name, 'user');
    if (userConfig) {
      return userConfig;
    }

    // Try extension level
    const extensionConfig = await this.findSubagentByNameAtLevel(
      name,
      'extension',
    );
    if (extensionConfig) {
      return extensionConfig;
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

    // Prevent updating session-level agents
    if (existing.level === 'session') {
      throw new SubagentError(
        `Cannot update session-level subagent "${name}"`,
        SubagentErrorCode.INVALID_CONFIG,
        name,
      );
    }

    // Merge updates with existing configuration
    const updatedConfig = this.mergeConfigurations(existing, updates);

    // Validate the updated configuration
    this.validator.validateOrThrow(updatedConfig);

    // Ensure filePath exists for file-based agents
    if (!existing.filePath) {
      throw new SubagentError(
        `Cannot update subagent "${name}": no file path available`,
        SubagentErrorCode.FILE_ERROR,
        name,
      );
    }

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
  async deleteSubagent(
    name: string,
    level?: SubagentLevel,
    extensionName?: string,
  ): Promise<void> {
    // Check if it's a built-in agent first
    if (BuiltinAgentRegistry.isBuiltinAgent(name)) {
      throw new SubagentError(
        `Cannot delete built-in subagent "${name}"`,
        SubagentErrorCode.INVALID_CONFIG,
        name,
      );
    }
    if (level === 'extension') {
      throw new SubagentError(
        `Cannot delete subagent "${name}" in extension "${extensionName}", If needed, you can directly uninstall extension.`,
        SubagentErrorCode.INVALID_CONFIG,
        name,
      );
    }

    const levelsToCheck: SubagentLevel[] = level
      ? [level]
      : ['project', 'user'];
    let deleted = false;

    for (const currentLevel of levelsToCheck) {
      // Skip builtin and session levels for deletion
      if (currentLevel === 'builtin' || currentLevel === 'session') {
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

    // In SDK mode, only load session-level subagents
    if (this.config.getSdkMode()) {
      const levelsToCheck: SubagentLevel[] = options.level
        ? [options.level]
        : ['session'];

      for (const level of levelsToCheck) {
        const levelSubagents = this.subagentsCache?.get(level) || [];

        for (const subagent of levelSubagents) {
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

      return subagents;
    }

    // Normal mode: load from project, user, and builtin levels
    const levelsToCheck: SubagentLevel[] = options.level
      ? [options.level]
      : ['project', 'user', 'builtin', 'extension'];

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
            // Project comes before user, user comes before builtin, session comes last
            const levelOrder = {
              project: 0,
              user: 1,
              builtin: 2,
              session: 3,
              extension: 4,
            };
            comparison =
              levelOrder[a.level as SubagentLevel] -
              levelOrder[b.level as SubagentLevel];
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
   * Loads session-level subagents into the cache.
   * Session subagents are provided directly via config and are read-only.
   *
   * @param subagents - Array of session subagent configurations
   */
  loadSessionSubagents(subagents: SubagentConfig[]): void {
    if (!this.subagentsCache) {
      this.subagentsCache = new Map();
    }

    const sessionSubagents = subagents.map((config) => ({
      ...config,
      level: 'session' as SubagentLevel,
      filePath: `<session:${config.name}>`,
    }));

    this.subagentsCache.set('session', sessionSubagents);
    this.notifyChangeListeners();
  }

  /**
   * Refreshes the subagents cache by loading all subagents from disk.
   * This method is called automatically when cache is null or when force=true.
   *
   * @private
   */
  async refreshCache(): Promise<void> {
    const subagentsCache = new Map();

    const levels: SubagentLevel[] = ['project', 'user', 'builtin', 'extension'];

    for (const level of levels) {
      const levelSubagents = await this.listSubagentsAtLevel(level);
      subagentsCache.set(level, levelSubagents);
    }

    // Preserve session subagents from old cache
    const sessionSubagents = this.subagentsCache?.get('session');
    if (sessionSubagents) {
      subagentsCache.set('session', sessionSubagents);
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
    return parseSubagentContent(content, filePath, level, this.validator);
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

    if (config.disallowedTools && config.disallowedTools.length > 0) {
      frontmatter['disallowedTools'] = config.disallowedTools;
    }

    if (config.model && config.model !== 'inherit') {
      frontmatter['model'] = config.model;
    }

    if (config.runConfig) {
      frontmatter['runConfig'] = config.runConfig;
    }

    if (config.color && config.color !== 'auto') {
      frontmatter['color'] = config.color;
    }

    if (
      config.approvalMode &&
      APPROVAL_MODES.includes(config.approvalMode as never)
    ) {
      frontmatter['approvalMode'] = config.approvalMode;
    }

    if (config.background) {
      frontmatter['background'] = true;
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
   * Creates an AgentHeadless from a subagent configuration.
   *
   * @param config - Subagent configuration
   * @param runtimeContext - Runtime context
   * @returns Promise resolving to AgentHeadless
   */
  async createAgentHeadless(
    config: SubagentConfig,
    runtimeContext: Config,
    options?: {
      eventEmitter?: AgentEventEmitter;
      hooks?: AgentHooks;
      promptConfigOverrides?: Partial<PromptConfig>;
      modelConfigOverrides?: Partial<ModelConfig>;
      runConfigOverrides?: Partial<RunConfig>;
      toolConfigOverride?: ToolConfig;
    },
  ): Promise<AgentHeadless> {
    try {
      const runtimeConfig = await this.convertToRuntimeConfig(config);
      const promptConfig: PromptConfig = {
        ...runtimeConfig.promptConfig,
        ...options?.promptConfigOverrides,
      };
      const modelConfig: ModelConfig = {
        ...runtimeConfig.modelConfig,
        ...options?.modelConfigOverrides,
      };
      const runConfig: RunConfig = {
        ...runtimeConfig.runConfig,
        ...options?.runConfigOverrides,
      };
      const toolConfig =
        options?.toolConfigOverride ?? runtimeConfig.toolConfig;

      // When the model selector specifies a different provider, build a
      // per-agent Config with a dedicated ContentGenerator so the subagent
      // talks to the right API without affecting the parent process.
      const agentContext = await this.maybeOverrideContentGenerator(
        config,
        runtimeContext,
      );

      return await AgentHeadless.create(
        config.name,
        agentContext,
        promptConfig,
        modelConfig,
        runConfig,
        toolConfig,
        options?.eventEmitter,
        options?.hooks,
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new SubagentError(
          `Failed to create AgentHeadless: ${error.message}`,
          SubagentErrorCode.INVALID_CONFIG,
          config.name,
        );
      }
      throw error;
    }
  }

  /**
   * When a subagent's model selector specifies a model (bare ID or
   * authType-prefixed), build a Config override with a dedicated
   * ContentGenerator so the model actually reaches the API.
   * For inherit selectors we still build a thin Object.create
   * override so the subagent gets an isolated FileReadCache via
   * the per-Config own-property machinery — returning `base`
   * directly would let the subagent share the parent's read entries
   * and silently weaken prior-read enforcement on its mutation
   * paths.
   */
  private async maybeOverrideContentGenerator(
    config: SubagentConfig,
    base: Config,
  ): Promise<Config> {
    const selection = parseSubagentModelSelection(config.model);
    if (selection.inherits) {
      // Thin prototype-delegation override: no method changes, but a
      // distinct instance triggers the lazy-init in
      // `Config.getFileReadCache()` so the subagent gets its own
      // cache rather than inheriting the parent's.
      //
      // Same caveat as in `agent.ts:createApprovalModeOverride`: the
      // tool registry was bound on the parent at initialise time, so
      // tool invocations still resolve `this.config` to the parent
      // and reach the parent's cache. `InProcessBackend.createPerAgentConfig`
      // already rebuilds the registry via `override.createToolRegistry()`
      // + `copyDiscoveredToolsFrom(base.getToolRegistry())`; doing
      // that here is the follow-up that closes the bound-tool path.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isolated = Object.create(base) as any;
      return isolated as Config;
    }

    const authType =
      selection.authType ?? base.getContentGeneratorConfig().authType;
    const authOverrides = {
      authType: authType as string,
    };

    const agentGeneratorConfig = buildAgentContentGeneratorConfig(
      base,
      selection.modelId,
      authOverrides,
    );

    const agentGenerator = await createContentGenerator(
      agentGeneratorConfig,
      base,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const override = Object.create(base) as any;
    override.getContentGenerator = (): ContentGenerator => agentGenerator;
    override.getContentGeneratorConfig = (): ContentGeneratorConfig =>
      agentGeneratorConfig;
    override.getAuthType = (): AuthType | undefined =>
      agentGeneratorConfig.authType;
    override.getModel = (): string => agentGeneratorConfig.model;

    debugLogger.info(
      `Created per-agent ContentGenerator for subagent "${config.name}": authType=${authType}, model=${agentGeneratorConfig.model}`,
    );

    return override as Config;
  }

  /**
   * Converts a file-based SubagentConfig to runtime configuration
   * compatible with AgentHeadless.create().
   *
   * @param config - File-based subagent configuration
   * @returns Runtime configuration for AgentHeadless
   */
  async convertToRuntimeConfig(
    config: SubagentConfig,
  ): Promise<SubagentRuntimeConfig> {
    const promptConfig: PromptConfig = {
      systemPrompt: config.systemPrompt,
    };

    const selection = parseSubagentModelSelection(config.model);
    const modelConfig: ModelConfig = {
      ...(selection.modelId ? { model: selection.modelId } : {}),
    };

    const runConfig: RunConfig = {
      ...config.runConfig,
    };

    let toolConfig: ToolConfig | undefined;
    if (
      (config.tools && config.tools.length > 0) ||
      (config.disallowedTools && config.disallowedTools.length > 0)
    ) {
      const toolNames = config.tools
        ? await this.transformToToolNames(config.tools)
        : ['*'];
      toolConfig = {
        tools: toolNames,
        ...(config.disallowedTools && config.disallowedTools.length > 0
          ? {
              disallowedTools: await this.transformToToolNames(
                config.disallowedTools,
              ),
            }
          : {}),
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
  private async transformToToolNames(tools: string[]): Promise<string[]> {
    const toolRegistry = this.config.getToolRegistry();
    if (!toolRegistry) {
      return tools;
    }

    await toolRegistry.warmAll();
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
      debugLogger.warn(
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

    if (level === 'session') {
      return `<session:${name}>`;
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

    if (level === 'extension') {
      const extensions = this.config.getActiveExtensions();
      return extensions.flatMap((extension) => extension.agents || []);
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
        } catch (error) {
          // Skip invalid files but surface the reason. Before this warning
          // was added, invalid subagent files failed silently — a user who
          // mistyped frontmatter or used a reserved name had no way to see
          // why their agent wasn't loading.
          warnInvalidSubagentFile(filePath, error);
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

    const lowerName = name.toLowerCase();
    for (const subagent of allSubagents) {
      if (subagent.name.toLowerCase() === lowerName) {
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

export async function loadSubagentFromDir(
  baseDir: string,
): Promise<SubagentConfig[]> {
  try {
    const files = await fs.readdir(baseDir);
    const subagents: SubagentConfig[] = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(baseDir, file);

      try {
        const content = await fs.readFile(filePath, 'utf8');
        const config = parseSubagentContent(
          content,
          filePath,
          'extension',
          new SubagentValidator(),
        );
        subagents.push(config);
      } catch (error) {
        warnInvalidSubagentFile(filePath, error);
        continue;
      }
    }

    return subagents;
  } catch (_error) {
    // Directory doesn't exist or can't be read
    return [];
  }
}

function parseSubagentContent(
  content: string,
  filePath: string,
  level: SubagentLevel,
  validator: SubagentValidator,
): SubagentConfig {
  try {
    const normalizedContent = normalizeContent(content);

    // Split frontmatter and content
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = normalizedContent.match(frontmatterRegex);

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
    const disallowedToolsRaw = frontmatter['disallowedTools'];
    const disallowedTools: string[] | undefined = Array.isArray(
      disallowedToolsRaw,
    )
      ? disallowedToolsRaw.filter(
          (item): item is string => typeof item === 'string',
        )
      : typeof disallowedToolsRaw === 'string'
        ? [disallowedToolsRaw]
        : undefined;
    const modelRaw = frontmatter['model'];
    const legacyModelConfig = frontmatter['modelConfig'] as
      | Record<string, unknown>
      | undefined;
    const runConfig = frontmatter['runConfig'] as
      | Record<string, unknown>
      | undefined;
    const color = frontmatter['color'] as string | undefined;
    const approvalModeRaw = frontmatter['approvalMode'];
    if (
      approvalModeRaw !== undefined &&
      approvalModeRaw !== null &&
      typeof approvalModeRaw !== 'string'
    ) {
      throw new Error(
        `Invalid "approvalMode" value: expected a string, got ${typeof approvalModeRaw}. Valid values: ${APPROVAL_MODES.join(', ')}`,
      );
    }
    const approvalMode =
      typeof approvalModeRaw === 'string' && approvalModeRaw !== ''
        ? approvalModeRaw
        : undefined;
    if (
      approvalMode !== undefined &&
      !APPROVAL_MODES.includes(approvalMode as never)
    ) {
      throw new Error(
        `Invalid "approvalMode" value "${approvalMode}". Valid values: ${APPROVAL_MODES.join(', ')}`,
      );
    }
    const model =
      modelRaw != null && modelRaw !== ''
        ? String(modelRaw)
        : typeof legacyModelConfig?.['model'] === 'string'
          ? legacyModelConfig['model']
          : undefined;

    const backgroundRaw = frontmatter['background'];
    if (
      backgroundRaw !== undefined &&
      backgroundRaw !== 'true' &&
      backgroundRaw !== 'false' &&
      backgroundRaw !== true &&
      backgroundRaw !== false
    ) {
      debugLogger.warn(
        `Agent file ${filePath} has invalid background value '${backgroundRaw}'. Must be 'true', 'false', or omitted.`,
      );
    }
    const background =
      backgroundRaw === 'true' || backgroundRaw === true ? true : undefined;

    const config: SubagentConfig = {
      name,
      description,
      tools,
      disallowedTools,
      approvalMode,
      systemPrompt: systemPrompt.trim(),
      filePath,
      model,
      runConfig: runConfig as Partial<RunConfig>,
      color,
      level,
      ...(background ? { background } : {}),
    };

    // Validate the parsed configuration
    const validation = validator.validateConfig(config);
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
 * Log an invalid-subagent-file error via the debug logger. Before this was
 * added, the loader swallowed these errors entirely — users running with
 * debug logging enabled had no way to tell why their subagent wasn't loading.
 * Kept on the debug channel so the TUI stays quiet during normal startup.
 */
function warnInvalidSubagentFile(filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  debugLogger.debug(`Skipped invalid file ${filePath}: ${message}`);
}
