/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  HookOutput,
  PendingAsyncHook,
  AsyncHookOutputMessage,
  PendingAsyncOutput,
} from './types.js';

const debugLogger = createDebugLogger('ASYNC_HOOK_REGISTRY');

/**
 * Default maximum concurrent async hooks
 */
const DEFAULT_MAX_CONCURRENT_HOOKS = 10;

/**
 * Default timeout check interval (5 seconds)
 */
const DEFAULT_TIMEOUT_CHECK_INTERVAL = 5000;

/**
 * Generate a unique hook ID
 */
export function generateHookId(): string {
  return `hook_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Configuration options for AsyncHookRegistry
 */
export interface AsyncHookRegistryOptions {
  maxConcurrentHooks?: number;
  enableAutoTimeoutCheck?: boolean;
  timeoutCheckInterval?: number;
}

/**
 * Async Hook Registry - tracks and manages asynchronously executing hooks
 * with concurrency limits and automatic timeout checking
 */
export class AsyncHookRegistry {
  private readonly pendingHooks: Map<string, PendingAsyncHook> = new Map();
  private readonly completedOutputs: AsyncHookOutputMessage[] = [];
  private readonly completedContexts: string[] = [];
  private readonly maxConcurrentHooks: number;
  private timeoutCheckTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AsyncHookRegistryOptions = {}) {
    this.maxConcurrentHooks =
      options.maxConcurrentHooks ?? DEFAULT_MAX_CONCURRENT_HOOKS;

    // Start automatic timeout checking if enabled
    if (options.enableAutoTimeoutCheck) {
      const interval =
        options.timeoutCheckInterval ?? DEFAULT_TIMEOUT_CHECK_INTERVAL;
      this.startTimeoutChecker(interval);
    }
  }

  /**
   * Start automatic timeout checking
   */
  private startTimeoutChecker(interval: number): void {
    if (this.timeoutCheckTimer) {
      clearInterval(this.timeoutCheckTimer);
    }
    this.timeoutCheckTimer = setInterval(() => {
      this.checkTimeouts();
    }, interval);
  }

  /**
   * Stop automatic timeout checking
   */
  stopTimeoutChecker(): void {
    if (this.timeoutCheckTimer) {
      clearInterval(this.timeoutCheckTimer);
      this.timeoutCheckTimer = undefined;
    }
  }

  /**
   * Get current number of running hooks
   */
  getRunningCount(): number {
    return Array.from(this.pendingHooks.values()).filter(
      (hook) => hook.status === 'running',
    ).length;
  }

  /**
   * Check if we can accept more async hooks
   */
  canAcceptMore(): boolean {
    return this.getRunningCount() < this.maxConcurrentHooks;
  }

  /**
   * Register a new async hook execution
   * @returns hookId if registered, null if rejected due to concurrency limit
   */
  register(hook: Omit<PendingAsyncHook, 'status'>): string | null {
    // Check concurrency limit
    if (!this.canAcceptMore()) {
      debugLogger.warn(
        `Async hook registration rejected: concurrency limit reached (${this.maxConcurrentHooks})`,
      );
      return null;
    }

    const hookId = hook.hookId;
    const pendingHook: PendingAsyncHook = {
      ...hook,
      status: 'running',
    };

    this.pendingHooks.set(hookId, pendingHook);
    debugLogger.debug(
      `Registered async hook: ${hookId} (${hook.hookName}) for event ${hook.hookEvent} [${this.getRunningCount()}/${this.maxConcurrentHooks}]`,
    );

    return hookId;
  }

  /**
   * Update hook output (stdout/stderr)
   */
  updateOutput(hookId: string, stdout?: string, stderr?: string): void {
    const hook = this.pendingHooks.get(hookId);
    if (hook) {
      if (stdout !== undefined) {
        hook.stdout += stdout;
      }
      if (stderr !== undefined) {
        hook.stderr += stderr;
      }
    }
  }

  /**
   * Mark a hook as completed with output
   */
  complete(hookId: string, output?: HookOutput): void {
    const hook = this.pendingHooks.get(hookId);
    if (!hook) {
      debugLogger.warn(`Attempted to complete unknown hook: ${hookId}`);
      return;
    }

    hook.status = 'completed';
    hook.output = output;

    // Process output for delivery
    this.processCompletedOutput(hook);

    // Remove from pending
    this.pendingHooks.delete(hookId);

    debugLogger.debug(`Async hook completed: ${hookId} (${hook.hookName})`);
  }

  /**
   * Mark a hook as failed
   */
  fail(hookId: string, error: Error): void {
    const hook = this.pendingHooks.get(hookId);
    if (!hook) {
      debugLogger.warn(`Attempted to fail unknown hook: ${hookId}`);
      return;
    }

    hook.status = 'failed';
    hook.error = error;

    // Add error message to outputs
    this.completedOutputs.push({
      type: 'error',
      message: `Async hook ${hook.hookName} failed: ${error.message}`,
      hookName: hook.hookName,
      hookId,
      timestamp: Date.now(),
    });

    // Remove from pending
    this.pendingHooks.delete(hookId);

    debugLogger.debug(`Async hook failed: ${hookId} (${hook.hookName})`);
  }

  /**
   * Mark a hook as timed out and terminate the process if running
   */
  timeout(hookId: string): void {
    const hook = this.pendingHooks.get(hookId);
    if (!hook) {
      debugLogger.warn(`Attempted to timeout unknown hook: ${hookId}`);
      return;
    }

    // Terminate the process if it's still running
    if (hook.process && !hook.process.killed) {
      debugLogger.debug(`Terminating process for timed out hook: ${hookId}`);
      // First try graceful termination with SIGTERM
      hook.process.kill('SIGTERM');
      // Force kill with SIGKILL after 2 seconds if still running
      const forceKillTimeout = setTimeout(() => {
        if (hook.process && !hook.process.killed) {
          debugLogger.debug(`Force killing process for hook: ${hookId}`);
          hook.process.kill('SIGKILL');
        }
      }, 2000);
      // Clean up the timeout if process exits
      hook.process.once('exit', () => {
        clearTimeout(forceKillTimeout);
      });
    }

    hook.status = 'timeout';
    hook.error = new Error(`Hook timed out after ${hook.timeout}ms`);

    // Add timeout message to outputs
    this.completedOutputs.push({
      type: 'warning',
      message: `Async hook ${hook.hookName} timed out after ${hook.timeout}ms`,
      hookName: hook.hookName,
      hookId,
      timestamp: Date.now(),
    });

    // Remove from pending
    this.pendingHooks.delete(hookId);

    debugLogger.debug(`Async hook timed out: ${hookId} (${hook.hookName})`);
  }

  /**
   * Get all pending hooks
   */
  getPendingHooks(): PendingAsyncHook[] {
    return Array.from(this.pendingHooks.values());
  }

  /**
   * Get pending hooks for a specific session
   */
  getPendingHooksForSession(sessionId: string): PendingAsyncHook[] {
    return Array.from(this.pendingHooks.values()).filter(
      (hook) => hook.sessionId === sessionId,
    );
  }

  /**
   * Get and clear pending output for delivery to the next turn
   */
  getPendingOutput(): PendingAsyncOutput {
    const output: PendingAsyncOutput = {
      messages: [...this.completedOutputs],
      contexts: [...this.completedContexts],
    };

    // Clear after retrieval
    this.completedOutputs.length = 0;
    this.completedContexts.length = 0;

    return output;
  }

  /**
   * Check if there are any pending outputs
   */
  hasPendingOutput(): boolean {
    return (
      this.completedOutputs.length > 0 || this.completedContexts.length > 0
    );
  }

  /**
   * Check if there are any running hooks
   */
  hasRunningHooks(): boolean {
    return this.pendingHooks.size > 0;
  }

  /**
   * Check for timed out hooks and mark them
   */
  checkTimeouts(): void {
    const now = Date.now();
    for (const [hookId, hook] of this.pendingHooks.entries()) {
      if (hook.status === 'running' && now - hook.startTime > hook.timeout) {
        this.timeout(hookId);
      }
    }
  }

  /**
   * Clear all pending hooks for a session (e.g., on session end)
   */
  clearSession(sessionId: string): void {
    for (const [hookId, hook] of this.pendingHooks.entries()) {
      if (hook.sessionId === sessionId) {
        this.pendingHooks.delete(hookId);
        debugLogger.debug(
          `Cleared async hook on session end: ${hookId} (${hook.hookName})`,
        );
      }
    }
  }

  /**
   * Process completed hook output for delivery
   */
  private processCompletedOutput(hook: PendingAsyncHook): void {
    // Parse stdout for JSON output
    if (hook.stdout) {
      try {
        const parsed = JSON.parse(hook.stdout.trim());

        // Extract system message
        if (parsed.systemMessage && typeof parsed.systemMessage === 'string') {
          this.completedOutputs.push({
            type: 'system',
            message: parsed.systemMessage,
            hookName: hook.hookName,
            hookId: hook.hookId,
            timestamp: Date.now(),
          });
        }

        // Extract additional context
        if (
          parsed.hookSpecificOutput?.additionalContext &&
          typeof parsed.hookSpecificOutput.additionalContext === 'string'
        ) {
          this.completedContexts.push(
            parsed.hookSpecificOutput.additionalContext,
          );
        }
      } catch {
        // Not JSON, treat as plain text message if non-empty
        const trimmed = hook.stdout.trim();
        if (trimmed) {
          this.completedOutputs.push({
            type: 'info',
            message: trimmed,
            hookName: hook.hookName,
            hookId: hook.hookId,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Add stderr as warning if present
    if (hook.stderr && hook.stderr.trim()) {
      this.completedOutputs.push({
        type: 'warning',
        message: hook.stderr.trim(),
        hookName: hook.hookName,
        hookId: hook.hookId,
        timestamp: Date.now(),
      });
    }
  }
}
