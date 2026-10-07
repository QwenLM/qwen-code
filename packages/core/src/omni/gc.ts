/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';
import type { MediaMemoryService } from '../services/media-memory/service.js';
import type { MediaResourceRegistry } from '../services/media-memory/registry.js';
import type { OmniObjectStore } from './storage.js';
import type { OmniUploadCache } from './upload-cache.js';
import type { OmniDegradationCache } from './policy/degradation-cache.js';
import { effectiveMaxUploadFileBytes } from './guard.js';
import { MEDIA_MEMORY_FILE_NAME } from '../services/media-memory/store.js';

const debugLogger = createDebugLogger('omni:gc');

/**
 * Mark-and-sweep GC over the content-addressed object store (storage
 * design §6.2). The design's two hard rules shape everything here:
 *
 * 1. **An unreadable ledger deletes nothing.** The root set comes from the
 *    memory snapshot; if that snapshot cannot be read, the GC has no way
 *    to tell "unreferenced" from "unknown" and skips the run entirely.
 * 2. **A referenced object is never deleted, even over budget.** Deleting
 *    it would leave memory records pointing at nothing — recall would
 *    report `artifact_unavailable` for artifacts the user paid for and the
 *    ledger still vouches for. Budget pressure is answered by suspending
 *    NEW derivations (policy design §8.4's budget-stop semantics), never
 *    by rewriting history.
 *
 * Sweep order is oldest-first so the budget pass converges on the objects
 * least likely to be re-used. Every deletion cascades into the upload
 * cache and the degradation cache — a cache hit must never point at bytes
 * that are gone (same invariant the recovery scan's corrupt-object path
 * already enforces).
 *
 * Multi-process safety is layered. New BYTES are covered by the
 * retention window (deletion in pass 1 requires BOTH "no reference in
 * the snapshot" and "older than the window", so another process's
 * just-promoted object survives on age alone — same argument as startup
 * recovery). New REFERENCES to old bytes are covered by touch-on-dedup:
 * every reference is preceded by a `putFile` whose dedup hit refreshes
 * the object's mtime before the commit lands, and both passes re-stat a
 * candidate at delete time (the budget pass — where age protects
 * nothing — additionally re-reads the ledger for a fresh root set).
 * The residual window is the moment between the re-stat and the rm,
 * down from the whole sweep duration. The once-per-root latch is
 * process-local by design; two processes GCing the same store can only
 * disagree toward "delete less".
 */

/** Object-file shape inside a shard: `<64-hex>.<extension>`. Anything else
 * (promotion temps, strays) belongs to the recovery scan, not the GC. */
const OBJECT_NAME_RE = /^([0-9a-f]{64})\.[A-Za-z0-9][A-Za-z0-9.]*$/;

export interface OmniGcOptions {
  store: OmniObjectStore;
  memoryService: MediaMemoryService;
  /** Live session bindings — roots alongside the snapshot (a resource
   * delivered this turn may be bound before its memory commit lands). */
  registry?: MediaResourceRegistry;
  uploadCache?: OmniUploadCache;
  degradationCache?: OmniDegradationCache;
  /** Days an unreferenced object survives after promotion. */
  retentionDays: number;
  /** Soft byte budget for objects/; over-budget triggers oldest-first
   * deletion of unreferenced objects regardless of age. */
  maxTotalBytes: number;
  /** Test seam: "now" in epoch ms. */
  nowMs?: number;
}

export interface OmniGcResult {
  /** False when the run was skipped (unreadable snapshot / latch). */
  ran: boolean;
  deletedObjects: number;
  deletedBytes: number;
  /** Bytes remaining in objects/ after the sweep. */
  remainingBytes: number;
  /** True when the store is still over budget with only referenced
   * objects left — new derivations are suspended until a later run
   * clears it. */
  derivationsSuspended: boolean;
}

const SKIPPED: OmniGcResult = {
  ran: false,
  deletedObjects: 0,
  deletedBytes: 0,
  remainingBytes: 0,
  derivationsSuspended: false,
};

