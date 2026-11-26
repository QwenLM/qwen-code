/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createHookConfigurationRef,
  getPluginHookRef,
} from './hookConfigurationRef.js';
import type { HookDiagnostic } from './hookDiagnostics.js';

import type { BuiltinHookDefinition } from '../builtin-plugins/types.js';
import type { Config } from '../config/config.js';
import {
  HookEventName,
  HookType,
  isHookEventName,
  ConfigSource,
  HOOKS_CONFIG_FIELDS,
  getHookDisplayText,
  type CommandHookConfig,
  type HookAction,
  type HookDefinition,
  type HookConfig,
  type RuntimeHookConfig,
} from './types.js';
import { buildPluginId } from '../plugins/pluginIdentifier.js';
import { getGoalHooksConfiguration } from '../goal/registerGoalHooks.js';
import { runLogger } from '../utils/runLogger.js';
import { coreEvents } from '../utils/events.js';
import {
  emitLoadErrorSummary,
  type ConfigLoadError,
} from '../utils/configLoadError.js';

/**
 * Hook registry entry with source information
 */
export interface HookRegistryEntry {
  config: HookConfig;
  source: ConfigSource;
  eventName: HookEventName;
  matcher?: string;
  sequential?: boolean;
  /** When true, this hook runs in the background without blocking */
  async?: boolean;
  enabled: boolean;
}

function toBuiltinHookConfig(
  contribution: BuiltinHookDefinition,
): HookConfig | string {
  const hook = contribution as {
    type?: unknown;
    command?: unknown;
    name?: unknown;
    action?: unknown;
    timeout?: unknown;
    async?: unknown;
    statusMessage?: unknown;
    env?: unknown;
    if?: unknown;
    args?: unknown;
    shell?: unknown;
    once?: unknown;
    asyncRewake?: unknown;
    rewakeMessage?: unknown;
    rewakeSummary?: unknown;
    runAfterCancellation?: unknown;
  };

  if (hook.type === 'runtime') {
    if (hook.command !== undefined) {
      return 'Runtime hook cannot define command';
    }
    if (typeof hook.name !== 'string' || !hook.name) {
      return 'Runtime hook missing name field';
    }
    if (typeof hook.action !== 'function') {
      return 'Runtime hook missing action function';
    }
    const internal =
      'internal' in contribution && contribution.internal === true;
    const runAfterCancellation = hook.runAfterCancellation;
    if (
      runAfterCancellation !== undefined &&
      runAfterCancellation !== 'completed-file-write'
    ) {
      return 'Runtime hook has invalid runAfterCancellation value';
    }
    if (
      runAfterCancellation === 'completed-file-write' &&
      contribution.event !== HookEventName.PostToolUse
    ) {
      return 'Runtime hook runAfterCancellation requires PostToolUse';
    }
    return {
      type: HookType.Runtime,
      name: hook.name,
      action: hook.action as HookAction,
      ...(internal ? { internal: true } : {}),
      ...(runAfterCancellation === 'completed-file-write'
        ? { runAfterCancellation }
        : {}),
      ...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {}),
      ...(typeof hook.statusMessage === 'string'
        ? { statusMessage: hook.statusMessage }
        : {}),
    } satisfies RuntimeHookConfig;
  }

  if (hook.type !== undefined && hook.type !== 'command') {
    return `Unsupported builtin hook type: ${String(hook.type)}`;
  }
  if (typeof hook.command !== 'string' || !hook.command) {
    return 'Command hook missing command field';
  }
  if (hook.action !== undefined) {
    return 'Command hook cannot define action';
  }
  if (
    hook.env !== undefined &&
    typeof hook.env !== 'function' &&
    (!hook.env || typeof hook.env !== 'object' || Array.isArray(hook.env))
  ) {
    return 'Command hook env must be an object or function';
  }

  return {
    type: HookType.Command,
    command: hook.command,
    ...(hook.if !== undefined ? { if: hook.if as string } : {}),
    ...(hook.args !== undefined ? { args: hook.args as string[] } : {}),
    ...(hook.shell !== undefined
      ? { shell: hook.shell as 'bash' | 'powershell' }
      : {}),
    ...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {}),
    ...(typeof hook.async === 'boolean' ? { async: hook.async } : {}),
    ...(typeof hook.once === 'boolean' ? { once: hook.once } : {}),
    ...(typeof hook.asyncRewake === 'boolean'
      ? { asyncRewake: hook.asyncRewake }
      : {}),
    ...(hook.rewakeMessage !== undefined
      ? { rewakeMessage: hook.rewakeMessage as string }
      : {}),
    ...(hook.rewakeSummary !== undefined
      ? { rewakeSummary: hook.rewakeSummary as string }
      : {}),
    ...(typeof hook.statusMessage === 'string'
      ? { statusMessage: hook.statusMessage }
      : {}),
    ...(hook.env !== undefined
      ? { env: hook.env as CommandHookConfig['env'] }
      : {}),
  } satisfies CommandHookConfig;
}

