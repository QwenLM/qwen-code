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
  (
    payload: HookPayload,
    context: HookContext,
  ): Promise<HookPayload | void> | HookPayload | void;
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

  // Additional hooks for Claude compatibility
  BEFORE_COMPACT = 'before.compact',
  SESSION_NOTIFICATION = 'session.notification',
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
  ): Promise<HookPayload> {
    const hooks = this.hooks.get(type) || [];
    const enabledHooks = hooks.filter((hook) => hook.enabled);

    let currentPayload = payload;

    // Execute hooks in priority order with error handling
    // For proper failure handling and to prevent direct payload mutations
    for (const hook of enabledHooks) {
      try {
        if (context.signal?.aborted) {
          break; // Stop execution if cancelled
        }

        // Create a deep clone of the current payload to protect against direct mutations
        // Use a custom replacer to handle special values that JSON.stringify can't handle
        const safePayload = JSON.parse(
          JSON.stringify(currentPayload, (key, value) => {
            // Handle special values that JSON can't serialize
            if (typeof value === 'undefined') {
              return '__UNDEFINED__'; // Use a unique marker for undefined
            }
            if (Number.isNaN(value)) {
              return '__NaN__'; // Use a unique marker for NaN
            }
            if (value === Infinity) {
              return '__POSITIVE_INFINITY__'; // Use a unique marker for positive infinity
            }
            if (value === -Infinity) {
              return '__NEGATIVE_INFINITY__'; // Use a unique marker for negative infinity
            }
            return value;
          }),
        );

        // Restore special values after parsing
        const restoreSpecialValues = (obj: unknown): unknown => {
          if (obj === null) return null;
          if (Array.isArray(obj)) {
            return obj.map((item) => restoreSpecialValues(item));
          }
          if (typeof obj === 'object') {
            const restored: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(
              obj as Record<string, unknown>,
            )) {
              if (value === '__UNDEFINED__') {
                restored[key] = undefined;
              } else if (value === '__NaN__') {
                restored[key] = NaN;
              } else if (value === '__POSITIVE_INFINITY__') {
                restored[key] = Infinity;
              } else if (value === '__NEGATIVE_INFINITY__') {
                restored[key] = -Infinity;
              } else {
                restored[key] = restoreSpecialValues(value);
              }
            }
            return restored;
          }
          return obj;
        };

        const restoredSafePayload = restoreSpecialValues(safePayload);

        // Pass the restored payload to the handler to prevent direct mutations
        const result = await Promise.resolve(
          hook.handler(restoredSafePayload, context),
        );

        // If the handler returns a modified payload, use it for subsequent hooks
        if (
          result !== undefined &&
          result !== null &&
          typeof result === 'object'
        ) {
          currentPayload = { ...currentPayload, ...result };
        } else if (result !== undefined && result !== null) {
          // If result is not an object but not undefined/null, it might be a primitive
          // In this case, we should handle it specially - but typically hooks should return objects
          console.warn(
            `Hook ${hook.id} returned a non-object result: ${typeof result}. This may indicate incorrect hook implementation.`,
          );
        }
      } catch (error) {
        console.error(
          `Error executing hook ${hook.id} of type ${type}:`,
          error,
        );
        // Don't let one hook failure stop the entire execution
        // The calling code may handle errors separately
      }
    }

    return currentPayload;
  }

  /**
   * Get all registered hooks (for debugging/testing purposes)
   */
  getAllHooks(): Map<HookType, HookRegistration[]> {
    return new Map(this.hooks);
  }
}