/** One GC per store root per process lifetime (same latch pattern as
 * startup recovery); the suspension flag lives beside it so the
 * orchestrator can consult it without holding a GC reference. */
const gcOnce = new Map<string, Promise<OmniGcResult>>();
const suspendedRoots = new Set<string>();

/** Test-only: allow re-running GC within one process. Pass
 * `keepSuspension` to re-arm the run latch while leaving the suspension
 * flag standing — the only way to prove a later run actually CLEARS it
 * (a full reset would make that assertion vacuous). */
export function resetGcLatchForTests(options?: {
  keepSuspension?: boolean;
}): void {
  gcOnce.clear();
  if (!options?.keepSuspension) suspendedRoots.clear();
}

/**
 * Effective byte budget for the sweep (storage design §7): never below
 * 10× the transport guard's single-media ceiling. A budget smaller than
 * a handful of normal uploads cannot hold legitimate experiment
 * artifacts — the first referenced object would tip it into permanent
 * derivation suspension, which reads as a broken pipeline rather than a
 * configuration mistake.
 */
export function effectiveOmniStorageMaxTotalBytes(config: Config): number {
  const configured = config.getOmniStorageMaxTotalBytes();
  const floor = 10 * effectiveMaxUploadFileBytes(config);
  if (configured < floor) {
    debugLogger.warn(
      `omni.storage.maxTotalBytes (${configured}) is below 10× the ` +
        `transport guard's single-media limit; using ${floor} bytes ` +
        `instead (the budget must hold at least ten normal uploads).`,
    );
    return floor;
  }
  return configured;
}

/**
 * Whether new policy derivations are suspended for this store (storage
 * design §6.2: over budget with only referenced objects left). Consulted
 * by the orchestrator before executing a policy tool; reuse and cache
 * hits stay allowed — they produce no new bytes.
 */
export function isOmniDerivationSuspended(omniRootDir: string): boolean {
  return suspendedRoots.has(path.resolve(omniRootDir));
}

/**
 * Await this process's in-flight GC for a store root, if one was started.
 * The startup wiring runs the GC fire-and-forget so delivery is never
 * blocked on a sweep — but the budget gate MUST NOT be consulted while
 * the sweep that sets the suspension flag is still running, or the first
 * derivation of every fresh process races past the budget (observed in
 * E2E: one headless run wrote new derivatives before the over-budget
 * verdict landed ~900ms later). Awaiting the settled run costs nothing
 * when the GC already finished and never rejects (runOmniGcOnce catches).
 */
export async function settleOmniGc(omniRootDir: string): Promise<void> {
  const existing = gcOnce.get(path.resolve(omniRootDir));
  if (existing) await existing;
}

/** Real-directory guard (lstat, symlinks rejected) — the sweep deletes
 * files under every directory it descends into, and a symlinked shard
 * would redirect those deletions outside the store. Same rationale as
 * the recovery scan's guard. */
async function isRealDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

