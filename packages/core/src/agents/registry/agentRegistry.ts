/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CoreEvent, coreEvents } from '../../utils/events.js';
import type { AgentOverride, Config } from '../../config/config.js';
import type { AgentListingEntry } from '../agent-policy-view.js';
import {
  type AgentDefinition,
  type AgentSource,
  type LocalAgentDefinition,
  RESOLVED_AGENT_REASONING,
  type AgentMcpServerSpec,
} from '../types.js';
import {
  type AgentLoadError,
  agentResourceToAgentDefinition,
  loadAgentsFromPath,
  parseAgentsFromJson,
} from './agentLoader.js';
import { stripUnsafePluginFields } from './pluginAgentPolicy.js';
import {
  substitutePluginVariables,
  getLoadedPluginId,
} from '../../plugins/index.js';
import {
  emitLoadErrorSummary,
  type ConfigLoadError,
} from '../../utils/configLoadError.js';
import { GeneralPurposeAgent } from '../builtin/general-purpose-agent.js';
import { StatusLineSetupAgent } from '../builtin/statusline-setup-agent.js';
import { ExploreAgent } from '../builtin/explore-agent.js';
import { PlanAgent } from '../builtin/plan-agent.js';
import { type z } from 'zod';
import { runLogger } from '../../utils/runLogger.js';
import {
  mergeAgentModelConfig,
  resolveConfiguredAgentModel,
} from '../agentModelConfig.js';
import type { Model } from '../../provider/model/model.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { isSDKMode } from '../../utils/headless.js';
import {
  FRONTMATTER_REGEX,
  coerceDescriptionToString,
  resolveAgentReasoning,
} from '../../utils/frontmatterParsers.js';
import { load as loadYaml } from 'js-yaml';
import { getErrorMessage } from '../../utils/errors.js';
import { resolvePromptBundleForModel } from '../../prompts/bundle-resolver.js';

const MODEL_EFFORT_LOAD_ERROR_PREFIX = 'Model/effort validation failed:';

function formatEffortForError(effort: string): string {
  return effort === 'none' ? 'disabled' : effort;
}

/**
 * Retry failed plugin agents with lenient fallback values.
 * Aligned with reference project: name falls back to filename,
 * description falls back to a generic string, body becomes system prompt.
 * Only applies to plugin agents — user/project agents keep strict validation.
 */
async function retryFailedPluginAgents(
  errors: AgentLoadError[],
  pluginName: string,
  agentDir: string,
): Promise<LocalAgentDefinition[]> {
  const agents: LocalAgentDefinition[] = [];

  for (const err of errors) {
    if (!err.filePath || !err.filePath.endsWith('.md')) continue;

    try {
      const content = await fs.readFile(err.filePath, 'utf-8');

      const match = content.match(FRONTMATTER_REGEX);
      let body: string;
      let frontmatterName: string | undefined;
      let frontmatterDesc: string | undefined;

      if (match) {
        body = (match[2] || '').trim();
        try {
          const raw = loadYaml(match[1]) as Record<string, unknown> | undefined;
          if (raw) {
            frontmatterName =
              coerceDescriptionToString(raw['name']) ?? undefined;
            frontmatterDesc =
              coerceDescriptionToString(raw['description']) ??
              coerceDescriptionToString(raw['when-to-use']) ??
              undefined;
          }
        } catch {
          // YAML parse failed — use fallback values
        }
      } else {
        body = content.trim();
      }

      const baseName = path.basename(err.filePath).replace(/\.md$/i, '');
      const agentName = frontmatterName || baseName;
      const description = frontmatterDesc || `Agent from ${pluginName} plugin`;
      const systemPrompt = body || description;

      // Derive namespace from subdirectory path relative to agentDir
      const relDir = path.relative(agentDir, path.dirname(err.filePath));
      const namespace = relDir && relDir !== '.' ? relDir.split(path.sep) : [];
      const nameParts = [pluginName, ...namespace, agentName];

      const agent: LocalAgentDefinition = {
        kind: 'local',
        name: nameParts.join(':'),
        description,
        promptConfig: {
          systemPrompt,
        },
        modelConfig: {
          model: 'inherit',
        },
        metadata: {
          filePath: err.filePath,
        },
      };

      agents.push(agent);
      debugLogger.log(
        `[AgentRegistry] Plugin ${pluginName}: loaded agent "${agent.name}" with lenient fallback`,
      );
    } catch (readErr) {
      debugLogger.warn(
        `[AgentRegistry] Plugin ${pluginName}: could not retry agent at ${err.filePath}: ${getErrorMessage(readErr)}`,
      );
    }
  }

  return agents;
}

