/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission Sync — file-based fallback for tool approval when
 * the in-memory leaderPermissionBridge is unavailable (startup
 * race, Phase 2 pane-based agents).
 *
 * Lifecycle:
 *   1. Teammate creates a SwarmPermissionRequest file in
 *      `~/.qwen/teams/{team}/permissions/{id}.json`.
 *   2. Teammate sends a `permission_request` mailbox message
 *      to the leader.
 *   3. Teammate polls the request file at 500ms intervals.
 *   4. Leader reads the request, shows UI, writes response.
 *   5. Teammate picks up the resolved status and proceeds.
 *
 * Concurrency: proper-lockfile protects read-modify-write cycles.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { lock, unlock } from 'proper-lockfile';
import { getTeamDir } from './teamHelpers.js';

// ─── Constants ───────────────────────────────────────────────

const PERMISSIONS_DIR = 'permissions';
const DEFAULT_POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
  stale: 5000,
};

// ─── Types ───────────────────────────────────────────────────

export type PermissionStatus = 'pending' | 'approved' | 'denied';

export interface SwarmPermissionRequest {
  /** Unique request ID. */
  id: string;
  /** Teammate requesting permission. */
  teammateName: string;
  /** Tool that needs approval. */
  toolName: string;
  /** Tool input parameters (for display). */
  toolInput: Record<string, unknown>;
  /** ISO timestamp of the request. */
  requestedAt: string;
  /** Current status. */
  status: PermissionStatus;
  /** Filled in when resolved. */
  response?: {
    outcome: 'approved' | 'denied';
    reason?: string;
    resolvedAt: string;
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function getPermissionsDir(teamName: string): string {
  return path.join(getTeamDir(teamName), PERMISSIONS_DIR);
}

function getRequestPath(teamName: string, requestId: string): string {
  return path.join(getPermissionsDir(teamName), `${requestId}.json`);
}

let nextRequestId = 1;

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `perm-${Date.now()}-${nextRequestId++}`;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Create a permission request file. Returns the request ID.
 */
export async function createPermissionRequest(
  teamName: string,
  teammateName: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  const dir = getPermissionsDir(teamName);
  await fs.mkdir(dir, { recursive: true });

  const id = generateRequestId();
  const request: SwarmPermissionRequest = {
    id,
    teammateName,
    toolName,
    toolInput,
    requestedAt: new Date().toISOString(),
    status: 'pending',
  };

  await fs.writeFile(
    getRequestPath(teamName, id),
    JSON.stringify(request, null, 2),
  );

  return id;
}

/**
 * Read a permission request by ID. Returns null if not found.
 */
export async function readPermissionRequest(
  teamName: string,
  requestId: string,
): Promise<SwarmPermissionRequest | null> {
  const filePath = getRequestPath(teamName, requestId);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as SwarmPermissionRequest;
  } catch {
    return null;
  }
}

/**
 * Resolve a pending permission request (leader writes outcome).
 * Uses file locking for safe concurrent access.
 */
export async function resolvePermissionRequest(
  teamName: string,
  requestId: string,
  outcome: 'approved' | 'denied',
  reason?: string,
): Promise<void> {
  const filePath = getRequestPath(teamName, requestId);
  const dir = getPermissionsDir(teamName);

  await lock(dir, LOCK_OPTIONS);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const request = JSON.parse(data) as SwarmPermissionRequest;

    if (request.status !== 'pending') {
      return; // Already resolved — no-op.
    }

    request.status = outcome;
    request.response = {
      outcome,
      reason,
      resolvedAt: new Date().toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(request, null, 2));
  } finally {
    await unlock(dir, {});
  }
}

/**
 * Poll a permission request until it's resolved or times out.
 * Returns the final request state.
 *
 * Throws if the request is not found or times out.
 */
export async function waitForPermissionResponse(
  teamName: string,
  requestId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_MS,
): Promise<SwarmPermissionRequest> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const request = await readPermissionRequest(teamName, requestId);

    if (!request) {
      throw new Error(`Permission request "${requestId}" not found.`);
    }

    if (request.status !== 'pending') {
      return request;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Permission request "${requestId}" timed out ` + `after ${timeoutMs}ms.`,
  );
}

/**
 * Clean up all permission request files for a team.
 */
export async function clearPermissions(teamName: string): Promise<void> {
  const dir = getPermissionsDir(teamName);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist — ignore.
  }
}

/**
 * Reset the request ID counter (for testing).
 */
export function resetRequestIdCounter(): void {
  nextRequestId = 1;
}
