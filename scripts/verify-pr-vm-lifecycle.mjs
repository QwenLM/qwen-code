#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-side lifecycle helper for microVM and provider-VM `/verify-pr` rounds:
 *
 *   1. `reap` — idempotently stops a run's verified VMM/helper PIDs (never by
 *      broad process name), removes working disks/sockets inside explicitly
 *      approved roots, and revokes the per-round token file (§7.3).
 *   2. `finalize` — builds and atomically writes launcher-owned
 *      `execution-record.json` from a host-held `prepare` snapshot, verifies
 *      live worker absence and `checkExecutionRecord()`, and writes host
 *      `boundary.json` into the artifact dir ONLY when every gate passes
 *      (D9/D10).
 *
 * Exit codes:
 *   0  reap succeeded, or finalize wrote execution-record.json + boundary.json
 *   1  reap encountered errors, or finalize blocked fail-closed (no boundary.json)
 *   2  usage error
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';
import { checkExecutionRecord, isFilesystemRoot } from './verify-pr-check.mjs';

export const OWNERSHIP_SCHEMA = 'verify-pr-ownership-v1';
export const EXECUTION_RECORD_SCHEMA = 'verify-pr-exec-record-v1';

const SHA256_RE = /^[0-9a-f]{64}$/;

const HELP = `Usage:
  node scripts/verify-pr-vm-lifecycle.mjs reap --ownership <file> --approved-root <dir> [--approved-root <dir>...] [--out-report <file>]
  node scripts/verify-pr-vm-lifecycle.mjs finalize --context <host-snapshot> --context-sha256 <64-hex> --launcher-dir <dir> --artifact-dir <dir> --meta <json-file> [--no-verify-live-pid]

Subcommands:
  reap      Idempotently stop verified worker/helper PIDs, remove approved
            working disks/sockets, and mark the per-round token revoked.
  finalize  Write launcher-owned execution-record.json, verify it against
            checkExecutionRecord() (plus live worker absence for local VMMs),
            and emit boundary.json only on a clean pass.
`;

