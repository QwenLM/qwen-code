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
 * - Written on session start (clean launch or resume). When another process
 *   already holds the canonical sidecar for the same session id (concurrent
 *   --resume), each process keeps an independent claim.
 * - On clean exit of the claiming process the record is demoted, not
 *   deleted: `releaseRuntimeStatus` rewrites it with the non-live
 *   sentinel pid 0, keeping the `session_id`/`work_dir` membership
 *   evidence that session lookup consults for `/cd`-relocated sessions
 *   (the sweep's liveness gates reject pid <= 0, so the session is
 *   seen as closed). Crashed processes skip the demotion; a liveness
 *   check suffices there.
 * - `clearRuntimeStatus` remains for the narrow case where the same
 *   PID keeps running while no longer serving the recorded session
 *   and no membership evidence needs to survive.
 *
 * Ordinary owner refreshes use `atomicWriteJSON`; ownership transitions use
 * create-only hard-link commits so racing claims cannot overwrite each other.
 * The schema is small and stable; external consumers should treat
 * unknown fields as forward-compatible additions.
 */

import { randomBytes } from 'node:crypto';
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
 * Atomically claim a runtime status path without replacing a live sibling.
 *
 * The canonical path is preferred. If another process already owns it, this
 * process writes a uniquely named sidecar in the same chats directory; sweep
 * liveness discovery scans every `*.runtime.json` file, so both processes keep
 * independent on-disk evidence. The returned path is the claim the caller owns
 * and must later pass to `releaseRuntimeStatus`.
 */
export async function claimRuntimeStatus(
  filePath: string,
  fields: WriteRuntimeStatusFields,
): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = createRuntimeStatusPayload(fields);
  if (await createOnlyRuntimeStatus(filePath, payload)) {
    return filePath;
  }

  const existing = await readRuntimeStatus(filePath);
  if (existing !== null && isPidAlive(existing.pid)) {
    return createSiblingClaim(filePath, payload);
  }

  const displacedPath = siblingPath(filePath, 'displaced');
  try {
    await fs.rename(filePath, displacedPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    if (await createOnlyRuntimeStatus(filePath, payload)) return filePath;
    return createSiblingClaim(filePath, payload);
  }

  const displaced = await readRuntimeStatus(displacedPath);
  if (displaced !== null && isPidAlive(displaced.pid)) {
    await restoreRuntimeStatus(displacedPath, filePath);
    return createSiblingClaim(filePath, payload);
  }

  let claimed: boolean;
  try {
    claimed = await createOnlyRuntimeStatus(filePath, payload);
  } catch (error) {
    await restoreRuntimeStatus(displacedPath, filePath).catch(() => {});
    throw error;
  }
  if (claimed) {
    await fs.unlink(displacedPath).catch(() => {});
    return filePath;
  }

  await fs.unlink(displacedPath).catch(() => {});
  return createSiblingClaim(filePath, payload);
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

/**
 * Release the runtime claim at `filePath` on clean session shutdown.
 *
 * Demotes rather than deletes: the record is rewritten with the
 * non-live sentinel pid 0, so liveness gates see the session as closed
 * while the `session_id`/`work_dir` membership evidence survives for
 * `/cd`-relocated session lookup. Only the claim THIS process
 * established is released — a record holding a foreign pid is put back
 * untouched.
 *
 * The release is fenced by a rename: a claim landing on the original
 * path after the fence belongs to a sibling and wins, so a racing
 * claim cannot be destroyed between the ownership check and the
 * rewrite. Best-effort throughout; never throws.
 */
export async function releaseRuntimeStatus(filePath: string): Promise<void> {
  const stagingPath = siblingPath(filePath, 'releasing');
  try {
    try {
      await fs.rename(filePath, stagingPath);
    } catch {
      return; // already gone — nothing to release
    }
    const claim = await readRuntimeStatus(stagingPath);
    if (claim === null || claim.pid !== process.pid) {
      // Not our claim (or unreadable) — put it back exactly as found.
      await restoreRuntimeStatus(stagingPath, filePath);
      return;
    }
    try {
      await createOnlyRuntimeStatus(
        filePath,
        createRuntimeStatusPayload({
          sessionId: claim.sessionId,
          workDir: claim.workDir,
          pid: 0,
          qwenVersion: claim.qwenVersion,
        }),
      );
    } catch {
      await restoreRuntimeStatus(stagingPath, filePath).catch(() => {});
      return;
    }
    // EEXIST means a sibling claimed the original path after the rename fence.
    // Its claim wins; either way the staged copy is ours and can be discarded.
    await fs.unlink(stagingPath).catch(() => {});
  } catch {
    // ignored: best-effort release
  }
}

async function createSiblingClaim(
  filePath: string,
  payload: RuntimeStatusOnDisk,
): Promise<string> {
  for (;;) {
    const claimPath = siblingPath(filePath, 'claim');
    if (await createOnlyRuntimeStatus(claimPath, payload)) return claimPath;
  }
}

async function restoreRuntimeStatus(
  stagedPath: string,
  preferredPath: string,
): Promise<void> {
  if (await linkCreateOnly(stagedPath, preferredPath)) {
    await fs.unlink(stagedPath).catch(() => {});
    return;
  }
  for (;;) {
    const claimPath = siblingPath(preferredPath, 'claim');
    if (await linkCreateOnly(stagedPath, claimPath)) {
      await fs.unlink(stagedPath).catch(() => {});
      return;
    }
  }
}

function siblingPath(filePath: string, kind: string): string {
  const suffix = '.runtime.json';
  const stem = filePath.endsWith(suffix)
    ? filePath.slice(0, -suffix.length)
    : filePath;
  return `${stem}.${kind}-${randomBytes(8).toString('hex')}${suffix}`;
}

async function createOnlyRuntimeStatus(
  filePath: string,
  payload: RuntimeStatusOnDisk,
): Promise<boolean> {
  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      flush: true,
    });
    return await linkCreateOnly(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function linkCreateOnly(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    await fs.link(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw error;
  }
}

function isFiniteInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
