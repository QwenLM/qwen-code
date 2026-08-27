/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime status sidecar for an active interactive Qwen Code session.
 *
 * This module writes a small JSON file alongside the session's chat log
 * while an interactive session is alive. It exists so that **external**
 * tools (terminal multiplexers, tab managers, IDE integrations,
 * observability daemons) can answer the question:
 *
 *     "Which Qwen Code session is the running PID X serving?"
 *
 * The CLI does not embed the session id in `argv` for fresh
 * (non-resumed) sessions, and the OS process title can be truncated, so
 * a side-channel file that records the explicit
 * `(pid, session_id, work_dir, ...)` tuple is the most reliable
 * cross-platform signal.
 *
 * Lifecycle:
 * - Written on session start (clean launch or resume); the resume case
 *   atomically overwrites whatever the previous PID wrote.
 * - Deleted only when the same PID keeps running while no longer
 *   serving the recorded session, such as `/clear`, `/resume`, or a
 *   daemon process closing one session while staying alive for others.
 *   Crashed processes skip deletion; a liveness check is sufficient
 *   there.
 *
 * The file is written via `atomicWriteJSON` (write-to-temp + rename,
 * with in-place fallback when ownership differs).
 * The schema is small and stable; external consumers should treat
 * unknown fields as forward-compatible additions.
 */

import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJSON } from './atomicFileWrite.js';
import { isNodeError } from './errors.js';
import { isPidAlive } from './process-liveness.js';

export const RUNTIME_STATUS_SCHEMA_VERSION = 1;

/** Snapshot of a live Qwen Code session process for external observers. */
export interface RuntimeStatus {
  schemaVersion: number;
  pid: number;
  sessionId: string;
  workDir: string;
  hostname: string;
  /** Epoch seconds (with sub-second precision). Matches kimi-cli's format. */
  startedAt: number;
  qwenVersion: string | null;
}

/**
 * On-disk JSON shape. Keys are snake_case to match the cross-tool
 * convention established by kimi-cli's `runtime.json`, so external
 * observers can use one parser for both ecosystems.
 */
interface RuntimeStatusOnDisk {
  schema_version: number;
  pid: number;
  session_id: string;
  work_dir: string;
  hostname: string;
  started_at: number;
  qwen_version: string | null;
}

export interface WriteRuntimeStatusFields {
  sessionId: string;
  workDir: string;
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Defaults to `null`. Pass the value of `getCliVersion()`. */
  qwenVersion?: string | null;
}

function createRuntimeStatusPayload(
  fields: WriteRuntimeStatusFields,
): RuntimeStatusOnDisk {
  return {
    schema_version: RUNTIME_STATUS_SCHEMA_VERSION,
    pid: fields.pid ?? process.pid,
    session_id: fields.sessionId,
    work_dir: fields.workDir,
    hostname: os.hostname(),
    started_at: Date.now() / 1000,
    qwen_version: fields.qwenVersion ?? null,
  };
}

/**
 * Write the runtime status file at `filePath`.
 *
 * The parent directory is created on demand. Exceptions propagate to
 * the caller; callers that want best-effort semantics should wrap in
 * a try/catch.
 */
export async function writeRuntimeStatus(
  filePath: string,
  fields: WriteRuntimeStatusFields,
): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, createRuntimeStatusPayload(fields));
  return filePath;
}

/**
 * Read the runtime status file at `filePath`, if present.
 *
 * Returns `null` if the file is missing, malformed (truncated UTF-8,
 * invalid JSON, non-object payload, wrong field types), or written by a
 * schema version this code does not understand. The function never
 * coerces null/array/object into a string just to satisfy the
 * dataclass.
 *
 * Note: a returned record only proves that *some* Qwen Code process
 * once claimed this session. The PID may already be dead (clean quit
 * or crash). Consumers must verify liveness themselves before treating
 * the record as a currently-running session.
 */
