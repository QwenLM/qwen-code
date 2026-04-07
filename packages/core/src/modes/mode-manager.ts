/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview ModeManager - Manages mode lifecycle, loading, and switching.
 *
 * The ModeManager handles loading built-in, user, and project modes,
 * validating configurations, and applying mode settings to the Config.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SubagentManager } from '../subagents/subagent-manager.js';

import type {
  ModeConfig,
  ModeRuntime,
  ModeLevel,
  ValidationResult,
  ListModesOptions,
  CreateModeOptions,
} from './types.js';
import { ModeError, ModeErrorCode, ModeApprovalMode } from './types.js';
import { BUILTIN_MODES } from './builtin-modes.js';
import {
  loadModesFromDir,
  getUserModesDir,
  getProjectModesDir,
} from './mode-load.js';
import { modeValidator } from './mode-validation.js';
import { ModeHookRegistry, type HookTrigger, type HookExecutionResult } from './mode-hooks.js';
import { resolveInheritedMode, getInheritanceChain, isInheritedFrom, findDescendants } from './mode-inheritance.js';
import { ModeAnalytics } from './mode-analytics.js';

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_MANAGER');

/**
 * Events emitted by ModeManager.
 */
export type ModeManagerEvents = {
  'mode:changed': [mode: ModeRuntime];
  'mode:reset': [];
  'mode:error': [error: ModeError];
};

/**
 * Manages mode lifecycle, loading, and switching.
 */