interface ObjectStat {
  sha256: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

async function listObjects(objectsDir: string): Promise<ObjectStat[]> {
  const out: ObjectStat[] = [];
  if (!(await isRealDirectory(objectsDir))) return out;
  let shards: string[];
  try {
    shards = await fs.readdir(objectsDir);
  } catch {
    return out;
  }
  for (const shard of shards) {
    const shardDir = path.join(objectsDir, shard);
    if (!(await isRealDirectory(shardDir))) continue;
    let names: string[];
    try {
      names = await fs.readdir(shardDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = OBJECT_NAME_RE.exec(name);
      if (!match) continue;
      const filePath = path.join(shardDir, name);
      try {
        const st = await fs.lstat(filePath);
        if (!st.isFile()) continue;
        out.push({
          sha256: match[1],
          filePath,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // Raced away; nothing to account for.
      }
    }
  }
  return out;
}

async function deleteObject(
  object: ObjectStat,
  options: OmniGcOptions,
): Promise<boolean> {
  try {
    await fs.rm(object.filePath, { force: true });
  } catch (err) {
    debugLogger.debug(
      `gc: failed to delete ${object.sha256}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
  // Cascade AFTER the bytes are gone: a cache entry pointing at a missing
  // object degrades to a miss (both caches already tolerate that), while
  // the reverse order could re-serve a deleted object from cache.
  try {
    await options.uploadCache?.removeBySha256(object.sha256);
  } catch {
    // Cache hygiene is best-effort; a stale entry degrades to a miss.
  }
  try {
    await options.degradationCache?.removeByOriginalSha256(object.sha256);
    await options.degradationCache?.removeByDegradedSha256(object.sha256);
  } catch {
    // Same best-effort stance.
  }
  debugLogger.debug(
    `gc: deleted unreferenced object ${object.sha256} (${object.sizeBytes} bytes)`,
  );
  return true;
}

/**
 * Run the GC once per store root per process. Runs AFTER startup
 * recovery (the recovery scan owns staging/downloads/quarantine and
 * temp-file hygiene; the GC owns only committed objects).
 */
export function runOmniGcOnce(options: OmniGcOptions): Promise<OmniGcResult> {
  const rootKey = path.resolve(options.store.getOmniRootDir());
  const existing = gcOnce.get(rootKey);
  if (existing) return existing;
  const run = sweep(options, rootKey).catch((err) => {
    debugLogger.debug(
      `gc: run failed, skipped: ${err instanceof Error ? err.message : err}`,
    );
    return SKIPPED;
  });
  gcOnce.set(rootKey, run);
  return run;
}

/**
 * Whether the memory ledger was recently lost to corruption. The store's
 * own recovery (C8) backs a corrupt document up as
 * `memory.json.corrupt-<ts>` and continues on an EMPTY snapshot — correct
 * for recall (degrade to a miss, start a fresh ledger), catastrophic if
 * the GC trusted it: an empty ledger reads as "nothing is referenced" and
 * the sweep would erase the entire store off one corruption event. A
 * fresh backup therefore blocks the run; once the newest backup is older
 * than the retention window, the empty ledger has stood long enough to be
 * the real state of the world.
 */
async function recentlyRecoveredFromCorruption(
  omniRootDir: string,
  retentionDays: number,
  nowMs: number,
): Promise<boolean> {
  const prefix = `${MEDIA_MEMORY_FILE_NAME}.corrupt-`;
  let names: string[];
  try {
    names = await fs.readdir(omniRootDir);
  } catch {
    return false;
  }
  const cutoff = nowMs - retentionDays * 24 * 3600_000;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const stamp = Number(name.slice(prefix.length));
    if (Number.isFinite(stamp) && stamp >= cutoff) return true;
    try {
      const st = await fs.lstat(path.join(omniRootDir, name));
      if (st.mtimeMs >= cutoff) return true;
    } catch {
      // Unreadable backup: treat as recent (fail-closed).
      return true;
    }
  }
  return false;
}

async function sweep(
  options: OmniGcOptions,
  rootKey: string,
): Promise<OmniGcResult> {
  const nowMsForGuard = options.nowMs ?? Date.now();
  const refs = await options.memoryService.collectManagedRefs();
  if (refs === null) {
    // Hard rule 1: roots unknown → delete nothing, and leave any prior
    // suspension in place (we cannot prove the pressure is gone either).
    debugLogger.debug('gc: memory snapshot unreadable, skipping run');
    return SKIPPED;
  }
  // Reading the snapshot above may itself have just performed the
  // corruption recovery — the backup check must come AFTER it.
  if (
    await recentlyRecoveredFromCorruption(
      options.store.getOmniRootDir(),
      options.retentionDays,
      nowMsForGuard,
    )
  ) {
    debugLogger.debug(
      'gc: memory ledger recently recovered from corruption, skipping run',
    );
    return SKIPPED;
  }
  // Live session handles count as roots too. Only locators inside the
  // object store matter here — a handle on a user file protects nothing
  // (GC never touches paths outside objects/ in the first place).
  const objectsDir = options.store.getObjectsDir();
  for (const fileRef of options.registry?.activeFileRefs() ?? []) {
    const name = path.basename(fileRef);
    const match = OBJECT_NAME_RE.exec(name);
    if (match && fileRef.startsWith(objectsDir)) refs.add(match[1]);
  }

  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionDays * 24 * 3600_000;
  const objects = await listObjects(objectsDir);

  let deletedObjects = 0;
  let deletedBytes = 0;
  const survivors: ObjectStat[] = [];

  /** Freshness re-check at delete time. The root snapshot and the object
   * listing are minutes-stale by the time a candidate is deleted, and a
   * concurrent commit can reference OLD bytes in that gap (its putFile
   * dedup-touch refreshes the object's mtime BEFORE the commit lands —
   * ordering invariant). Re-statting narrows the race from "whole sweep
   * duration" to the moment between this stat and the rm. */
  const touchedSinceListing = async (
    object: ObjectStat,
    freshCutoffMs: number,
  ): Promise<boolean> => {
    try {
      return (await fs.lstat(object.filePath)).mtimeMs >= freshCutoffMs;
    } catch {
      // Raced away — nothing left to delete either.
      return true;
    }
  };

  // Pass 1: expired and unreferenced.
  for (const object of objects) {
    if (refs.has(object.sha256) || object.mtimeMs >= cutoffMs) {
      survivors.push(object);
      continue;
    }
    if (await touchedSinceListing(object, cutoffMs)) {
      survivors.push(object);
      continue;
    }
    if (await deleteObject(object, options)) {
      deletedObjects += 1;
      deletedBytes += object.sizeBytes;
    } else {
      survivors.push(object);
    }
  }

  // Pass 2: budget. Oldest unreferenced objects go regardless of age;
  // referenced objects are untouchable (hard rule 2). Because age no
  // longer protects anything here, the pass re-reads the ledger for a
  // FRESH root set and skips objects touched since the sweep began —
  // both signals catch a commit that landed while pass 1 ran.
  let remainingBytes = survivors.reduce((sum, o) => sum + o.sizeBytes, 0);
  if (remainingBytes > options.maxTotalBytes) {
    const freshRefs = await options.memoryService.collectManagedRefs();
    if (freshRefs === null) {
      // Ledger became unreadable mid-run: fail closed — delete nothing
      // more. The store is still over budget, so suspension holds.
      debugLogger.debug(
        'gc: ledger unreadable at budget pass, skipping budget deletions',
      );
    } else {
      const unreferenced = survivors
        .filter((o) => !refs.has(o.sha256) && !freshRefs.has(o.sha256))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const object of unreferenced) {
        if (remainingBytes <= options.maxTotalBytes) break;
        if (await touchedSinceListing(object, nowMs)) continue;
        if (await deleteObject(object, options)) {
          deletedObjects += 1;
          deletedBytes += object.sizeBytes;
          remainingBytes -= object.sizeBytes;
        }
      }
    }
  }

  const derivationsSuspended = remainingBytes > options.maxTotalBytes;
  if (derivationsSuspended) {
    suspendedRoots.add(rootKey);
    debugLogger.warn(
      `omni object store over budget with only referenced objects left ` +
        `(${remainingBytes} > ${options.maxTotalBytes} bytes); new policy ` +
        `derivations are suspended for this session. Raise ` +
        `omni.storage.maxTotalBytes or delete memory records you no ` +
        `longer need — either change takes effect at the next session ` +
        `start (the GC runs once per process).`,
    );
  } else {
    suspendedRoots.delete(rootKey);
  }

  if (deletedObjects > 0) {
    debugLogger.debug(
      `gc: removed ${deletedObjects} object(s) / ${deletedBytes} bytes; ` +
        `${remainingBytes} bytes remain`,
    );
  }
  return {
    ran: true,
    deletedObjects,
    deletedBytes,
    remainingBytes,
    derivationsSuspended,
  };
}
