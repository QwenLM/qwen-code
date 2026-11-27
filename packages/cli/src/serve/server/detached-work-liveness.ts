/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dir } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { isNodeError } from '@qwen-code/qwen-code-core/utils/errors.js';
import { openNoFollow } from '@qwen-code/qwen-code-core/utils/no-follow-open.js';
import { getProjectHash } from '@qwen-code/qwen-code-core/utils/paths.js';
import {
  isZombie,
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
} from '@qwen-code/qwen-code-core/utils/process-liveness.js';

/**
 * Detached background-shell liveness for persisted sessions (#17819).
 *
 * A session whose owning CLI process died can leave `running` shell sidecars
 * behind — the registry settles sidecars on graceful exit only (see
 * `settleAsCancelled`), so a hard kill orphans them. The session list needs
 * to know whether such a shell is still running to warn about delete, but it
 * has no live entry to ask. This resolver reads the sidecars from disk:
 *
 * - `<projectTempDir>/background-shells/<sessionId>/shell-*.status`
 * - `running` and `cancelled` claims, plus `failed` records with a process
 *   token, are checked against the identity captured at shell registration.
 *
 * Deliberately best-effort: every failure mode degrades to `unknown` or to
 * "no detached work" — never an error — because this runs inside the session
 * list response path. The client treats `unknown` as a hint, not a block.
 */

export type DetachedBackgroundWork = 'running' | 'unknown';

export type ProcessProbe = 'alive-verified' | 'alive-unverified' | 'dead';

export type ProcessInspector = (
  pid: number,
  procStart?: string,
  pidNs?: number,
) => ProcessProbe;

const DEFAULT_CACHE_TTL_MS = 45_000;
const MAX_SESSIONS_PER_REFRESH = 100;
const MAX_DIRECTORY_ENTRIES = 128;
// Reads exceed probes 2:1 so the verified "129 accumulated terminal records
// before a live shell" shape stays fully classified; beyond this cap the
// verdict falls back to `unknown` and the leak is retention's problem.
const MAX_STATUS_FILE_READS = 256;
const MAX_STATUS_BYTES = 16 * 1024;

const defaultInspector: ProcessInspector = (pid, procStart, pidNs) => {
  // Consult every identity claim the record carries before trusting the
  // local pid table: a pid from a foreign namespace (shared runtime
  // directory) may vanish from — or collide with — this host's table, so
  // ESRCH there proves nothing about the recorded shell (#17819).
  const localPidNs = readPidNamespaceId();
  if (pidNs !== undefined && (localPidNs === null || localPidNs !== pidNs)) {
    return 'alive-unverified';
  }
  // On Linux a null namespace read means procfs failed — not that namespaces
  // don't exist. The record's namespace is then unconfirmable, and sibling
  // containers sharing this runtime directory make the local pid table
  // meaningless. Only platforms without pid namespaces at all may settle
  // verdicts from the local table alone (#17819).
  const pidNamespacesUnsupported = process.platform !== 'linux';
  if (procStart === undefined) {
    if (!pidNamespacesUnsupported && pidNs === undefined) {
      return 'alive-unverified';
    }
    // A namespace claim without its paired start token cannot anchor the
    // shell to any host: the record may have been written by a machine
    // sharing this runtime directory, so a local ESRCH proves nothing
    // (#17819).
    if (pidNs !== undefined) {
      return 'alive-unverified';
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      return isNodeError(error) && error.code === 'ESRCH'
        ? 'dead'
        : 'alive-unverified';
    }
    return 'alive-unverified';
  }
  if (!pidNamespacesUnsupported && pidNs === undefined) {
    // Start token without a confirmable namespace claim: the boot id is
    // shared by every container on the machine, so the token alone cannot
    // rule out a foreign-namespace shell (#17819).
    return 'alive-unverified';
  }
  const [recordedBootId, startTicks, extra] = procStart.split(':');
  const bootId = readLocalBootId();
  if (
    bootId === null ||
    recordedBootId !== bootId ||
    startTicks === undefined ||
    !/^\d+$/.test(startTicks) ||
    extra !== undefined
  ) {
    return 'alive-unverified';
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isNodeError(error) && error.code === 'ESRCH'
      ? 'dead'
      : 'alive-unverified';
  }
  const currentStart = readProcStartToken(pid);
  if (currentStart === null) return 'alive-unverified';
  return currentStart === procStart && !isZombie(pid)
    ? 'alive-verified'
    : 'dead';
};

interface DetachedWorkProbeOptions {
  sessionIds: readonly string[];
  projectTempDir: string;
  liveSince?: ReadonlyMap<string, number>;
  signal?: AbortSignal;
  inspector?: ProcessInspector;
  now?: number;
  cacheTtlMs?: number;
  maxSessionsPerRefresh?: number;
}

interface CacheEntry {
  liveSince: number | undefined;
  verdict: DetachedBackgroundWork | undefined;
  expiresAt: number;
}

// Repeated catalog reads share results keyed by temp dir and session.
const probeCache = new Map<string, CacheEntry>();

function shellsDirFor(projectTempDir: string, sessionId: string): string {
  return path.join(projectTempDir, 'background-shells', sessionId);
}

const SHELL_STATUS_PATTERN = /^shell-.+\.status$/;

/**
 * The project temp dir a workspace's shell sidecars live under. Must be
 * called inside the resolved-runtime `Storage.runWithResolvedRuntimeBaseDir`
 * scope that every session-list path already runs in.
 */
export function projectTempDirFor(workspaceCwd: string): string {
  return path.join(Storage.getGlobalTempDir(), getProjectHash(workspaceCwd));
}

async function readStatusFile(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const file = await openNoFollow(filePath, { nonBlocking: true });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return undefined;
    const payload: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    )
      return undefined;
    return payload as Record<string, unknown>;
  } finally {
    await file.close();
  }
}