export class ModeManager extends EventEmitter {
  private currentMode: ModeRuntime | null = null;
  private modeRegistry: Map<string, ModeConfig> = new Map();
  private hookRegistry: ModeHookRegistry;
  private analytics: ModeAnalytics;
  private readonly changeListeners: Set<() => void> = new Set();

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly skillManager: SkillManager,
    private readonly subagentManager: SubagentManager,
    private readonly config?: Config,
    private readonly projectDir?: string,
  ) {
    super();
    this.hookRegistry = new ModeHookRegistry(config!);
    this.analytics = new ModeAnalytics();
  }

  // ─── Change Listeners ──────────────────────────────────────────────────────

  /**
   * Register a listener for mode changes.
   *
   * @param listener - Callback function
   * @returns Unsubscribe function
   */
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
        debugLogger.warn('Mode change listener threw an error:', error);
      }
    }
  }

  // ─── Loading Modes ─────────────────────────────────────────────────────────

  /**
   * Load all available modes from all sources.
   * Precedence: project > user > builtin
   *
   * @param config - Config instance for resolving paths
   */
  async loadAllModes(config: Config): Promise<void> {
    this.modeRegistry.clear();

    // 1. Load built-in modes (lowest priority)
    await this.loadBuiltinModes();

    // 2. Load user modes (overrides built-in)
    await this.loadUserModes(config);

    // 3. Load project modes (highest priority, overrides user)
    if (this.projectDir) {
      await this.loadProjectModes(config);
    }

    debugLogger.debug(
      `Loaded ${this.modeRegistry.size} modes total`,
    );
  }

  /**
   * Load built-in modes.
   */
  async loadBuiltinModes(): Promise<void> {
    debugLogger.debug('Loading built-in modes');
    for (const mode of BUILTIN_MODES) {
      this.modeRegistry.set(mode.name, mode);
    }
    debugLogger.debug(`Registered ${BUILTIN_MODES.length} built-in modes`);
  }

  /**
   * Load user modes from ~/.qwen/modes/.
   *
   * @param config - Config instance
   */
  async loadUserModes(config: Config): Promise<void> {
    const homeDir = os.homedir();
    const userModesDir = getUserModesDir(homeDir);

    debugLogger.debug(`Loading user modes from: ${userModesDir}`);

    try {
      const modes = await loadModesFromDir(userModesDir, 'user');
      for (const mode of modes) {
        const validation = this.validateMode(mode);
        if (validation.isValid) {
          this.modeRegistry.set(mode.name, mode);
          debugLogger.debug(`Loaded user mode: ${mode.name}`);
        } else {
          debugLogger.warn(
            `Skipping invalid user mode "${mode.name}": ${validation.errors.join(', ')}`,
          );
        }
      }
    } catch (error) {
      // Directory may not exist, that's fine
      debugLogger.debug(`User modes directory not found: ${userModesDir}`);
    }
  }

  /**
   * Load project modes from .qwen/modes/.
   *
   * @param config - Config instance
   */
  async loadProjectModes(config: Config): Promise<void> {
    if (!this.projectDir) return;

    const projectModesDir = getProjectModesDir(this.projectDir);

    debugLogger.debug(`Loading project modes from: ${projectModesDir}`);

    try {
      const modes = await loadModesFromDir(projectModesDir, 'project');
      for (const mode of modes) {
        const validation = this.validateMode(mode);
        if (validation.isValid) {
          this.modeRegistry.set(mode.name, mode);
          debugLogger.debug(`Loaded project mode: ${mode.name}`);
        } else {
          debugLogger.warn(
            `Skipping invalid project mode "${mode.name}": ${validation.errors.join(', ')}`,
          );
        }
      }
    } catch (error) {
      debugLogger.debug(
        `Project modes directory not found: ${projectModesDir}`,
      );
    }
  }

  // ─── Mode Switching ────────────────────────────────────────────────────────

  /**
   * Switch to a mode by name.
   *
   * @param modeName - Name of the mode to switch to
   * @param config - Config instance to apply mode settings to
   * @returns Runtime mode state
   * @throws ModeError if mode not found or validation fails
   */
  async switchMode(modeName: string, config: Config): Promise<ModeRuntime> {
    debugLogger.debug(`Switching to mode: ${modeName}`);

    // Find mode in registry
    const modeConfig = this.modeRegistry.get(modeName);
    if (!modeConfig) {
      const available = Array.from(this.modeRegistry.keys()).join(', ');
      throw new ModeError(
        `Mode "${modeName}" not found. Available modes: ${available}`,
        ModeErrorCode.NOT_FOUND,
        modeName,
      );
    }

    // Validate mode against current tool/subagent/skill availability
    const availableTools = new Set(
      this.toolRegistry.getAllToolNames(),
    );
    const availableSubagents = new Set(
      this.subagentManager.listSubagents().map((s) => s.name),
    );
    const availableSkills = new Set(
      this.skillManager.listSkills().map((s) => s.name),
    );

    const validation = modeValidator.validateConfig(
      modeConfig,
      availableTools,
      availableSubagents,
      availableSkills,
    );

    if (!validation.isValid) {
      throw new ModeError(
        `Invalid mode "${modeName}": ${validation.errors.join('; ')}`,
        ModeErrorCode.VALIDATION_ERROR,
        modeName,
      );
    }

    // Save original settings for restoration
    const originalSettings = {
      approvalMode: config.getApprovalMode(),
    };

    // Apply mode settings to config
    await this.applyModeToConfig(modeConfig, config);

    // Execute onEnter hooks
    const enterResults = await this.executeHooks(modeName, 'onEnter');
    const failedHooks = enterResults.filter((r) => !r.success);
    if (failedHooks.length > 0) {
      debugLogger.warn(
        `${failedHooks.length} onEnter hook(s) failed for mode "${modeName}"`,
      );
    }

    // Update runtime state
    this.currentMode = {
      config: modeConfig,
      appliedAt: new Date(),
      originalSettings,
    };

    // Record analytics for the mode switch
    this.analytics.recordSession(modeName, 0, {
      toolCalls: 0,
      messages: 0,
      filesModified: 0,
    });

    // Emit events
    this.emit('mode:changed', this.currentMode);
    this.notifyChangeListeners();

    debugLogger.debug(
      `Switched to mode: ${modeConfig.icon} ${modeConfig.displayName}`,
    );

    return this.currentMode;
  }

  /**
   * Reset to default (general) mode.
   *
   * @param config - Config instance
   */
  async resetToDefault(config: Config): Promise<void> {
    debugLogger.debug('Resetting to default mode');

    // If we have original settings, restore them
    if (this.currentMode?.originalSettings) {
      if (this.currentMode.originalSettings.approvalMode) {
        config.setApprovalMode(
          this.currentMode.originalSettings.approvalMode,
        );
      }
    } else {
      // Switch to general mode
      const generalMode = this.modeRegistry.get('general');
      if (generalMode) {
        await this.applyModeToConfig(generalMode, config);
      }
    }

    this.currentMode = null;
    this.emit('mode:reset');
    this.notifyChangeListeners();

    debugLogger.debug('Reset to default mode');
  }

  // ─── Getters ───────────────────────────────────────────────────────────────

  /**
   * Get the currently active mode.
   *
   * @returns Current mode runtime state, or null if no mode is active
   */
  getCurrentMode(): ModeRuntime | null {
    return this.currentMode;
  }

  /**
   * Get all available modes.
   *
   * @returns Array of mode configurations
   */
  getAvailableModes(): ModeConfig[] {
    return Array.from(this.modeRegistry.values());
  }

  /**
   * Get a mode by name.
   *
   * @param name - Mode name
   * @returns Mode config or undefined
   */
  getMode(name: string): ModeConfig | undefined {
    const mode = this.modeRegistry.get(name);
    if (!mode) return undefined;

    // Return resolved version if it has inheritance
    if (mode.inheritedFrom) {
      return this.getResolvedMode(name);
    }

    return mode;
  }

  /**
   * List modes with optional filtering.
   *
   * @param options - Filter options
   * @returns Filtered array of mode configs
   */
  listModes(options?: ListModesOptions): ModeConfig[] {
    let modes = Array.from(this.modeRegistry.values());

    // Filter by level
    if (options?.level) {
      modes = modes.filter((m) => m.level === options.level);
    }

    // Filter by tool availability
    if (options?.hasTool) {
      modes = modes.filter((m) => {
        if (m.allowedTools) {
          return m.allowedTools.includes(options.hasTool!);
        }
        // If no allowedTools constraint, tool is available
        if (!m.allowedTools && !m.deniedTools) {
          return true;
        }
        // Check if tool is not denied
        if (m.deniedTools) {
          return !m.deniedTools.includes(options.hasTool!);
        }
        return true;
      });
    }

    // Sort
    if (options?.sortBy === 'name') {
      modes.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name);
        return options.sortOrder === 'desc' ? -cmp : cmp;
      });
    } else if (options?.sortBy === 'level') {
      const levelOrder: Record<ModeLevel, number> = {
        project: 0,
        user: 1,
        builtin: 2,
      };
      modes.sort((a, b) => {
        const cmp = levelOrder[a.level] - levelOrder[b.level];
        return options.sortOrder === 'desc' ? -cmp : cmp;
      });
    }

    return modes;
  }

  // ─── Tool Filtering ────────────────────────────────────────────────────────

  /**
   * Get the list of tool names available for the current mode.
   *
   * @returns Array of tool names (filtered by mode constraints)
   */
  getAvailableToolNames(): string[] {
    const allTools = this.toolRegistry.getAllToolNames();
    const mode = this.currentMode?.config;

    if (!mode) {
      return allTools;
    }

    // Apply allowedTools whitelist
    if (mode.allowedTools) {
      return allTools.filter((t) => mode.allowedTools!.includes(t));
    }

    // Apply deniedTools blacklist
    if (mode.deniedTools) {
      return allTools.filter((t) => !mode.deniedTools!.includes(t));
    }

    // No constraints
    return allTools;
  }

  /**
   * Get the list of sub-agent names available for the current mode.
   *
   * @returns Array of sub-agent names
   */
  getAvailableSubagentNames(): string[] {
    const allSubagents = this.subagentManager
      .listSubagents()
      .map((s) => s.name);
    const mode = this.currentMode?.config;

    if (!mode) {
      return allSubagents;
    }

    // Apply allowedSubagents whitelist
    if (mode.allowedSubagents) {
      return allSubagents.filter((s) => mode.allowedSubagents!.includes(s));
    }

    // No constraints
    return allSubagents;
  }

  /**
   * Get the list of skill names available for the current mode.
   *
   * @returns Array of skill names
   */
  getAvailableSkillNames(): string[] {
    const allSkills = this.skillManager.listSkills().map((s) => s.name);
    const mode = this.currentMode?.config;

    if (!mode) {
      return allSkills;
    }

    // Apply allowedSkills whitelist
    if (mode.allowedSkills) {
      return allSkills.filter((s) => mode.allowedSkills!.includes(s));
    }

    // No constraints
    return allSkills;
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  /**
   * Validate a mode configuration.
   *
   * @param config - Mode configuration
   * @returns Validation result
   */
  validateMode(config: ModeConfig): ValidationResult {
    const availableTools = new Set(
      this.toolRegistry.getAllToolNames(),
    );
    const availableSubagents = new Set(
      this.subagentManager.listSubagents().map((s) => s.name),
    );
    const availableSkills = new Set(
      this.skillManager.listSkills().map((s) => s.name),
    );

    return modeValidator.validateConfig(
      config,
      availableTools,
      availableSubagents,
      availableSkills,
    );
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  /**
   * Apply mode settings to the Config instance.
   * Note: Many Config fields are readonly, so we only apply what's mutable.
   *
   * @param modeConfig - Mode configuration
   * @param config - Config instance to modify
   */
  private async applyModeToConfig(
    modeConfig: ModeConfig,
    config: Config,
  ): Promise<void> {
    // Apply approval mode (mutable)
    if (modeConfig.approvalMode) {
      config.setApprovalMode(modeConfig.approvalMode);
    }

    // Note: systemPrompt, model config, and run config are readonly in Config.
    // These would need to be made mutable in Config for full mode support.
    // For now, we store them in the runtime state for reference.

    debugLogger.debug(
      `Applied mode settings: ${modeConfig.icon} ${modeConfig.displayName}`,
    );
  }

  // ─── Hook Management ───────────────────────────────────────────────────────

  /**
   * Execute hooks for a given trigger in the current mode.
   *
   * @param modeName - Mode name
   * @param trigger - Hook trigger type
   * @returns Array of execution results
   */
  async executeHooks(
    modeName: string,
    trigger: HookTrigger,
  ): Promise<HookExecutionResult[]> {
    return this.hookRegistry.executeHooks(modeName, trigger);
  }

  /**
   * Register hooks for a mode.
   *
   * @param modeName - Mode name
   * @param hooks - Array of hook configurations
   */
  registerHooks(modeName: string, hooks: ModeHook[]): void {
    this.hookRegistry.registerHooks(modeName, hooks);
  }

  /**
   * Get the hook registry for inspection.
   */
  getHookRegistry(): ModeHookRegistry {
    return this.hookRegistry;
  }

  // ─── Inheritance Management ────────────────────────────────────────────────

  /**
   * Get a mode by name, with inheritance resolved.
   *
   * @param name - Mode name
   * @returns Fully resolved mode config
   */
  getResolvedMode(name: string): ModeConfig | undefined {
    const mode = this.modeRegistry.get(name);
    if (!mode) return undefined;

    try {
      return resolveInheritedMode(mode, this.modeRegistry);
    } catch (error) {
      debugLogger.error(`Failed to resolve inheritance for mode "${name}":`, error);
      return undefined;
    }
  }

  /**
   * Get the inheritance chain for a mode.
   *
   * @param name - Mode name
   * @returns Array of mode names in the inheritance chain
   */
  getModeInheritanceChain(name: string): string[] {
    const mode = this.modeRegistry.get(name);
    if (!mode) return [];

    return getInheritanceChain(mode, this.modeRegistry);
  }

  /**
   * Find all modes that inherit from a given mode.
   *
   * @param ancestorName - Ancestor mode name
   * @returns Array of descendant mode configs
   */
  findModeDescendants(ancestorName: string): ModeConfig[] {
    return findDescendants(ancestorName, this.modeRegistry);
  }

  /**
   * Check if a mode inherits from another.
   *
   * @param modeName - Mode name
   * @param ancestorName - Potential ancestor name
   * @returns True if mode inherits from ancestor
   */
  isModeInheritedFrom(modeName: string, ancestorName: string): boolean {
    const mode = this.modeRegistry.get(modeName);
    if (!mode) return false;

    return isInheritedFrom(mode, ancestorName, this.modeRegistry);
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────

  /**
   * Get the ModeAnalytics instance for tracking mode usage.
   *
   * @returns ModeAnalytics instance
   */
  getAnalytics(): ModeAnalytics {
    return this.analytics;
  }

  /**
   * Record session statistics for the current mode.
   * Call this when a session ends to update analytics.
   *
   * @param duration - Session duration in seconds
   * @param stats - Session statistics
   */
  recordCurrentModeSession(
    duration: number,
    stats: {
      toolCalls: number;
      messages: number;
      filesModified: number;
    },
  ): void {
    const modeName = this.currentMode?.config.name;
    if (!modeName) {
      debugLogger.debug('No active mode to record session for');
      return;
    }

    this.analytics.recordSession(modeName, duration, stats);
  }
}