export async function readRuntimeStatus(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<RuntimeStatus | null> {
  let raw: string;
  try {
    options.signal?.throwIfAborted();
    raw = options.signal
      ? await fs.readFile(filePath, {
          encoding: 'utf-8',
          signal: options.signal,
        })
      : await fs.readFile(filePath, 'utf-8');
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
  options.signal?.throwIfAborted();

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  options.signal?.throwIfAborted();

  return parseRuntimeStatus(data);
}

/** Read every runtime sidecar for `sessionId` in one chats directory. */
export async function readRuntimeStatusClaims(
  chatsDir: string,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ statuses: RuntimeStatus[]; incomplete: boolean }> {
  let entries: syncFs.Dirent[];
  try {
    options.signal?.throwIfAborted();
    entries = await fs.readdir(chatsDir, { withFileTypes: true });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { statuses: [], incomplete: false };
    }
    return { statuses: [], incomplete: true };
  }

  const statuses: RuntimeStatus[] = [];
  let incomplete = false;
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    if (!entry.isFile() || !entry.name.endsWith('.runtime.json')) continue;
    const claimPath = path.join(chatsDir, entry.name);
    const status = await readRuntimeStatus(claimPath, options);
    if (status === null) {
      incomplete = true;
      continue;
    }
    if (status.sessionId === sessionId) {
      statuses.push(status);
    }
  }
  return { statuses, incomplete };
}

/**
 * Synchronous cleanup predicate. Any active local or foreign-host sidecar
 * keeps the entry. `maxAgeMs` is used only by the sweep's early heuristic;
 * its final destructive gate calls without an age limit.
 */
export function hasActiveRuntimeStatusClaimSync(
  chatsDir: string,
  maxAgeMs?: number,
): boolean {
  let entries: syncFs.Dirent[];
  try {
    entries = syncFs.readdirSync(chatsDir, { withFileTypes: true });
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ENOENT');
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.runtime.json')) continue;
    const claimPath = path.join(chatsDir, entry.name);
    try {
      if (
        maxAgeMs !== undefined &&
        Date.now() - syncFs.statSync(claimPath).mtimeMs > maxAgeMs
      ) {
        continue;
      }
      const status = parseRuntimeStatus(
        JSON.parse(syncFs.readFileSync(claimPath, 'utf8')),
      );
      if (status === null || isRuntimeStatusActive(status)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function isRuntimeStatusActive(status: RuntimeStatus): boolean {
  return (
    status.pid > 0 &&
    (status.hostname !== os.hostname() || isPidAlive(status.pid))
  );
}

function parseRuntimeStatus(data: unknown): RuntimeStatus | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;

  // Schema gate first: an unknown schema_version is not our concern.
  if (obj['schema_version'] !== RUNTIME_STATUS_SCHEMA_VERSION) {
    return null;
  }

  const schemaVersion = obj['schema_version'];
  const pid = obj['pid'];
  const sessionId = obj['session_id'];
  const workDir = obj['work_dir'];
  const hostname = obj['hostname'];
  const startedAt = obj['started_at'];
  const qwenVersion = obj['qwen_version'];

  if (!isFiniteInteger(schemaVersion)) return null;
  if (!isFiniteInteger(pid)) return null;
  if (typeof sessionId !== 'string') return null;
  if (typeof workDir !== 'string') return null;
  if (typeof hostname !== 'string') return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return null;
  }
  if (qwenVersion !== null && typeof qwenVersion !== 'string') return null;

  return {
    schemaVersion,
    pid,
    sessionId,
    workDir,
    hostname,
    startedAt,
    qwenVersion,
  };
}

/**
 * Remove the runtime status file at `filePath`, if present.
 *
 * Called only when the **same PID continues running** but stops serving
 * the recorded session.
 *
 * Safe to call multiple times and on paths that no longer exist;
 * `ENOENT` and other `OSError`-class failures are swallowed so cleanup
 * cannot disrupt the surrounding control flow.
 */
export async function clearRuntimeStatus(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignored: best-effort cleanup
  }
}

function isFiniteInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
