/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { isSameProcess } from '@qwen-code/qwen-code-core/utils/process-liveness.js';
import {
  isLocalIdentity,
  readPidfileNamespaceId,
  readPidfileProcessToken,
} from '../../commands/channel/pidfile.js';
import { withChannelPidfileLock } from '../../commands/channel/pidfile-lock.js';

export type PrTransitionType =
  | 'ci_failure'
  | 'merge_conflict'
  | 'head_change'
  | 'state_change';

export type PrWatchRoleGroup = 'review' | 'verify' | 'fix' | 'untyped';

export interface PrWatchIdentity {
  /**
   * API host, already normalised by the caller (design §1's `pullRequestKey`
   * strips `www.` and drops the port). See {@link prWatchFileKey}.
   */
  host: string;
  /** `owner/repo`, without the host. */
  repo: string;
  number: number;
}

export interface PrWatchPendingEntry {
  type: PrTransitionType;
  key: string;
  summary: string;
  detectedAt: string;
  served?: PrWatchRoleGroup[];
  /**
   * The head a `head_change` was detected for. Delivery judges self-push
   * against this, not the file's current head, which a later observation may
   * have moved on. Absent on entries written before the field existed.
   */
  headSha?: string;
}

export interface PrWatchState {
  pr: PrWatchIdentity;
  lastBoundAt?: string;
  observedAt?: string;
  state?: 'open' | 'merged' | 'closed';
  title?: string;
  headSha?: string;
  checks?: 'passing' | 'failing' | 'pending' | 'none';
  mergeable?: 'mergeable' | 'conflicting';
  ciFired?: string[];
  delivered?: string[];
  pending?: PrWatchPendingEntry[];
}

export const PR_WATCH_CI_FIRED_CAP = 16;
export const PR_WATCH_DELIVERED_CAP = 64;
export const PR_WATCH_PENDING_CAP = 16;

const TRANSITION_TYPES = new Set<PrTransitionType>([
  'ci_failure',
  'merge_conflict',
  'head_change',
  'state_change',
]);
const ROLE_GROUPS = new Set<PrWatchRoleGroup>([
  'review',
  'verify',
  'fix',
  'untyped',
]);
const TEMP_FILE_PATTERN = /^\.[0-9a-f]{40}\.json\.[0-9a-f-]+\.tmp$/;

export function defaultPrWatchDir(): string {
  return path.join(Storage.getGlobalQwenDir(), 'serve', 'pr-watch');
}

/**
 * Lowercased `host/owner/repo#number` file key. This only lowercases: the
 * caller must pass a host already normalised by `pullRequestKey` (design §1),
 * or `www.github.com` and `github.com` would split one PR across two files —
 * two baselines and a double delivery.
 */
export function prWatchFileKey(identity: PrWatchIdentity): string {
  return `${identity.host}/${identity.repo}#${identity.number}`.toLowerCase();
}

export function prWatchFilePath(
  watchDir: string,
  identity: PrWatchIdentity,
): string {
  const digest = createHash('sha256')
    .update(prWatchFileKey(identity))
    .digest('hex')
    .slice(0, 40);
  return path.join(watchDir, `${digest}.json`);
}

export function prWatchOwnerPath(watchDir: string): string {
  return path.join(watchDir, 'owner.pid');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isStringArray(value: unknown, cap: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= cap &&
    value.every((entry) => isNonEmptyString(entry))
  );
}

function isIdentity(value: unknown): value is PrWatchIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const identity = value as Partial<PrWatchIdentity>;
  return (
    isNonEmptyString(identity.host) &&
    isNonEmptyString(identity.repo) &&
    typeof identity.number === 'number' &&
    Number.isSafeInteger(identity.number) &&
    identity.number > 0
  );
}

function sameIdentity(a: PrWatchIdentity, b: PrWatchIdentity): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  );
}

