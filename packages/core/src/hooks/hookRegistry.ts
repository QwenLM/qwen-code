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
import { TrustedHooksManager } from './trustedHooks.js';

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
  getHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined;
  getProjectHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined;
  getDisabledHooks(): string[];
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
    return entry.config.name || entry.config.command || 'unknown-command';
  }

  /**
   * Check for untrusted project hooks and warn the user
   */
  private checkProjectHooksTrust(): void {
    const projectHooks = this.config.getProjectHooks();
    if (!projectHooks) return;

    try {
      const trustedHooksManager = new TrustedHooksManager();
      const untrusted = trustedHooksManager.getUntrustedHooks(
        this.config.getProjectRoot(),
        projectHooks,
      );

      if (untrusted.length > 0) {
        const message = `WARNING: The following project-level hooks have been detected in this workspace:
${untrusted.map((h: string) => `  - ${h}`).join('\n')}

These hooks will be executed. If you did not configure these hooks or do not trust this project,
please review the project settings (.qwen/settings.json) and remove them.`;
        this.feedbackEmitter?.emitFeedback('warning', message);

        // Trust them so we don't warn again
        trustedHooksManager.trustHooks(
          this.config.getProjectRoot(),
          projectHooks,
        );
      }
    } catch {
      debugLogger.warn('Failed to check project hooks trust');
    }
  }

  /**
   * Process hooks from the config that was already loaded by the CLI
   */
  private processHooksFromConfig(): void {
    if (this.config.isTrustedFolder()) {
      this.checkProjectHooksTrust();
    }

    // Get hooks from the main config (this comes from the merged settings)
    const configHooks = this.config.getHooks();
    if (configHooks) {
      if (this.config.isTrustedFolder()) {
        this.processHooksConfiguration(configHooks, HooksConfigSource.Project);
      } else {
        debugLogger.warn(
          'Project hooks disabled because the folder is not trusted.',
        );
      }
    }

    // Get hooks from extensions
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

    // Get disabled hooks list from settings
    const disabledHooks = this.config.getDisabledHooks();

    for (const hookConfig of definition.hooks) {
      if (
        hookConfig &&
        typeof hookConfig === 'object' &&
        this.validateHookConfig(hookConfig, eventName, source)
      ) {
        // Check if this hook is in the disabled list
        const hookName = this.getHookName({ config: hookConfig });
        const isDisabled = disabledHooks.includes(hookName);

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

        // Add source to hook config
        hookConfig.source = source;

        this.entries.push({
          config: hookConfig,
          source,
          eventName,
          matcher: definition.matcher,
          sequential: definition.sequential,
          enabled: !isDisabled,
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
    if (!config.type || !['command', 'plugin'].includes(config.type)) {
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