/**
 * The registry stores agents with heterogeneous output schemas and does not
 * inspect their schema-specific output values. Erase the output type once at
 * this storage boundary instead of widening individual return values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RegistryAgentDefinition = AgentDefinition<any>;

/**
 * Manages the discovery, loading, validation, and registration of
 * AgentDefinitions.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, RegistryAgentDefinition>(); // 运行时真正可调用集合
  private readonly allDefinitions = new Map<string, RegistryAgentDefinition>(); // 所有定义，包括被禁用的、校验失败的、同名定义最后发现的
  /** Flat list of every discovered definition, including shadowed duplicates. */
  private readonly discoveredList: RegistryAgentDefinition[] = []; // 全部来源和全部同名版本
  /** Errors encountered during the last load/reload cycle. */
  private loadErrors: ConfigLoadError[] = []; // 解析失败

  /**
   * Write-target for register methods. During loadAgents()/refreshAgents()
   * this points to a temporary buffer; outside those methods it points to
   * the live fields.
   */

  private _defaultTarget: {
    agents: Map<string, RegistryAgentDefinition>;
    allDefinitions: Map<string, RegistryAgentDefinition>;
    discoveredList: RegistryAgentDefinition[];
    loadErrors: ConfigLoadError[];
  } = {
    agents: this.agents,
    allDefinitions: this.allDefinitions,
    discoveredList: this.discoveredList,
    loadErrors: this.loadErrors,
  };
  private _target = this._defaultTarget;

  /**
   * Agent definitions injected by the SDK host at runtime. They have no
   * re-readable source, so reload() must re-register them after the buffer
   * swap. Keep registration order, including shadowed and disabled definitions.
   * CLI --agents definitions are excluded: loadAgents() re-parses those.
   */
  private readonly sdkInjectedAgents: RegistryAgentDefinition[] = [];
  private _reloadInFlight: Promise<void> | null = null;
  private _reloadPendingAfter = false;
  private _agentRefreshInFlight: Promise<void> | null = null;
  private _agentRefreshPending = false;
  private _reportModelEffortErrorsAfterRefresh = false;
  private readonly reportedModelEffortErrors = new Set<string>();

  constructor(private readonly config: Config) {}

  /**
   * Discovers and loads agents.
   */
  async initialize(): Promise<void> {
    coreEvents.on(CoreEvent.ModelChanged, this.onModelChanged);
    coreEvents.on(CoreEvent.ModelInfoChanged, this.onModelInfoChanged);
    coreEvents.on(CoreEvent.TrustChanged, this.onTrustChanged);

    await this.loadAgents({ emitToFeed: true });
  }

  private onModelChanged = () => {
    this.scheduleAgentRefresh(false);
  };

  private onTrustChanged = () => {
    this.reload().catch((e) => {
      runLogger.error(
        '[AgentRegistry] Failed to reload agents on trust change:',
        e,
      );
    });
  };

  private onModelInfoChanged = () => {
    if (!this.config.isAgentsEnabled()) {
      return;
    }
    this.scheduleAgentRefresh(true);
  };

  private scheduleAgentRefresh(reportModelEffortErrors: boolean): void {
    this._reportModelEffortErrorsAfterRefresh ||= reportModelEffortErrors;
    if (this._agentRefreshInFlight) {
      this._agentRefreshPending = true;
      return;
    }

    this._agentRefreshInFlight = (async () => {
      let shouldReportModelEffortErrors = false;
      do {
        this._agentRefreshPending = false;
        shouldReportModelEffortErrors ||=
          this._reportModelEffortErrorsAfterRefresh;
        this._reportModelEffortErrorsAfterRefresh = false;
        await this.refreshAgents();
      } while (this._agentRefreshPending);

      if (shouldReportModelEffortErrors) {
        coreEvents.emitAgentsRefreshed(this.config.getSessionId());
        this.emitNewModelEffortLoadErrors();
      }
    })()
      .catch((e) => {
        runLogger.error(
          '[AgentRegistry] Failed to refresh agents after model update:',
          e,
        );
      })
      .finally(() => {
        this._agentRefreshInFlight = null;
        if (
          this._agentRefreshPending ||
          this._reportModelEffortErrorsAfterRefresh
        ) {
          this._agentRefreshPending = false;
          this.scheduleAgentRefresh(false);
        }
      });
  }

  /**
   * Clears the current registry and re-scans for agents.
   * Uses a coalescing guard so concurrent reload requests are collapsed.
   */
  async reload(): Promise<void> {
    if (this._reloadInFlight) {
      this._reloadPendingAfter = true;
      await this._reloadInFlight;
      return;
    }

    do {
      this._reloadPendingAfter = false;
      this._reloadInFlight = this._doReload();
      try {
        await this._reloadInFlight;
      } finally {
        this._reloadInFlight = null;
      }
    } while (this._reloadPendingAfter);
  }

  private async _doReload(): Promise<void> {
    await this.config.reloadAgents();

    // SDK-injected agents live only in memory and would otherwise be wiped by
    // loadAgents()'s _withBuffer swap. CLI --agents agents are re-parsed by
    // loadAgents() itself, so only SDK injections are re-registered here.
    await this.loadAgents({ emitToFeed: false });

    for (const def of [...this.sdkInjectedAgents]) {
      try {
        await this.registerAgent(def);
      } catch (e) {
        runLogger.warn(
          `[AgentRegistry] Failed to re-register SDK agent "${def.name}" after reload:`,
          e,
        );
      }
    }

    coreEvents.emitAgentsRefreshed(this.config.getSessionId());
  }

  /**
   * Disposes of resources and removes event listeners.
   */
  dispose(): void {
    coreEvents.off(CoreEvent.ModelChanged, this.onModelChanged);
    coreEvents.off(CoreEvent.ModelInfoChanged, this.onModelInfoChanged);
    coreEvents.off(CoreEvent.TrustChanged, this.onTrustChanged);
  }

  /**
   * Returns errors encountered during the last load/reload cycle.
   * Used by UI panels to display error banners.
   */
  getLoadErrors(): readonly ConfigLoadError[] {
    return this.loadErrors;
  }

  private getModelEffortLoadErrors(): ConfigLoadError[] {
    return this.loadErrors.filter((error) =>
      error.message.startsWith(MODEL_EFFORT_LOAD_ERROR_PREFIX),
    );
  }

  private getModelEffortLoadErrorSignature(error: ConfigLoadError): string {
    return `${error.name ?? ''}\u0000${error.filePath}\u0000${error.message}`;
  }

  private rememberReportedModelEffortLoadErrors(): void {
    this.reportedModelEffortErrors.clear();
    for (const error of this.getModelEffortLoadErrors()) {
      this.reportedModelEffortErrors.add(
        this.getModelEffortLoadErrorSignature(error),
      );
    }
  }

  private emitNewModelEffortLoadErrors(): void {
    const currentErrors = this.getModelEffortLoadErrors();
    const newErrors = currentErrors.filter(
      (error) =>
        !this.reportedModelEffortErrors.has(
          this.getModelEffortLoadErrorSignature(error),
        ),
    );

    if (newErrors.length > 0) {
      emitLoadErrorSummary(newErrors, 'agent', (severity, message) =>
        coreEvents.emitFeedback(severity, message),
      );
    }
    this.rememberReportedModelEffortLoadErrors();
  }

  private async loadAgents(
    opts: { emitToFeed: boolean } = { emitToFeed: true },
  ): Promise<void> {
    await this._withBuffer(async (buffer) => {
      await this.loadBuiltInAgents();

      if (!this.config.isAgentsEnabled()) {
        return;
      }

      const allowedSources = this.config.getAllowedAgentSources();
      if (allowedSources) {
        runLogger.log(
          `[AgentRegistry] Filtering agent sources: ${allowedSources.join(', ')}`,
        );
      }

      // User/project files are discovered and watched by @qwen-code/resource.
      // Consume the un-deduplicated snapshot so the CLI can preserve its
      // existing diagnostics and precedence projection.
      for (const error of this.config.getResourceAgentLoadErrors()) {
        this._target.loadErrors.push({
          name: undefined,
          filePath: error.filePath,
          message: error.message,
          configType: 'agent',
          source: error.source,
        });
      }
      for (const resource of this.config.getResourceAgentDefinitions()) {
        const agent = agentResourceToAgentDefinition(resource);
        try {
          AgentRegistry.tagSource(agent, resource.metadata.source);
          await this.registerAgent(agent);
        } catch (e) {
          runLogger.warn(
            `[AgentRegistry] Error registering ${resource.metadata.source} agent "${agent.name}":`,
            e,
          );
          this._target.loadErrors.push({
            name: agent.name,
            filePath: resource.metadata.filePath,
            message: `Error registering agent: ${e instanceof Error ? e.message : String(e)}`,
            configType: 'agent',
            source: resource.metadata.source,
          });
        }
      }

      // Load agents from plugins (from agentsPath / agentsPaths directories)
      if (this.config.isAgentSourceAllowed('plugin')) {
        for (const plugin of this.config.getEnabledPlugins()) {
          const agentEntries: string[] = [];
          if (plugin.agentsPath) agentEntries.push(plugin.agentsPath);
          if (plugin.agentsPaths) agentEntries.push(...plugin.agentsPaths);

          for (const agentEntry of agentEntries) {
            try {
              const loadResult = await loadAgentsFromPath(agentEntry, {
                pluginName: plugin.name,
              });
              if (!loadResult) continue;

              if (
                loadResult.sourceType === 'directory' &&
                loadResult.errors.length > 0
              ) {
                const lenientAgents = await retryFailedPluginAgents(
                  loadResult.errors,
                  plugin.name,
                  agentEntry,
                );
                loadResult.agents.push(...lenientAgents);
              }

              await Promise.allSettled(
                loadResult.agents.map(async (agent) => {
                  try {
                    AgentRegistry.applyPluginAgentPolicy(agent);
                    AgentRegistry.applyPluginAgentContentSubstitution(
                      agent,
                      plugin.path,
                      getLoadedPluginId(plugin),
                    );
                    await this.registerAgent(agent);
                  } catch (e) {
                    runLogger.warn(
                      `[AgentRegistry] Error registering plugin agent "${agent.name}" from ${plugin.name}:`,
                      e,
                    );
                    coreEvents.emitFeedback(
                      'error',
                      `Error registering plugin agent "${agent.name}": ${e instanceof Error ? e.message : String(e)}`,
                    );
                  }
                }),
              );
              for (const err of loadResult.errors) {
                runLogger.warn(
                  `[AgentRegistry] Plugin ${plugin.name} agent load error:`,
                  err.message,
                );
              }
            } catch (e) {
              runLogger.warn(
                `[AgentRegistry] Error loading plugin agents from ${agentEntry}:`,
                e,
              );
            }
          }
        }
      }

      // Register inline agents from --agents CLI flag (highest priority — overrides all others)
      const inlineJson = this.config.getInlineAgentsJson();
      if (inlineJson) {
        try {
          const flagAgents = parseAgentsFromJson(inlineJson);
          for (const agent of flagAgents) {
            AgentRegistry.tagSource(agent, 'flag');
            await this.registerLocalAgent(agent);
          }
          if (this.config.getDebugMode()) {
            runLogger.log(
              `[AgentRegistry] Registered ${flagAgents.length} flag agent(s) from --agents flag.`,
            );
          }
        } catch (e) {
          runLogger.warn(
            '[AgentRegistry] Error parsing flag agents from --agents flag:',
            e,
          );
          this._target.loadErrors.push({
            name: undefined,
            filePath: '--agents flag',
            message: `Error parsing --agents flag: ${e instanceof Error ? e.message : String(e)}`,
            configType: 'agent',
            source: 'inline',
          });
        }
      }

      if (this.config.getDebugMode()) {
        runLogger.log(
          `[AgentRegistry] Loaded with ${buffer.agents.size} agents.`,
        );
      }
    });

    // Emit a summarized feed-stream warning for any load errors (only on initial load)
    if (opts.emitToFeed) {
      emitLoadErrorSummary(this.loadErrors, 'agent', (severity, message) =>
        coreEvents.emitFeedback(severity, message),
      );
      this.rememberReportedModelEffortLoadErrors();
    }
  }

  private async loadBuiltInAgents(): Promise<void> {
    await this.registerLocalAgent(
      AgentRegistry.tagSource(GeneralPurposeAgent(this.config), 'built-in'),
    );

    const statuslineSetup = StatusLineSetupAgent(this.config);
    if (!this.isSkippedInSdkMode(statuslineSetup)) {
      await this.registerLocalAgent(
        AgentRegistry.tagSource(statuslineSetup, 'built-in'),
      );
    }

    // Register Plan Mode built-in agents.
    // ExploreAgent MUST be registered before PlanAgent because PlanAgent's toolConfig
    // references ExploreAgent via Agent(explore), requiring it to already be registered.
    await this.registerLocalAgent(
      AgentRegistry.tagSource(ExploreAgent(this.config), 'built-in'),
    );
    await this.registerLocalAgent(
      AgentRegistry.tagSource(PlanAgent(this.config), 'built-in'),
    );

    // Agents contributed by the product's builtin plugins are registered as
    // built-ins, so user/project definitions with the same name still win.
    // Definitions are re-read on every load (nothing is cached here); plugin
    // change notifications currently refresh tools/hooks/skills, not agents.
    const builtinContributions = this.config.getBuiltinPluginContributions();
    const contributedAgents = builtinContributions?.isReady()
      ? builtinContributions.getAgentDefinitions()
      : [];
    for (const agent of contributedAgents) {
      if (this.isSkippedInSdkMode(agent)) continue;
      await this.registerLocalAgent(
        AgentRegistry.tagSource(agent, 'built-in'),
      );
    }
  }

  private isSkippedInSdkMode(agent: LocalAgentDefinition): boolean {
    return agent.skipInSdkMode === true && isSDKMode();
  }

  private async refreshAgents(): Promise<void> {
    // Snapshot from discoveredList (the full, un-deduplicated list) so that
    // shadowed agents (e.g. personal/foo overridden by project/foo) survive
    // the rebuild. Using `agents` (the deduplicated winner map) would lose them.
    const nonBuiltInDiscovered = this.discoveredList.filter(
      (agent) => agent.metadata?.source !== 'built-in',
    );

    await this._withBuffer(async () => {
      await this.loadBuiltInAgents();
      await Promise.allSettled(
        nonBuiltInDiscovered.map(async (agent) => {
          await this.registerAgent(agent);
        }),
      );
    });
  }

  /**
   * Runs `fn` with `_target` pointing to a fresh buffer.
   * After `fn` completes, the buffer is atomically swapped into the live
   * instance fields; on error the live state is left untouched.
   */
  private async _withBuffer(
    fn: (buffer: typeof this._target) => Promise<void>,
  ): Promise<void> {
    const buffer: typeof this._target = {
      agents: new Map<string, RegistryAgentDefinition>(),
      allDefinitions: new Map<string, RegistryAgentDefinition>(),
      discoveredList: [],
      loadErrors: [],
    };
    const prevTarget = this._target;
    this._target = buffer; // 二者指向同一个变量，在执行 fn 期间，修改 this._target 会映射到 buffer
    try {
      await fn(buffer);
      this._applySnapshot(buffer);
    } finally {
      this._target = prevTarget;
    }
  }

  /** Atomically swap buffer contents into live fields. */
  private _applySnapshot(snapshot: typeof this._target): void {
    this.agents.clear();
    for (const [k, v] of snapshot.agents) this.agents.set(k, v);

    this.allDefinitions.clear();
    for (const [k, v] of snapshot.allDefinitions) this.allDefinitions.set(k, v);

    this.discoveredList.length = 0;
    for (const item of snapshot.discoveredList) this.discoveredList.push(item);

    this.loadErrors.length = 0;
    for (const item of snapshot.loadErrors) this.loadErrors.push(item);
  }

  /**
   * Registers an agent definition. If an agent with the same name exists,
   * it will be overwritten, respecting the precedence established by the
   * initialization order.
   */
  protected async registerAgent<TOutput extends z.ZodTypeAny>(
    definition: AgentDefinition<TOutput>,
  ): Promise<boolean> {
    return this.registerLocalAgent(definition);
  }

  /**
   * Registers a local agent definition synchronously.
   */
  protected async registerLocalAgent<TOutput extends z.ZodTypeAny>(
    definition: AgentDefinition<TOutput>,
  ): Promise<boolean> {
    const target = this._target;
    const identity = this.config.getModelRequestIdentity();
    // Basic validation
    if (!definition.name || !definition.description) {
      runLogger.warn(
        `[AgentRegistry] Skipping invalid agent definition. Missing name or description.`,
      );
      return false;
    }

    target.allDefinitions.set(definition.name, definition);
    target.discoveredList.push(definition);

    const settingsOverrides =
      this.config.getAgentsSettings().overrides?.[definition.name];

    if (!this.isAgentEnabled(definition, settingsOverrides)) {
      if (this.config.getDebugMode()) {
        runLogger.log(
          `[AgentRegistry] Skipping disabled agent '${definition.name}'`,
        );
      }
      return false;
    }

    if (target.agents.has(definition.name) && this.config.getDebugMode()) {
      runLogger.log(`[AgentRegistry] Overriding agent '${definition.name}'`);
    }

    const mergedDefinition = this.applyOverrides(definition, settingsOverrides);
    const resolvedDefinition = this.resolveReasoning(mergedDefinition);
    const modelEffortError =
      await this.validateConfiguredModelEffort(resolvedDefinition);
    if (
      identity !== this.config.getModelRequestIdentity() ||
      target.allDefinitions.get(definition.name) !== definition
    )
      return false;
    if (modelEffortError) {
      const loadError: ConfigLoadError = {
        name: resolvedDefinition.name,
        filePath: resolvedDefinition.metadata?.filePath ?? 'local agent',
        message: `${MODEL_EFFORT_LOAD_ERROR_PREFIX} ${modelEffortError}`,
        configType: 'agent',
        source: resolvedDefinition.metadata?.source ?? 'unknown',
      };
      target.loadErrors.push(loadError);
      runLogger.warn(
        `[AgentRegistry] ${loadError.message} Agent "${resolvedDefinition.name}" was not registered.`,
      );
      return false;
    }

    target.agents.set(resolvedDefinition.name, resolvedDefinition);
    return true;
  }

  private async validateConfiguredModelEffort<TOutput extends z.ZodTypeAny>(
    definition: LocalAgentDefinition<TOutput>,
  ): Promise<string | undefined> {
    const configuredModel = definition.modelConfig.model?.trim();
    if (
      definition.effort === undefined ||
      !configuredModel ||
      configuredModel === 'inherit'
    ) {
      return undefined;
    }

    const reasoningEffort =
      definition[RESOLVED_AGENT_REASONING]?.reasoningEffort;
    if (reasoningEffort === undefined) {
      return `could not resolve configured effort for model "${configuredModel}".`;
    }

    const manager = this.config.getModelProviderManager();
    let model: Model | undefined;
    try {
      model = await resolveConfiguredAgentModel(manager, configuredModel);
    } catch (error) {
      if (error instanceof ModelNotFoundError) return error.message;
      throw error;
    }
    if (!model) {
      // Nothing listed yet: the model list is still loading.
      if ((await manager.listModels()).length === 0) {
        return undefined;
      }
      return `configured model "${configuredModel}" was not found in the current model list.`;
    }

    const effortLabel = formatEffortForError(reasoningEffort);
    if (model.enabled === false) {
      return `configured model "${configuredModel}" is disabled and cannot use effort "${effortLabel}".`;
    }

    const supportedEfforts = model.capabilities.reasoning.supportedEfforts;
    if (supportedEfforts.length === 0) {
      return `configured model "${configuredModel}" does not support configurable reasoning effort.`;
    }
    if (!supportedEfforts.includes(reasoningEffort)) {
      return (
        `configured model "${configuredModel}" does not support effort "${effortLabel}". ` +
        `Supported efforts: ${supportedEfforts.map(formatEffortForError).join(', ')}.`
      );
    }

    return undefined;
  }

  private isAgentEnabled<TOutput extends z.ZodTypeAny>(
    definition: AgentDefinition<TOutput>,
    overrides?: AgentOverride,
  ): boolean {
    const isExperimental = definition.experimental === true;
    let isEnabled = !isExperimental;

    if (overrides && overrides.enabled !== undefined) {
      isEnabled = overrides.enabled;
    }

    return isEnabled;
  }

  private applyOverrides<TOutput extends z.ZodTypeAny>(
    definition: LocalAgentDefinition<TOutput>,
    overrides?: AgentOverride,
  ): LocalAgentDefinition<TOutput> {
    if (!overrides) {
      return definition;
    }

    const mcpOverrideSpecs: AgentMcpServerSpec[] | undefined =
      overrides.mcpServers
        ? Object.entries(overrides.mcpServers).map(([name, config]) => ({
            [name]: config,
          }))
        : undefined;

    // Preserve getter descriptors (e.g. lazy toolConfig) from the original
    // definition while applying specific overrides as plain value properties.
    const overrideValues: Partial<LocalAgentDefinition<TOutput>> = {
      ...(overrides.runConfig && {
        runConfig: { ...definition.runConfig, ...overrides.runConfig },
      }),
      ...(overrides.modelConfig && {
        modelConfig: mergeAgentModelConfig(
          definition.modelConfig,
          overrides.modelConfig,
        ),
      }),
      ...(overrides.tools && { toolConfig: { tools: overrides.tools } }),
      ...(mcpOverrideSpecs && {
        mcpServers: [...(definition.mcpServers ?? []), ...mcpOverrideSpecs],
      }),
    };

    return Object.defineProperties({} as LocalAgentDefinition<TOutput>, {
      ...Object.getOwnPropertyDescriptors(definition),
      ...Object.getOwnPropertyDescriptors(overrideValues),
    });
  }

  private resolveReasoning<TOutput extends z.ZodTypeAny>(
    definition: LocalAgentDefinition<TOutput>,
  ): LocalAgentDefinition<TOutput> {
    const configuredThinkingBudget =
      definition.modelConfig.generateContentConfig?.thinkingConfig
        ?.thinkingBudget;
    const resolvedReasoning = resolveAgentReasoning(
      definition.effort,
      configuredThinkingBudget,
    );
    if (!resolvedReasoning) {
      return definition;
    }

    // Materialize a frontmatter-derived budget only after all configuration
    // sources have been resolved. This keeps main-thread agent model aliases
    // compatible while preserving the source distinction during loading.
    const modelConfig =
      configuredThinkingBudget === undefined
        ? mergeAgentModelConfig(definition.modelConfig, {
            generateContentConfig: {
              thinkingConfig: {
                thinkingBudget: resolvedReasoning.thinkingBudget,
              },
            },
          })
        : definition.modelConfig;

    return Object.defineProperties({} as LocalAgentDefinition<TOutput>, {
      ...Object.getOwnPropertyDescriptors(definition),
      ...Object.getOwnPropertyDescriptors({
        modelConfig,
      }),
      // An enumerable Symbol survives immutable object spreads in execution
      // code but does not leak into JSON or management UI payloads.
      [RESOLVED_AGENT_REASONING]: {
        value: resolvedReasoning,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    });
  }

  /**
   * Retrieves an agent definition by name.
   */
  getDefinition(name: string): RegistryAgentDefinition | undefined {
    return this.agents.get(name);
  }

  /**
   * Returns all active agent definitions.
   */
  getAllDefinitions(): RegistryAgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * Returns `{ name, description }` for every active agent.
   *
   * Satisfies `AttachmentExternalContext.agentRegistry` structurally, so hosts
   * can pass the registry itself instead of re-deriving this projection.
   */
  getAgentListing(modelId?: string): AgentListingEntry[] {
    const bundle = resolvePromptBundleForModel(modelId);
    return this.getAllDefinitions().map(
      ({ name, description, descriptionLean }) => ({
        name,
        description:
          bundle === 'lean' && descriptionLean ? descriptionLean : description,
      }),
    );
  }

  /**
   * Returns a list of all registered agent names.
   */
  getAllAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Returns a list of all discovered agent names, regardless of whether they are enabled.
   */
  getAllDiscoveredAgentNames(): string[] {
    return Array.from(this.allDefinitions.keys());
  }

  /**
   * Retrieves a discovered agent definition by name.
   */
  getDiscoveredDefinition(name: string): RegistryAgentDefinition | undefined {
    return this.allDefinitions.get(name);
  }

  /**
   * Returns all discovered agent definitions including shadowed duplicates.
   * When multiple sources define an agent with the same name, all versions
   * are returned so callers can display shadowed entries.
   */
  getAllDiscoveredDefinitions(): RegistryAgentDefinition[] {
    return [...this.discoveredList];
  }

  /**
   * Tags an agent definition with a source identifier.
   */
  static tagSource<TOutput extends z.ZodTypeAny>(
    def: AgentDefinition<TOutput>,
    source: AgentSource,
  ): AgentDefinition<TOutput> {
    if (!def.metadata) {
      def.metadata = {};
    }
    def.metadata.source = source;
    return def;
  }

  /**
   * Single entry point for plugin-shipped agents: drops unsafe frontmatter
   * fields, then tags the source. Keeping these two steps in one helper makes
   * "plugin agent" the only place that knows the policy exists.
   */
  static applyPluginAgentPolicy(def: AgentDefinition): void {
    stripUnsafePluginFields(def);
    AgentRegistry.tagSource(def, 'plugin');
  }

  /**
   * Inline-substitute branded plugin root/data variables (and the
   * `${CLAUDE_*}` aliases) in a plugin agent's system prompt so the agent can
   * reference files bundled with its plugin.
   */
  static applyPluginAgentContentSubstitution(
    def: AgentDefinition,
    pluginRoot: string,
    pluginId: string,
  ): void {
    const systemPrompt = def.promptConfig?.systemPrompt;
    if (!systemPrompt || !pluginRoot) return;
    def.promptConfig.systemPrompt = substitutePluginVariables(systemPrompt, {
      path: pluginRoot,
      pluginId,
    });
  }

  /**
   * Register agent definitions received from the SDK via the initialize
   * control_request. Tagged source='flag' (same as --agents CLI flag).
   *
   * Uses incremental registration (not _withBuffer) which is safe because
   * this runs during handleInitialize before any query/turn starts.
   * Per-agent try/catch isolates failures. Emits AgentsRefreshed after
   * successful registrations to trigger AgentTool description refresh.
   */
  async registerSdkAgents(defs: AgentDefinition[]): Promise<{
    registered: string[];
    failed: Array<{ name?: string; error: string }>;
  }> {
    const registered: string[] = [];
    const failed: Array<{ name?: string; error: string }> = [];

    for (const def of defs) {
      try {
        AgentRegistry.tagSource(def, 'flag');
        const didRegister = await this.registerAgent(def);
        // Record only after registration completes without throwing. A false
        // result can still be a discovered definition (disabled or awaiting a
        // compatible model), which must survive reload for later revalidation.
        if (def.name && def.description) {
          this.sdkInjectedAgents.push(def);
        }
        if (didRegister) {
          registered.push(def.name);
        } else {
          const loadError = [...this.loadErrors]
            .reverse()
            .find((error) => error.name === def.name);
          failed.push({
            name: def.name,
            error: loadError?.message ?? 'Agent was not registered.',
          });
        }
      } catch (e) {
        failed.push({
          name: def.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (registered.length > 0) {
      coreEvents.emitAgentsRefreshed(this.config.getSessionId());
    }

    if (this.config.getDebugMode()) {
      runLogger.log(
        `[AgentRegistry] SDK agents: registered=[${registered.join(', ')}]` +
          (failed.length > 0
            ? ` failed=[${failed.map((f) => f.name ?? '?').join(', ')}]`
            : ''),
      );
    }

    return { registered, failed };
  }
}