function parsePendingEntry(value: unknown): PrWatchPendingEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<PrWatchPendingEntry>;
  if (
    !isNonEmptyString(entry.type) ||
    !TRANSITION_TYPES.has(entry.type as PrTransitionType) ||
    !isNonEmptyString(entry.key) ||
    typeof entry.summary !== 'string' ||
    !isTimestamp(entry.detectedAt)
  ) {
    return null;
  }
  if (entry.served !== undefined) {
    if (
      !Array.isArray(entry.served) ||
      entry.served.length > ROLE_GROUPS.size ||
      !entry.served.every((group) => ROLE_GROUPS.has(group)) ||
      new Set(entry.served).size !== entry.served.length
    ) {
      return null;
    }
  }
  if (entry.headSha !== undefined && !isNonEmptyString(entry.headSha)) {
    return null;
  }
  return {
    type: entry.type as PrTransitionType,
    key: entry.key,
    summary: entry.summary,
    detectedAt: entry.detectedAt,
    ...(entry.served !== undefined ? { served: [...entry.served] } : {}),
    ...(entry.headSha !== undefined ? { headSha: entry.headSha } : {}),
  };
}

export function parsePrWatchState(
  value: unknown,
  expected?: PrWatchIdentity,
): PrWatchState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const state = value as Partial<PrWatchState>;
  if (!isIdentity(state.pr)) return null;
  if (expected && !sameIdentity(state.pr, expected)) return null;
  if (state.lastBoundAt !== undefined && !isTimestamp(state.lastBoundAt)) {
    return null;
  }
  if (state.observedAt !== undefined && !isTimestamp(state.observedAt)) {
    return null;
  }
  if (
    state.state !== undefined &&
    state.state !== 'open' &&
    state.state !== 'merged' &&
    state.state !== 'closed'
  ) {
    return null;
  }
  if (state.title !== undefined && typeof state.title !== 'string') return null;
  if (state.headSha !== undefined && !isNonEmptyString(state.headSha)) {
    return null;
  }
  if (
    state.checks !== undefined &&
    state.checks !== 'passing' &&
    state.checks !== 'failing' &&
    state.checks !== 'pending' &&
    state.checks !== 'none'
  ) {
    return null;
  }
  if (
    state.mergeable !== undefined &&
    state.mergeable !== 'mergeable' &&
    state.mergeable !== 'conflicting'
  ) {
    return null;
  }
  if (
    state.ciFired !== undefined &&
    !isStringArray(state.ciFired, PR_WATCH_CI_FIRED_CAP)
  ) {
    return null;
  }
  if (
    state.delivered !== undefined &&
    !isStringArray(state.delivered, PR_WATCH_DELIVERED_CAP)
  ) {
    return null;
  }
  let pending: PrWatchPendingEntry[] | undefined;
  if (state.pending !== undefined) {
    if (
      !Array.isArray(state.pending) ||
      state.pending.length > PR_WATCH_PENDING_CAP
    ) {
      return null;
    }
    pending = [];
    for (const raw of state.pending) {
      const entry = parsePendingEntry(raw);
      if (!entry) return null;
      pending.push(entry);
    }
  }
  return {
    pr: {
      host: state.pr.host,
      repo: state.pr.repo,
      number: state.pr.number,
    },
    ...(state.lastBoundAt !== undefined
      ? { lastBoundAt: state.lastBoundAt }
      : {}),
    ...(state.observedAt !== undefined ? { observedAt: state.observedAt } : {}),
    ...(state.state !== undefined ? { state: state.state } : {}),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.headSha !== undefined ? { headSha: state.headSha } : {}),
    ...(state.checks !== undefined ? { checks: state.checks } : {}),
    ...(state.mergeable !== undefined ? { mergeable: state.mergeable } : {}),
    ...(state.ciFired !== undefined ? { ciFired: [...state.ciFired] } : {}),
    ...(state.delivered !== undefined
      ? { delivered: [...state.delivered] }
      : {}),
    ...(pending !== undefined ? { pending } : {}),
  };
}

export type PrWatchReadResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; filePath: string }
  | { kind: 'state'; filePath: string; state: PrWatchState }
  | { kind: 'error'; filePath: string; error: unknown };

function effectiveUid(): number | undefined {
  return process.geteuid?.();
}

function uidMismatchError(
  filePath: string,
  owner: number,
): NodeJS.ErrnoException {
  const uid = effectiveUid();
  return Object.assign(
    new Error(
      `PR watch file ${filePath} is owned by uid ${owner}, not the effective uid ${uid}; skipping it.`,
    ),
    { code: 'EUID_MISMATCH' },
  );
}

/**
 * Read one PR's watch file. The caller holds the PR's PathMutexRegistry lock;
 * this function takes no lock of its own. Absent and invalid content initialise
 * silently; any other read error fails closed so the caller skips the tick.
 */
