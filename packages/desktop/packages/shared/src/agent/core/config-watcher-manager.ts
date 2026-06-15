/**
 * ConfigWatcherManager
 *
 * Provides a simplified interface for watching configuration file changes.
 * Wraps the underlying ConfigWatcher with agent-focused callbacks.
 *
 * Used by backend agents for hot-reloading:
 * - Source config changes (add/update/delete)
 * - Skills config changes
 * - Permissions config changes
 * - Validation errors
 */

import {
  ConfigWatcher,
  createConfigWatcher,
  type ConfigWatcherCallbacks,
} from '../../config/watcher.ts';
import type { LoadedSource } from '../../sources/types.ts';
import type { LoadedSkill } from '../../skills/types.ts';
import type { ValidationResult } from '../../config/validators.ts';
import { debug } from '../../utils/debug.ts';

// ============================================================
// Types
// ============================================================

/**
 * Callbacks for config changes - simplified for agent use
 */
export interface ConfigWatcherManagerCallbacks {
  /**
   * Called when a source config changes.
   * @param slug - Source slug
   * @param source - Updated source or null if deleted
   */
  onSourceChange?: (slug: string, source: LoadedSource | null) => void;

  /**
   * Called when the sources list changes (add/remove folders).
   * @param sources - All current sources
   */
  onSourcesListChange?: (sources: LoadedSource[]) => void;

  /**
   * Called when a skill config changes.
   * @param slug - Skill slug
   * @param skill - Updated skill or null if deleted
   */
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;

  /**
   * Called when the skills list changes (add/remove folders).
   * @param skills - All current skills
   */
  onSkillsListChange?: (skills: LoadedSkill[]) => void;

  /**
   * Called when workspace permissions change.
   * @param workspaceId - Workspace ID
   */
  onWorkspacePermissionsChange?: (workspaceId: string) => void;

  /**
   * Called when a source's permissions change.
   * @param sourceSlug - Source slug
   */
  onSourcePermissionsChange?: (sourceSlug: string) => void;

  /**
   * Called when default (app-level) permissions change.
   */
  onDefaultPermissionsChange?: () => void;

  /**
   * Called when a validation error occurs while loading config.
   * @param file - File path relative to config root
   * @param errors - Validation errors
   */
  onValidationError?: (file: string, errors: string[]) => void;

  /**
   * Called when an error occurs reading/parsing a file.
   * @param file - File path relative to config root
   * @param error - Error that occurred
   */
  onError?: (file: string, error: Error) => void;
}

/**
 * Configuration for ConfigWatcherManager
 */
export interface ConfigWatcherManagerConfig {
  /**
   * Workspace root path to watch.
   * Can be either workspace ID or full path.
   */
  workspaceRootPath: string;

  /**
   * Whether the agent is running in headless mode.
   * Config watching is skipped in headless mode to reduce overhead.
   */
  isHeadless?: boolean;

  /**
   * Debug callback for logging.
   */
  onDebug?: (message: string) => void;
}

// ============================================================
// ConfigWatcherManager Class
// ============================================================

/**
 * Manages config file watching for agent hot-reload functionality.
 *
 * Provides a simplified interface over ConfigWatcher that:
 * - Only exposes agent-relevant callbacks
 * - Handles headless mode (no-op)
 * - Provides consistent debug logging
 */
export class ConfigWatcherManager {
  private watcher: ConfigWatcher | null = null;
  private workspaceRootPath: string;
  private isHeadless: boolean;
  private callbacks: ConfigWatcherManagerCallbacks;
  private onDebugCallback: ((message: string) => void) | null;

  constructor(config: ConfigWatcherManagerConfig, callbacks: ConfigWatcherManagerCallbacks = {}) {
    this.workspaceRootPath = config.workspaceRootPath;
    this.isHeadless = config.isHeadless ?? false;
    this.callbacks = callbacks;
    this.onDebugCallback = config.onDebug ?? null;
  }

  /**
   * Start watching configuration files.
   * No-op if already running or in headless mode.
   */
  start(): void {
    if (this.watcher) {
      return; // Already running
    }

    if (this.isHeadless) {
      this.debug('Config watching disabled in headless mode');
      return;
    }

    // Create the underlying ConfigWatcher with our simplified callbacks
    const watcherCallbacks: ConfigWatcherCallbacks = {
      onSourceChange: (slug, source) => {
        this.debug(`Source changed: ${slug} ${source ? 'updated' : 'deleted'}`);
        this.callbacks.onSourceChange?.(slug, source);
      },

      onSourcesListChange: (sources) => {
        this.debug(`Sources list changed: ${sources.length} sources`);
        this.callbacks.onSourcesListChange?.(sources);
      },

      onSkillChange: (slug, skill) => {
        this.debug(`Skill changed: ${slug} ${skill ? 'updated' : 'deleted'}`);
        this.callbacks.onSkillChange?.(slug, skill);
      },

      onSkillsListChange: (skills) => {
        this.debug(`Skills list changed: ${skills.length} skills`);
        this.callbacks.onSkillsListChange?.(skills);
      },

      onWorkspacePermissionsChange: (workspaceId) => {
        this.debug(`Workspace permissions changed: ${workspaceId}`);
        this.callbacks.onWorkspacePermissionsChange?.(workspaceId);
      },

      onSourcePermissionsChange: (sourceSlug) => {
        this.debug(`Source permissions changed: ${sourceSlug}`);
        this.callbacks.onSourcePermissionsChange?.(sourceSlug);
      },

      onDefaultPermissionsChange: () => {
        this.debug('Default permissions changed');
        this.callbacks.onDefaultPermissionsChange?.();
      },

      onValidationError: (file, result) => {
        // Map ValidationIssue objects to string messages for the callback
        const errorMessages = result.errors.map(e => e.message);
        this.debug(`Config validation error: ${file} - ${errorMessages.join(', ')}`);
        this.callbacks.onValidationError?.(file, errorMessages);
      },

      onError: (file, error) => {
        this.debug(`Config file error: ${file} - ${error.message}`);
        this.callbacks.onError?.(file, error);
      },
    };

    this.watcher = createConfigWatcher(this.workspaceRootPath, watcherCallbacks);
    this.debug('Config watcher started');
  }

  /**
   * Stop watching configuration files.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
      this.debug('Config watcher stopped');
    }
  }

  /**
   * Check if the watcher is currently running.
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }

  /**
   * Update callbacks after construction.
   * Useful when callbacks need to reference agent state that isn't available at construction.
   */
  updateCallbacks(callbacks: Partial<ConfigWatcherManagerCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Get the workspace root path being watched.
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  private debug(message: string): void {
    const formattedMessage = `[ConfigWatcherManager] ${message}`;
    if (this.onDebugCallback) {
      this.onDebugCallback(formattedMessage);
    }
    debug(formattedMessage);
  }
}

/**
 * Create and optionally start a ConfigWatcherManager.
 *
 * @param config - Manager configuration
 * @param callbacks - Callbacks for config changes
 * @param autoStart - Whether to start watching immediately (default: true)
 * @returns ConfigWatcherManager instance
 */
export function createConfigWatcherManager(
  config: ConfigWatcherManagerConfig,
  callbacks: ConfigWatcherManagerCallbacks = {},
  autoStart = true
): ConfigWatcherManager {
  const manager = new ConfigWatcherManager(config, callbacks);
  if (autoStart) {
    manager.start();
  }
  return manager;
}
