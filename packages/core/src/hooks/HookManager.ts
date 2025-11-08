/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

/**
 * Hook system for Qwen Code, inspired by Claude Code's hook system.
 * This system allows users to execute custom scripts at key points in the application lifecycle.
 */

export interface HookPayload {
  /** Unique identifier for the hook execution */
  id: string;
  /** Timestamp of when the hook was triggered */
  timestamp: number;
  /** Additional data specific to the hook type */
  [key: string]: unknown;
}

export interface HookContext {
  /** Configuration and runtime context */
  config: Config;
  /** Cancellation signal for the hook execution */
  signal?: AbortSignal;
}

export interface HookFunction {
  (payload: HookPayload, context: HookContext): Promise<void> | void;
}

export interface HookRegistration {
  id: string;
  type: HookType;
  handler: HookFunction;
  priority?: number; // Lower numbers execute first, default is 0
  enabled?: boolean; // Whether the hook is currently enabled
}

export enum HookType {
  // Application lifecycle hooks
  APP_STARTUP = 'app.startup',
  APP_SHUTDOWN = 'app.shutdown',
  SESSION_START = 'session.start',
  SESSION_END = 'session.end',

  // Interactive mode hooks
  INPUT_RECEIVED = 'input.received',
  OUTPUT_READY = 'output.ready',
  BEFORE_RESPONSE = 'before.response',
  AFTER_RESPONSE = 'after.response',

  // Tool execution hooks
  BEFORE_TOOL_USE = 'tool.before',
  AFTER_TOOL_USE = 'tool.after',

  // Command processing hooks
  BEFORE_COMMAND = 'command.before',
  AFTER_COMMAND = 'command.after',

  // Model interaction hooks
  BEFORE_MODEL_REQUEST = 'model.before_request',
  AFTER_MODEL_RESPONSE = 'model.after_response',

  // File system hooks
  BEFORE_FILE_READ = 'file.before_read',
  AFTER_FILE_READ = 'file.after_read',
  BEFORE_FILE_WRITE = 'file.before_write',
  AFTER_FILE_WRITE = 'file.after_write',

  // Error hooks
  ERROR_OCCURRED = 'error.occurred',
  ERROR_HANDLED = 'error.handled',
}

export class HookManager {
  private hooks: Map<HookType, HookRegistration[]> = new Map();
  private static instance: HookManager;

  constructor() {
    // Initialize the map with empty arrays for each hook type
    Object.values(HookType).forEach((hookType) => {
      this.hooks.set(hookType, []);
    });
  }

  /**
   * Get singleton instance of HookManager
   */
  static getInstance(): HookManager {
    if (!HookManager.instance) {
      HookManager.instance = new HookManager();
    }
    return HookManager.instance;
  }

  /**
   * Register a new hook
   */
  register(
    hookRegistration: Omit<HookRegistration, 'id'> & { id?: string },
  ): string {
    const id =
      hookRegistration.id ||
      `hook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const fullRegistration: HookRegistration = {
      ...hookRegistration,
      id,
      enabled: hookRegistration.enabled !== false, // Default to true if not specified
    };

    const hooksArray = this.hooks.get(fullRegistration.type) || [];
    hooksArray.push(fullRegistration);

    // Sort by priority (lower numbers execute first)
    hooksArray.sort((a, b) => (a.priority || 0) - (b.priority || 0));

    this.hooks.set(fullRegistration.type, hooksArray);
    return id;
  }

  /**
   * Unregister a hook by ID
   */
  unregister(hookId: string): boolean {
    let found = false;
    for (const [_, hooksArray] of this.hooks) {
      const index = hooksArray.findIndex((hook) => hook.id === hookId);
      if (index !== -1) {
        hooksArray.splice(index, 1);
        found = true;
      }
    }
    return found;
  }

  /**
   * Enable a hook by ID
   */
  enable(hookId: string): boolean {
    for (const [_, hooksArray] of this.hooks) {
      const hook = hooksArray.find((hook) => hook.id === hookId);
      if (hook) {
        hook.enabled = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Disable a hook by ID
   */
  disable(hookId: string): boolean {
    for (const [_, hooksArray] of this.hooks) {
      const hook = hooksArray.find((hook) => hook.id === hookId);
      if (hook) {
        hook.enabled = false;
        return true;
      }
    }
    return false;
  }

  /**
   * Execute all hooks registered for a specific type
   */
  async executeHooks(
    type: HookType,
    payload: HookPayload,
    context: HookContext,
  ): Promise<void> {
    const hooks = this.hooks.get(type) || [];
    const enabledHooks = hooks.filter((hook) => hook.enabled);

    // Execute hooks in priority order
    for (const hook of enabledHooks) {
      try {
        if (context.signal?.aborted) {
          break; // Stop execution if cancelled
        }

        await Promise.resolve(hook.handler(payload, context));
      } catch (error) {
        console.error(
          `Error executing hook ${hook.id} of type ${type}:`,
          error,
        );
        // Don't let one hook failure stop the entire execution
        // The calling code may handle errors separately
      }
    }
  }

  /**
   * Get all registered hooks (for debugging/testing purposes)
   */
  getAllHooks(): Map<HookType, HookRegistration[]> {
    return new Map(this.hooks);
  }
}
