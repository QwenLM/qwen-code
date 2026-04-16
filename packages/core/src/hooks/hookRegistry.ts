/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookDefinition, HookConfig } from './types.js';
import {
  HookEventName,
  HooksConfigSource,
  HOOKS_CONFIG_FIELDS,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('HOOK_REGISTRY');

/**
 * Extension with hooks support
 */
export interface ExtensionWithHooks {
  isActive: boolean;
  hooks?: { [K in HookEventName]?: HookDefinition[] };
}

/**
 * Configuration interface for HookRegistry
 * This abstracts the Config dependency to make the registry more flexible
 */
export interface HookRegistryConfig {
  getProjectRoot(): string;
  isTrustedFolder(): boolean;
  getUserHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined;
  getProjectHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined;
  getExtensions(): ExtensionWithHooks[];
}

/**
 * Feedback emitter interface for warning/info messages
 */
export interface FeedbackEmitter {
  emitFeedback(type: 'warning' | 'info' | 'error', message: string): void;
}

/**
 * Hook registry entry with source information
 */
export interface HookRegistryEntry {
  config: HookConfig;
  source: HooksConfigSource;
  eventName: HookEventName;
  matcher?: string;
  sequential?: boolean;
  enabled: boolean;
}

/**
 * Hook registry that loads and validates hook definitions from multiple sources
 */
export class HookRegistry {
  private readonly config: HookRegistryConfig;
  private readonly feedbackEmitter?: FeedbackEmitter;
  private entries: HookRegistryEntry[] = [];

  constructor(config: HookRegistryConfig, feedbackEmitter?: FeedbackEmitter) {
    this.config = config;
    this.feedbackEmitter = feedbackEmitter;
  }

  /**
   * Initialize the registry by processing hooks from config
   */
  async initialize(): Promise<void> {
    this.entries = [];
    this.processHooksFromConfig();

    debugLogger.debug(
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
   * Enable or disable a specific hook
   */
  setHookEnabled(hookName: string, enabled: boolean): void {
    const updated = this.entries.filter((entry) => {
      const name = this.getHookName(entry);
      if (name === hookName) {
        entry.enabled = enabled;
        return true;
      }
      return false;
    });

    if (updated.length > 0) {
      debugLogger.info(
        `${enabled ? 'Enabled' : 'Disabled'} ${updated.length} hook(s) matching "${hookName}"`,
      );
    } else {
      debugLogger.warn(`No hooks found matching "${hookName}"`);
    }
  }

  /**
   * Get hook name for identification and display purposes
   */
  private getHookName(
    entry: HookRegistryEntry | { config: HookConfig },
  ): string {
    const config = entry.config;
    if (config.name) return config.name;
    if (config.type === 'command')
      return (config as { command?: string }).command || 'unknown-command';
    if (config.type === 'http')
      return (config as { url?: string }).url || 'unknown-url';
    if (config.type === 'function')
      return (config as { id?: string }).id || 'unknown-function';
    return 'unknown-hook';
  }

  /**
   * Process hooks from the config that was already loaded by the CLI
   */
  private processHooksFromConfig(): void {
    // Load user hooks (always available, regardless of folder trust)
    const userHooks = this.config.getUserHooks();
    if (userHooks) {
      this.processHooksConfiguration(userHooks, HooksConfigSource.User);
    }

    // Load project hooks (only in trusted folders)
    // The config.getProjectHooks() already checks trust status internally
    const projectHooks = this.config.getProjectHooks();
    if (projectHooks) {
      this.processHooksConfiguration(projectHooks, HooksConfigSource.Project);
    }

    // Extension hooks are always loaded
    const extensions = this.config.getExtensions() || [];
    for (const extension of extensions) {
      if (extension.isActive && extension.hooks) {
        this.processHooksConfiguration(
          extension.hooks,
          HooksConfigSource.Extensions,
        );
      }
    }
  }

  /**
   * Process hooks configuration and add entries
   */
  private processHooksConfiguration(
    hooksConfig: { [K in HookEventName]?: HookDefinition[] },
    source: HooksConfigSource,
  ): void {
    for (const [eventName, definitions] of Object.entries(hooksConfig)) {
      if (HOOKS_CONFIG_FIELDS.includes(eventName)) {
        continue;
      }

      if (!this.isValidEventName(eventName)) {
        this.feedbackEmitter?.emitFeedback(
          'warning',
          `Invalid hook event name: "${eventName}" from ${source} config. Skipping.`,
        );
        continue;
      }

      const typedEventName = eventName;

      if (!Array.isArray(definitions)) {
        debugLogger.warn(
          `Hook definitions for event "${eventName}" from source "${source}" is not an array. Skipping.`,
        );
        continue;
      }

      for (const definition of definitions) {
        this.processHookDefinition(definition, typedEventName, source);
      }
    }
  }

  /**
   * Process a single hook definition
   */
  private processHookDefinition(
    definition: HookDefinition,
    eventName: HookEventName,
    source: HooksConfigSource,
  ): void {
    if (
      !definition ||
      typeof definition !== 'object' ||
      !Array.isArray(definition.hooks)
    ) {
      debugLogger.warn(
        `Discarding invalid hook definition for ${eventName} from ${source}:`,
        definition,
      );
      return;
    }

    for (const hookConfig of definition.hooks) {
      if (
        hookConfig &&
        typeof hookConfig === 'object' &&
        this.validateHookConfig(hookConfig, eventName, source)
      ) {
        const hookName = this.getHookName({ config: hookConfig });

        // Check for duplicate hooks (same name+command+source+eventName+matcher+sequential)
        const isDuplicate = this.entries.some(
          (existing) =>
            existing.eventName === eventName &&
            existing.source === source &&
            this.getHookName(existing) === hookName &&
            existing.matcher === definition.matcher &&
            existing.sequential === definition.sequential,
        );
        if (isDuplicate) {
          debugLogger.debug(
            `Skipping duplicate hook "${hookName}" for ${eventName} from ${source}`,
          );
          continue;
        }

        // Add source to hook config (only for command and http hooks)
        if (hookConfig.type !== 'function') {
          (hookConfig as { source?: HooksConfigSource }).source = source;
        }

        this.entries.push({
          config: hookConfig,
          source,
          eventName,
          matcher: definition.matcher,
          sequential: definition.sequential,
          enabled: true,
        });
      } else {
        // Invalid hooks are logged and discarded here, they won't reach HookRunner
        debugLogger.warn(
          `Discarding invalid hook configuration for ${eventName} from ${source}:`,
          hookConfig,
        );
      }
    }
  }

  /**
   * Validate a hook configuration
   */
  private validateHookConfig(
    config: HookConfig,
    eventName: HookEventName,
    source: HooksConfigSource,
  ): boolean {
    if (
      !config.type ||
      !['command', 'http', 'function'].includes(config.type)
    ) {
      debugLogger.warn(
        `Invalid hook ${eventName} from ${source} type: ${config.type}`,
      );
      return false;
    }

    if (config.type === 'command' && !config.command) {
      debugLogger.warn(
        `Command hook ${eventName} from ${source} missing command field`,
      );
      return false;
    }

    if (config.type === 'http' && !config.url) {
      debugLogger.warn(
        `HTTP hook ${eventName} from ${source} missing url field`,
      );
      return false;
    }

    if (config.type === 'function' && typeof config.callback !== 'function') {
      debugLogger.warn(
        `Function hook ${eventName} from ${source} missing or invalid callback`,
      );
      return false;
    }

    return true;
  }

  /**
   * Check if an event name is valid
   */
  private isValidEventName(eventName: string): eventName is HookEventName {
    const validEventNames: string[] = Object.values(HookEventName);
    return validEventNames.includes(eventName);
  }

  /**
   * Get source priority (lower number = higher priority)
   */
  private getSourcePriority(source: HooksConfigSource): number {
    switch (source) {
      case HooksConfigSource.Project:
        return 1;
      case HooksConfigSource.User:
        return 2;
      case HooksConfigSource.System:
        return 3;
      case HooksConfigSource.Extensions:
        return 4;
      default:
        return 999;
    }
  }
}
