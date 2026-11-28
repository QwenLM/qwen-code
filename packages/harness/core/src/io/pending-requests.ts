/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview PendingRequestManager — bidirectional control protocol support.
 *
 * When the CLI needs a decision from the SDK parent process (e.g., tool
 * permission), it sends a `control_request` with a unique `request_id` to
 * stdout and waits for a matching `control_response` from stdin.
 *
 * This manager tracks pending requests and resolves/rejects their Promises
 * when the matching response arrives.
 *
 *   - sendRequest() creates a pending Promise and returns it
 *   - resolve() matches by request_id and resolves the Promise
 *   - reject() matches by request_id and rejects the Promise
 *   - cancel() sends a control_cancel_request and rejects the Promise
 */

import { randomUUID } from 'node:crypto';
import { runLogger } from '../utils/runLogger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingEntry<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  createdAt: number;
}

export const DEFAULT_PERMISSION_RESOLUTION_KIND = 'tool_use';

// ---------------------------------------------------------------------------
// PendingRequestManager
// ---------------------------------------------------------------------------

export class PendingRequestManager {
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * A set of resolved tool permission requests to prevent duplicate processing.
   * Uses FIFO eviction to cap memory usage.
   */
  private readonly resolvedPermissionKeys = new Set<string>();
  private static readonly MAX_RESOLVED_TRACKING = 1000;

  /**
   * Create a pending request and return { requestId, promise }.
   *
   * The returned promise resolves when `resolve(requestId, result)` is called
   * (typically when a matching control_response arrives from stdin), or rejects
   * when `reject(requestId, reason)` / `cancel(requestId)` is called.
   *
   * @param signal Optional abort signal to auto-reject on abort
   */
  createRequest<T = unknown>(
    signal?: AbortSignal,
  ): {
    requestId: string;
    promise: Promise<T>;
  } {
    return this.createRequestWithId(randomUUID(), signal);
  }

  /**
   * Create a pending request using an existing protocol correlation id.
   *
   * Permission requests already have a scheduler/tool-use id. Reusing it at
   * the control boundary keeps every controller and persisted pending action
   * correlated to the same request without an alias table.
   */
  createRequestWithId<T = unknown>(
    requestId: string,
    signal?: AbortSignal,
  ): {
    requestId: string;
    promise: Promise<T>;
  } {
    if (!requestId || this.pending.has(requestId)) {
      throw new Error(`Pending request id is invalid or duplicated: ${requestId}`);
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        createdAt: Date.now(),
      });

      // Auto-reject on abort
      if (signal) {
        const onAbort = () => {
          if (this.pending.has(requestId)) {
            this.pending.delete(requestId);
            reject(new Error('Request aborted'));
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });

    return { requestId, promise };
  }

  /**
   * Resolve a pending request by its request_id.
   *
   * @returns true if a matching pending request was found and resolved.
   */
  resolve(requestId: string, result: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      runLogger.warn(
        `[PendingRequestManager] No pending request for id="${requestId}" (orphan response)`,
      );
      return false;
    }
    this.pending.delete(requestId);
    entry.resolve(result);
    return true;
  }

  /**
   * Reject a pending request by its request_id.
   *
   * @returns true if a matching pending request was found and rejected.
   */
  reject(requestId: string, reason: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    this.pending.delete(requestId);
    entry.reject(reason);
    return true;
  }

  /**
   * Cancel all pending requests (e.g., on session teardown).
   */
  cancelAll(reason = 'Session terminated'): void {
    for (const [requestId, entry] of this.pending) {
      entry.reject(new Error(reason));
      runLogger.log(
        `[PendingRequestManager] Cancelled pending request id="${requestId}"`,
      );
    }
    this.pending.clear();
  }

  /**
   * Track a resolved tool_use_id to prevent duplicate processing.
   * Different permission kinds for the same tool_use_id are distinct requests.
   * Evicts oldest entries when exceeding the limit (FIFO).
   */
  trackResolvedToolUseId(
    toolUseId: string,
    permissionKind = DEFAULT_PERMISSION_RESOLUTION_KIND,
  ): void {
    const resolvedKey = buildResolvedToolUseKey(toolUseId, permissionKind);
    if (this.resolvedPermissionKeys.has(resolvedKey)) {
      return;
    }
    if (
      this.resolvedPermissionKeys.size >=
      PendingRequestManager.MAX_RESOLVED_TRACKING
    ) {
      // Evict oldest (first inserted)
      const first = this.resolvedPermissionKeys.values().next().value;
      if (first) this.resolvedPermissionKeys.delete(first);
    }
    this.resolvedPermissionKeys.add(resolvedKey);
  }

  /**
   * Check if a tool_use_id has already been resolved.
   */
  isToolUseIdResolved(
    toolUseId: string,
    permissionKind = DEFAULT_PERMISSION_RESOLUTION_KIND,
  ): boolean {
    return this.resolvedPermissionKeys.has(
      buildResolvedToolUseKey(toolUseId, permissionKind),
    );
  }

  /**
   * Get the request_ids of all currently pending requests.
   * Used by interrupt handling to send control_cancel_request to the SDK.
   */
  getPendingRequestIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * Get the number of currently pending requests.
   */
  get size(): number {
    return this.pending.size;
  }
}

function buildResolvedToolUseKey(
  toolUseId: string,
  permissionKind: string,
): string {
  return `${permissionKind}:${toolUseId}`;
}