function sleepMs(ms) {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

function withinPrefix(root, target) {
  return (
    target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

function resolveParentPreservingLeaf(absPath) {
  const leaf = absPath.slice(dirname(absPath).length).replace(/^[\\/]+/, '');
  let cursor = dirname(absPath);
  const tail = [];
  while (true) {
    try {
      const real = realpathSync(cursor);
      return tail.length > 0
        ? join(real, ...tail.reverse(), leaf)
        : join(real, leaf);
    } catch {
      const next = dirname(cursor);
      if (next === cursor) return absPath;
      tail.push(cursor.slice(next.length).replace(/^[\\/]+/, ''));
      cursor = next;
    }
  }
}

/**
 * Checks that `targetPath` resides strictly under one of `approvedRoots`
 * without following a symlink at the final leaf. Rejects filesystem roots as
 * approved prefixes.
 */
export function isPathWithinApprovedRoots(targetPath, approvedRoots = []) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return false;
  if (!Array.isArray(approvedRoots) || approvedRoots.length === 0) return false;
  const candidate = resolveParentPreservingLeaf(resolve(targetPath));
  for (const root of approvedRoots) {
    if (typeof root !== 'string' || root.trim() === '') continue;
    let resolvedRoot = resolve(root);
    try {
      resolvedRoot = realpathSync(resolvedRoot);
    } catch {
      // Keep lexical resolved path when root does not exist yet.
    }
    if (isFilesystemRoot(resolvedRoot)) continue;
    if (candidate !== resolvedRoot && withinPrefix(resolvedRoot, candidate)) {
      return true;
    }
  }
  return false;
}

const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function readSingleLinkRegularFile(filePath) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (error) {
    return { error: `unreadable:${error.code ?? 'ENOENT'}`, text: null };
  }
  if (st.isSymbolicLink()) return { error: 'symlink', text: null };
  if (!st.isFile()) return { error: 'non-regular', text: null };
  if (st.nlink !== 1)
    return { error: `hardlink-alias:${st.nlink}`, text: null };
  if (st.size > MAX_RECORD_BYTES) return { error: 'too-large', text: null };
  try {
    return { error: null, text: readFileSync(filePath, 'utf8') };
  } catch (error) {
    return { error: `read-failed:${error.code ?? 'EIO'}`, text: null };
  }
}

let atomicTmpSeq = 0;

function writeAtomicPrivate(filePath, content) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
      throw new Error(
        `refusing to overwrite symlink, non-regular, or multi-link file: ${filePath}`,
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  atomicTmpSeq += 1;
  const tmp = `${filePath}.${process.pid}.${atomicTmpSeq}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
}

/**
 * Inspects whether `pid` is genuinely alive (excluding zombie/dead states so
 * an unwaited child does not look alive to `kill(pid, 0)`).
 */
export function inspectPidState(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { alive: false, zombie: false };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return { alive: false, zombie: false };
    // EPERM means the process exists under another UID; fall through to state check.
  }
  if (process.platform === 'linux') {
    try {
      const statText = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const idx = statText.lastIndexOf(')');
      if (idx !== -1) {
        const state = statText
          .slice(idx + 1)
          .trim()
          .split(/\s+/)[0];
        if (state === 'Z' || state === 'X' || state === 'x') {
          return { alive: false, zombie: true };
        }
      }
    } catch {
      return { alive: false, zombie: false };
    }
    return { alive: true, zombie: false };
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
  });
  if (ps.status !== 0 || ps.stdout.trim() === '') {
    return { alive: false, zombie: false };
  }
  if (ps.stdout.trim().startsWith('Z')) {
    return { alive: false, zombie: true };
  }
  return { alive: true, zombie: false };
}

/** Returns observed `{ exe, cmdline }` for `pid`, or `null` if absent. */
export function inspectPidIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (process.platform === 'linux') {
    if (!existsSync(`/proc/${pid}`)) return null;
    let exe = '';
    let cmdline = '';
    try {
      exe = realpathSync(`/proc/${pid}/exe`);
    } catch {
      // Unreadable exe link (e.g. cross-UID or exiting).
    }
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .replace(/\0+/g, ' ')
        .trim();
    } catch {
      // Ignore unreadable cmdline.
    }
    return { exe, cmdline };
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'comm=,args='], {
    encoding: 'utf8',
  });
  if (ps.status !== 0 || ps.stdout.trim() === '') return null;
  const line = ps.stdout.trim();
  const space = line.indexOf(' ');
  const exe = space === -1 ? line : line.slice(0, space);
  const cmdline = space === -1 ? line : line.slice(space + 1).trim();
  return { exe, cmdline };
}

function identityMatches(observed, expectedTokens) {
  if (!Array.isArray(expectedTokens) || expectedTokens.length === 0) {
    return false;
  }
  const haystack = `${observed?.exe ?? ''} ${observed?.cmdline ?? ''}`;
  return expectedTokens.some(
    (token) =>
      typeof token === 'string' && token !== '' && haystack.includes(token),
  );
}

/** Atomically writes a run's `ownership.json` for crash recovery. */
export function writeOwnershipRecord(ownershipPath, record) {
  const payload = {
    schemaVersion: OWNERSHIP_SCHEMA,
    ...record,
  };
  writeAtomicPrivate(ownershipPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readProcessGroupId(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const groupId = Number(result.stdout.trim());
  return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
}

function hasLiveProcessGroupMember(groupId) {
  const members = spawnSync('ps', ['-eo', 'pgid=,stat='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (members.status !== 0) return null;
  return members.stdout.split('\n').some((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)/);
    return match && Number(match[1]) === groupId && !/^[ZX]/.test(match[2]);
  });
}

function signalProcessGroup(groupId, signal, label, report) {
  try {
    process.kill(-groupId, signal);
    return 'sent';
  } catch (error) {
    if (
      error.code === 'ESRCH' ||
      (error.code === 'EPERM' && hasLiveProcessGroupMember(groupId) === false)
    ) {
      return 'absent';
    }
    report.errors.push(
      `process-group-${signal.toLowerCase()}-failed:${label}:${groupId}:${error.code}`,
    );
    return 'error';
  }
}

function stopOwnedProcessGroup(groupId, label, graceMs, report) {
  if (!Number.isInteger(groupId) || groupId <= 1) {
    report.errors.push(`invalid-process-group:${label}:${groupId}`);
    return;
  }
  const ownGroup = readProcessGroupId(process.pid);
  if (ownGroup === null) {
    report.errors.push(`process-group-self-probe-failed:${label}`);
    return;
  }
  if (groupId === process.pid || groupId === ownGroup) {
    report.errors.push(`refusing-own-process-group:${label}:${groupId}`);
    return;
  }
  const observedGroup = readProcessGroupId(groupId);
  if (observedGroup !== null && observedGroup !== groupId) {
    report.errors.push(`process-group-mismatch:${label}:${groupId}`);
    return;
  }
  // The supervisor may already have exited while its group still contains
  // workers. Only the trusted launcher writes this run-owned group id.
  if (signalProcessGroup(groupId, 'SIGTERM', label, report) !== 'sent') {
    return;
  }
  const deadline = Date.now() + graceMs;
  let present = true;
  while (Date.now() < deadline && present) {
    try {
      process.kill(-groupId, 0);
      sleepMs(25);
    } catch (error) {
      if (error.code === 'ESRCH') present = false;
      else if (
        error.code === 'EPERM' &&
        hasLiveProcessGroupMember(groupId) === false
      ) {
        // macOS may use EPERM for a zombie-only group.
        present = false;
      } else {
        report.errors.push(
          `process-group-probe-failed:${label}:${groupId}:${error.code}`,
        );
        return;
      }
    }
  }
  if (!present) return;
  if (signalProcessGroup(groupId, 'SIGKILL', label, report) === 'sent') {
    report.processes.push({ label, pid: groupId, action: 'group-killed' });
  }
}

function stopVerifiedPid(entry, label, report, { graceMs, killWaitMs }) {
  const pid = entry?.pid;
  const expectedTokens = entry?.expectedExeTokens ?? [];
  if (
    entry?.processGroupId !== undefined &&
    Number.isInteger(pid) &&
    pid > 1 &&
    inspectPidState(pid).alive
  ) {
    const observed = inspectPidIdentity(pid);
    if (observed && !identityMatches(observed, expectedTokens)) {
      report.errors.push(
        `pid-identity-mismatch:${label}:${pid}:observed=${observed.exe}`,
      );
      return;
    }
    if (observed) {
      stopOwnedProcessGroup(entry.processGroupId, label, graceMs, report);
    }
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    report.errors.push(`invalid-pid:${label}:${pid}`);
    return;
  }
  if (pid === process.pid) {
    report.errors.push(`refusing-self-pid:${label}:${pid}`);
    return;
  }
  if (!inspectPidState(pid).alive) {
    report.processes.push({ label, pid, action: 'already-absent' });
    return;
  }
  const observed = inspectPidIdentity(pid);
  if (!observed) {
    report.processes.push({ label, pid, action: 'already-absent' });
    return;
  }
  if (!identityMatches(observed, expectedTokens)) {
    report.errors.push(
      `pid-identity-mismatch:${label}:${pid}:observed=${observed.exe}`,
    );
    report.processes.push({
      label,
      pid,
      action: 'refused-identity-mismatch',
      observed,
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      report.processes.push({ label, pid, action: 'already-absent' });
      return;
    }
    report.errors.push(`sigterm-failed:${label}:${pid}:${error.code}`);
    return;
  }

  const termDeadline = Date.now() + graceMs;
  while (Date.now() < termDeadline) {
    if (!inspectPidState(pid).alive) {
      report.processes.push({ label, pid, action: 'terminated' });
      return;
    }
    sleepMs(25);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') {
      report.processes.push({ label, pid, action: 'terminated' });
      return;
    }
    report.errors.push(`sigkill-failed:${label}:${pid}:${error.code}`);
    return;
  }

  const killDeadline = Date.now() + killWaitMs;
  while (Date.now() < killDeadline) {
    if (!inspectPidState(pid).alive) {
      report.processes.push({ label, pid, action: 'killed' });
      return;
    }
    sleepMs(50);
  }

  report.errors.push(`pid-still-alive-after-sigkill:${label}:${pid}`);
  report.processes.push({ label, pid, action: 'still-alive' });
}

function removeApprovedPath(targetPath, label, approvedRoots, report) {
  if (!isPathWithinApprovedRoots(targetPath, approvedRoots)) {
    report.errors.push(`unapproved-path:${label}:${targetPath}`);
    return;
  }
  let st;
  try {
    st = lstatSync(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      report.paths.push({ label, path: targetPath, action: 'already-absent' });
      return;
    }
    report.errors.push(`stat-failed:${label}:${targetPath}:${error.code}`);
    return;
  }
  try {
    if (st.isDirectory() && !st.isSymbolicLink()) {
      rmdirSync(targetPath);
    } else {
      unlinkSync(targetPath);
    }
    report.paths.push({ label, path: targetPath, action: 'removed' });
  } catch (error) {
    report.errors.push(`remove-failed:${label}:${targetPath}:${error.code}`);
  }
}

function revokeApprovedToken(tokenPath, approvedRoots, report) {
  if (!isPathWithinApprovedRoots(tokenPath, approvedRoots)) {
    report.errors.push(`unapproved-path:token:${tokenPath}`);
    return;
  }
  let st;
  try {
    st = lstatSync(tokenPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      report.token = { path: tokenPath, action: 'already-absent' };
      return;
    }
    report.errors.push(`stat-failed:token:${tokenPath}:${error.code}`);
    return;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    report.errors.push(`invalid-token-file:${tokenPath}`);
    return;
  }
  let data = {};
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed;
    }
  } catch {
    data = {};
  }
  if (data.revoked === true) {
    report.token = { path: tokenPath, action: 'already-revoked' };
    return;
  }
  data.revoked = true;
  data.revokedBy = 'verify-pr-vm-lifecycle';
  data.revokedAt = new Date().toISOString();
  writeAtomicPrivate(tokenPath, `${JSON.stringify(data, null, 2)}\n`);
  report.token = { path: tokenPath, action: 'revoked' };
}

function resolveFirecrackerWorkerPid(record) {
  const token = record.expectedExeTokens?.[0];
  if (
    process.platform !== 'linux' ||
    record.backend !== 'firecracker' ||
    typeof token !== 'string' ||
    token === '' ||
    token.includes('/') ||
    !Number.isInteger(record.vmmUid) ||
    record.vmmUid <= 0 ||
    typeof record.runId !== 'string'
  ) {
    return { pid: null, error: null };
  }
  const candidates = [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch (error) {
    return { pid: null, error: `firecracker-proc-enumeration:${error.code}` };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const exe = readlinkSync(`/proc/${entry}/exe`);
      if (exe !== token && !exe.endsWith(`/${token}`)) continue;
      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const uidLine = status
        .split('\n')
        .find((line) => line.startsWith('Uid:'));
      if (Number(uidLine?.split(/\s+/)[1]) !== record.vmmUid) continue;
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      if (
        !argv.some(
          (arg, index) => arg === '--id' && argv[index + 1] === record.runId,
        )
      ) {
        continue;
      }
      candidates.push(Number(entry));
    } catch {
      // A process can exit between /proc enumeration and identity reads.
    }
  }
  if (candidates.length > 1) {
    return {
      pid: null,
      error: `firecracker-worker-recovery-ambiguous:${record.runId}`,
    };
  }
  return { pid: candidates[0] ?? null, error: null };
}

/**
 * Idempotently reaps only the resources named in `ownershipPath`.
 * Refuses to kill PIDs whose executable identity does not match or to touch
 * paths outside `approvedRoots`.
 */
export function reapOwnership(
  ownershipPath,
  { approvedRoots = [], graceMs = 500, killWaitMs = 5000 } = {},
) {
  const validRoots = approvedRoots.filter((r) => {
    if (typeof r !== 'string' || r.trim() === '') return false;
    let resolvedRoot = resolve(r);
    try {
      resolvedRoot = realpathSync(resolvedRoot);
    } catch {
      // Keep lexical resolved path.
    }
    return !isFilesystemRoot(resolvedRoot);
  });
  if (validRoots.length === 0) {
    return {
      status: 'failed',
      runId: null,
      backend: null,
      processes: [],
      paths: [],
      token: null,
      errors: ['approvedRoots must contain at least one non-root directory'],
    };
  }

  const read = readSingleLinkRegularFile(ownershipPath);
  if (read.error) {
    return {
      status: 'failed',
      runId: null,
      backend: null,
      processes: [],
      paths: [],
      token: null,
      errors: [`ownership-${read.error}`],
    };
  }
  let record;
  try {
    record = JSON.parse(read.text);
  } catch {
    return {
      status: 'failed',
      runId: null,
      backend: null,
      processes: [],
      paths: [],
      token: null,
      errors: ['ownership-invalid-json'],
    };
  }
  if (!record || record.schemaVersion !== OWNERSHIP_SCHEMA) {
    return {
      status: 'failed',
      runId: null,
      backend: null,
      processes: [],
      paths: [],
      token: null,
      errors: ['ownership-unsupported-schema'],
    };
  }

  const recovery = resolveFirecrackerWorkerPid(record);
  if (
    recovery.pid &&
    (!Number.isInteger(record.worker?.pid) ||
      !inspectPidState(record.worker.pid).alive)
  ) {
    record.worker = {
      ...record.worker,
      pid: recovery.pid,
      expectedExeTokens:
        record.worker?.expectedExeTokens ?? record.expectedExeTokens ?? [],
      processGroupId: undefined,
    };
  }

  const report = {
    status: 'reaped',
    runId: record.runId ?? null,
    backend: record.backend ?? null,
    resolvedWorkerPid: recovery.pid,
    processes: [],
    paths: [],
    token: null,
    errors: recovery.error ? [recovery.error] : [],
  };

  if (record.worker && typeof record.worker === 'object') {
    stopVerifiedPid(record.worker, 'worker', report, { graceMs, killWaitMs });
  }
  if (Array.isArray(record.helpers)) {
    record.helpers.forEach((helper, idx) => {
      stopVerifiedPid(helper, `helper-${idx}`, report, { graceMs, killWaitMs });
    });
  }
  if (record.workDiskPath) {
    removeApprovedPath(record.workDiskPath, 'work-disk', validRoots, report);
  }
  if (Array.isArray(record.socketPaths)) {
    record.socketPaths.forEach((sock, idx) => {
      removeApprovedPath(sock, `socket-${idx}`, validRoots, report);
    });
  }
  if (record.socketDir) {
    removeApprovedPath(record.socketDir, 'socket-dir', validRoots, report);
  }
  if (record.tokenFile) {
    revokeApprovedToken(record.tokenFile, validRoots, report);
  }

  report.status = report.errors.length === 0 ? 'reaped' : 'failed';
  return report;
}

/**
 * Builds a canonical `execution-record.json` object from a host-held `prepare`
 * snapshot and observed runtime/teardown metadata.
 */
export function buildExecutionRecord({
  contextSnapshot,
  contextSha256,
  runId,
  backend,
  backendVersion,
  platform = `${process.platform}-${process.arch}`,
  startedAt,
  endedAt,
  destroyedAt = null,
  outputStatus,
  teardownStatus,
  diskDestroyed = false,
  tokenRevoked = false,
  launchPolicyDigest,
  trustedInputDigest,
  kernelDigest = null,
  rootfsDigest = null,
  supervisorPid = null,
  workerPid = null,
  workerExe = null,
  workerExitEvidence = null,
  providerLifecycle = null,
  prTrust = null,
  executionClass = null,
}) {
  const trustFromSnapshot = contextSnapshot?.trustClassification ?? null;
  const headRefOid = contextSnapshot?.headRefOid ?? '';
  if (
    trustFromSnapshot?.headRefOid &&
    trustFromSnapshot.headRefOid !== headRefOid
  ) {
    throw new Error(
      `stale trustClassification headRefOid (${trustFromSnapshot.headRefOid}) does not match snapshot headRefOid (${headRefOid})`,
    );
  }
  const prNumber = contextSnapshot?.pr ?? contextSnapshot?.number ?? null;
  const resolvedTrust = prTrust ?? trustFromSnapshot?.prTrust ?? 'unknown';
  const resolvedClass =
    executionClass ?? trustFromSnapshot?.executionClass ?? 'hardware-isolated';

  const record = {
    schemaVersion: EXECUTION_RECORD_SCHEMA,
    runId,
    repo: contextSnapshot?.repo ?? '',
    pr: prNumber,
    baseRefOid: contextSnapshot?.baseRefOid ?? '',
    headRefOid,
    contextDigest: contextSha256,
    prTrust: resolvedTrust,
    executionClass: resolvedClass,
    backend,
    backendVersion,
    platform,
    trustedInputDigest,
    launchPolicyDigest,
    startedAt,
    endedAt,
    destroyedAt,
    teardownStatus,
    diskDestroyed: Boolean(diskDestroyed),
    tokenRevoked: Boolean(tokenRevoked),
    outputStatus,
  };
  if (backend === 'firecracker' || backend === 'vfkit') {
    record.kernelDigest = kernelDigest;
    record.rootfsDigest = rootfsDigest;
    if (supervisorPid !== null) record.supervisorPid = supervisorPid;
    record.workerPid = workerPid;
    record.workerExe = workerExe;
    record.workerExitEvidence = workerExitEvidence;
  } else if (backend === 'provider-vm') {
    record.providerLifecycle = providerLifecycle;
  }
  return record;
}

/**
 * Writes `execution-record.json` into launcher-owned storage outside
 * `artifactDir`, enforces live worker absence for local VMMs, validates via
 * `checkExecutionRecord()`, and emits `artifactDir/boundary.json` ONLY on pass.
 */
export function writeExecutionRecordAndBoundary({
  record,
  launcherDir,
  artifactDir,
  verifyLivePid = true,
}) {
  const resolvedLauncher = resolve(launcherDir);
  const resolvedArtifact = resolve(artifactDir);
  mkdirSync(resolvedLauncher, { recursive: true, mode: 0o700 });
  mkdirSync(resolvedArtifact, { recursive: true, mode: 0o700 });
  const realLauncher = realpathSync(resolvedLauncher);
  const realArtifact = realpathSync(resolvedArtifact);

  if (
    realLauncher === realArtifact ||
    withinPrefix(realArtifact, realLauncher) ||
    withinPrefix(realLauncher, realArtifact)
  ) {
    return {
      ok: false,
      errors: [
        'launcherDir and artifactDir must not overlap or nest inside each other',
      ],
      executionRecordPath: null,
      executionRecordSha256: null,
      boundaryPath: null,
    };
  }

  const normalized = { ...record };
  const liveErrors = [];
  if (
    verifyLivePid &&
    (normalized.backend === 'firecracker' || normalized.backend === 'vfkit') &&
    Number.isInteger(normalized.workerPid) &&
    normalized.workerPid > 1 &&
    inspectPidState(normalized.workerPid).alive
  ) {
    normalized.workerExitEvidence = 'alive';
    normalized.teardownStatus = 'running';
    liveErrors.push(`worker-still-alive:${normalized.workerPid}`);
  }

  const recordPath = join(realLauncher, 'execution-record.json');
  const recordText = `${JSON.stringify(normalized, null, 2)}\n`;
  try {
    writeAtomicPrivate(recordPath, recordText);
  } catch (error) {
    return {
      ok: false,
      errors: [`execution-record-write-refused:${error.message}`],
      executionRecordPath: null,
      executionRecordSha256: null,
      boundaryPath: null,
    };
  }
  const recordSha256 = createHash('sha256')
    .update(recordText, 'utf8')
    .digest('hex');

  const check = checkExecutionRecord(recordText, {
    expectedHead: normalized.headRefOid || null,
    expectedSha256: recordSha256,
    actualSha256: recordSha256,
    // The record was built host-side from the digest-bound prepare snapshot,
    // so its own coordinates are the trusted anchor for this self-check.
    coordinates:
      normalized.repo && Number.isInteger(normalized.pr)
        ? {
            owner: normalized.repo.split('/')[0],
            repo: normalized.repo.split('/').slice(1).join('/'),
            number: normalized.pr,
          }
        : null,
  });
  const errors = [...liveErrors, ...check.errors];
  const boundaryPath = join(realArtifact, 'boundary.json');
  if (errors.length > 0) {
    // Ensure a failed round never leaves a stale boundary declaration behind.
    try {
      const st = lstatSync(boundaryPath);
      if (st.isFile() && !st.isSymbolicLink())
        rmSync(boundaryPath, { force: true });
    } catch {
      // Absent.
    }
    return {
      ok: false,
      errors,
      executionRecordPath: recordPath,
      executionRecordSha256: recordSha256,
      boundaryPath: null,
    };
  }

  let mode;
  if (normalized.executionClass === 'hardware-isolated') {
    mode = normalized.backend === 'provider-vm' ? 'vm' : 'microvm';
  } else {
    mode = 'container';
  }
  const boundary = {
    mode,
    backend: normalized.backend,
    executionClass: normalized.executionClass,
    prTrust: normalized.prTrust,
    runId: normalized.runId,
    headRefOid: normalized.headRefOid,
    executionRecordSha256: recordSha256,
    writtenBy: 'verify-pr-vm-lifecycle',
    writtenAfterTeardown: true,
  };
  try {
    writeAtomicPrivate(boundaryPath, `${JSON.stringify(boundary, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      errors: [`boundary-write-refused:${error.message}`],
      executionRecordPath: recordPath,
      executionRecordSha256: recordSha256,
      boundaryPath: null,
    };
  }
  return {
    ok: true,
    errors: [],
    executionRecordPath: recordPath,
    executionRecordSha256: recordSha256,
    boundaryPath,
    boundary,
  };
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === 'reap') {
    let ownership = null;
    let outReport = null;
    const approvedRoots = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === '--ownership') {
        ownership = rest[(i += 1)] ?? null;
      } else if (arg === '--approved-root') {
        const root = rest[(i += 1)] ?? null;
        if (!root) {
          process.stderr.write(
            `verify-pr vm-lifecycle: --approved-root requires a path\n\n${HELP}`,
          );
          return 2;
        }
        approvedRoots.push(root);
      } else if (arg === '--out-report') {
        outReport = rest[(i += 1)] ?? null;
      } else {
        process.stderr.write(
          `verify-pr vm-lifecycle: unknown option ${arg}\n\n${HELP}`,
        );
        return 2;
      }
    }
    if (!ownership || approvedRoots.length === 0) {
      process.stderr.write(
        `verify-pr vm-lifecycle reap: --ownership and at least one --approved-root are required\n\n${HELP}`,
      );
      return 2;
    }
    const report = reapOwnership(ownership, { approvedRoots });
    if (outReport) {
      writeAtomicPrivate(outReport, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'reaped' ? 0 : 1;
  }

  if (subcommand === 'finalize') {
    let contextPath = null;
    let contextSha = null;
    let launcherDir = null;
    let artifactDir = null;
    let metaPath = null;
    let verifyLivePid = true;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === '--context') {
        contextPath = rest[(i += 1)] ?? null;
      } else if (arg === '--context-sha256') {
        contextSha = rest[(i += 1)] ?? null;
      } else if (arg === '--launcher-dir') {
        launcherDir = rest[(i += 1)] ?? null;
      } else if (arg === '--artifact-dir') {
        artifactDir = rest[(i += 1)] ?? null;
      } else if (arg === '--meta') {
        metaPath = rest[(i += 1)] ?? null;
      } else if (arg === '--no-verify-live-pid') {
        verifyLivePid = false;
      } else {
        process.stderr.write(
          `verify-pr vm-lifecycle: unknown option ${arg}\n\n${HELP}`,
        );
        return 2;
      }
    }
    if (
      !contextPath ||
      !contextSha ||
      !SHA256_RE.test(contextSha) ||
      !launcherDir ||
      !artifactDir ||
      !metaPath
    ) {
      process.stderr.write(
        `verify-pr vm-lifecycle finalize: --context, --context-sha256 (64-hex), --launcher-dir, --artifact-dir, and --meta are required\n\n${HELP}`,
      );
      return 2;
    }
    const ctxRead = readSingleLinkRegularFile(contextPath);
    if (ctxRead.error) {
      process.stderr.write(
        `verify-pr vm-lifecycle finalize: context ${contextPath} rejected (${ctxRead.error})\n`,
      );
      return 1;
    }
    const actualCtxSha = createHash('sha256')
      .update(ctxRead.text, 'utf8')
      .digest('hex');
    if (actualCtxSha !== contextSha) {
      process.stderr.write(
        'verify-pr vm-lifecycle finalize: --context bytes do not match --context-sha256\n',
      );
      return 1;
    }
    const metaRead = readSingleLinkRegularFile(metaPath);
    if (metaRead.error) {
      process.stderr.write(
        `verify-pr vm-lifecycle finalize: meta ${metaPath} rejected (${metaRead.error})\n`,
      );
      return 1;
    }
    let contextSnapshot;
    let meta;
    try {
      contextSnapshot = JSON.parse(ctxRead.text);
      meta = JSON.parse(metaRead.text);
    } catch (error) {
      process.stderr.write(
        `verify-pr vm-lifecycle finalize: invalid JSON input: ${error.message}\n`,
      );
      return 1;
    }
    let record;
    try {
      record = buildExecutionRecord({
        contextSnapshot,
        contextSha256: contextSha,
        ...meta,
      });
    } catch (error) {
      process.stderr.write(
        `verify-pr vm-lifecycle finalize: ${error.message}\n`,
      );
      return 1;
    }
    const result = writeExecutionRecordAndBoundary({
      record,
      launcherDir,
      artifactDir,
      verifyLivePid,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  process.stderr.write(
    `verify-pr vm-lifecycle: unknown subcommand ${subcommand}\n\n${HELP}`,
  );
  return 2;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