/**
 * One session's detached-shell verdict: `'running'` when any sidecar claims
 * a running shell with a verified-live pid, `'unknown'` when a running
 * claim could not be settled either way, undefined when the session has no
 * sidecars or every running claim was disproven.
 */
async function probeSession(
  sessionId: string,
  projectTempDir: string,
  liveSince: number | undefined,
  inspector: ProcessInspector,
  signal?: AbortSignal,
): Promise<DetachedBackgroundWork | undefined> {
  const directory = shellsDirFor(projectTempDir, sessionId);
  let entries: Dir;
  try {
    if (!(await fsp.lstat(directory)).isDirectory()) return 'unknown';
    entries = await fsp.opendir(directory);
  } catch (error) {
    return isNodeError(error) && error.code === 'ENOENT'
      ? undefined
      : 'unknown';
  }
  let unknown = false;
  let reads = 0;
  let probes = 0;
  try {
    for await (const entry of entries) {
      signal?.throwIfAborted();
      // Directory noise (output files, temp droppings) never consumes either
      // budget: unrelated entries must not push a real verdict to `unknown`
      // (#17819).
      if (!SHELL_STATUS_PATTERN.test(entry.name)) continue;
      // The read budget bounds cold-cache disk traffic per session, since
      // sidecars are never unlinked and terminal records keep accumulating.
      // The probe budget bounds process inspection. Both are conservative:
      // exhausting one without a verdict reports `unknown`, never `idle`.
      // A running shell beyond the read cap stays undiscovered — retention
      // of historical sidecars must keep directories below this bound.
      if (++reads > MAX_STATUS_FILE_READS) return 'unknown';
      const sidecar = entry.isFile()
        ? await readStatusFile(path.join(directory, entry.name)).catch(
            () => undefined,
          )
        : undefined;
      const startTime = sidecar?.['startTime'];
      // A shell started in the current live session is already tracked by
      // its registry. A missing or unreadable timestamp proves no ownership.
      if (
        liveSince !== undefined &&
        typeof startTime === 'string' &&
        Date.parse(startTime) >= liveSince
      ) {
        continue;
      }
      const status = sidecar?.['status'];
      const procStart = sidecar?.['procStart'];
      if (
        status === 'completed' ||
        (status === 'failed' && procStart === undefined)
      )
        continue;
      // Cancellation and transport errors can be recorded before exit.
      if (
        status !== 'running' &&
        status !== 'cancelled' &&
        status !== 'failed'
      ) {
        unknown = true;
        continue;
      }
      const pid = sidecar?.['pid'];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        unknown = true;
        continue;
      }
      // Charge the probe budget only where the probe happens. Records
      // classified above as settled — completed, failed without a procStart,
      // or started in the current live session — never reach a probe, so the
      // sidecars a long-lived session accumulates cannot exhaust it and
      // force a spurious permanent `unknown`. Cancelled records and failed
      // records carrying a procStart still probe: they can predate exit.
      if (++probes > MAX_DIRECTORY_ENTRIES) return 'unknown';
      const pidNs = sidecar?.['pidNs'];
      const probe = inspector(
        pid,
        typeof procStart === 'string' ? procStart : undefined,
        typeof pidNs === 'number' ? pidNs : undefined,
      );
      if (probe === 'alive-verified') return 'running';
      if (probe === 'alive-unverified') unknown = true;
    }
  } catch {
    signal?.throwIfAborted();
    return 'unknown';
  }
  return unknown ? 'unknown' : undefined;
}

/**
 * Resolves the detached background-shell signal for the given persisted
 * sessions. Returns only sessions with a verdict; absent = no detached
 * work observed. Results are cached for `cacheTtlMs` (absent verdicts
 * included — the cache bounds both disk scans and pid probes), and at most
 * `maxSessionsPerRefresh` uncached sessions are probed per call so a huge
 * catalog cannot turn one list request into a scan storm; the rest roll
 * over to later refreshes.
 */
export async function resolveDetachedBackgroundWork(
  options: DetachedWorkProbeOptions,
): Promise<ReadonlyMap<string, DetachedBackgroundWork>> {
  const now = options.now ?? Date.now();
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cap = options.maxSessionsPerRefresh ?? MAX_SESSIONS_PER_REFRESH;
  const inspector = options.inspector ?? defaultInspector;

  for (const [key, entry] of probeCache) {
    if (entry.expiresAt <= now) probeCache.delete(key);
  }

  const results = new Map<string, DetachedBackgroundWork>();
  const pending: Array<{ sessionId: string; liveSince: number | undefined }> =
    [];
  for (const sessionId of options.sessionIds) {
    const liveSince = options.liveSince?.get(sessionId);
    const cached = probeCache.get(`${options.projectTempDir}\0${sessionId}`);
    if (cached && cached.liveSince === liveSince) {
      if (cached.verdict !== undefined) {
        results.set(sessionId, cached.verdict);
      }
    } else {
      pending.push({ sessionId, liveSince });
    }
  }

  for (const { sessionId, liveSince } of pending.slice(0, cap)) {
    options.signal?.throwIfAborted();
    const verdict = await probeSession(
      sessionId,
      options.projectTempDir,
      liveSince,
      inspector,
      options.signal,
    );
    options.signal?.throwIfAborted();
    probeCache.set(`${options.projectTempDir}\0${sessionId}`, {
      liveSince,
      verdict,
      expiresAt: now + ttl,
    });
    if (verdict !== undefined) results.set(sessionId, verdict);
  }
  return results;
}

/** Test seam: drops every cached verdict. */
export function resetDetachedWorkProbeCache(): void {
  probeCache.clear();
}