export function readPrWatchStateSync(
  watchDir: string,
  identity: PrWatchIdentity,
): PrWatchReadResult {
  const filePath = prWatchFilePath(watchDir, identity);
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'error', filePath, error };
  }
  const uid = effectiveUid();
  if (uid !== undefined && stats.uid !== uid) {
    return {
      kind: 'error',
      filePath,
      error: uidMismatchError(filePath, stats.uid),
    };
  }
  if (!stats.isFile()) {
    return {
      kind: 'error',
      filePath,
      error: Object.assign(
        new Error(`PR watch path ${filePath} is not a regular file.`),
        { code: 'ENOTREG' },
      ),
    };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    return { kind: 'error', filePath, error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', filePath };
  }
  const state = parsePrWatchState(parsed, identity);
  if (!state) return { kind: 'invalid', filePath };
  return { kind: 'state', filePath, state };
}

function ensureWatchDir(watchDir: string): void {
  if (!existsSync(watchDir)) {
    mkdirSync(watchDir, { recursive: true, mode: 0o700 });
    return;
  }
  const stats = lstatSync(watchDir);
  if (!stats.isDirectory()) {
    throw Object.assign(
      new Error(`PR watch directory ${watchDir} is not a directory.`),
      { code: 'ENOTDIR' },
    );
  }
  const uid = effectiveUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw uidMismatchError(watchDir, stats.uid);
  }
}

/**
 * Replace one PR's watch file with a temp file beside the target renamed over
 * it. The caller holds the PR's lock and must already have read the file in
 * this lock hold; a target owned by another uid is refused, never written in
 * place.
 */
export function writePrWatchStateSync(
  watchDir: string,
  identity: PrWatchIdentity,
  state: PrWatchState,
): void {
  const validated = parsePrWatchState(state, identity);
  if (!validated) {
    throw new Error('Refusing to write an invalid PR watch state.');
  }
  ensureWatchDir(watchDir);
  const filePath = prWatchFilePath(watchDir, identity);
  if (existsSync(filePath)) {
    const stats = lstatSync(filePath);
    const uid = effectiveUid();
    if (uid !== undefined && stats.uid !== uid) {
      throw uidMismatchError(filePath, stats.uid);
    }
    if (!stats.isFile()) {
      throw Object.assign(
        new Error(`PR watch path ${filePath} is not a regular file.`),
        { code: 'ENOTREG' },
      );
    }
  }
  const tempPath = path.join(
    watchDir,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const data = Buffer.from(JSON.stringify(validated, null, 2), 'utf-8');
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) {
        throw Object.assign(
          new Error(`Short write to PR watch temp file ${tempPath}.`),
          { code: 'EIO' },
        );
      }
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The temp file is removed below.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // A failed write may never have created the temp file.
    }
    throw error;
  }
}

export function deletePrWatchStateSync(
  watchDir: string,
  identity: PrWatchIdentity,
): boolean {
  const filePath = prWatchFilePath(watchDir, identity);
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const uid = effectiveUid();
  if (uid !== undefined && stats.uid !== uid) {
    throw uidMismatchError(filePath, stats.uid);
  }
  if (!stats.isFile()) {
    throw Object.assign(
      new Error(`PR watch path ${filePath} is not a regular file.`),
      { code: 'ENOTREG' },
    );
  }
  unlinkSync(filePath);
  return true;
}

/** Remove temp files left by a crash mid-write; called after a claim. */
export function sweepPrWatchTempFilesSync(watchDir: string): number {
  let removed = 0;
  for (const entry of readdirSync(watchDir, { withFileTypes: true })) {
    if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) continue;
    try {
      unlinkSync(path.join(watchDir, entry.name));
      removed += 1;
    } catch {
      // Best-effort: a temp file may disappear between readdir and unlink.
    }
  }
  return removed;
}

export interface PrWatchOwnerRecord {
  pid: number;
  procStart?: string | null;
  pidNs?: number | null;
  startedAt: string;
}

export function buildPrWatchOwnerRecord(): PrWatchOwnerRecord {
  return {
    pid: process.pid,
    procStart: readPidfileProcessToken(process.pid),
    pidNs: readPidfileNamespaceId(),
    startedAt: new Date().toISOString(),
  };
}

