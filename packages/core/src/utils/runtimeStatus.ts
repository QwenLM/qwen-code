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
 * - Marked inactive with an owner check when the same process stops serving a
 *   session. The retained workDir is the durable location marker for sessions
 *   moved by `/cd`.
 * - A crash can leave a stale file. External observers still verify PID
 *   liveness before treating the record as current.
 *
 * The file is written via `atomicWriteJSON` (write-to-temp + rename,
 * with in-place fallback when ownership differs).
 * The schema is small and stable; external consumers should treat
 * unknown fields as forward-compatible additions.
 */

import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJSON } from './atomicFileWrite.js';

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
  ownerId?: string;
  active: boolean;
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
  owner_id?: string;
  active?: boolean;
}

export interface WriteRuntimeStatusFields {
  sessionId: string;
  workDir: string;
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Defaults to `null`. Pass the value of `getCliVersion()`. */
  qwenVersion?: string | null;
  ownerId?: string;
  active?: boolean;
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
  const payload: RuntimeStatusOnDisk = {
    schema_version: RUNTIME_STATUS_SCHEMA_VERSION,
    pid: fields.pid ?? process.pid,
    session_id: fields.sessionId,
    work_dir: fields.workDir,
    hostname: os.hostname(),
    started_at: Date.now() / 1000,
    qwen_version: fields.qwenVersion ?? null,
    ...(fields.ownerId ? { owner_id: fields.ownerId } : {}),
    active: fields.active ?? true,
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, payload);
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
): Promise<RuntimeStatus | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

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
  const ownerId = obj['owner_id'];
  const active = obj['active'];

  if (!isFiniteInteger(schemaVersion)) return null;
  if (!isFiniteInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof workDir !== 'string' || workDir.length === 0) return null;
  if (typeof hostname !== 'string' || hostname.length === 0) return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return null;
  }
  if (qwenVersion !== null && typeof qwenVersion !== 'string') return null;
  if (
    ownerId !== undefined &&
    (typeof ownerId !== 'string' || ownerId.length === 0)
  ) {
    return null;
  }
  if (active !== undefined && typeof active !== 'boolean') return null;

  return {
    schemaVersion,
    pid,
    sessionId,
    workDir,
    hostname,
    startedAt,
    qwenVersion,
    ...(ownerId ? { ownerId } : {}),
    active: active ?? true,
  };
}

async function restoreRuntimeStatusAside(
  asidePath: string,
  filePath: string,
): Promise<void> {
  try {
    await fs.link(asidePath, filePath);
    await fs.unlink(asidePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await fs.unlink(asidePath).catch(() => {});
      return;
    }
    try {
      const raw = await fs.readFile(asidePath);
      await fs.writeFile(filePath, raw, { flag: 'wx', mode: 0o600 });
      await fs.unlink(asidePath).catch(() => {});
    } catch (restoreError) {
      if ((restoreError as NodeJS.ErrnoException).code === 'EEXIST') {
        await fs.unlink(asidePath).catch(() => {});
      }
    }
  }
}

export async function deactivateRuntimeStatus(
  filePath: string,
  ownerId: string | undefined,
): Promise<void> {
  if (!ownerId) return;
  const asidePath = `${filePath}.deactivating.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(filePath, asidePath);
  } catch {
    return;
  }

  const status = await readRuntimeStatus(asidePath);
  if (status?.ownerId !== ownerId) {
    await restoreRuntimeStatusAside(asidePath, filePath);
    return;
  }

  const inactive: RuntimeStatusOnDisk = {
    schema_version: status.schemaVersion,
    pid: status.pid,
    session_id: status.sessionId,
    work_dir: status.workDir,
    hostname: status.hostname,
    started_at: status.startedAt,
    qwen_version: status.qwenVersion,
    owner_id: ownerId,
    active: false,
  };
  try {
    await fs.writeFile(filePath, JSON.stringify(inactive, null, 2), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    await fs.unlink(asidePath).catch(() => {});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await fs.unlink(asidePath).catch(() => {});
      return;
    }
    await restoreRuntimeStatusAside(asidePath, filePath);
  }
}

/**
 * Remove the runtime status file at `filePath`, if present.
 *
 * When qwen-code exits unexpectedly, an external observer's PID-liveness check detects the
 * stale process. This helper also covers the case where the **same PID
 * continues running** but stops serving the recorded session.
 *
 * Safe to call multiple times and on paths that no longer exist;
 * `ENOENT` and other `OSError`-class failures are swallowed so cleanup
 * cannot disrupt the surrounding control flow.
 */
export async function clearRuntimeStatus(
  filePath: string,
  ownerId?: string,
): Promise<void> {
  if (ownerId === undefined) {
    await fs.unlink(filePath).catch(() => {});
    return;
  }

  const asidePath = `${filePath}.clearing.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(filePath, asidePath);
  } catch {
    return;
  }

  const status = await readRuntimeStatus(asidePath);
  if (status?.ownerId === ownerId) {
    await fs.unlink(asidePath).catch(() => {});
    return;
  }

  await restoreRuntimeStatusAside(asidePath, filePath);
}

function isFiniteInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
