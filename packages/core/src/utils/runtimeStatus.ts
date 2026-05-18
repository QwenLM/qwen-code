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
 * - **Not** deleted on clean `/quit` or on crash. From an external
 *   observer's standpoint the recorded PID no longer exists in either
 *   case, so a liveness check is sufficient and an explicit cleanup
 *   adds nothing.
 * - `clearRuntimeStatus` exists for the narrow case where the same PID
 *   keeps running while no longer serving the recorded session
 *   (e.g. a hypothetical future mode-switch). Not currently invoked.
 *
 * The file is written atomically (tmp-file + rename) and contains a
 * small, stable schema. External consumers should treat unknown fields
 * as forward-compatible additions.
 */

import * as fs from 'node:fs/promises';
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

/**
 * Atomically write the runtime status file at `filePath`.
 *
 * Writes via tmp-file + rename so an external observer never sees a
 * partially written file: it sees either the previous contents or the
 * fully committed new contents.
 *
 * The parent directory of `filePath` is created on demand. Exceptions
 * from the underlying I/O propagate to the caller; this function does
 * not log or swallow them. Callers that want best-effort semantics
 * should wrap the call in a try/catch. On failure no leftover `.tmp`
 * file is kept on disk.
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
 * Intentionally **not** called on `/quit` — when the qwen-code process
 * exits, an external observer's PID-liveness check already detects the
 * missing process, so a stale record is harmless. This helper exists
 * for the narrow case where the **same PID continues running** but
 * stops serving the recorded session.
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