function parseOwnerRecord(value: unknown): PrWatchOwnerRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<PrWatchOwnerRecord>;
  if (
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !isTimestamp(record.startedAt)
  ) {
    return null;
  }
  if (
    record.procStart !== undefined &&
    record.procStart !== null &&
    typeof record.procStart !== 'string'
  ) {
    return null;
  }
  if (
    record.pidNs !== undefined &&
    record.pidNs !== null &&
    typeof record.pidNs !== 'number'
  ) {
    return null;
  }
  return {
    pid: record.pid,
    ...(record.procStart !== undefined ? { procStart: record.procStart } : {}),
    ...(record.pidNs !== undefined ? { pidNs: record.pidNs } : {}),
    startedAt: record.startedAt,
  };
}

function sameOwnerRecord(
  a: PrWatchOwnerRecord,
  b: PrWatchOwnerRecord,
): boolean {
  return (
    a.pid === b.pid &&
    (a.procStart ?? null) === (b.procStart ?? null) &&
    (a.pidNs ?? null) === (b.pidNs ?? null) &&
    a.startedAt === b.startedAt
  );
}

type OwnerFileRead =
  | { kind: 'absent' }
  | { kind: 'content'; raw: string }
  | { kind: 'error'; reason: string };

/**
 * Read the owner record without following links or blocking on a FIFO. The
 * watch directory is private, but a same-uid session can still plant a special
 * file there; the claim runs on the refresh thread and must not hang.
 */
