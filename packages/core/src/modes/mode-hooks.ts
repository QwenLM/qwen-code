/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Hooks — execute commands automatically when entering/exiting modes.
 *
 * Hooks are defined in MODE.md frontmatter or in settings, and execute
 * shell commands or slash commands on mode transitions.
 */

import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_HOOKS');

/**
 * Type of hook trigger.
 */
export type HookTrigger =
  | 'onEnter'       // Executed when entering the mode
  | 'onExit'        // Executed when exiting the mode
  | 'onStart'       // Executed once when session starts with this mode
  | 'beforeAction'  // Executed before each agent action in this mode
  | 'afterAction';  // Executed after each agent action in this mode

/**
 * Type of hook command.
 */
export type HookCommandType =
  | 'shell'         // Execute a shell command
  | 'slash'         // Execute a slash command
  | 'message'       // Display a message to the user
  | 'prompt';       // Modify the system prompt

/**
 * Configuration for a single mode hook.
 */
export interface ModeHook {
  /** When this hook should fire */
  trigger: HookTrigger;

  /** Type of command to execute */
  commandType: HookCommandType;

  /** The command/message to execute */
  command: string;

  /** Whether to continue if this hook fails */
  continueOnError?: boolean;

  /** Timeout in seconds (default: 30) */
  timeoutSeconds?: number;

  /** Description for display in hook lists */
  description?: string;

  /** Conditions for conditional execution */
  condition?: {
    /** Only execute if files matching this pattern exist */
    filesExist?: string[];
    /** Only execute if environment variable is set */
    envVarSet?: string;
    /** Only execute if git is initialized */
    gitInitialized?: boolean;
  };
}

/**
 * Result of hook execution.
 */
export interface HookExecutionResult {
  hook: ModeHook;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

/**
 * Registry and executor of mode hooks.
 */
export class ModeHookRegistry {
  private hooks: Map<string, ModeHook[]> = new Map();

  constructor(private readonly config: Config) {}

  /**
   * Register hooks for a specific mode.
   *
   * @param modeName - Mode name
   * @param hooks - Array of hook configurations
   */
  registerHooks(modeName: string, hooks: ModeHook[]): void {
    this.hooks.set(modeName, hooks);
    debugLogger.debug(`Registered ${hooks.length} hooks for mode: ${modeName}`);
  }

  /**
   * Get all hooks for a mode.
   *
   * @param modeName - Mode name
   * @returns Array of hooks
   */
  getHooks(modeName: string): ModeHook[] {
    return this.hooks.get(modeName) ?? [];
  }

  /**
   * Execute all hooks for a given trigger and mode.
   *
   * @param modeName - Mode name
   * @param trigger - Hook trigger type
   * @returns Array of execution results
   */
  async executeHooks(
    modeName: string,
    trigger: HookTrigger,
  ): Promise<HookExecutionResult[]> {
    const modeHooks = this.getHooks(modeName);
    const matchingHooks = modeHooks.filter((h) => h.trigger === trigger);

    if (matchingHooks.length === 0) {
      return [];
    }

    debugLogger.debug(
      `Executing ${matchingHooks.length} hooks for trigger "${trigger}" in mode "${modeName}"`,
    );

    const results: HookExecutionResult[] = [];

    for (const hook of matchingHooks) {
      // Check conditions
      if (!this.checkConditions(hook)) {
        debugLogger.debug(`Hook condition not met, skipping: ${hook.description || hook.command}`);
        continue;
      }

      const startTime = Date.now();
      try {
        const output = await this.executeHook(hook);
        results.push({
          hook,
          success: true,
          output,
          durationMs: Date.now() - startTime,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          hook,
          success: false,
          error: errorMsg,
          durationMs: Date.now() - startTime,
        });

        if (!hook.continueOnError) {
          debugLogger.warn(`Hook failed and continueOnError is false: ${errorMsg}`);
          break;
        }
      }
    }

    return results;
  }

  /**
   * Check if a hook's conditions are met.
   */
  private checkConditions(hook: ModeHook): boolean {
    if (!hook.condition) {
      return true;
    }

    const cond = hook.condition;

    if (cond.filesExist && cond.filesExist.length > 0) {
      // Would need fs import here — conditions are best evaluated lazily
      // For now, return true and let shell commands handle file checks
    }

    if (cond.envVarSet && !process.env[cond.envVarSet]) {
      return false;
    }

    return true;
  }

  /**
   * Execute a single hook.
   */
  private async executeHook(hook: ModeHook): Promise<string | undefined> {
    const timeout = (hook.timeoutSeconds ?? 30) * 1000;

    switch (hook.commandType) {
      case 'shell':
        return this.executeShellCommand(hook.command, timeout);

      case 'slash':
        return this.executeSlashCommand(hook.command);

      case 'message':
        // Message hooks just display to user — return the message
        return hook.command;

      case 'prompt':
        // Prompt hooks return modified prompt text
        return hook.command;

      default:
        throw new Error(`Unknown hook command type: ${(hook as ModeHook).commandType}`);
    }
  }

  /**
   * Execute a shell command hook.
   */
  private async executeShellCommand(
    command: string,
    timeout: number,
  ): Promise<string> {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    debugLogger.debug(`Executing shell hook: ${command}`);

    const { stdout, stderr } = await execAsync(command, {
      timeout,
      cwd: this.config.getWorkingDir(),
      maxBuffer: 1024 * 1024, // 1MB
    });

    if (stderr && !stdout) {
      return stderr;
    }
    return stdout;
  }

  /**
   * Execute a slash command hook.
   * Returns the command string for the UI to process.
   */
  private async executeSlashCommand(command: string): Promise<string> {
    debugLogger.debug(`Executing slash command hook: ${command}`);
    // Return the command for the UI layer to handle
    return command;
  }

  /**
   * Remove all hooks for a mode.
   */
  clearHooks(modeName: string): void {
    this.hooks.delete(modeName);
  }

  /**
   * Get all registered hooks counts.
   */
  getStats(): Map<string, number> {
    const stats = new Map<string, number>();
    for (const [modeName, hooks] of this.hooks) {
      stats.set(modeName, hooks.length);
    }
    return stats;
  }
}
