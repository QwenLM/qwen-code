/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  HookEventName,
  CommandHookConfig,
  HttpHookConfig,
  FunctionHookConfig,
  FunctionHookCallback,
  HookConfig,
} from './types.js';
import { HookType } from './types.js';

const debugLogger = createDebugLogger('SESSION_HOOKS_MANAGER');

/**
 * Generate a unique hook ID
 */
function generateHookId(): string {
  return `session_hook_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Session hook entry with matcher and configuration
 */
export interface SessionHookEntry {
  hookId: string;
  eventName: HookEventName;
  matcher: string;
  config: HookConfig;
  sequential?: boolean;
}

/**
 * Session hooks storage per session
 */
interface SessionHooksStorage {
  hooks: Map<HookEventName, SessionHookEntry[]>;
}

/**
 * Session Hooks Manager - manages hooks registered at runtime for specific sessions
 * Used primarily for SDK integration where hooks are registered programmatically
 */
export class SessionHooksManager {
  private readonly sessions: Map<string, SessionHooksStorage> = new Map();

  /**
   * Get or create session storage
   */
  private getSessionStorage(sessionId: string): SessionHooksStorage {
    let storage = this.sessions.get(sessionId);
    if (!storage) {
      storage = { hooks: new Map() };
      this.sessions.set(sessionId, storage);
    }
    return storage;
  }

  /**
   * Add a function hook for a session
   * @param sessionId Session ID
   * @param event Hook event name
   * @param matcher Matcher pattern (e.g., 'Bash', '*', 'Write|Edit')
   * @param callback Function callback to execute
   * @param errorMessage Error message to display on failure
   * @param options Additional options
   * @returns Hook ID for later removal
   */
  addFunctionHook(
    sessionId: string,
    event: HookEventName,
    matcher: string,
    callback: FunctionHookCallback,
    errorMessage: string,
    options?: {
      timeout?: number;
      id?: string;
      name?: string;
      description?: string;
      statusMessage?: string;
    },
  ): string {
    const hookId = options?.id || generateHookId();

    const config: FunctionHookConfig = {
      type: HookType.Function,
      id: hookId,
      name: options?.name,
      description: options?.description,
      timeout: options?.timeout,
      callback,
      errorMessage,
      statusMessage: options?.statusMessage,
    };

    const entry: SessionHookEntry = {
      hookId,
      eventName: event,
      matcher,
      config,
    };

    const storage = this.getSessionStorage(sessionId);
    const eventHooks = storage.hooks.get(event) || [];
    eventHooks.push(entry);
    storage.hooks.set(event, eventHooks);

    debugLogger.debug(
      `Added function hook ${hookId} for session ${sessionId} on event ${event}`,
    );

    return hookId;
  }

  /**
   * Add a command or HTTP hook for a session
   * @param sessionId Session ID
   * @param event Hook event name
   * @param matcher Matcher pattern
   * @param hook Hook configuration (command or HTTP)
   * @param options Additional options
   */
  addSessionHook(
    sessionId: string,
    event: HookEventName,
    matcher: string,
    hook: CommandHookConfig | HttpHookConfig,
    options?: { sequential?: boolean },
  ): string {
    const hookId = generateHookId();

    const entry: SessionHookEntry = {
      hookId,
      eventName: event,
      matcher,
      config: hook,
      sequential: options?.sequential,
    };

    const storage = this.getSessionStorage(sessionId);
    const eventHooks = storage.hooks.get(event) || [];
    eventHooks.push(entry);
    storage.hooks.set(event, eventHooks);

    debugLogger.debug(
      `Added session hook ${hookId} for session ${sessionId} on event ${event}`,
    );

    return hookId;
  }

  /**
   * Remove a function hook by ID
   * @param sessionId Session ID
   * @param event Hook event name
   * @param hookId Hook ID to remove
   * @returns True if hook was found and removed
   */
  removeFunctionHook(
    sessionId: string,
    event: HookEventName,
    hookId: string,
  ): boolean {
    const storage = this.sessions.get(sessionId);
    if (!storage) {
      return false;
    }

    const eventHooks = storage.hooks.get(event);
    if (!eventHooks) {
      return false;
    }

    const index = eventHooks.findIndex((entry) => entry.hookId === hookId);
    if (index === -1) {
      return false;
    }

    eventHooks.splice(index, 1);
    debugLogger.debug(
      `Removed hook ${hookId} from session ${sessionId} on event ${event}`,
    );

    return true;
  }

  /**
   * Remove a hook by ID (searches all events)
   * @param sessionId Session ID
   * @param hookId Hook ID to remove
   * @returns True if hook was found and removed
   */
  removeHook(sessionId: string, hookId: string): boolean {
    const storage = this.sessions.get(sessionId);
    if (!storage) {
      return false;
    }

    for (const [event, eventHooks] of storage.hooks.entries()) {
      const index = eventHooks.findIndex((entry) => entry.hookId === hookId);
      if (index !== -1) {
        eventHooks.splice(index, 1);
        debugLogger.debug(
          `Removed hook ${hookId} from session ${sessionId} on event ${event}`,
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Get all hooks for a session and event
   * @param sessionId Session ID
   * @param event Hook event name
   * @returns Array of session hook entries
   */
  getHooksForEvent(
    sessionId: string,
    event: HookEventName,
  ): SessionHookEntry[] {
    const storage = this.sessions.get(sessionId);
    if (!storage) {
      return [];
    }

    return storage.hooks.get(event) || [];
  }

  /**
   * Get hooks that match a specific tool/target
   * @param sessionId Session ID
   * @param event Hook event name
   * @param target Target to match (e.g., tool name)
   * @returns Array of matching hook entries
   */
  getMatchingHooks(
    sessionId: string,
    event: HookEventName,
    target: string,
  ): SessionHookEntry[] {
    const hooks = this.getHooksForEvent(sessionId, event);
    return hooks.filter((entry) => this.matchesPattern(entry.matcher, target));
  }

  /**
   * Check if a target matches a pattern
   * Supports: exact match, '*' wildcard, '|' for alternatives
   */
  private matchesPattern(pattern: string, target: string): boolean {
    if (pattern === '*') {
      return true;
    }

    // Handle pipe-separated alternatives
    if (pattern.includes('|')) {
      const alternatives = pattern.split('|').map((s) => s.trim());
      return alternatives.some((alt) => this.matchesPattern(alt, target));
    }

    // Exact match
    return pattern === target;
  }

  /**
   * Check if a session has any hooks registered
   * @param sessionId Session ID
   * @returns True if session has hooks
   */
  hasSessionHooks(sessionId: string): boolean {
    const storage = this.sessions.get(sessionId);
    if (!storage) {
      return false;
    }

    for (const eventHooks of storage.hooks.values()) {
      if (eventHooks.length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear all hooks for a session
   * @param sessionId Session ID
   */
  clearSessionHooks(sessionId: string): void {
    this.sessions.delete(sessionId);
    debugLogger.debug(`Cleared all hooks for session ${sessionId}`);
  }

  /**
   * Get all session IDs with registered hooks
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get hook count for a session
   */
  getHookCount(sessionId: string): number {
    const storage = this.sessions.get(sessionId);
    if (!storage) {
      return 0;
    }

    let count = 0;
    for (const eventHooks of storage.hooks.values()) {
      count += eventHooks.length;
    }
    return count;
  }
}