/**
 * Hook registry that loads and validates hook definitions from multiple sources
 */
export class HookRegistry {
  private readonly config: Config;
  private entries: HookRegistryEntry[] = [];
  /** Per-agent session hooks, keyed by agentId. Cleared when the agent finishes. */
  private sessionHooks: Map<string, HookRegistryEntry[]> = new Map();
  /** Errors accumulated during the most recent initialize() call */
  private loadErrors: Array<
    ConfigLoadError & {
      diagnostic: HookDiagnostic;
      target?: {
        source: ConfigSource;
        event: string;
        groupIndex: number;
        hookIndex: number;
      };
    }
  > = [];

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Get load errors collected during the most recent initialize() call.
   */
  getLoadErrors(): readonly ConfigLoadError[] {
    return this.loadErrors.map(
      ({ diagnostic: _diagnostic, target: _target, ...error }) => error,
    );
  }

  getDiagnostics(
    resolveReference?: (
      source: ConfigSource,
      event: string,
      groupIndex: number,
      hookIndex: number,
    ) => string | undefined,
  ): HookDiagnostic[] {
    return this.loadErrors.map(({ diagnostic, target }) => ({
      ...diagnostic,
      ...(target && resolveReference
        ? {
            hook_ref:
              resolveReference(
                target.source,
                target.event,
                target.groupIndex,
                target.hookIndex,
              ) ?? diagnostic.hook_ref,
          }
        : {}),
    }));
  }

