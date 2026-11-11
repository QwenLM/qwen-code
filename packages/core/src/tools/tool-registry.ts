/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ShellTool } from './shell.js';
import { PowerShellTool } from './powerShell.js';
import type { FunctionDeclaration } from '@google/genai';
import { type ScriptToolDescription } from '../codemode/types.js';
import {
  describeProgrammaticContract,
  describeProgrammaticResult,
  describeProgrammaticTool,
  renderToolCatalog,
} from '../codemode/tool-catalog.js';
import { buildCodeModeDescription } from '../codemode/description.js';
import { toolSearchText } from '../codemode/tool-search.js';
import { type CodeModeExposure } from '../codemode/settings.js';
import { type AnyDeclarativeTool } from './tools.js';
import type { Config } from '../config/config.js';
import { DiscoveredMCPTool } from '../mcp/tools/mcp-tool.js';
import { McpAuthTool } from './mcp-auth-tool.js';
import { runLogger } from '../utils/runLogger.js';
import { truncateString } from '../utils/textUtils.js';
import {
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  TOOL_LEGACY_ALIASES,
  getToolAliases,
  UPDATE_TOPIC_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from './tool-names.js';
import { MCP_CALL_TOOL_NAME } from './mcp-lazy/constants.js';
import {
  ineffectiveDeferredNames,
  isScriptCallable,
  patternsMayDeferMcp,
  readDeferredToolPatterns,
  resolveExposure,
  resolveMcpRegistration,
  type ExposureContext,
  type McpRegistration,
  type ToolExposure,
} from './tool-exposure.js';
import { isWorkflowAuthoringAvailable } from '../workflows/workflow-authoring.js';
import { getWorkflowToolDescription } from '../workflows/workflow-prompts.js';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import {
  applyFileReadRecoveryDescriptions,
  type FileReadRecoverySchemaContext,
} from './file-read-recovery-schemas.js';
import type { ModelStreamTool } from '../provider/modelStreamRequest.js';
import { buildModelStreamTools } from '../qoder/tools/function-declarations.js';

export interface ToolRegistrySchemaOptions {
  /** Fixed schema list for fork cache alignment; skips MCP injection. */
  schemaOverride?: readonly ModelStreamTool[];
  /** Host-side hide list applied after conversion (schema only). */
  schemaFilter?: (tool: ModelStreamTool) => boolean;
}

/**
 * Partition rank used to order the tool table: built-ins first, then MCP tools.
 */
function getToolPriority(tool: AnyDeclarativeTool): number {
  if (tool instanceof DiscoveredMCPTool) return 2;
  return 0;
}

/**
 * Canonical tool ordering: by partition, then by server name for MCP tools,
 * then by tool name. Kept at module scope so sorting allocates no closures.
 */
function compareTools(
  toolA: AnyDeclarativeTool,
  toolB: AnyDeclarativeTool,
): number {
  const priorityA = getToolPriority(toolA);
  const priorityB = getToolPriority(toolB);
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  if (priorityA === 2) {
    const serverCmp = (toolA as DiscoveredMCPTool).serverName.localeCompare(
      (toolB as DiscoveredMCPTool).serverName,
    );
    if (serverCmp !== 0) return serverCmp;
  }

  return toolA.name.localeCompare(toolB.name);
}

/** How one agent sees its tools, computed once per declaration set. */
export interface ToolView {
  /** Undefined when CodeMode is not declared to this agent. */
  codeMode?: CodeModeExposure;
  /** Declarations sent to the model. */
  declared: FunctionDeclaration[];
  /** Tools this agent's CodeMode scripts may call. */
  scriptTools: ReadonlyMap<string, AnyDeclarativeTool>;
  /** Filled only when the agent has CodeMode or mcp_call; otherwise every tool is declared. */
  exposure: ReadonlyMap<string, ToolExposure>;
}

/** The view's description-independent part, shared by declaration arrays that differ only in descriptions. */
interface ExposureResolution extends Omit<ToolView, 'declared'> {
  tools: ReadonlyMap<string, AnyDeclarativeTool>;
  /** Present when exposure may hide declarations; false hides the meta tools too. */
  metaNeeded?: boolean;
}

/** The first sentence of a description, for one-line deferred listings. */
function firstSentence(description: string): string {
  const line = description.trim().split('\n', 1)[0] ?? '';
  const end = line.search(/[.!?。！？](\s|$)/);
  const sentence = end === -1 ? line : line.slice(0, end + 1);
  return truncateString(sentence, 160, '…');
}

/** Declared first so the model sees script orchestration before the direct tools. */
const LEADING_DECLARATIONS: readonly string[] = [
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
];

/** Every other declaration keeps its relative order. */
function withLeadingDeclarations(
  declarations: FunctionDeclaration[],
): FunctionDeclaration[] {
  const leading = LEADING_DECLARATIONS.flatMap((name) =>
    declarations.filter((item) => item.name === name),
  );
  return [
    ...leading,
    ...declarations.filter(
      (item) => !LEADING_DECLARATIONS.includes(item.name ?? ''),
    ),
  ];
}

export class ToolRegistry {
  // The tools keyed by tool name as seen by the LLM.
  // This includes tools which are currently not active, use `getActiveTools`
  // and `isActive` to get only the active tools.
  // Held in canonical `compareTools` order; `ensureToolOrder` restores the
  // invariant lazily after a registration disturbs it.
  private allKnownTools: Map<string, AnyDeclarativeTool> = new Map();
  private toolOrderDirty = false;
  // Model-facing MCP name -> canonical registry key. Internal registration,
  // permissions, and MCP dispatch continue to use the canonical key.
  private mcpModelNameIndex: Map<string, string> = new Map();
  private mcpModelNameConflicts = new Set<string>();
  private mcpDirectNameConflicts = new Set<string>();
  // In-process cache for declarations, keyed by modelId + prompt bundle so a
  // live remote-policy change cannot leave Full/Lean tool descriptions stale.
  // Cleared whenever the tool set changes (register/unregister/sort/remove).
  private readonly schemaCache = new Map<string, FunctionDeclaration[]>();
  private readonly toolViews = new WeakMap<FunctionDeclaration[], ToolView>();
  private config: Config;
  private isMainRegistry: boolean;

  private registeredMcpTools = new Set<string>();
  private unsubscribeMcp?: () => void;
  private readonly convertedSchemaCache = new WeakMap<
    object,
    ModelStreamTool[]
  >();

  constructor(
    config: Config,
    isMainRegistry: boolean = false,
    private readonly schemaOptions: ToolRegistrySchemaOptions = {},
  ) {
    this.config = config;
    this.isMainRegistry = isMainRegistry;
  }

  /**
   * Model-facing tool schemas for this registry, with MCP-injected tools
   * loaded on demand. Forks may substitute a fixed schema list.
   */
  getSchema(
    modelKey?: string,
    schemaContext?: FileReadRecoverySchemaContext,
  ): ModelStreamTool[] {
    const override = this.schemaOptions.schemaOverride;
    if (override) return [...override];
    this.applyMcpTools();
    const effectiveModel = modelKey ?? this.config.getActiveModel() ?? '';
    const declarations = schemaContext
      ? this.getModelFunctionDeclarations(effectiveModel, schemaContext)
      : this.getModelFunctionDeclarations(effectiveModel);
    const cached = this.convertedSchemaCache.get(declarations);
    if (cached) return cached;
    const filter = this.schemaOptions.schemaFilter;
    const schemas = buildModelStreamTools(declarations);
    const visible = filter ? schemas.filter(filter) : schemas;
    this.convertedSchemaCache.set(declarations, visible);
    return visible;
  }

  /** Releases the MCP catalogue subscription, if one was established. */
  dispose(): void {
    this.unsubscribeMcp?.();
    this.unsubscribeMcp = undefined;
  }

  private applyMcpTools(): void {
    const mcp = this.config.getSessionMcpManager?.();
    const plan = mcp?.getInjectedMcpTools();
    if (!mcp || !plan) return;
    this.unsubscribeMcp ??= mcp.onToolListChange(() => this.applyMcpTools());
    const next = new Set<string>();
    for (const entry of plan.tools) {
      next.add(entry.qualifiedName);
      if (this.getKnownTool(entry.qualifiedName) !== entry.tool) {
        this.registerTool(entry.tool);
      }
    }
    for (const name of this.registeredMcpTools) {
      if (!next.has(name)) this.unregisterTool(name);
    }
    if (plan.includeMetaTools) {
      this.config.registerLazyMetaTools(this);
    }
    this.sortTools();
    this.registeredMcpTools.clear();
    for (const name of next) this.registeredMcpTools.add(name);
  }

  /**
   * Creates a shallow clone of the registry and its current known tools.
   */
  clone(): ToolRegistry {
    const clone = new ToolRegistry(this.config);
    clone.allKnownTools = new Map(this.allKnownTools);
    clone.toolOrderDirty = this.toolOrderDirty;
    clone.mcpModelNameIndex = new Map(this.mcpModelNameIndex);
    clone.mcpModelNameConflicts = new Set(this.mcpModelNameConflicts);
    clone.mcpDirectNameConflicts = new Set(this.mcpDirectNameConflicts);
    return clone;
  }

  /** Known companion tools keyed by the tool they serve, resolved through overridable lookups. */
  getCompanionsByPrimary(): Map<string, AnyDeclarativeTool[]> {
    const companions = new Map<string, AnyDeclarativeTool[]>();
    for (const name of this.getAllToolNames()) {
      const tool = this.getKnownTool(name);
      const primary = tool?.exposureHints.companionOf;
      if (primary === undefined) continue;
      const list = companions.get(primary);
      if (list) list.push(tool!);
      else companions.set(primary, [tool!]);
    }
    return companions;
  }

  /**
   * Registers a tool definition.
   *
   * Note that excluded tools are still registered to allow for enabling them
   * later in the session.
   *
   * @param tool - The tool object containing schema and execution logic.
   */
  registerTool(tool: AnyDeclarativeTool): void {
    const replaced = this.allKnownTools.get(tool.name);
    // Unbound shell overrides inherit the host's availability and runtime edition.
    // Bind before scheduling: Bash concurrency checks also read session settings.
    if (tool instanceof ShellTool && !tool.isBoundToConfig) {
      if (!(replaced instanceof ShellTool)) return;
      tool = tool.bindToConfig(this.config);
    } else if (tool instanceof PowerShellTool && !tool.isBoundToConfig) {
      if (!(replaced instanceof PowerShellTool)) return;
      tool = tool.bindToConfig(this.config, replaced.edition);
    }
    if (replaced) {
      // Decide on behavior: throw error, log warning, or allow overwrite
      runLogger.warn(
        `Tool with name "${tool.name}" is already registered. Overwriting.`,
      );
    }
    this.allKnownTools.set(tool.name, tool);
    // A new key lands at the end of the Map's iteration order; re-sort lazily
    // on the next read rather than on every insert.
    this.toolOrderDirty = true;
    this.rebuildMcpModelNameIndex();
    this.invalidateSchemaCache();
  }

  /**
   * Unregisters a tool definition by name.
   *
   * @param name - The name of the tool to unregister.
   */
  unregisterTool(name: string): void {
    const removed = this.allKnownTools.get(name);
    if (this.allKnownTools.delete(name)) {
      // A tool and its companion are only usable together, so they leave together.
      const partner = removed?.exposureHints.companionOf;
      for (const tool of [...this.allKnownTools.values()])
        if (tool.exposureHints.companionOf === name || tool.name === partner)
          this.allKnownTools.delete(tool.name);
      this.rebuildMcpModelNameIndex();
    }
    this.invalidateSchemaCache();
  }

  private rebuildMcpModelNameIndex(reportDiagnostics = true): void {
    const candidates = new Map<string, DiscoveredMCPTool[]>();
    for (const tool of this.allKnownTools.values()) {
      if (!(tool instanceof DiscoveredMCPTool) || !tool.exposedName) continue;
      const tools = candidates.get(tool.exposedName) ?? [];
      tools.push(tool);
      candidates.set(tool.exposedName, tools);
    }

    const nextIndex = new Map<string, string>();
    const nextConflicts = new Set<string>();
    const nextDirectConflicts = new Set<string>();
    for (const [modelName, tools] of candidates) {
      if (tools.length === 1) {
        const tool = tools[0];
        nextIndex.set(modelName, tool.name);
        const directTool = this.allKnownTools.get(modelName);
        if (
          directTool &&
          directTool !== tool &&
          this.isToolEnabledByConfig(directTool)
        ) {
          nextDirectConflicts.add(modelName);
          if (
            reportDiagnostics &&
            !this.mcpDirectNameConflicts.has(modelName)
          ) {
            const message = `MCP exposed tool name "${modelName}" conflicts with active tool "${directTool.name}". Hiding "${tool.name}".`;
            runLogger.warn(message);
            this.config
              .getSessionMcpManager()
              ?.emitDiagnostic('warning', message, undefined, tool.serverName);
          }
        }
        continue;
      }

      nextConflicts.add(modelName);
      if (reportDiagnostics && !this.mcpModelNameConflicts.has(modelName)) {
        const canonicalNames = tools
          .map((tool) => tool.name)
          .sort()
          .join(', ');
        const message = `MCP exposed tool name "${modelName}" is configured by multiple tools (${canonicalNames}). All conflicting tools are hidden until the name is unique.`;
        runLogger.warn(message);
        this.config.getSessionMcpManager()?.emitDiagnostic('error', message);
      }
    }

    this.mcpModelNameIndex = nextIndex;
    this.mcpModelNameConflicts = nextConflicts;
    this.mcpDirectNameConflicts = nextDirectConflicts;
  }

  private canExposeMcpModelName(
    tool: DiscoveredMCPTool,
    excludeTools?: Set<string>,
  ): boolean {
    if (
      !tool.exposedName ||
      this.mcpModelNameIndex.get(tool.exposedName) !== tool.name
    ) {
      return false;
    }

    const directTool = this.allKnownTools.get(tool.exposedName);
    return (
      !directTool ||
      directTool === tool ||
      !this.isToolEnabledByConfig(directTool, excludeTools)
    );
  }

  private getModelFacingName(tool: AnyDeclarativeTool): string {
    if (tool instanceof DiscoveredMCPTool && this.canExposeMcpModelName(tool)) {
      return tool.exposedName ?? tool.getFullyQualifiedName();
    }
    return tool instanceof DiscoveredMCPTool
      ? tool.getFullyQualifiedName()
      : tool.name;
  }

  /**
   * Sorts tools as:
   * 1. Built-in tools, sorted by name.
   * 2. MCP tools ordered by server name then tool name.
   *
   * Stable ordering within each partition ensures the tool list sent to the
   * server is deterministic, which is a prerequisite for prompt-cache reuse.
   */
  sortTools(): void {
    this.toolOrderDirty = true;
    this.invalidateSchemaCache();
  }

  /**
   * Restores the canonical order of `allKnownTools` if a registration disturbed
   * it. Registration can finish in a different order in independent CLI
   * processes (for example Skill discovery racing MCP startup), so the ordering
   * invariant is enforced on the map itself instead of at each read site — a
   * caller cannot serialize insertion order into the prompt-cache key, and no
   * read pays for a sort unless the tool set actually changed.
   */
  private ensureToolOrder(): void {
    if (!this.toolOrderDirty) return;
    this.toolOrderDirty = false;
    this.allKnownTools = new Map(
      Array.from(this.allKnownTools.entries()).sort((a, b) =>
        compareTools(a[1], b[1]),
      ),
    );
  }

  /**
   * Removes all tools from a specific MCP server.
   * @param serverName The name of the server to remove tools from.
   */
  removeMcpToolsByServer(serverName: string): void {
    let removed = false;
    for (const [name, tool] of this.allKnownTools.entries()) {
      if (
        (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) ||
        (tool instanceof McpAuthTool && tool.serverName === serverName)
      ) {
        this.allKnownTools.delete(name);
        removed = true;
      }
    }
    if (removed) this.rebuildMcpModelNameIndex();
    this.invalidateSchemaCache();
  }

  invalidateSchemaCache(): void {
    this.schemaCache.clear();
  }

  private buildToolMetadata(): Map<string, Record<string, unknown>> {
    const toolMetadata = new Map<string, Record<string, unknown>>();
    for (const [name, tool] of this.allKnownTools) {
      const metadata: Record<string, unknown> = tool.toolAnnotations
        ? { ...tool.toolAnnotations }
        : {};
      // Include server name so the permission pipeline can resolve composite
      // wildcard patterns (e.g. "*__*") against unqualified tool names.
      if (tool instanceof DiscoveredMCPTool) {
        metadata['_serverName'] = tool.serverName;
      }
      if (Object.keys(metadata).length > 0) {
        toolMetadata.set(name, metadata);
      }
    }
    return toolMetadata;
  }

  /**
   * @returns All the tools that are not excluded.
   */
  private getActiveTools(): AnyDeclarativeTool[] {
    this.ensureToolOrder();
    const toolMetadata = this.buildToolMetadata();
    const allKnownNames = new Set(this.allKnownTools.keys());
    const excludedTools = this.isMainRegistry
      ? (this.expandExcludeToolsWithAliases(
          this.config.getExcludeTools(toolMetadata, allKnownNames),
        ) ?? new Set([]))
      : new Set<string>();
    // In plain headless mode, hide tools that require user interaction. This
    // covers the plan lifecycle tools too: plan mode is meaningless without a
    // user to approve the plan, and both tools are bypass-immune.
    const shouldHideInteractiveTools =
      this.isMainRegistry &&
      this.config.shouldHideInteractiveTools?.() === true;
    const activeTools: AnyDeclarativeTool[] = [];
    for (const tool of this.allKnownTools.values()) {
      if (!this.isActiveTool(tool, excludedTools)) continue;
      if (shouldHideInteractiveTools && tool.requiresUserInteraction()) {
        continue;
      }
      activeTools.push(tool);
    }
    // Already in canonical order: `ensureToolOrder` above guarantees the
    // iteration order of `allKnownTools`, and filtering preserves it.
    return activeTools;
  }

  /**
   * Expands an excludeTools set to include all legacy aliases.
   * For example, if 'search_file_content' is excluded and it's an alias for
   * 'Grep', both names will be in the returned set.
   */
  private expandExcludeToolsWithAliases(
    excludeTools: Set<string> | undefined,
  ): Set<string> | undefined {
    if (!excludeTools || excludeTools.size === 0) {
      return excludeTools;
    }
    const expanded = new Set<string>();
    for (const name of excludeTools) {
      for (const alias of getToolAliases(name)) {
        expanded.add(alias);
      }
    }
    return expanded;
  }

  /**
   * @param tool
   * @param excludeTools (optional, helps performance for repeated calls)
   * @returns Whether or not the `tool` is not excluded.
   */
  private isActiveTool(
    tool: AnyDeclarativeTool,
    excludeTools?: Set<string>,
  ): boolean {
    excludeTools ??=
      this.expandExcludeToolsWithAliases(
        this.config.getExcludeTools(
          this.buildToolMetadata(),
          new Set(this.allKnownTools.keys()),
        ),
      ) ?? new Set([]);

    if (
      tool instanceof DiscoveredMCPTool &&
      tool.exposedName &&
      !this.canExposeMcpModelName(tool, excludeTools)
    ) {
      return false;
    }

    return this.isToolEnabledByConfig(tool, excludeTools);
  }

  private isToolEnabledByConfig(
    tool: AnyDeclarativeTool,
    excludeTools?: Set<string>,
  ): boolean {
    excludeTools ??=
      this.expandExcludeToolsWithAliases(
        this.config.getExcludeTools(
          this.buildToolMetadata(),
          new Set(this.allKnownTools.keys()),
        ),
      ) ?? new Set([]);

    if (tool.name === UPDATE_TOPIC_TOOL_NAME) {
      if (!this.config.isTopicUpdateNarrationEnabled()) {
        return false;
      }
    }

    // MCP tools have a canonical permission identity independent of their raw
    // or model-facing name. Built-in narrowing such as `tools: []` must not
    // exclude an MCP tool merely because its server-side name is `Read`.
    if (tool instanceof DiscoveredMCPTool) {
      return !excludeTools.has(tool.getFullyQualifiedName());
    }

    const normalizedClassName = (
      tool.configurationName ?? tool.constructor.name
    ).replace(/^_+/, '');
    const possibleNames = [tool.name, normalizedClassName];
    return !possibleNames.some((name) => excludeTools.has(name));
  }

  /**
   * Retrieves the complete callable tool view, including CodeMode-only tools.
   * Extracts the declarations from the ToolListUnion structure.
   * Includes every active tool.
   * @param modelId Optional model identifier to get model-specific schemas.
   * @returns An array of FunctionDeclarations.
   */
  getFunctionDeclarations(
    modelId?: string,
    schemaContext?: FileReadRecoverySchemaContext,
  ): FunctionDeclaration[] {
    const cacheKey = JSON.stringify([
      modelId ?? null,
      resolvePromptBundleForModel(modelId),
      schemaContext?.preReadLineDropped === true,
      this.getTool(CODE_MODE_TOOL_NAME)
        ? this.config.getCodeModeExposure()
        : undefined,
    ]);
    const cached = this.schemaCache.get(cacheKey);
    if (cached) {
      const finalized = this.finalizeWorkflowDescription(cached);
      if (finalized !== cached) this.schemaCache.set(cacheKey, finalized);
      return finalized;
    }

    const declarations: FunctionDeclaration[] = [];
    const seenNames = new Set<string>();

    this.getActiveTools().forEach((tool) => {
      const toolName = this.getModelFacingName(tool);

      if (seenNames.has(toolName) || !this.allowedForMainAgent(tool)) {
        return;
      }

      seenNames.add(toolName);

      let schema = tool.getSchema(modelId);

      // Ensure the schema name matches the qualified name for MCP tools
      if (tool instanceof DiscoveredMCPTool) {
        schema = {
          ...schema,
          name: toolName,
        };
      }

      declarations.push(schema);
    });

    const finalized = this.finalizeToolDescriptions(
      applyFileReadRecoveryDescriptions(
        this.withoutOrphanedCompanions(declarations),
        modelId,
        schemaContext,
      ),
    );
    this.schemaCache.set(cacheKey, finalized);
    return finalized;
  }

  /** A companion is declared only beside the tool it serves. */
  private withoutOrphanedCompanions(
    declarations: FunctionDeclaration[],
  ): FunctionDeclaration[] {
    const names = new Set(declarations.map((item) => item.name));
    const kept = declarations.filter((item) => {
      const primary = item.name
        ? this.allKnownTools.get(item.name)?.exposureHints.companionOf
        : undefined;
      return primary === undefined || names.has(primary);
    });
    return kept.length === declarations.length ? declarations : kept;
  }

  /** The main agent's `tools` setting; other registries are already scoped to their agent. */
  private allowedForMainAgent(tool: AnyDeclarativeTool): boolean {
    const mainAgentTools = this.isMainRegistry
      ? this.config.getMainAgentTools()
      : undefined;
    if (!mainAgentTools) return true;
    // Companions follow the tool they serve, via withoutOrphanedCompanions().
    if (tool.exposureHints.companionOf !== undefined) return true;
    const toolName = this.getModelFacingName(tool);
    const configurationName = tool.configurationName ?? tool.constructor.name;
    return (
      mainAgentTools.includes(toolName) ||
      mainAgentTools.includes(tool.name) ||
      mainAgentTools.includes(configurationName) ||
      mainAgentTools.some((t) => t.startsWith(`${configurationName}(`))
    );
  }

  /** This agent's CodeMode exposure. Declared names do not vary by model, so no model ID is needed. */
  getCodeModeExposure(): CodeModeExposure | undefined {
    const tool = this.getTool(CODE_MODE_TOOL_NAME);
    return tool && this.allowedForMainAgent(tool)
      ? this.config.getCodeModeExposure()
      : undefined;
  }

  /** Model declarations; tools hidden from them keep normal dispatch and permissions. */
  getModelFunctionDeclarations(
    modelId?: string,
    schemaContext?: FileReadRecoverySchemaContext,
  ): FunctionDeclaration[] {
    return this.getToolView(modelId, schemaContext).declared;
  }

  /** How this agent sees each tool; every exposure consumer reads this view. */
  getToolView(
    modelId?: string,
    schemaContext?: FileReadRecoverySchemaContext,
  ): ToolView {
    return this.viewOf(this.getFunctionDeclarations(modelId, schemaContext));
  }

  private viewOf(declarations: FunctionDeclaration[]): ToolView {
    const cached = this.toolViews.get(declarations);
    if (cached) return cached;
    const view = this.viewFrom(
      declarations,
      this.resolveExposures(declarations),
    );
    this.toolViews.set(declarations, view);
    return view;
  }

  /** Depends on declared names, configuration and the applied MCP registration, never on descriptions. */
  private resolveExposures(
    declarations: readonly FunctionDeclaration[],
  ): ExposureResolution {
    const names = new Set(declarations.map((item) => item.name));
    const codeMode = names.has(CODE_MODE_TOOL_NAME)
      ? this.config.getCodeModeExposure()
      : undefined;
    const metaCall = names.has(MCP_CALL_TOOL_NAME);
    // Without CodeMode, only full registration can hide tools behind mcp_call;
    // under lazy registration every registered tool is declared as is.
    const registration =
      codeMode || metaCall ? this.mcpRegistration() : undefined;
    const context: ExposureContext | undefined =
      registration && (codeMode || registration.mode === 'full')
        ? {
            patterns: this.deferredToolPatterns(),
            mcpViaCodeMode: registration.mcpViaCodeMode,
            declaredMcpServers: registration.declaredMcpServers,
            codeMode,
            metaCall,
          }
        : undefined;
    const tools = new Map<string, AnyDeclarativeTool>();
    const exposure = new Map<string, ToolExposure>();
    // Scripts reach MCP only through tools[name], never through the meta tools.
    const scriptTools = new Map<string, AnyDeclarativeTool>();
    for (const { name } of declarations) {
      const tool = name ? this.getTool(name) : undefined;
      if (!name || !tool) continue;
      tools.set(name, tool);
      if (isScriptCallable(tool)) scriptTools.set(name, tool);
      if (context) exposure.set(name, resolveExposure(tool, context));
    }
    return {
      codeMode,
      scriptTools,
      exposure,
      tools,
      // Under full registration the meta tools matter only while they reach some MCP tool.
      ...(registration && context
        ? {
            metaNeeded:
              registration.mode === 'lazy' ||
              [...exposure.values()].includes('meta'),
          }
        : {}),
    };
  }

  private viewFrom(
    declarations: FunctionDeclaration[],
    resolution: ExposureResolution,
  ): ToolView {
    const { codeMode, scriptTools, exposure, tools, metaNeeded } = resolution;
    let declared = declarations;
    if (metaNeeded !== undefined) {
      const visible = declarations.filter((item) => {
        const value = item.name ? exposure.get(item.name) : undefined;
        if (value === undefined) return true;
        if (value !== 'declared') return false;
        return metaNeeded || !tools.get(item.name!)?.exposureHints.metaTool;
      });
      // Preserve identity when nothing is hidden; request caches key on it.
      if (visible.length !== declarations.length) declared = visible;
    }
    return {
      ...(codeMode ? { codeMode } : {}),
      declared,
      scriptTools,
      exposure,
    };
  }

  /** The manager's applied registration decides what is registered; config only predicts it before attachment. */
  private mcpRegistration(): McpRegistration {
    return (
      this.config.getMcpClientManager?.()?.peekAppliedRegistration?.() ??
      resolveMcpRegistration(
        this.config.getCodeModeExposure(),
        this.config.getMcpLazyLoad(),
      )
    );
  }

  private deferredToolPatterns(): readonly string[] {
    return readDeferredToolPatterns(this.config.getSetting('codeMode'));
  }

  /** Decided by configuration, so the CodeMode description does not change as servers connect. */
  private mcpMayDefer(): boolean {
    return (
      this.mcpRegistration().mcpViaCodeMode ||
      patternsMayDeferMcp(this.deferredToolPatterns()) ||
      Object.values(this.config.getMcpServers?.() ?? {}).some(
        (server) => server.deferred === true,
      )
    );
  }

  private readonly warnedDeferredNames = new Set<string>();

  /** A listed model-only tool stays declared; say so once per name. */
  private warnIneffectiveDeferredTools(): void {
    const patterns = this.deferredToolPatterns();
    if (!patterns.length) return;
    for (const name of ineffectiveDeferredNames(
      patterns,
      this.getAllKnownTools(),
    )) {
      if (this.warnedDeferredNames.has(name)) continue;
      this.warnedDeferredNames.add(name);
      runLogger.warn(
        `[CodeMode] codeMode.deferredTools lists ${name}, which CodeMode scripts cannot call; it stays declared.`,
      );
    }
  }

  private readonly programmaticCatalogCache = new WeakMap<
    FunctionDeclaration[],
    readonly ScriptToolDescription[]
  >();

  getProgrammaticToolCatalog(
    modelId?: string,
  ): readonly ScriptToolDescription[] {
    const declarations = this.getFunctionDeclarations(modelId);
    const cached = this.programmaticCatalogCache.get(declarations);
    if (cached) return cached;
    const catalog = [...this.viewOf(declarations).scriptTools].map(
      ([name, tool]) => {
        const schema = { ...tool.getSchema(modelId), name };
        return {
          name,
          description: describeProgrammaticTool(
            schema,
            tool.programmatic.outputSchema,
            tool.programmatic.note,
          ),
          searchText: toolSearchText(
            name,
            schema.description,
            schema.parametersJsonSchema ?? schema.parameters,
          ),
          ...(tool.exposureHints.namespace
            ? { namespace: tool.exposureHints.namespace.server }
            : {}),
        };
      },
    );
    this.programmaticCatalogCache.set(declarations, catalog);
    return catalog;
  }

  /**
   * Retrieves a filtered list of tool schemas based on a list of tool names.
   * @param toolNames - An array of tool names to include.
   * @param modelId Optional model identifier to get model-specific schemas.
   * @returns An array of FunctionDeclarations for the specified tools.
   */
  getFunctionDeclarationsFiltered(
    toolNames: string[],
    modelId?: string,
    schemaContext?: FileReadRecoverySchemaContext,
  ): FunctionDeclaration[] {
    const declarations: FunctionDeclaration[] = [];
    for (const name of toolNames) {
      const tool = this.getTool(name);
      if (tool) {
        let schema = tool.getSchema(modelId);

        // Ensure the schema name matches the qualified name for MCP tools
        if (tool instanceof DiscoveredMCPTool) {
          schema = {
            ...schema,
            name: this.getModelFacingName(tool),
          };
        }

        declarations.push(schema);
      }
    }
    return this.finalizeToolDescriptions(
      applyFileReadRecoveryDescriptions(declarations, modelId, schemaContext),
    );
  }

  private finalizeToolDescriptions(
    declarations: FunctionDeclaration[],
  ): FunctionDeclaration[] {
    const codeIndex = declarations.findIndex(
      (item) => item.name === CODE_MODE_TOOL_NAME,
    );
    if (codeIndex === -1) return this.finalizeWorkflowDescription(declarations);
    const resolution = this.resolveExposures(declarations);
    const only = resolution.codeMode === 'only';
    const exposureOf = (item: FunctionDeclaration) =>
      item.name ? resolution.exposure.get(item.name) : undefined;
    const toolOf = (item: FunctionDeclaration) =>
      item.name ? resolution.scriptTools.get(item.name) : undefined;
    const deferredBuiltins = declarations.flatMap((item) => {
      const tool = toolOf(item);
      return tool &&
        !tool.exposureHints.namespace &&
        exposureOf(item) === 'deferred'
        ? [
            {
              name: item.name!,
              summary: firstSentence(item.description ?? ''),
              longRunning: tool.exposureHints.longRunning === true,
            },
          ]
        : [];
    });
    this.warnIneffectiveDeferredTools();
    const members = declarations.flatMap((item) => {
      const tool = toolOf(item);
      return tool && exposureOf(item) === 'inline'
        ? [
            describeProgrammaticContract(
              item,
              tool.programmatic.outputSchema,
              only,
              tool.programmatic.note,
            ),
          ]
        : [];
    });
    const description = buildCodeModeDescription({
      only,
      deferred: deferredBuiltins.length > 0 || this.mcpMayDefer(),
      deferredTools: deferredBuiltins,
      catalog: only ? renderToolCatalog(members) : '',
    });
    declarations = declarations.map((item, index) => {
      if (index === codeIndex) return { ...item, description };
      const tool = toolOf(item);
      if (
        !tool ||
        tool.exposureHints.namespace ||
        exposureOf(item) !== 'declared'
      )
        return item;
      return {
        ...item,
        description: `${item.description ?? ''}\n${describeProgrammaticResult(item.name!, tool.programmatic.outputSchema, tool.programmatic.note)}`,
      };
    });
    const finalized = this.finalizeWorkflowDescription(
      withLeadingDeclarations(declarations),
    );
    // The resolution is keyed by name, so reordering and rewriting keep it valid.
    this.toolViews.set(finalized, this.viewFrom(finalized, resolution));
    return finalized;
  }

  private finalizeWorkflowDescription(
    declarations: FunctionDeclaration[],
  ): FunctionDeclaration[] {
    const index = declarations.findIndex((d) => d.name === WORKFLOW_TOOL_NAME);
    if (index === -1) return declarations;
    const description = getWorkflowToolDescription({
      authoringAvailable: isWorkflowAuthoringAvailable(
        this.config,
        declarations.flatMap((d) => (d.name ? [d.name] : [])),
      ),
    });
    if (declarations[index].description === description) return declarations;
    // The schema registry caches by array identity. Preserve it on ordinary
    // turns, and never mutate a schema already used by an earlier request.
    const updated = [...declarations];
    updated[index] = { ...declarations[index], description };
    return updated;
  }

  /**
   * Returns an array of names for all active tools.
   * For MCP tools, this returns the configured model-facing name.
   * The list is deduplicated.
   */
  getAllToolNames(): string[] {
    const names = new Set<string>();
    for (const tool of this.getActiveTools()) {
      names.add(this.getModelFacingName(tool));
    }
    return Array.from(names);
  }

  /**
   * Returns names for all known tools, including tools excluded from the main
   * session by permission rules. Subagent setup uses this so a child agent's
   * default tool table is controlled by its own AgentDefinition.
   */
  getAllKnownToolNames(): string[] {
    this.ensureToolOrder();
    const names = new Set<string>();
    for (const tool of this.allKnownTools.values()) {
      names.add(this.getModelFacingName(tool));
    }
    return Array.from(names);
  }

  /**
   * Returns true if a tool with the given name is currently active.
   * More efficient than `getAllToolNames().includes(name)` — short-circuits
   * on first match without allocating an intermediate array.
   */
  hasToolEnabled(name: string): boolean {
    return this.getTool(name) !== undefined;
  }

  /**
   * Returns an array of all active tool instances.
   */
  getAllTools(): AnyDeclarativeTool[] {
    const seen = new Set<string>();
    const tools: AnyDeclarativeTool[] = [];

    for (const tool of this.getActiveTools().sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    )) {
      const name = this.getModelFacingName(tool);
      if (!seen.has(name)) {
        seen.add(name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /**
   * Filters discovered MCP tools using the registry's existing visibility
   * rules, without changing live registrations or publishing diagnostics.
   */
  getVisibleMcpTools(tools: readonly DiscoveredMCPTool[]): DiscoveredMCPTool[] {
    if (tools.length === 0) return [];
    const view = new ToolRegistry(this.config, this.isMainRegistry);
    view.allKnownTools = new Map(this.allKnownTools);
    for (const tool of tools) view.allKnownTools.set(tool.name, tool);
    view.toolOrderDirty = true;
    view.rebuildMcpModelNameIndex(false);
    const candidates = new Set(tools);
    return view
      .getAllTools()
      .filter(
        (tool): tool is DiscoveredMCPTool =>
          tool instanceof DiscoveredMCPTool && candidates.has(tool),
      );
  }

  /**
   * Returns all registered tool instances, including tools
   * currently excluded from the main session by permission rules.
   */
  getAllKnownTools(): AnyDeclarativeTool[] {
    const seen = new Set<string>();
    const tools: AnyDeclarativeTool[] = [];

    for (const tool of Array.from(this.allKnownTools.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    )) {
      const name = this.getModelFacingName(tool);
      if (!seen.has(name)) {
        seen.add(name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /**
   * Returns an array of tools registered from a specific MCP server.
   */
  getToolsByServer(serverName: string): AnyDeclarativeTool[] {
    const serverTools: AnyDeclarativeTool[] = [];
    for (const tool of this.getActiveTools()) {
      if ((tool as DiscoveredMCPTool)?.serverName === serverName) {
        serverTools.push(tool);
      }
    }
    return serverTools.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get a registered tool by name without applying active/excluded filtering.
   * This is intended for isolated child registries that should decide their
   * own tool surface after cloning from the main registry.
   */
  getKnownTool(name: string): AnyDeclarativeTool | undefined {
    let tool = this.allKnownTools.get(name);

    if (!tool && TOOL_LEGACY_ALIASES[name]) {
      const currentName = TOOL_LEGACY_ALIASES[name];
      tool = this.allKnownTools.get(currentName);
      if (tool) {
        runLogger.debug(
          `Resolved legacy tool name "${name}" to current name "${currentName}"`,
        );
      }
    }

    return tool;
  }

  /**
   * Get the definition of a specific tool.
   */
  getTool(name: string): AnyDeclarativeTool | undefined {
    const tool = this.getKnownTool(name);

    if (tool && this.isActiveTool(tool)) {
      return tool;
    }

    const canonicalName = this.mcpModelNameIndex.get(name);
    if (canonicalName) {
      const aliasedTool = this.allKnownTools.get(canonicalName);
      if (aliasedTool && this.isActiveTool(aliasedTool)) {
        return aliasedTool;
      }
    }
    return;
  }
}