function readOwnerFileGuardedSync(ownerPath: string): OwnerFileRead {
  let stats;
  try {
    stats = lstatSync(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return {
      kind: 'error',
      reason: `cannot stat ${ownerPath}: ${String(error)}`,
    };
  }
  if (!stats.isFile()) {
    return { kind: 'error', reason: `${ownerPath} is not a regular file` };
  }
  let fd: number;
  try {
    fd = openSync(
      ownerPath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    return {
      kind: 'error',
      reason: `cannot open ${ownerPath}: ${String(error)}`,
    };
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return { kind: 'error', reason: `${ownerPath} is not a regular file` };
    }
    return { kind: 'content', raw: readFileSync(fd, 'utf-8') };
  } catch (error) {
    return {
      kind: 'error',
      reason: `cannot read ${ownerPath}: ${String(error)}`,
    };
  } finally {
    closeSync(fd);
  }
}

export type PrWatchClaimResult =
  | { kind: 'claimed'; record: PrWatchOwnerRecord }
  | { kind: 'retained'; record: PrWatchOwnerRecord }
  | { kind: 'blocked'; reason: string };

function defaultLog(message: string): void {
  process.stderr.write(`[pr-watch] ${message}\n`);
}

function checkDirectoryOwnership(
  watchDir: string,
): { ok: true } | { ok: false; reason: string } {
  let stats;
  try {
    stats = lstatSync(watchDir);
  } catch (error) {
    return { ok: false, reason: `cannot stat ${watchDir}: ${String(error)}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, reason: `${watchDir} is not a directory` };
  }
  const uid = effectiveUid();
  if (uid !== undefined && stats.uid !== uid) {
    return {
      ok: false,
      reason: `${watchDir} is owned by uid ${stats.uid}, not effective uid ${uid}`,
    };
  }
  let entries;
  try {
    entries = readdirSync(watchDir, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: `cannot list ${watchDir}: ${String(error)}` };
  }
  for (const entry of entries) {
    const entryPath = path.join(watchDir, entry.name);
    let entryStats;
    try {
      entryStats = lstatSync(entryPath);
    } catch (error) {
      return {
        ok: false,
        reason: `cannot stat ${entryPath}: ${String(error)}`,
      };
    }
    if (uid !== undefined && entryStats.uid !== uid) {
      return {
        ok: false,
        reason: `${entryPath} is owned by uid ${entryStats.uid}, not effective uid ${uid}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Claim the watch directory's owner record, following the channel pidfile's
 * identity rules at a caller-chosen path. A provably dead local record is
 * swept; a record this machine cannot verify blocks the claim and is named on
 * every attempt. Every blocked outcome is logged through `log`, so a daemon
 * that does not hold the record never silently skips PR watch. The caller runs
 * this only when its effective event set is non-empty and its refresh timer
 * runs.
 */
export function claimPrWatchOwnershipSync(
  watchDir: string,
  log: (message: string) => void = defaultLog,
): PrWatchClaimResult {
  const result = attemptPrWatchClaimSync(watchDir, log);
  if (result.kind === 'blocked') {
    log(`not claiming PR watch: ${result.reason}`);
  }
  return result;
}

function attemptPrWatchClaimSync(
  watchDir: string,
  log: (message: string) => void,
): PrWatchClaimResult {
  try {
    mkdirSync(watchDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `cannot create ${watchDir}: ${String(error)}`,
    };
  }
  const ownership = checkDirectoryOwnership(watchDir);
  if (!ownership.ok) {
    return { kind: 'blocked', reason: ownership.reason };
  }
  if (process.platform !== 'win32') {
    try {
      const mode = lstatSync(watchDir).mode & 0o777;
      if ((mode & 0o077) !== 0) chmodSync(watchDir, 0o700);
    } catch (error) {
      return {
        kind: 'blocked',
        reason: `cannot secure ${watchDir}: ${String(error)}`,
      };
    }
  }
  const ownerPath = prWatchOwnerPath(watchDir);
  try {
    return withChannelPidfileLock(
      ownerPath,
      () => {
        let existing: PrWatchOwnerRecord | null = null;
        let staleRecord = false;
        const ownerFile = readOwnerFileGuardedSync(ownerPath);
        if (ownerFile.kind === 'error') {
          return { kind: 'blocked', reason: ownerFile.reason };
        }
        if (ownerFile.kind === 'content') {
          try {
            existing = parseOwnerRecord(JSON.parse(ownerFile.raw));
          } catch {
            existing = null;
          }
          if (existing && !isLocalIdentity(existing)) {
            return {
              kind: 'blocked',
              reason: `${ownerPath} holds a record this machine cannot verify, written before a reboot or by another machine or PID namespace sharing this home. Confirm no PR watch owner is running, then delete that file to claim again.`,
            };
          }
          if (existing && isSameProcess(existing.pid, existing.procStart)) {
            if (existing.pid === process.pid) {
              return { kind: 'retained', record: existing };
            }
            return {
              kind: 'blocked',
              reason: `${ownerPath} is held by live pid ${existing.pid}`,
            };
          }
          // A dead or invalid local record is transient. Build the replacement
          // before sweeping it so a token-read failure leaves the old record in
          // place for the next attempt.
          staleRecord = true;
        }
        let record: PrWatchOwnerRecord;
        try {
          record = buildPrWatchOwnerRecord();
        } catch (error) {
          return {
            kind: 'blocked',
            reason: `cannot build owner record: ${String(error)}`,
          };
        }
        if (staleRecord) {
          try {
            unlinkSync(ownerPath);
          } catch (error) {
            return {
              kind: 'blocked',
              reason: `cannot sweep stale ${ownerPath}: ${String(error)}`,
            };
          }
        }
        try {
          writeFileSync(ownerPath, JSON.stringify(record, null, 2), {
            encoding: 'utf-8',
            flag: 'wx',
            mode: 0o600,
          });
        } catch (error) {
          return {
            kind: 'blocked',
            reason: `cannot create ${ownerPath}: ${String(error)}`,
          };
        }
        try {
          sweepPrWatchTempFilesSync(watchDir);
        } catch (error) {
          // The claim already succeeded; a failed sweep must not report it as
          // blocked and leave the live owner record looking like a failure.
          log(`claimed PR watch but temp sweep failed: ${String(error)}`);
        }
        return { kind: 'claimed', record };
      },
      { dirMode: 0o700 },
    );
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `cannot lock ${ownerPath}: ${String(error)}`,
    };
  }
}

/** Remove the owner record only when it is still the expected one. */
export function releasePrWatchOwnershipSync(
  watchDir: string,
  expected: PrWatchOwnerRecord,
): boolean {
  // Stay missing when absent; if a concurrent removal slips past this check,
  // the lock helper still recreates the directory privately via dirMode.
  if (!existsSync(watchDir)) return false;
  const ownerPath = prWatchOwnerPath(watchDir);
  try {
    return withChannelPidfileLock(
      ownerPath,
      () => {
        const ownerFile = readOwnerFileGuardedSync(ownerPath);
        if (ownerFile.kind !== 'content') return false;
        let current: PrWatchOwnerRecord | null;
        try {
          current = parseOwnerRecord(JSON.parse(ownerFile.raw));
        } catch {
          return false;
        }
        if (!current || !sameOwnerRecord(current, expected)) return false;
        try {
          unlinkSync(ownerPath);
          return true;
        } catch {
          return false;
        }
      },
      { dirMode: 0o700 },
    );
  } catch {
    return false;
  }
}