  /**
   * Register a new hook programmatically
   */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean; source?: ConfigSource },
  ): void {
    const source = options?.source ?? ConfigSource.Runtime;

    const validationError = this.validateHookConfig(config, eventName, source);
    if (validationError !== null) {
      throw new Error(
        `Invalid hook configuration for ${eventName} from ${source}: ${validationError}`,
      );
    }

    this.entries.push({
      config,
      source,
      eventName,
      matcher: options?.matcher,
      sequential: options?.sequential,
      enabled: true,
    });
  }

  /**
   * Initialize the registry by processing hooks from config
   */
  async initialize(opts: { emitToFeed?: boolean } = {}): Promise<void> {
    const { emitToFeed = true } = opts;
    const runtimeHooks = this.entries.filter(
      (entry) => entry.source === ConfigSource.Runtime,
    );
    this.entries = [...runtimeHooks];
    this.loadErrors = [];
    this.processHooksFromConfig();

    // Emit a summarized feed-stream warning for any load errors (only on initial load)
    if (emitToFeed) {
      emitLoadErrorSummary(this.loadErrors, 'hook', (severity, message) =>
        coreEvents.emitFeedback(severity, message),
      );
    }

    runLogger.debug(
      `Hook registry initialized with ${this.entries.length} hook entries`,
    );
  }

  /**
   * Get all hook entries for a specific event
   */
  getHooksForEvent(eventName: HookEventName): HookRegistryEntry[] {
    return this.entries
      .filter((entry) => entry.eventName === eventName && entry.enabled)
      .sort(
        (a, b) =>
          this.getSourcePriority(a.source) - this.getSourcePriority(b.source),
      );
  }

  /**
   * Get all registered hooks
   */
  getAllHooks(): HookRegistryEntry[] {
    return [...this.entries];
  }

  /**
   * Remove entries matching the given hook name from the in-memory registry.
   * Returns the number of entries removed.
   */
  removeEntry(hookName: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (entry) => getHookDisplayText(entry.config) !== hookName,
    );
    const removed = before - this.entries.length;

    if (removed > 0) {
      runLogger.log(
        `Removed ${removed} hook entry(ies) matching "${hookName}"`,
      );
    } else {
      runLogger.warn(`No hooks found matching "${hookName}" for removal`);
    }

    return removed;
  }

  /**
   * Register a session-scoped hook for a specific agent.
   * Session hooks are active only while the agent is running and are
   * cleared via {@link clearSessionHooks} when the agent finishes.
   */
  registerSessionHook(
    agentId: string,
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean },
  ): void {
    const entry: HookRegistryEntry = {
      config,
      source: ConfigSource.Runtime,
      eventName,
      matcher: options?.matcher,
      sequential: options?.sequential,
      enabled: true,
    };
    const existing = this.sessionHooks.get(agentId) || [];
    existing.push(entry);
    this.sessionHooks.set(agentId, existing);

    runLogger.debug(
      `Registered session hook for agent "${agentId}" on event "${eventName}"`,
    );
  }

  /**
   * Remove all session hooks registered for the given agent.
   */
  clearSessionHooks(agentId: string): void {
    const count = this.sessionHooks.get(agentId)?.length ?? 0;
    this.sessionHooks.delete(agentId);
    if (count > 0) {
      runLogger.debug(
        `Cleared ${count} session hook(s) for agent "${agentId}"`,
      );
    }
  }

  /**
   * Remove a specific session hook entry for the given agent.
   * Used by the `once` mechanism to remove a hook after its first execution.
   * Returns true if a hook was found and removed.
   */
  removeSessionHook(agentId: string, config: HookConfig): boolean {
    const entries = this.sessionHooks.get(agentId);
    if (!entries) return false;

    const idx = entries.findIndex((e) => e.config === config);
    if (idx === -1) return false;

    const removed = entries[idx];
    entries.splice(idx, 1);
    runLogger.debug(
      `Removed once-hook for agent "${agentId}" on event "${removed.eventName}"`,
    );
    return true;
  }

  /**
   * Remove session hook entries matching the given config (by reference)
   * across all inline skill buckets ("skill:<name>", without ":fork").
   *
   * Inline skill hooks fire in the main agent context, which carries no
   * agentId, so the `once` mechanism cannot address them through
   * {@link removeSessionHook}. This method covers that case.
   * Returns true if at least one entry was removed.
   */
  removeInlineSkillSessionHooks(config: HookConfig): boolean {
    let removed = false;
    for (const [id, entries] of this.sessionHooks) {
      if (!id.startsWith('skill:') || id.endsWith(':fork')) continue;

      const before = entries.length;
      const remaining = entries.filter((e) => e.config !== config);
      if (remaining.length === before) continue;

      removed = true;
      if (remaining.length === 0) {
        this.sessionHooks.delete(id);
      } else {
        this.sessionHooks.set(id, remaining);
      }
      runLogger.debug(
        `Removed ${before - remaining.length} once-hook(s) for "${id}"`,
      );
    }
    return removed;
  }

  /**
   * Get session hooks for a specific agent and event.
   */
  getSessionHooksForEvent(
    agentId: string,
    eventName: HookEventName,
  ): HookRegistryEntry[] {
    return (this.sessionHooks.get(agentId) || []).filter(
      (e) => e.eventName === eventName && e.enabled,
    );
  }

  /**
   * Get session hooks from all active inline skills for a given event.
   * Inline skill hooks are registered under "skill:<name>" (without ":fork").
   * Called by the planner when the main agent (no agentId) executes tools.
   */
  getInlineSkillSessionHooksForEvent(
    eventName: HookEventName,
  ): HookRegistryEntry[] {
    const results: HookRegistryEntry[] = [];
    for (const [id, entries] of this.sessionHooks) {
      if (id.startsWith('skill:') && !id.endsWith(':fork')) {
        for (const e of entries) {
          if (e.eventName === eventName && e.enabled) {
            results.push(e);
          }
        }
      }
    }
    return results;
  }

  /**
   * Process hooks from the config that was already loaded by the CLI.
   * Each source (project, local, user, extensions) is processed separately
   * to preserve the correct ConfigSource tagging.
   */
  private processHooksFromConfig(): void {
    // 1) Project hooks (workspace settings.json)
    this.loadHooksFromSource(
      this.config.getProjectHooks(),
      ConfigSource.Project,
      true,
    );

    // 2) Local hooks (workspace settings.local.json)
    this.loadHooksFromSource(
      this.config.getLocalHooks(),
      ConfigSource.Local,
      true,
    );

    // 3) User hooks (user settings)
    this.loadHooksFromSource(
      this.config.getUserHooks(),
      ConfigSource.User,
      false,
    );

    // 4) Flag hooks (--settings CLI flag)
    this.loadHooksFromSource(
      this.config.getFlagHooks(),
      ConfigSource.Flag,
      false, // requiresTrust = false: user explicitly opted in via --settings
    );

    // 5) Plugin hooks
    if (!this.config.isSettingSourceAllowed('plugin')) {
      runLogger.log(
        'Plugin hooks skipped: source "plugin" not in --setting-sources',
      );
    } else {
      const plugins = this.config.getEnabledPlugins();
      for (const plugin of plugins) {
        if (plugin.hooksConfig) {
          this.processHooksConfiguration(
            plugin.hooksConfig,
            ConfigSource.Plugins,
            {
              pluginRoot: plugin.path,
              pluginId: buildPluginId(plugin.name, plugin.source),
            },
          );
        }
      }
    }

    // 6) Goal-loop runtime hooks (first-party, always mounted; the hook
    //    itself no-ops when no goal exists on disk)
    this.processHooksConfiguration(
      getGoalHooksConfiguration(this.config) ?? {},
      ConfigSource.System,
    );

    const builtinContributions = this.config.getBuiltinPluginContributions();
    const contributionContext = {
      getSettings: () => this.config.getSettings(),
    };
    for (const contribution of builtinContributions?.isReady()
      ? builtinContributions.getHooks(contributionContext)
      : []) {
      const { event, matcher, sequential, pluginRoot, pluginId } = contribution;
      if (!isHookEventName(event)) {
        runLogger.warn(`[builtin-plugins] Unsupported hook event: ${event}`);
        continue;
      }
      const hookConfig = toBuiltinHookConfig(contribution);
      if (typeof hookConfig === 'string') {
        runLogger.warn(
          `[builtin-plugins] Invalid hook for ${event}: ${hookConfig}`,
        );
        continue;
      }
      this.processHooksConfiguration(
        {
          [event]: [
            {
              matcher,
              sequential,
              hooks: [
                hookConfig.type === HookType.Command
                  ? { ...hookConfig, builtinPlugin: true }
                  : hookConfig,
              ],
            },
          ],
        },
        ConfigSource.System,
        pluginRoot && pluginId ? { pluginRoot, pluginId } : undefined,
      );
    }
  }

  /**
   * Loads hooks from a single config source, applying --setting-sources
   * filtering and folder trust checks.
   */
  private loadHooksFromSource(
    hooks: { [K in HookEventName]?: HookDefinition[] } | undefined,
    source: ConfigSource,
    requiresTrust: boolean,
  ): void {
    if (!hooks) return;
    const label = source.charAt(0).toUpperCase() + source.slice(1);
    if (!this.config.isSettingSourceAllowed(source)) {
      runLogger.log(`${label} hooks skipped: not in --setting-sources`);
      return;
    }
    if (requiresTrust && !this.config.isTrustedFolder()) {
      runLogger.warn(
        `${label} hooks disabled because the folder is not trusted.`,
      );
      return;
    }
    this.processHooksConfiguration(hooks, source);
  }

  /**
   * Process hooks configuration and add entries
   */
  private processHooksConfiguration(
    hooksConfig: { [K in HookEventName]?: HookDefinition[] },
    source: ConfigSource,
    pluginContext?: { pluginRoot: string; pluginId: string },
  ): void {
    for (const [eventName, definitions] of Object.entries(hooksConfig)) {
      if (HOOKS_CONFIG_FIELDS.includes(eventName)) {
        continue;
      }

      if (!this.isValidEventName(eventName)) {
        const msg = `Invalid hook event name: "${eventName}" from ${source} config. Skipping.`;
        this.loadErrors.push({
          filePath: `${source} config`,
          message: msg,
          diagnostic: {
            code: 'hook_validation_error',
            event: eventName,
            message: 'Invalid hook event name.',
          },
          configType: 'hook',
          source,
        });
        continue;
      }

      const typedEventName = eventName;

      if (!Array.isArray(definitions)) {
        const msg = `Hook definitions for event "${eventName}" from source "${source}" is not an array. Skipping.`;
        this.loadErrors.push({
          filePath: `${source} config`,
          message: msg,
          diagnostic: {
            code: 'hook_validation_error',
            event: eventName,
            message: 'Hook definitions must be an array.',
          },
          configType: 'hook',
          source,
        });
        continue;
      }

      for (const [groupIndex, definition] of definitions.entries()) {
        this.processHookDefinition(
          definition,
          typedEventName,
          source,
          groupIndex,
          pluginContext,
        );
      }
    }
  }

  /**
   * Process a single hook definition
   */
  private processHookDefinition(
    definition: HookDefinition,
    eventName: HookEventName,
    source: ConfigSource,
    groupIndex: number,
    pluginContext?: { pluginRoot: string; pluginId: string },
  ): void {
    if (
      !definition ||
      typeof definition !== 'object' ||
      !Array.isArray(definition.hooks)
    ) {
      const msg = `Discarding invalid hook definition for ${eventName} from ${source}: missing or invalid "hooks" array.`;
      this.loadErrors.push({
        filePath: `${source} config`,
        message: msg,
        diagnostic: {
          code: 'hook_validation_error',
          event: eventName,
          field: 'hooks',
          message: 'Missing or invalid hooks array.',
        },
        configType: 'hook',
        source,
      });
      return;
    }

    for (const [hookIndex, hookConfig] of definition.hooks.entries()) {
      if (
        hookConfig &&
        typeof hookConfig === 'object' &&
        this.validateHookConfig(hookConfig, eventName, source) === null
      ) {
        // Add source to hook config
        hookConfig.source = source;

        // Inject plugin context into command hooks so it flows through
        // planner → executor → runner without changing intermediate signatures.
        if (pluginContext && hookConfig.type === 'command') {
          hookConfig.pluginRoot = pluginContext.pluginRoot;
          hookConfig.pluginId = pluginContext.pluginId;
        }

        // Per-hook async override takes precedence over definition-level async.
        // Only CommandHookConfig has the per-hook `async` field.
        const perHookAsync =
          hookConfig.type === 'command' ? hookConfig.async : undefined;
        const effectiveAsync = perHookAsync ?? definition.async;

        this.entries.push({
          config: hookConfig,
          source,
          eventName,
          matcher: definition.matcher,
          sequential: definition.sequential,
          async: effectiveAsync,
          enabled: true,
        });
      } else {
        // Invalid hooks are logged and discarded here, they won't reach HookRunner
        const reason =
          hookConfig && typeof hookConfig === 'object'
            ? this.validateHookConfig(hookConfig, eventName, source)
            : null;
        const msg = reason
          ? `Discarding invalid hook for ${eventName} from ${source}: ${reason}`
          : `Discarding invalid hook configuration for ${eventName} from ${source}.`;
        this.loadErrors.push({
          filePath: `${source} config`,
          message: msg,
          target: { source, event: eventName, groupIndex, hookIndex },
          diagnostic: {
            code: 'hook_validation_error',
            event: eventName,
            hook_ref:
              source === ConfigSource.Plugins
                ? getPluginHookRef(definition, hookIndex)
                : createHookConfigurationRef(
                    `settings:${source}`,
                    eventName,
                    groupIndex,
                    hookIndex,
                    hookConfig,
                  ),
            message: reason?.startsWith('Invalid hook type:')
              ? 'Invalid hook type.'
              : (reason ?? 'Invalid hook configuration.'),
          },
          configType: 'hook',
          source,
        });
      }
    }
  }

  /**
   * Validate a hook configuration.
   * Returns null if valid, or a string describing the validation error.
   */
  private validateHookConfig(
    config: HookConfig,
    _eventName: HookEventName,
    _source: ConfigSource,
  ): string | null {
    if (
      !config.type ||
      !Object.values(HookType).includes(config.type as HookType)
    ) {
      return `Invalid hook type: ${config.type}`;
    }

    if (config.type === 'command' && !config.command) {
      return `Command hook missing command field`;
    }

    if (config.type === 'command' && config.args !== undefined) {
      if (!Array.isArray(config.args)) {
        return `Command hook 'args' must be an array of strings`;
      }
      for (const arg of config.args) {
        if (typeof arg !== 'string') {
          return `Command hook 'args' must contain only strings`;
        }
      }
    }

    if (config.type === 'runtime' && !config.name) {
      return `Runtime hook missing name field`;
    }

    if (config.type === 'http' && !config.url) {
      return `HTTP hook missing url field`;
    }

    if (
      (config.type === 'prompt' || config.type === 'agent') &&
      !config.prompt
    ) {
      const label = config.type === 'prompt' ? 'Prompt' : 'Agent';
      return `${label} hook missing prompt field`;
    }

    return null;
  }

  /**
   * Check if an event name is valid
   */
  private isValidEventName(eventName: string): eventName is HookEventName {
    const validEventNames = Object.values(HookEventName);

    return validEventNames.includes(eventName as HookEventName);
  }

  /**
   * Get source priority (lower number = higher priority)
   */
  private getSourcePriority(source: ConfigSource): number {
    switch (source) {
      case ConfigSource.Runtime:
        return 0; // Highest
      case ConfigSource.Flag:
        return 0.5;
      case ConfigSource.Project:
        return 1;
      case ConfigSource.Local:
        return 1.5;
      case ConfigSource.User:
        return 2;
      case ConfigSource.System:
        return 3;
      case ConfigSource.Plugins:
        return 4;
      default:
        return 999;
    }
  }
}
