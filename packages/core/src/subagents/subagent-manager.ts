/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { isScalar, parseDocument, visit } from 'yaml';
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from '../utils/yaml-parser.js';
import type {
  SubagentConfig,
  SubagentModelRoute,
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
import {
  BUBBLE_APPROVAL_MODE,
  SubagentError,
  SubagentErrorCode,
} from './types.js';
import { SubagentValidator } from './validation.js';
import { AgentHeadless } from '../agents/runtime/agent-headless.js';
import type { SubagentExecutor } from '../agents/runtime/subagent-executor.js';
import type {
  AgentEventEmitter,
  AgentHooks,
} from '../agents/runtime/agent-events.js';
import type { Config, MCPServerConfig } from '../config/config.js';
import { APPROVAL_MODES, deriveConfig } from '../config/config.js';
import type { HookDefinition, HookEventName } from '../hooks/types.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import type { ReasoningEffort } from '../core/reasoning-effort.js';
import {
  createRuntimeContentGeneratorView,
  resolveAgentReasoningTier,
  type AuthOverrides,
} from '../models/content-generator-config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';
import {
  buildModelIdContext,
  resolveModelId,
  type ResolvedModelId,
} from '../utils/modelId.js';
const debugLogger = createDebugLogger('SUBAGENT_MANAGER');
import { BuiltinAgentRegistry } from './builtin-agents.js';
import {
  COLOR_VALUES,
  isColor,
  isPermissionMode,
  parseAgentExecutor,
  parseAgentHooks,
  parseAgentMcpServers,
  parseMaxTurns,
  claudePermissionModeToApprovalMode,
} from './agent-frontmatter-schema.js';
import {
  resolveBuiltinToolName,
  ToolDisplayNamesMigration,
  ToolNames,
} from '../tools/tool-names.js';
import { QWEN_DIR, Storage } from '../config/storage.js';
import {
  hasRebuiltToolRegistry,
  rebuildToolRegistryOnOverride,
} from '../tools/agent/agent.js';

const AGENT_CONFIG_DIR = 'agents';

/**
 * Whether `mode` is valid on a subagent definition's `approvalMode`: any
 * session-level {@link APPROVAL_MODES} value, plus the subagent-only
 * {@link BUBBLE_APPROVAL_MODE}. `'bubble'` is intentionally NOT a member of the
 * global `ApprovalMode` enum (it would pollute the session model/approval
 * pickers); it is valid only here.
 *
 * Reads `APPROVAL_MODES` lazily (inside the call) rather than via a top-level
 * spread: this module sits in an import cycle with `config.ts`, and an eager
 * `[...APPROVAL_MODES]` at module-eval time can observe `APPROVAL_MODES`
 * before `config.ts` has finished initializing it.
 */
function isSubagentApprovalMode(mode: string): boolean {
  return (
    (APPROVAL_MODES as readonly string[]).includes(mode) ||
    mode === BUBBLE_APPROVAL_MODE
  );
}

/** Human-readable list of valid subagent approval modes, for error messages. */
function subagentApprovalModesLabel(): string {
  return [...APPROVAL_MODES, BUBBLE_APPROVAL_MODE].join(', ');
}

/**
 * Manages subagent configurations stored as Markdown files with YAML frontmatter.
 * Provides CRUD operations, validation, and integration with the runtime system.
 */
export class SubagentManager {
  private readonly validator: SubagentValidator;
  private subagentsCache: Map<SubagentLevel, SubagentConfig[]> | null = null;
  // R10-2: executor-block refusals recorded during a level scan, keyed by level
  // then lowercased declared name. loadSubagent consults this so a by-name
  // dispatch REFUSES instead of falling through to a lower-precedence in-process
  // definition of the same name (the silent substitution this feature prevents).
  private readonly executorRefusals = new Map<
    SubagentLevel,
    Map<string, SubagentError>
  >();
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

  private applyBuiltinSettings(config: SubagentConfig): SubagentConfig {
    if (config.name !== 'Explore') {
      return config;
    }

    const configuredModel =
      this.config.getAgentsSettings().builtin?.exploreModel;
    if (typeof configuredModel !== 'string') {
      return config;
    }

    const exploreModel = configuredModel.trim();
    if (!exploreModel) {
      return config;
    }

    return { ...config, model: exploreModel };
  }

  resolveModelGrade(
    grade: string | undefined,
    agentConfig: SubagentConfig,
  ): string | undefined {
    const configuredModel = agentConfig.model?.trim();
    if (
      !agentConfig.isBuiltin &&
      configuredModel &&
      configuredModel !== 'inherit'
    ) {
      return undefined;
    }

    if (!grade) {
      return undefined;
    }

    return this.getAvailableModelGrades().get(grade);
  }

  getAvailableModelGrades(): Map<string, string> {
    const { modelGrades, allowedGrades } = this.config.getAgentsSettings();
    if (
      !modelGrades ||
      typeof modelGrades !== 'object' ||
      Array.isArray(modelGrades) ||
      (allowedGrades !== undefined && !Array.isArray(allowedGrades))
    ) {
      return new Map();
    }

    return new Map(
      Object.entries(modelGrades).flatMap(([grade, model]) => {
        const normalizedGrade = grade.trim();
        return normalizedGrade !== '' &&
          typeof model === 'string' &&
          model.trim() !== '' &&
          (allowedGrades === undefined ||
            allowedGrades.some(
              (allowedGrade) =>
                typeof allowedGrade === 'string' &&
                allowedGrade.trim() === normalizedGrade,
            ))
          ? [[normalizedGrade, model.trim()] as const]
          : [];
      }),
    );
  }

  private getBuiltinAgent(name: string): SubagentConfig | null {
    const config = BuiltinAgentRegistry.getBuiltinAgent(name);
    return config ? this.applyBuiltinSettings(config) : null;
  }

  private getBuiltinAgents(): SubagentConfig[] {
    return BuiltinAgentRegistry.getBuiltinAgents().map((config) =>
      this.applyBuiltinSettings(config),
    );
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
    options.assertCanCommit?.();
    await fs.mkdir(dir, { recursive: true });

    // Update config with actual file path and level
    const finalConfig: SubagentConfig = {
      ...config,
      level: options.level,
      filePath,
    };

    // Serialize and write the file
    const content = this.serializeSubagent(finalConfig);

    options.assertCanCommit?.();
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
        return this.getBuiltinAgent(name);
      }

      if (level === 'session') {
        const sessionSubagents = this.subagentsCache?.get('session') || [];
        return (
          sessionSubagents.find(
            (agent) => agent.name.toLowerCase() === lowerName,
          ) || null
        );
      }

      // The explicit-level path does not fall through to a lower-precedence
      // definition or a builtin, so it cannot silently substitute an in-process
      // agent — return the level's match (or null) without the R10-2 refusal.
      // Only the by-name fall-through path below (used by dispatch) refuses.
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
    this.throwRecordedExecutorRefusal('project', lowerName);

    // Try user level
    const userConfig = await this.findSubagentByNameAtLevel(name, 'user');
    if (userConfig) {
      return userConfig;
    }
    this.throwRecordedExecutorRefusal('user', lowerName);

    // Try extension level
    const extensionConfig = await this.findSubagentByNameAtLevel(
      name,
      'extension',
    );
    if (extensionConfig) {
      return extensionConfig;
    }
    this.throwRecordedExecutorRefusal('extension', lowerName);

    // Try built-in agents as fallback
    return this.getBuiltinAgent(name);
  }

  // R10-2: refuse a by-name dispatch when this level skipped a file that
  // declared `name` but had an invalid executor block, instead of falling
  // through to a lower-precedence in-process definition (or a builtin) of the
  // same name — which would silently substitute a Qwen-model agent for the
  // external one the file asked for, with only a discovery-time console.warn.
  // Scoped to executor refusals recorded during the level scan, so an arbitrary
  // malformed file cannot disable an unrelated builtin.
  private throwRecordedExecutorRefusal(
    level: SubagentLevel,
    lowerName: string,
  ): void {
    const refusal = this.executorRefusals.get(level)?.get(lowerName);
    if (refusal) throw refusal;
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
    options?: { assertCanCommit?: () => void },
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

    if (existing.level === 'extension') {
      throw new SubagentError(
        `Cannot update extension-provided subagent "${name}"`,
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

    options?.assertCanCommit?.();
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
    options?: { assertCanCommit?: () => void },
  ): Promise<void> {
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
    let deleteError: SubagentError | undefined;

    // Assert once before any deletion so a closed generation fails atomically
    // instead of unlinking some level files and then throwing mid-loop.
    options?.assertCanCommit?.();
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
        } catch (error) {
          deleteError = new SubagentError(
            `Failed to delete subagent file: ${error instanceof Error ? error.message : String(error)}`,
            SubagentErrorCode.FILE_ERROR,
            name,
          );
        }
      }
    }

    if (!deleted) {
      if (deleteError) throw deleteError;
      const isBuiltin = BuiltinAgentRegistry.isBuiltinAgent(name);
      throw new SubagentError(
        isBuiltin
          ? `Cannot delete built-in subagent "${name}"`
          : `Subagent "${name}" not found`,
        isBuiltin
          ? SubagentErrorCode.INVALID_CONFIG
          : SubagentErrorCode.NOT_FOUND,
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
    // Safe mode: only builtin subagents are available
    const defaultLevels: SubagentLevel[] = this.config.isSafeMode()
      ? ['builtin']
      : ['project', 'user', 'builtin', 'extension'];
    if (
      this.config.isSafeMode() &&
      options.level &&
      options.level !== 'builtin'
    ) {
      debugLogger.debug(
        `Safe mode: overriding requested level '${options.level}' to 'builtin'`,
      );
    }
    const levelsToCheck: SubagentLevel[] = options.level
      ? this.config.isSafeMode() && options.level !== 'builtin'
        ? ['builtin']
        : [options.level]
      : defaultLevels;

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

    // Safe mode: only load builtin subagents
    const levels: SubagentLevel[] = this.config.isSafeMode()
      ? ['builtin']
      : ['project', 'user', 'builtin', 'extension'];

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

    if (config.approvalMode && isSubagentApprovalMode(config.approvalMode)) {
      frontmatter['approvalMode'] = config.approvalMode;
    }

    if (config.background !== undefined) {
      frontmatter['background'] = config.background;
    }

    // CC 2.1.168 declarative-agent fields (round-trip parity).
    // Skip permissionMode when approvalMode is already being written: on the
    // next load the parser takes approvalMode (explicit wins over bridge),
    // making permissionMode dead frontmatter that silently ignores any
    // later user edits.
    if (config.permissionMode && frontmatter['approvalMode'] === undefined) {
      frontmatter['permissionMode'] = config.permissionMode;
    }

    if (config.maxTurns !== undefined) {
      frontmatter['maxTurns'] = config.maxTurns;
    }

    // Nested CC fields. Safe to round-trip with the eemeli/yaml parser; the
    // previous skip-list carve-out is gone (see docs/design/yaml-parser-replacement.md).
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      frontmatter['mcpServers'] = config.mcpServers;
    }

    if (config.hooks && Object.keys(config.hooks).length > 0) {
      frontmatter['hooks'] = config.hooks;
    }

    if (config.executor !== undefined) {
      const executor = parseAgentExecutor(config.executor);
      if (!executor) {
        throw new SubagentError(
          `Subagent "${config.name}" executor block failed validation. Refusing to save it without its executor.`,
          SubagentErrorCode.INVALID_CONFIG,
          config.name,
        );
      }
      frontmatter['executor'] = executor;
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
   * Creates an AgentHeadless from a subagent configuration and returns a
   * `dispose` callback that releases the per-spawn cleanup-bearing resources
   * (ephemeral hook entries registered against the session's HookRegistry,
   * the per-agent tool registry created when `mcpServers` triggers a force
   * rebuild and the MCP child processes / sockets it owns).
   *
   * Callers MUST invoke `dispose` in a `finally` block around the
   * `subagent.execute()` call. This is the only reliable way to clean up
   * across every execute() exit path: the inner try/finally inside
   * `AgentHeadless.execute()` does not fire `onStop` on the early-exit
   * paths (`createChat()` returning null, `prepareTools()` throwing), and a
   * leaked HookRegistry entry would fire globally for every matching event
   * for the rest of the session; a leaked ToolRegistry would leave stdio
   * child processes alive until process exit.
   *
   * `dispose` is idempotent — calling it twice is safe (the unregister
   * callback filters by `agentScope` and is a no-op the second time; the
   * registry's `stop()` is itself documented idempotent).
   *
   * @param config - Subagent configuration
   * @param runtimeContext - Runtime context
   * @returns the AgentHeadless and a `dispose` callback to run in the
   *          caller's `finally` block.
   */
  async createAgentHeadless(
    config: SubagentConfig,
    runtimeContext: Config,
    options?: {
      eventEmitter?: AgentEventEmitter;
      hooks?: AgentHooks;
      promptConfigOverrides?: Partial<PromptConfig>;
      modelConfigOverrides?: Partial<ModelConfig>;
      runtimeAuthOverrides?: AuthOverrides;
      runConfigOverrides?: Partial<RunConfig>;
      toolConfigOverride?: ToolConfig;
      /** Business/task name used for local per-invocation usage labels. */
      taskName?: string;
      /** Stable id used to keep one invocation grouped across resume. */
      subagentId?: string;
    },
  ): Promise<{ subagent: SubagentExecutor; dispose: () => Promise<void> }> {
    // Track per-spawn cleanup callbacks declared outside the inner
    // `try/catch` so the catch can fire them on a constructor failure
    // before the caller ever receives the return value. The successful
    // path puts the same callbacks behind `dispose`. Both inner callbacks
    // are idempotent at the source (`HookRegistry.addAgentHooks` filters
    // by `agentScope`; `ToolRegistry.stop` is documented idempotent), so
    // `runCleanup` doesn't need its own null-out guards — a duplicate
    // invocation is at worst wasted work, never a re-fire of side effects.
    let unregisterAgentHooks: (() => void) | undefined;
    let disposeSubagentRegistry: (() => Promise<void>) | undefined;
    const runCleanup = async (): Promise<void> => {
      if (unregisterAgentHooks) {
        try {
          unregisterAgentHooks();
        } catch (error) {
          debugLogger.warn(
            `Subagent "${config.name}": failed to unregister per-agent hooks: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (disposeSubagentRegistry) {
        try {
          await disposeSubagentRegistry();
        } catch (error) {
          debugLogger.warn(
            `Subagent "${config.name}": failed to stop per-agent ToolRegistry: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };

    try {
      if (config.executor !== undefined) {
        // Safe mode promises that only built-in subagents are available and
        // that no repo-supplied execution surface runs. Discovery filtering is
        // not enough: `loadSubagent` resolves a `subagent_type` from disk
        // (project/user/extension) regardless of safe mode, and a cloned repo
        // can ship `.qwen/agents/<builtin-name>.md` carrying an `executor` that
        // resolves before the built-in of the same name. Refuse at the dispatch
        // gate so safe mode never spawns a definition-supplied binary.
        if (runtimeContext.isSafeMode()) {
          throw new SubagentError(
            `Subagent "${config.name}" declares an external executor, which safe mode forbids: safe mode restricts subagents to the built-in set and never spawns a definition-supplied binary.`,
            SubagentErrorCode.INVALID_CONFIG,
            config.name,
          );
        }
        const spec = parseAgentExecutor(config.executor);
        if (!spec) {
          throw new SubagentError(
            `Subagent "${config.name}" executor block failed validation. Refusing to run it in-process.`,
            SubagentErrorCode.INVALID_CONFIG,
            config.name,
          );
        }
        if (
          (config.level === 'project' || config.level === 'builtin') &&
          !runtimeContext.isTrustedFolder()
        ) {
          throw new SubagentError(
            `Cannot start external agent "${config.name}" from an untrusted project.`,
            SubagentErrorCode.INVALID_CONFIG,
            config.name,
          );
        }
        const unsupported = [
          ['tools', config.tools],
          ['disallowedTools', config.disallowedTools],
          ['mcpServers', config.mcpServers],
          ['hooks', config.hooks],
          ['maxTurns', config.maxTurns],
          ['runConfig.max_turns', config.runConfig?.max_turns],
          [
            'runConfigOverrides.max_turns',
            options?.runConfigOverrides?.max_turns,
          ],
          [
            'model',
            config.model && config.model !== 'inherit'
              ? config.model
              : undefined,
          ],
          [
            'modelConfigOverrides',
            Object.keys(options?.modelConfigOverrides ?? {}).length > 0
              ? options?.modelConfigOverrides
              : undefined,
          ],
          ['runtimeAuthOverrides', options?.runtimeAuthOverrides],
          ['toolConfigOverride', options?.toolConfigOverride],
          [
            'promptConfigOverrides.renderedSystemPrompt',
            options?.promptConfigOverrides?.renderedSystemPrompt,
          ],
          [
            'promptConfigOverrides.initialMessages',
            options?.promptConfigOverrides?.initialMessages,
          ],
          ['hooks callbacks', options?.hooks],
        ].filter(([, value]) => value !== undefined);
        if (unsupported.length > 0) {
          throw new SubagentError(
            `External agent "${config.name}" does not support ${unsupported.map(([key]) => key).join(', ')}.`,
            SubagentErrorCode.INVALID_CONFIG,
            config.name,
          );
        }
        const externalExecutor = runtimeContext.getExternalAgentExecutor();
        if (!externalExecutor) {
          throw new SubagentError(
            `Subagent "${config.name}" declares an executor but this host registered no external agent executor. Refusing to run it in-process.`,
            SubagentErrorCode.INVALID_CONFIG,
            config.name,
          );
        }
        const subagent = await externalExecutor.create({
          spec,
          name: config.name,
          // The peer permission mode must be the host's effective, already
          // clamped approval policy — not the definition's raw request. The
          // Agent tool resolves the definition's approvalMode against the
          // parent session's mode and folder trust (resolveSubagentApprovalMode)
          // and stamps the result onto this runtimeContext, so reading it back
          // here is what stops a definition from escalating the external agent
          // past the parent session's limit. config.permissionMode is already
          // bridged into that resolved value at parse time.
          approvalMode: runtimeContext.getApprovalMode(),
          permissionMode: config.permissionMode,
          promptConfig: {
            systemPrompt: config.systemPrompt,
            ...options?.promptConfigOverrides,
          },
          modelConfig: {},
          runConfig: {
            ...config.runConfig,
            ...options?.runConfigOverrides,
          },
          toolConfig: {
            tools: ['*'],
            disallowedTools: [ToolNames.ASK_USER_QUESTION],
          },
          eventEmitter: options?.eventEmitter,
          taskName: options?.taskName,
          subagentId: options?.subagentId,
          runtimeContext: deriveConfig(runtimeContext),
        });
        return {
          subagent,
          dispose: async () => {
            await subagent.dispose?.();
          },
        };
      }
      const runtimeConfig = await this.convertToRuntimeConfig(
        config,
        runtimeContext,
      );
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
      const configuredToolConfig =
        options?.toolConfigOverride ?? runtimeConfig.toolConfig;
      const toolConfig: ToolConfig = {
        tools: configuredToolConfig?.tools ?? ['*'],
        ...(configuredToolConfig?.executionAllowedTools !== undefined
          ? {
              executionAllowedTools: [
                ...configuredToolConfig.executionAllowedTools,
              ],
            }
          : {}),
        disallowedTools: Array.from(
          new Set([
            ...(configuredToolConfig?.disallowedTools ?? []),
            ToolNames.ASK_USER_QUESTION,
          ]),
        ),
      };

      // When the model selector specifies a different provider, or the
      // caller asked for a per-agent reasoning effort, build a dedicated
      // ContentGenerator + view so the subagent talks to the right API with
      // its own settings without affecting the parent process. The view is
      // applied via AsyncLocalStorage when the agent runs.
      const runtimeView = await this.buildRuntimeContentGeneratorView(
        config,
        runtimeContext,
        modelConfig.model,
        options?.runtimeAuthOverrides,
        modelConfig.reasoningEffort,
      );

      const { context: subagentContext, cleanup } =
        await this.buildSubagentContextOverride(runtimeContext, config);
      disposeSubagentRegistry = cleanup;

      // Register per-agent frontmatter hooks. The returned unregister callback
      // is invoked from `dispose` (and from the catch block below on a
      // constructor failure). v1 limitation: while the entries live in the
      // registry they fire for every event of their declared type, regardless
      // of which agent is currently active — proper per-agent scope filtering
      // is deferred.
      const hookSystem = runtimeContext.getHookSystem();
      const hookRegistry = hookSystem?.getRegistry();
      if (config.hooks && Object.keys(config.hooks).length > 0) {
        if (config.level === 'project' && !runtimeContext.isTrustedFolder()) {
          // Project agents load from <repo>/.qwen/agents/ regardless of
          // trust (read-only use is fine), but their hooks are repo-supplied
          // code execution — the same gate Config.getProjectHooks() applies
          // to settings-file hooks.
          debugLogger.warn(
            `Subagent "${config.name}" is a project agent in an untrusted folder; ignoring its hooks.`,
          );
        } else if (hookRegistry) {
          const agentScope = `agent:${config.name}:${randomUUID()}`;
          unregisterAgentHooks = hookRegistry.addAgentHooks(
            config.hooks as { [K in HookEventName]?: HookDefinition[] },
            agentScope,
          );
        } else {
          // Single outer guard; nested branch on hookRegistry. The pre-fix
          // structure repeated the `config.hooks && Object.keys(...).length`
          // predicate across two `if`/`else if` arms, which made it easy to
          // drift one side during future edits.
          debugLogger.warn(
            `Subagent "${config.name}" declares hooks but the host has no HookSystem; ignoring per-agent hooks.`,
          );
        }
      }

      try {
        const subagent = await AgentHeadless.create(
          config.name,
          subagentContext,
          promptConfig,
          modelConfig,
          runConfig,
          toolConfig,
          options?.eventEmitter,
          options?.hooks,
          runtimeView,
          options?.taskName,
          options?.subagentId,
        );
        return { subagent, dispose: runCleanup };
      } catch (innerError) {
        // The caller never received the return value — `dispose` cannot
        // possibly fire. Run the cleanup ourselves so the registered hook
        // entries and the rebuilt ToolRegistry don't leak past this
        // constructor failure.
        await runCleanup();
        throw innerError;
      }
    } catch (error) {
      // Already-classified errors carry an accurate message; re-wrapping them
      // under "Failed to create AgentHeadless" would misreport the executor
      // path, which never constructs an AgentHeadless at all.
      if (error instanceof SubagentError || config.executor !== undefined) {
        throw error;
      }
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
   * Build the per-subagent Config override used as the AgentHeadless
   * runtime context. The override is a thin factory-derived wrapper: no
   * method changes, but a distinct
   * instance triggers the lazy own-property init in
   * `Config.getFileReadCache()` so the subagent gets its own cache
   * rather than inheriting the parent's recorded reads — which would
   * silently weaken prior-read enforcement on its mutation paths.
   *
   * The tool registry is also rebuilt on the override so `EditTool` /
   * `WriteFileTool` / `ReadFileTool` resolve `this.config` to the
   * subagent — without that step, the parent's cached tool instances
   * still reach the parent's FileReadCache. The rebuild is skipped when
   * a wrapper above `runtimeContext` already rebuilt one (typically
   * `agent.ts:createApprovalModeOverride`, which marks itself via a
   * Symbol-keyed flag — Symbol lookup walks the prototype chain, so
   * this also catches wrapper-on-wrapper layering like the background
   * launch passing its stamped `createApprovalModeOverride` override directly
   * as `runtimeContext`). Rebuilding twice would waste work,
   * leak listeners on shared managers, and split caches across registry
   * layers.
   */
  private async buildSubagentContextOverride(
    runtimeContext: Config,
    config: SubagentConfig,
  ): Promise<{
    context: Config;
    /**
     * Set only when this call force-rebuilt the registry to land per-agent
     * MCP server connections. The freshly built registry owns stdio child
     * processes / sockets that the parent's `Config.shutdown` cannot reach,
     * so the caller (`createAgentHeadless`) carries this callback through
     * to its `dispose` closure and runs it when the subagent terminates.
     *
     * Field name matches the `cleanup` field on
     * `ApprovalModeOverrideHandle` (the sibling override-builder return
     * shape) for cross-API consistency.
     */
    cleanup?: () => Promise<void>;
  }> {
    const subagentContext = deriveConfig(runtimeContext);

    // Session Workflow plan-revision state is session-global on the base
    // Config. The prototype set/clear assign
    // `this.sessionWorkflowPlanRevision`, which would land as an OWN property
    // on this wrapper and shadow the base value — a subagent's divergent
    // todo_write would clear the approved revision only for itself while the
    // parent keeps rejecting Agent launches against a plan that no longer
    // exists. Forward mutations through to the wrapped Config
    // (runtimeContext may itself be a write-through wrapper — the forwarding
    // chain bottoms out at the base Config); keep in sync with
    // `createApprovalModeOverride` in tools/agent/agent.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (subagentContext as any).setSessionWorkflowPlanRevision = (
      revision: Parameters<Config['setSessionWorkflowPlanRevision']>[0],
    ): void => {
      runtimeContext.setSessionWorkflowPlanRevision(revision);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (subagentContext as any).clearSessionWorkflowPlanRevision = (): void => {
      runtimeContext.clearSessionWorkflowPlanRevision();
    };

    // Per-agent MCP server overrides. Frontmatter `mcpServers` entries shadow
    // session-level servers on key collision (more-specific-wins, matching
    // CC's `scope: 'agent'` semantics). The runtime MCP loader still owns
    // the per-spec discriminated union validation; this only widens the set
    // of servers visible to the subagent's tool registry.
    const hasAgentMcpServers =
      config.mcpServers && Object.keys(config.mcpServers).length > 0;
    if (hasAgentMcpServers) {
      const sessionServers = runtimeContext.getMcpServers() ?? {};
      // Cast: per-frontmatter specs share the same record-of-records shape as
      // MCPServerConfig but the type assertion at this boundary is intentional
      // — the discovery layer downstream will refuse malformed specs at
      // connect time, surfacing a precise error instead of a typecheck noise.
      const merged: Record<string, MCPServerConfig> = {
        ...sessionServers,
        ...(config.mcpServers as Record<string, MCPServerConfig>),
      };
      subagentContext.getMcpServers = () => merged;
    }

    // The skip-rebuild optimization (`hasRebuiltToolRegistry`) is bypassed
    // when per-agent `mcpServers` are present: without a fresh rebuild
    // anchored on `subagentContext`, the existing wrapper-owned registry's
    // McpClientManager would resolve `cliConfig.getMcpServers()` to the
    // parent's session list and never see our merged override, so the
    // discovery loop below would silently no-op. Forcing a rebuild here
    // ties the manager to `subagentContext`, which is the only config in
    // the chain that knows about the per-agent servers.
    if (hasAgentMcpServers || !hasRebuiltToolRegistry(runtimeContext)) {
      await rebuildToolRegistryOnOverride(subagentContext, runtimeContext);
    }

    // The freshly rebuilt subagent ToolRegistry is constructed with
    // `skipDiscovery: true` and then back-fills tools by copying from the
    // parent's registry — which only knows about the session-level MCP
    // servers. Per-agent servers (or per-agent overrides of an existing
    // server) therefore need explicit discovery here so their tools land in
    // the subagent's registry before AgentHeadless runs. The discovery
    // method is idempotent and de-dupes in-flight calls, so a key shared
    // with the session set is safe to discover again — it picks up the
    // override spec rather than the session one.
    if (hasAgentMcpServers && config.mcpServers) {
      const subagentRegistry = subagentContext.getToolRegistry();
      const serverNames = Object.keys(config.mcpServers);
      // Parallel discovery: one misbehaving server (e.g. a stdio command
      // that hangs at startup) shouldn't serialise behind the others and
      // delay the subagent spawn by the sum of every per-server timeout.
      // Each call still carries the MCP layer's own per-server connect
      // timeout (stdio default 30s, remote default 5s, per-spec override
      // via `discoveryTimeoutMs`); `allSettled` only removes the
      // serialisation between siblings. Rejections are logged-and-dropped
      // so a single bad server doesn't block the others' tools from
      // landing in the subagent's registry.
      const results = await Promise.allSettled(
        serverNames.map((name) =>
          subagentRegistry.discoverToolsForServer(name),
        ),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          debugLogger.warn(
            `Failed to discover per-agent MCP server "${serverNames[i]}" for subagent "${config.name}": ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
          );
        }
      }
      return {
        context: subagentContext,
        cleanup: () => subagentRegistry.stop(),
      };
    }
    return { context: subagentContext };
  }

  /**
   * When a subagent's model selector resolves to a concrete model, build a
   * dedicated ContentGenerator and the view the agent runtime should publish
   * via AsyncLocalStorage during the run. Returns `undefined` when no
   * override is needed — including `inherit`, an unset `fast` selector, or
   * any selector that fails to resolve to a configured model.
   *
   * A `reasoningEffort` always needs its own view, even on the parent's model:
   * the tier is written onto the agent's copy of the config, and the session
   * config the agent would otherwise share must never receive it.
   *
   * FileReadCache isolation and tool-registry rebuilding are handled
   * separately in {@link buildSubagentContextOverride} — every subagent
   * (inherit or explicit) gets that, regardless of whether a runtime
   * view is built here.
   */
  private async buildRuntimeContentGeneratorView(
    config: SubagentConfig,
    base: Config,
    fallbackModelId?: string,
    runtimeAuthOverrides?: AuthOverrides,
    reasoningEffort?: ReasoningEffort,
  ): Promise<RuntimeContentGeneratorView | undefined> {
    const route = this.resolveModelRoute(
      config,
      base,
      runtimeAuthOverrides?.authType,
    );
    const modelId = route?.modelId ?? fallbackModelId;
    if (!modelId && reasoningEffort === undefined) {
      return undefined;
    }
    // An effort-only request would otherwise share the session's generator.
    // Give the agent its own only when the tier can land on the session's
    // model: a tier it cannot take (toggle-only, thinking off) changes nothing,
    // and a generator per dispatch would be pure cost.
    if (
      !modelId &&
      reasoningEffort !== undefined &&
      resolveAgentReasoningTier(
        base,
        base.getContentGeneratorConfig(),
        reasoningEffort,
      ) === undefined
    ) {
      return undefined;
    }

    const authType =
      route?.authType ??
      runtimeAuthOverrides?.authType ??
      base.getContentGeneratorConfig().authType;
    const authOverrides: AuthOverrides = route
      ? { authType: authType as string }
      : {
          ...runtimeAuthOverrides,
          authType: authType as string,
        };

    let view: RuntimeContentGeneratorView;
    try {
      view = await createRuntimeContentGeneratorView(
        base,
        base,
        modelId,
        authOverrides,
        {
          reasoningEffort,
          // A tier alone is no reason to log in: a headless dispatch must
          // never open an interactive device flow for it.
          ...(modelId ? {} : { requireCachedCredentials: true }),
        },
      );
    } catch (error) {
      if (modelId) throw error;
      // Effort-only: the agent still runs, on the session's generator and
      // effort, rather than failing the dispatch over a cosmetic option.
      debugLogger.warn(
        `Subagent "${config.name}" could not get its own ContentGenerator for reasoningEffort=${reasoningEffort} (${error instanceof Error ? error.message : String(error)}); it runs on the session's generator and effort.`,
      );
      return undefined;
    }

    const landed = view.contentGeneratorConfig.reasoning;
    debugLogger.info(
      `Created per-agent ContentGenerator for subagent "${config.name}": authType=${authType}, model=${view.contentGeneratorConfig.model}` +
        (reasoningEffort !== undefined
          ? `, reasoningEffort=${landed ? (landed.effort ?? 'none') : 'none'} (requested ${reasoningEffort})`
          : ''),
    );

    return view;
  }

  private resolveModelOverride(
    model: string | undefined,
    runtimeContext?: Config,
  ): ResolvedModelId | undefined {
    // Omit currentModel so `inherit` resolves to undefined; subagents treat
    // "inherit / no override" as a signal to skip building a dedicated
    // ContentGenerator entirely.
    const context = runtimeContext ? buildModelIdContext(runtimeContext) : {};
    return resolveModelId(model, { ...context, currentModel: undefined });
  }

  /**
   * Shared route-resolution core for a subagent definition's `model:`
   * selector: resolve it against `runtimeContext` (with `currentModel`
   * stripped, so `inherit` yields nothing) and return the concrete model
   * ID plus the auth type a dedicated ContentGenerator must be created
   * with. Returns `undefined` when the selector does not resolve to a
   * concrete model — `inherit`, an unset `fast` selector, or no selector.
   *
   * Every spawn path must resolve routes through this single helper so the
   * same `.qwen/agents/<name>.md` definition always maps to the same
   * provider route, whether it runs as an ordinary subagent
   * ({@link buildRuntimeContentGeneratorView}) or as a named teammate
   * ({@link resolveSubagentModelRoute}).
   *
   * @param fallbackAuthType - Middle step of the ordinary-spawn auth
   * fallback chain: runtime auth overrides carried by the caller. Spawn
   * paths without such overrides (teammates) pass nothing.
   */
  private resolveModelRoute(
    config: SubagentConfig,
    runtimeContext: Config,
    fallbackAuthType?: string,
  ): SubagentModelRoute | undefined {
    const resolvedModel = this.resolveModelOverride(
      config.model,
      runtimeContext,
    );
    if (!resolvedModel?.modelId) {
      return undefined;
    }
    const authType =
      resolvedModel.authType ??
      fallbackAuthType ??
      runtimeContext.getContentGeneratorConfig().authType;
    return {
      modelId: resolvedModel.modelId,
      authType: authType as string,
    };
  }

  /**
   * Resolve a subagent definition's model selector the way the ordinary
   * subagent spawn path does ({@link buildRuntimeContentGeneratorView}),
   * returning the concrete model ID plus the auth type a dedicated
   * ContentGenerator must be created with. Returns `undefined` when the
   * selector does not resolve to a concrete model — `inherit`, an unset
   * `fast` selector, or no selector — in which case the caller should
   * inherit the parent's ContentGenerator unchanged.
   *
   * Used by spawn paths outside `createAgentHeadless` that still need the
   * definition's provider route — the Agent Team teammate path (#10071)
   * passes it as `inProcess.authOverrides` so InProcessBackend builds the
   * same per-agent ContentGenerator an ordinary subagent would get.
   */
  resolveSubagentModelRoute(
    config: SubagentConfig,
  ): SubagentModelRoute | undefined {
    return this.resolveModelRoute(config, this.config);
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
    runtimeContext?: Config,
  ): Promise<SubagentRuntimeConfig> {
    if (config.executor !== undefined) {
      throw new SubagentError(
        `Subagent "${config.name}" declares an external executor and cannot be converted to an in-process agent.`,
        SubagentErrorCode.INVALID_CONFIG,
        config.name,
      );
    }
    const promptConfig: PromptConfig = {
      systemPrompt: config.systemPrompt,
    };

    const resolvedModel = this.resolveModelOverride(
      config.model,
      runtimeContext,
    );
    const modelConfig: ModelConfig = {
      ...(resolvedModel ? { model: resolvedModel.modelId } : {}),
    };

    const runConfig: RunConfig = {
      ...config.runConfig,
      // Top-level CC-style `maxTurns` wins over legacy nested
      // `runConfig.max_turns`. Both are kept for backward compatibility, but
      // when both are set, the top-level field is the authoritative source.
      ...(config.maxTurns !== undefined ? { max_turns: config.maxTurns } : {}),
    };

    let toolConfig: ToolConfig | undefined;
    if (
      (config.tools && config.tools.length > 0) ||
      (config.disallowedTools && config.disallowedTools.length > 0)
    ) {
      // Unresolved names (e.g. `WebSearch` while the opt-in web_search tool
      // is unregistered) stay in the list as dead, restrictive entries: an
      // explicit allow-list must never be widened on resolution failure, so
      // an agent whose every tool is unavailable runs tool-less (fail
      // closed) rather than inheriting shell/write it was not configured
      // for. Deliberate: this supersedes the earlier compatibility fallback
      // for converted Claude agents.
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
   * The entries of a deny list that can deny nothing: not an `mcp__` pattern
   * (those match by pattern at run time), not a built-in tool by tool name,
   * display name or legacy alias (registered in this session or not), and not
   * the name or display name of any registered tool. A deny that matches
   * nothing silently leaves the agent the tool the caller meant to take away,
   * so callers refuse these instead of forwarding them.
   */
  async findUnmatchedToolNames(tools: string[]): Promise<string[]> {
    const candidates = tools.filter(
      (name) =>
        !name.startsWith('mcp__') && resolveBuiltinToolName(name) === undefined,
    );
    if (candidates.length === 0) return [];
    const toolRegistry = this.config.getToolRegistry();
    if (!toolRegistry) return candidates;
    await toolRegistry.warmAll();
    const registered = new Set<string>();
    for (const tool of toolRegistry.getAllTools()) {
      registered.add(tool.name);
      if (tool.displayName) registered.add(tool.displayName);
    }
    return candidates.filter((name) => !registered.has(name));
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
        ? path.join(this.config.getProjectRoot(), QWEN_DIR, AGENT_CONFIG_DIR)
        : path.join(Storage.getGlobalQwenDir(), AGENT_CONFIG_DIR);

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
      return this.getBuiltinAgents();
    }

    if (level === 'extension') {
      const extensions = this.config.getActiveExtensions();
      // R10-2: extension agents load via loadSubagentFromDir, which skips and
      // warns on a refusal — so the directory-scan branch below never runs for
      // them and nothing would be recorded. Merge each active extension's
      // recorded executor-block refusals so the by-name fall-through refuses
      // them too instead of resolving a builtin of the same name.
      const merged = new Map<string, SubagentError>();
      for (const extension of extensions) {
        for (const [name, error] of extension.agentExecutorRefusals ?? []) {
          merged.set(name, error);
        }
      }
      this.executorRefusals.set('extension', merged);
      return extensions.flatMap((extension) => extension.agents || []);
    }

    const projectRoot = this.config.getProjectRoot();
    const homeDir = os.homedir();
    const isHomeDirectory = path.resolve(projectRoot) === path.resolve(homeDir);

    // If project level is requested but project root is same as home directory,
    // return empty array to avoid conflicts between project and global agents
    if (level === 'project' && isHomeDirectory) {
      // No fresh scan happens on this path, so clear any refusal a prior scan
      // recorded for the level — otherwise loadSubagent keeps throwing a stale
      // refusal for a file this path no longer reads. (R12-4)
      this.executorRefusals.set(level, new Map());
      return [];
    }

    const baseDir =
      level === 'project'
        ? path.join(projectRoot, QWEN_DIR, AGENT_CONFIG_DIR)
        : path.join(Storage.getGlobalQwenDir(), AGENT_CONFIG_DIR);

    try {
      const files = await fs.readdir(baseDir);
      const subagents: SubagentConfig[] = [];

      const refusals = new Map<string, SubagentError>();
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
          // R10-2: record an executor-block refusal by declared name so a
          // by-name dispatch can REFUSE instead of falling through to a
          // lower-precedence in-process definition of the same name. Scoped to
          // executor refusals (not parse failures generally) so an arbitrary
          // malformed repo file cannot disable an unrelated builtin at dispatch.
          if (
            error instanceof SubagentError &&
            error.subagentName !== undefined &&
            error.message.includes('invalid executor block')
          ) {
            refusals.set(error.subagentName.toLowerCase(), error);
          }
          continue;
        }
      }

      this.executorRefusals.set(level, refusals);
      return subagents;
    } catch (_error) {
      // Directory doesn't exist or can't be read. Clear any refusal a prior
      // scan recorded for this level so a stale entry cannot keep refusing a
      // by-name dispatch for a file that no longer exists or is unreadable. (R12-4)
      this.executorRefusals.set(level, new Map());
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
    let existing: SubagentConfig | null;
    try {
      existing = await this.loadSubagent(name, level);
    } catch (error) {
      // R10-2: loadSubagent now refuses a name claimed by an invalid-executor
      // file. For availability that name IS taken (the file exists), so report
      // it unavailable rather than propagating the dispatch-time refusal.
      if (
        error instanceof SubagentError &&
        error.message.includes('invalid executor block')
      ) {
        return false;
      }
      throw error;
    }

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
  // R10-2: when provided, executor-block refusals (an agent file that declares
  // an executor but failed to load) are recorded keyed by lowercased declared
  // name, so a by-name dispatch can refuse instead of falling through to a
  // builtin of the same name.
  refusals?: Map<string, SubagentError>,
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
        if (
          refusals &&
          error instanceof SubagentError &&
          error.subagentName !== undefined &&
          error.message.includes('invalid executor block')
        ) {
          refusals.set(error.subagentName.toLowerCase(), error);
        }
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
 * R12-5: returns true when a raw-text `executor:` probe match at `matchIndex`
 * lies inside a block scalar (`description: |` or `>`), i.e. the match is prose
 * documenting the executor syntax, not a real claim. The R10-1 probe is
 * indentation-tolerant, so without this a `description: |` line reading
 * `executor: acp` would hoist into a claim and hard-refuse an in-process
 * definition that merely carries an unrelated tolerated YAML quirk. Fail-closed:
 * if the AST walk itself throws, return false so the match stays a claim.
 */
function probeMatchInsideBlockScalar(
  document: ReturnType<typeof parseDocument>,
  matchIndex: number,
): boolean {
  try {
    let inside = false;
    visit(document, (_key, node) => {
      if (
        isScalar(node) &&
        (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') &&
        node.range &&
        node.range[0] <= matchIndex &&
        matchIndex < node.range[1]
      ) {
        inside = true;
      }
    });
    return inside;
  } catch {
    // A failed walk must not drop a real claim; leave the match as a claim.
    return false;
  }
}

function parseSubagentContent(
  content: string,
  filePath: string,
  level: SubagentLevel,
  validator: SubagentValidator,
): SubagentConfig {
  // R11-1/R11-4: the executor claim and the trusted declared name are computed
  // at FUNCTION scope so the catch can convert ANY load failure of an
  // executor-claiming file into a named executor refusal (recorded by
  // listSubagentsAtLevel, refused by loadSubagent's fall-through) — otherwise a
  // file that fails an EARLIER validation (missing description, bad approvalMode)
  // is skipped with nothing recorded, and a by-name dispatch silently falls
  // through to a lower-precedence in-process definition or the builtin. The name
  // comes from the real AST (parseDocument strips quotes), NOT the lenient value
  // — the lenient parser strips only double quotes, so a single-quoted
  // `name: 'Explore'` would otherwise be keyed "'explore'" and miss the
  // 'explore' dispatch lookup.
  let claimsExecutor = false;
  let declaredName: string | undefined;
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

    // Real-AST executor claim + trusted declared name, computed BEFORE any
    // validation can throw so the catch can route an executor-claiming file's
    // failure to a named refusal. The executor block below reuses `document`,
    // `hasExecutor` and `executorClaimMatch`.
    const document = parseDocument(frontmatterYaml);
    const hasExecutor = document.has('executor');
    const executorClaimMatch = /^[ \t]*["']?executor["']?[ \t]*:/m.exec(
      frontmatterYaml,
    );
    // R12-5: a probe match lying inside a block scalar is prose (a
    // `description: |`/`>` documenting the executor syntax), not a claim —
    // exclude it so the refusal guards below do not fire on an in-process
    // definition that only mentions `executor:` in prose. A genuine top-level
    // (even TAB-misindented) executor key is not inside a block scalar, so it
    // stays a claim and the R10-1/R9-2 refusals still hold.
    const probeIsClaim =
      executorClaimMatch !== null &&
      !probeMatchInsideBlockScalar(document, executorClaimMatch.index);
    claimsExecutor = hasExecutor || probeIsClaim;
    try {
      const nodeName = document.has('name') ? document.get('name') : undefined;
      if (typeof nodeName === 'string' && nodeName !== '')
        declaredName = nodeName;
    } catch {
      // toJS/node reads can throw on an unresolved alias; keep the lenient name.
    }
    if (declaredName === undefined) {
      const lenientName = frontmatter['name'];
      if (typeof lenientName === 'string' && lenientName !== '')
        declaredName = lenientName;
    }

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
    const toolsRaw = frontmatter['tools'];
    const tools: string[] | undefined = Array.isArray(toolsRaw)
      ? toolsRaw.filter((item): item is string => typeof item === 'string')
      : typeof toolsRaw === 'string'
        ? toolsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const disallowedToolsRaw = frontmatter['disallowedTools'];
    const disallowedTools: string[] | undefined = Array.isArray(
      disallowedToolsRaw,
    )
      ? disallowedToolsRaw.filter(
          (item): item is string => typeof item === 'string',
        )
      : typeof disallowedToolsRaw === 'string'
        ? disallowedToolsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const modelRaw = frontmatter['model'];
    const legacyModelConfig = frontmatter['modelConfig'] as
      | Record<string, unknown>
      | undefined;
    const runConfig = frontmatter['runConfig'] as
      | Record<string, unknown>
      | undefined;
    const colorRaw = frontmatter['color'];
    // CC silently drops colors outside the allowlist (_Y). Preserve the
    // legacy qwen `auto` sentinel for backward compat with existing files.
    const color =
      typeof colorRaw === 'string' && (isColor(colorRaw) || colorRaw === 'auto')
        ? colorRaw
        : undefined;
    if (
      colorRaw !== undefined &&
      color === undefined &&
      typeof colorRaw === 'string'
    ) {
      debugLogger.warn(
        `Agent file ${filePath} has invalid color '${colorRaw}'. Valid options: ${COLOR_VALUES.join(', ')}, auto. Dropping field.`,
      );
    }
    const approvalModeRaw = frontmatter['approvalMode'];
    if (
      approvalModeRaw !== undefined &&
      approvalModeRaw !== null &&
      typeof approvalModeRaw !== 'string'
    ) {
      throw new Error(
        `Invalid "approvalMode" value: expected a string, got ${typeof approvalModeRaw}. Valid values: ${subagentApprovalModesLabel()}`,
      );
    }
    const approvalMode =
      typeof approvalModeRaw === 'string' && approvalModeRaw !== ''
        ? approvalModeRaw
        : undefined;
    if (approvalMode !== undefined && !isSubagentApprovalMode(approvalMode)) {
      throw new Error(
        `Invalid "approvalMode" value "${approvalMode}". Valid values: ${subagentApprovalModesLabel()}`,
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
      backgroundRaw === 'true' || backgroundRaw === true
        ? true
        : backgroundRaw === 'false' || backgroundRaw === false
          ? false
          : undefined;

    // --- CC 2.1.168 declarative-agent fields (DL7-parity lenient parse) ---

    // permissionMode: CC enum carried verbatim. Bridges to approvalMode only
    // when approvalMode is unset.
    const permissionModeRaw = frontmatter['permissionMode'];
    const permissionMode = isPermissionMode(permissionModeRaw)
      ? permissionModeRaw
      : undefined;
    if (
      permissionModeRaw !== undefined &&
      permissionModeRaw !== null &&
      permissionMode === undefined
    ) {
      debugLogger.warn(
        `Agent file ${filePath} has invalid permissionMode '${permissionModeRaw}'. Dropping field.`,
      );
    }
    const bridgedApprovalMode =
      approvalMode === undefined && permissionMode !== undefined
        ? claudePermissionModeToApprovalMode(permissionMode)
        : undefined;
    const effectiveApprovalMode = approvalMode ?? bridgedApprovalMode;

    // maxTurns: positive integer (or numeric string).
    const maxTurns = parseMaxTurns(frontmatter['maxTurns']);
    if (frontmatter['maxTurns'] !== undefined && maxTurns === undefined) {
      debugLogger.warn(
        `Agent file ${filePath} has invalid maxTurns '${frontmatter['maxTurns']}'. Dropping field.`,
      );
    }

    // mcpServers: record-of-records shape (CC `gS8` shallow validation).
    // Strict per-spec union is deferred to the runtime MCP loader.
    const mcpServersRaw = frontmatter['mcpServers'];
    const mcpServers = parseAgentMcpServers(mcpServersRaw);
    if (mcpServersRaw !== undefined && mcpServers === undefined) {
      debugLogger.warn(
        `Agent file ${filePath} has invalid mcpServers (expected an object of server-name → spec). Dropping field.`,
      );
    }

    // hooks: record-of-arrays shape (CC `TKO` shallow validation).
    // Strict per-matcher union is deferred to the runtime hook subsystem.
    const hooksRaw = frontmatter['hooks'];
    const hooks = parseAgentHooks(hooksRaw);
    if (hooksRaw !== undefined && hooks === undefined) {
      debugLogger.warn(
        `Agent file ${filePath} has invalid hooks (expected an object of HookEventName → matcher array). Dropping field.`,
      );
    }

    // executor: qwen-code extension (not part of the mirrored CC schema).
    // Strictly validated because it names an external process to run; see
    // `parseAgentExecutor`. Availability of the named command is NOT checked
    // here — that is the injected executor's job at spawn time.
    //
    // A malformed block is a hard error, NOT a lenient drop. Dropping it would
    // leave `config.executor` undefined, so the definition would run
    // in-process: the task completes under Qwen's model, billed to the Qwen
    // provider, with nothing on stdout or stderr — precisely the silent
    // substitution this feature exists to prevent, and the consumption-point
    // re-validation can never catch it because the field is already gone. The
    // warn-only path was invisible in practice too, since `debugLogger.warn`
    // is a no-op unless QWEN_DEBUG_LOG_FILE is set. This deliberately diverges
    // from the lenient posture used for `mcpServers` / `hooks`: losing those
    // degrades a capability, whereas losing this one substitutes a different
    // agent for the one the definition asked for.
    // The shared parser strips nulls, including null arguments. Validate the
    // original YAML node so sanitization cannot change the executable request.
    // (`document`, `hasExecutor`, `executorClaimMatch` and `claimsExecutor` are
    // computed earlier, right after the frontmatter is parsed, so the catch can
    // route an executor-claiming file's failure to a named refusal.)
    // parseDocument repairs a syntactically invalid document instead of
    // throwing, and `document.errors` is the only signal that it did so. For an
    // executor-bearing definition that is unsafe: the repaired node can dispatch
    // a different command/args than the file declares, or drop the key and run
    // in-process. Refuse it and surface the real YAML error (with line/column).
    //
    // Scope this to executor-bearing files only. Every OTHER definition must
    // keep loading through the shared parser's lenient `parseSimple` fallback —
    // a description containing a colon, a tab-indented field, or a key
    // duplicated by a bad merge loads at the merge base, and refusing it here
    // would silently delete an agent from `/agents` (and break
    // `subagent_type:`) with nothing on stdout or stderr. Detect the claim from
    // the raw text too, so a YAML error that corrupts the `executor` key out of
    // the AST still cannot slip through to a silent in-process run. The probe is
    // indentation-TOLERANT (`^[ \t]*`, optional quotes) on purpose: a TAB before
    // a top-level `executor:` is invalid YAML indentation, so parseDocument
    // errors and drops the key, and a column-0-anchored probe would miss it — the
    // definition would then load executor-less and run in-process under a Qwen
    // model with nothing on any channel, the exact silent substitution this
    // feature exists to prevent. The accepted cost is that an `executor:` token
    // nested under another key (e.g. `metadata:`) in an otherwise-malformed file
    // is also treated as a claim and refused; a visible, user-fixable
    // over-refusal beats an invisible substitution or an invented dispatch. The
    // claim is NOT read from the lenient `parseSimple` value: that line-based
    // heuristic hoists an `executor:` line inside a `description: |` block scalar
    // into a top-level key, which would dispatch a command existing only as prose.
    // Refuse only when an error can actually corrupt the executor node, not on
    // every tolerated YAML error in the file. Two distinct dangers: (1) the real
    // YAML parser (parseDocument) lost the executor node (!hasExecutor) although
    // the file claims one; do NOT fall back to the lenient parseSimple value, a
    // line-based heuristic that mangles block scalars and sequences (command: |
    // plus an indented npx becomes command '|', spawning an executable the file
    // never declared), and YAML errors are not line-local, so an earlier
    // compact-mapping error can drop the whole remainder including executor;
    // (2) the AST
    // has the executor but an error sits at or after its line, so parseDocument
    // may have repaired the node into a different command/args than the file
    // declares. An error strictly BEFORE the executor line — a duplicate `name:`
    // from a bad merge, say — cannot have reached the executor subtree that
    // parseDocument kept (hasExecutor still true), which stays byte-faithful, so
    // refusing there would delete a valid external-agent
    // definition over an unrelated quirk (it still loads at the merge base via
    // the lenient `parseSimple` fallback). When the claim cannot be localized to
    // a line, fail closed and treat every error as reaching it.
    const executorLine =
      executorClaimMatch === null
        ? undefined
        : frontmatterYaml.slice(0, executorClaimMatch.index).split('\n').length;
    if (claimsExecutor && document.errors.length > 0) {
      const astLostExecutor = !hasExecutor;
      const reachingError = document.errors.find(
        (error) =>
          executorLine === undefined ||
          error.linePos === undefined ||
          error.linePos[0].line >= executorLine,
      );
      if (astLostExecutor || reachingError !== undefined) {
        throw new SubagentError(
          `Agent file ${filePath} has an invalid executor block: its frontmatter ` +
            `YAML does not parse (${(reachingError ?? document.errors[0]).message}). ` +
            `Refusing to load the definition rather than dispatch a silently ` +
            `repaired executor.`,
          SubagentErrorCode.INVALID_CONFIG,
          declaredName ?? name,
        );
      }
    }
    // parseDocument tolerates an unresolved YAML alias (e.g. `command: *undef`)
    // without recording a `document.errors` entry, but `toJS()` throws when it
    // resolves the node — so the errors-based guard above cannot catch it. Refuse
    // gracefully rather than let a raw YAML error escape parseSubagentContent.
    let executorRaw: unknown;
    if (hasExecutor) {
      let documentJs: unknown;
      try {
        documentJs = document.toJS();
      } catch (error) {
        throw new SubagentError(
          `Agent file ${filePath} has an invalid executor block: its frontmatter ` +
            `YAML does not resolve (${error instanceof Error ? error.message : String(error)}). ` +
            `Refusing to load the definition rather than dispatch an executor ` +
            `parsed from YAML that will not resolve to a document.`,
          SubagentErrorCode.INVALID_CONFIG,
          declaredName ?? name,
        );
      }
      executorRaw = (documentJs as Record<string, unknown>)['executor'];
    } else {
      // Do NOT fall back to the lenient parseSimple value: when parseDocument
      // (the real YAML parser) has no top-level executor node, any `executor:`
      // token the text probe matched is nested or block-scalar prose, and
      // parseSimple's reconstruction is untrustworthy (it invents `command: '|'`,
      // hoists prose into a key). A claim the AST lost under a YAML error is
      // already refused above; with no error there is genuinely no top-level
      // executor, so load without one rather than dispatch an unconfirmed value.
      executorRaw = undefined;
    }
    const executor = parseAgentExecutor(executorRaw);
    if ((hasExecutor || executorRaw !== undefined) && executor === undefined) {
      throw new SubagentError(
        `Agent file ${filePath} has an invalid executor block (expected ` +
          `{ kind: 'acp' | 'codex', command: string, args?: string[] }). Refusing to load ` +
          `the definition: dropping the block would silently run it in-process ` +
          `instead of in the external agent it asked for.`,
        SubagentErrorCode.INVALID_CONFIG,
        declaredName ?? name,
      );
    }

    const config: SubagentConfig = {
      name,
      description,
      tools,
      disallowedTools,
      approvalMode: effectiveApprovalMode,
      systemPrompt: systemPrompt.trim(),
      filePath,
      model,
      runConfig: runConfig as Partial<RunConfig>,
      color,
      level,
      ...(background !== undefined ? { background } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      ...(executor !== undefined ? { executor } : {}),
    };

    // Validate the parsed configuration
    const validation = validator.validateConfig(config);
    if (!validation.isValid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }

    return config;
  } catch (error) {
    // Preserve a SubagentError as-is: an executor-block refusal already carries
    // the declared agent name (subagentName), which loadSubagent needs to refuse
    // a by-name dispatch instead of falling through (R10-2). Re-wrapping would
    // strip the name and code.
    if (error instanceof SubagentError) throw error;
    // R11-1: a file that CLAIMS an executor but failed to load for ANY reason —
    // a missing description, an invalid approvalMode, any validation before or
    // after the executor block — must surface as a named executor refusal, so the
    // dispatch refuses rather than falling through to an in-process substitute.
    // (A file whose own name is unparseable stays undefined-keyed and falls
    // through to the generic wrap; it cannot be matched by name anyway.)
    if (claimsExecutor && declaredName) {
      throw new SubagentError(
        `Agent file ${filePath} has an invalid executor block: it declares an ` +
          `executor but failed to load (${error instanceof Error ? error.message : 'Unknown error'}). ` +
          `Refusing to fall through to a lower-precedence in-process substitute.`,
        SubagentErrorCode.INVALID_CONFIG,
        declaredName,
      );
    }
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
  if (
    error instanceof SubagentError &&
    message.includes('invalid executor block')
  ) {
    // eslint-disable-next-line no-console -- executor rejection must be visible without debug logging
    console.warn(`Skipped invalid file ${filePath}: ${message}`);
    return;
  }
  debugLogger.debug(`Skipped invalid file ${filePath}: ${message}`);
}
