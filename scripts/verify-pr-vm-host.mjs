#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host capability probes, deny-default macOS Seatbelt profile rendering, and
 * fail-closed per-round asset staging for hardware-isolated `/verify-pr` runs.
 *
 *   - Linux KVM: checks real `/dev/kvm` character-device open, cgroup v2,
 *     non-root VMM uid/gid, and real `firecracker` / `jailer` binaries.
 *   - macOS VZ:  checks Apple Silicon, `vfkit` virtualization entitlement via
 *     `codesign`, and runs a live positive+negative `/usr/bin/sandbox-exec`
 *     enforcement probe against the deny-default Seatbelt profile (D7).
 *   - Staging:   derives per-round working disks/kernels from read-only golden
 *     assets with independent inodes and SHA-256 parity, writes Firecracker
 *     `config.json` or macOS Seatbelt profiles atomically, and rolls back every
 *     newly created file on error without touching golden sources.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPathWithinApprovedRoots } from './verify-pr-vm-lifecycle.mjs';

const MAX_CONFIG_BYTES = 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DEFAULT_CODESIGN = '/usr/bin/codesign';
const DEFAULT_ENV_BIN = '/usr/bin/env';

let stagingSeq = 0;

function nextTempSuffix() {
  stagingSeq += 1;
  return `${process.pid}.${stagingSeq}`;
}

function withinDir(root, target) {
  return (
    target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

function assertSafeSeatbeltLiteral(label, value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    !isAbsolute(value) ||
    /["\\\r\n\0]/.test(value)
  ) {
    throw new Error(
      `invalid ${label}: must be an absolute path without quotes, backslashes, newlines, or NUL bytes`,
    );
  }
}

/**
 * Renders the minimal deny-default Seatbelt `.sb` profile for macOS `vfkit`
 * host-process confinement (D7). Parameters `POC_DIR` and `POC_SOCKET_DIR`
 * must be passed via `sandbox-exec -D` using canonicalized (`realpath`) paths.
 */
export function renderVfkitSeatbeltProfile({ vfkitBin = null } = {}) {
  const execRules = ['  (subpath "/bin")', '  (subpath "/usr/bin")'];
  const extraReadRules = [];
  if (vfkitBin !== null) {
    assertSafeSeatbeltLiteral('vfkitBin', vfkitBin);
    let resolvedBin = vfkitBin;
    try {
      resolvedBin = realpathSync(vfkitBin);
    } catch {
      // Keep explicit path when rendering a plan before installation.
    }
    assertSafeSeatbeltLiteral('vfkitBin', resolvedBin);
    execRules.push(`  (literal "${resolvedBin}")`);
    extraReadRules.push(`  (literal "${resolvedBin}")`);
    if (resolvedBin !== vfkitBin) {
      execRules.push(`  (literal "${vfkitBin}")`);
      extraReadRules.push(`  (literal "${vfkitBin}")`);
    }
  }

  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '',
    '(deny network-inbound)',
    '(deny network-outbound (remote ip))',
    '',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow process-info* (target self))',
    '(allow process-exec',
    ...execRules,
    ')',
    '',
    '(allow mach-lookup',
    '  (global-name "com.apple.Virtualization.VirtualMachine")',
    '  (global-name "com.apple.SecurityServer")',
    '  (global-name "com.apple.CoreServices.coreservicesd")',
    ')',
    '(allow iokit-open',
    '  (iokit-user-client-class "AppleHVClient")',
    '  (iokit-user-client-class "RootDomainUserClient")',
    ')',
    '',
    '(allow file-read*',
    '  (subpath "/bin")',
    '  (subpath "/usr/bin")',
    ...extraReadRules,
    '  (subpath (param "POC_DIR"))',
    '  (subpath (param "POC_SOCKET_DIR"))',
    ')',
    '(allow file-map-executable',
    '  (subpath "/bin")',
    '  (subpath "/usr/bin")',
    ...extraReadRules,
    ')',
    '(allow file-write*',
    '  (subpath (param "POC_DIR"))',
    '  (subpath (param "POC_SOCKET_DIR"))',
    ')',
    '(allow network-bind',
    '  (local unix-socket (subpath (param "POC_SOCKET_DIR")))',
    ')',
    '(allow network-outbound',
    '  (remote unix-socket (subpath (param "POC_SOCKET_DIR")))',
    ')',
    '',
  ].join('\n');
}

function canonicalizePreservingLeaf(absPath) {
  const leaf = basename(absPath);
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
      tail.push(basename(cursor));
      cursor = next;
    }
  }
}

function readSingleLinkFile(filePath, maxBytes = MAX_CONFIG_BYTES) {
  let fd;
  try {
    // O_NONBLOCK prevents blocking indefinitely if an attacker plants a FIFO.
    fd = openSync(
      filePath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'non-regular', text: null };
    if (st.nlink !== 1)
      return { error: `hardlink-alias:${st.nlink}`, text: null };
    if (st.size > maxBytes) return { error: 'too-large', text: null };
    return { error: null, text: readFileSync(fd, 'utf8') };
  } catch (error) {
    if (error.code === 'ELOOP') return { error: 'symlink', text: null };
    return { error: `unreadable:${error.code ?? 'UNKNOWN'}`, text: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isRegularExecutable(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, reason: 'missing-path', resolvedPath: null };
  }
  let st;
  try {
    st = lstatSync(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: `stat-failed:${error.code ?? 'ENOENT'}`,
      resolvedPath: null,
    };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, reason: 'symlink-refused', resolvedPath: null };
  }
  if (!st.isFile()) {
    return { ok: false, reason: 'non-regular-file', resolvedPath: null };
  }
  try {
    accessSync(filePath, fsConstants.X_OK);
  } catch (error) {
    return {
      ok: false,
      reason: `not-executable:${error.code ?? 'EACCES'}`,
      resolvedPath: null,
    };
  }
  return { ok: true, reason: null, resolvedPath: realpathSync(filePath) };
}

function findInPath(binaryName, envPath = process.env.PATH ?? '') {
  if (typeof binaryName !== 'string' || binaryName.includes(sep)) return null;
  for (const dir of envPath.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, binaryName);
    try {
      const st = lstatSync(candidate);
      if (st.isFile() || st.isSymbolicLink()) {
        // Return the unresolved candidate so isRegularExecutable applies the
        // same non-symlink policy to PATH discovery and explicit --*-bin flags.
        return candidate;
      }
    } catch {
      // Try next PATH entry.
    }
  }
  return null;
}

function probeBinaryVersion(binPath, args = ['--version'], timeoutMs = 5_000) {
  const res = spawnSync(binPath, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
    },
  });
  if (res.error) {
    return {
      ok: false,
      version: null,
      reason: `exec-error:${res.error.code ?? res.error.message}`,
    };
  }
  if (res.status !== 0) {
    return { ok: false, version: null, reason: `exit-status:${res.status}` };
  }
  const line = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) {
    return { ok: false, version: null, reason: 'empty-version-output' };
  }
  return { ok: true, version: line, reason: null };
}

/**
 * Live macOS Seatbelt enforcement probe (D7 / acceptance criterion 10).
 * Executes a clean-environment `/usr/bin/sandbox-exec` subprocess that must:
 *   1. Read and write inside `POC_DIR` (positive control), AND
 *   2. Fail to read a host canary file outside `POC_DIR` (negative control), AND
 *   3. Fail to create a file outside `POC_DIR` (negative write control).
 * Fails closed (`enforcing: false`) on any missing binary, bad profile, or
 * unexpected pass/leak.
 */
export function probeSeatbeltEnforcement({
  platform = process.platform,
  sandboxExecBin = DEFAULT_SANDBOX_EXEC,
  envBin = DEFAULT_ENV_BIN,
  seatbeltProfilePath = null,
  vfkitBin = null,
  timeoutMs = 10_000,
  probeParentDir = tmpdir(),
} = {}) {
  if (platform !== 'darwin') {
    return {
      enforcing: false,
      positiveReadOk: false,
      positiveWriteOk: false,
      canaryReadDenied: false,
      outsideWriteDenied: false,
      reasons: ['non-darwin-platform'],
    };
  }
  const sbExecCheck = isRegularExecutable(sandboxExecBin);
  if (!sbExecCheck.ok) {
    return {
      enforcing: false,
      positiveReadOk: false,
      positiveWriteOk: false,
      canaryReadDenied: false,
      outsideWriteDenied: false,
      reasons: [`sandbox-exec:${sbExecCheck.reason}`],
    };
  }

  let profileToUse = seatbeltProfilePath;
  if (profileToUse !== null) {
    const profileRead = readSingleLinkFile(profileToUse);
    if (profileRead.error) {
      return {
        enforcing: false,
        positiveReadOk: false,
        positiveWriteOk: false,
        canaryReadDenied: false,
        outsideWriteDenied: false,
        reasons: [`seatbelt-profile:${profileRead.error}`],
      };
    }
    profileToUse = realpathSync(profileToUse);
  }

  const probeRoot = realpathSync(
    mkdtempSync(join(probeParentDir, 'qc-sb-probe-')),
  );
  try {
    chmodSync(probeRoot, 0o700);
    const pocDir = join(probeRoot, 'poc');
    const sockDir = join(probeRoot, 'sock');
    const outsideDir = join(probeRoot, 'outside');
    mkdirSync(pocDir, { mode: 0o700 });
    mkdirSync(sockDir, { mode: 0o700 });
    mkdirSync(outsideDir, { mode: 0o700 });

    const insideToken = `inside-${randomBytes(12).toString('hex')}`;
    const writeToken = `write-${randomBytes(12).toString('hex')}`;
    const canaryToken = `canary-${randomBytes(12).toString('hex')}`;
    const insideFile = join(pocDir, 'inside.txt');
    const writeFile = join(pocDir, 'write-ok.txt');
    const canaryFile = join(outsideDir, 'host-canary.txt');
    const escapeWriteFile = join(outsideDir, 'escape-write.txt');
    writeFileSync(insideFile, `${insideToken}\n`, { mode: 0o600 });
    writeFileSync(canaryFile, `${canaryToken}\n`, { mode: 0o600 });

    if (profileToUse === null) {
      let renderedProfile;
      try {
        renderedProfile = renderVfkitSeatbeltProfile({ vfkitBin });
      } catch (error) {
        return {
          enforcing: false,
          positiveReadOk: false,
          positiveWriteOk: false,
          canaryReadDenied: false,
          outsideWriteDenied: false,
          reasons: [`seatbelt-profile-render:${error.message}`],
        };
      }
      profileToUse = join(probeRoot, 'vfkit.sb');
      writeFileSync(profileToUse, renderedProfile, {
        mode: 0o600,
      });
    }

    const script = [
      'set -u',
      'if READ_VAL=$(/bin/cat "$1" 2>/dev/null); then',
      '  printf "POS_READ=%s\\n" "$READ_VAL"',
      'else',
      '  printf "POS_READ_ERR=1\\n"',
      'fi',
      'if printf "%s\\n" "$3" > "$2" 2>/dev/null; then',
      '  printf "POS_WRITE=ok\\n"',
      'else',
      '  printf "POS_WRITE_ERR=1\\n"',
      'fi',
      'if CANARY_VAL=$(/bin/cat "$4" 2>/dev/null); then',
      '  printf "CANARY_LEAK=%s\\n" "$CANARY_VAL"',
      'else',
      '  printf "CANARY_DENIED=1\\n"',
      'fi',
      'if printf "escaped\\n" > "$5" 2>/dev/null; then',
      '  printf "OUTSIDE_WRITE_LEAK=1\\n"',
      'else',
      '  printf "OUTSIDE_WRITE_DENIED=1\\n"',
      'fi',
    ].join('\n');

    const res = spawnSync(
      envBin,
      [
        '-i',
        'PATH=/usr/bin:/bin',
        `HOME=${pocDir}`,
        `TMPDIR=${pocDir}`,
        'LANG=C',
        'LC_ALL=C',
        sandboxExecBin,
        '-f',
        profileToUse,
        '-D',
        `POC_DIR=${pocDir}`,
        '-D',
        `POC_SOCKET_DIR=${sockDir}`,
        '/bin/sh',
        '-c',
        script,
        'seatbelt-probe',
        insideFile,
        writeFile,
        writeToken,
        canaryFile,
        escapeWriteFile,
      ],
      { cwd: pocDir, encoding: 'utf8', timeout: timeoutMs },
    );

    const reasons = [];
    if (res.error) {
      reasons.push(`probe-exec-error:${res.error.code ?? res.error.message}`);
    }
    if (res.status !== 0) {
      reasons.push(`probe-exit-status:${res.status}`);
    }
    const stdout = res.stdout ?? '';
    const positiveReadOk = stdout.includes(`POS_READ=${insideToken}\n`);
    const positiveWriteOk =
      stdout.includes('POS_WRITE=ok\n') &&
      existsSync(writeFile) &&
      readFileSync(writeFile, 'utf8').trim() === writeToken;
    const canaryReadDenied =
      stdout.includes('CANARY_DENIED=1\n') &&
      !stdout.includes(canaryToken) &&
      !stdout.includes('CANARY_LEAK=');
    const outsideWriteDenied =
      stdout.includes('OUTSIDE_WRITE_DENIED=1\n') &&
      !stdout.includes('OUTSIDE_WRITE_LEAK=1') &&
      !existsSync(escapeWriteFile);

    if (!positiveReadOk) reasons.push('positive-read-failed');
    if (!positiveWriteOk) reasons.push('positive-write-failed');
    if (!canaryReadDenied) reasons.push('canary-read-not-denied');
    if (!outsideWriteDenied) reasons.push('outside-write-not-denied');

    const enforcing =
      reasons.length === 0 &&
      positiveReadOk &&
      positiveWriteOk &&
      canaryReadDenied &&
      outsideWriteDenied;

    return {
      enforcing,
      positiveReadOk,
      positiveWriteOk,
      canaryReadDenied,
      outsideWriteDenied,
      reasons,
    };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function probeLinuxKvm({
  platform,
  kvmDevice = '/dev/kvm',
  cgroupControllersPath = '/sys/fs/cgroup/cgroup.controllers',
  firecrackerBin = null,
  jailerBin = null,
  vmmUid = 65534,
  vmmGid = 65534,
}) {
  const reasons = [];
  if (platform !== 'linux') {
    return {
      available: false,
      kvmDeviceOk: false,
      cgroupV2Ok: false,
      firecrackerBin: null,
      firecrackerVersion: null,
      jailerBin: null,
      jailerVersion: null,
      vmmUidOk: false,
      reasons: ['non-linux-platform'],
    };
  }

  let kvmDeviceOk = false;
  let kvmFd;
  try {
    const st = lstatSync(kvmDevice);
    if (st.isSymbolicLink()) {
      reasons.push('kvm-device-symlink');
    } else if (!st.isCharacterDevice()) {
      reasons.push('kvm-device-not-char');
    } else {
      kvmFd = openSync(kvmDevice, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      kvmDeviceOk = true;
    }
  } catch (error) {
    reasons.push(`kvm-device:${error.code ?? 'UNAVAILABLE'}`);
  } finally {
    if (kvmFd !== undefined) closeSync(kvmFd);
  }

  let cgroupV2Ok = false;
  try {
    const controllers = readFileSync(cgroupControllersPath, 'utf8');
    if (controllers.trim().length > 0) {
      cgroupV2Ok = true;
    } else {
      reasons.push('cgroup-v2-empty');
    }
  } catch (error) {
    reasons.push(`cgroup-v2:${error.code ?? 'UNAVAILABLE'}`);
  }

  const vmmUidOk =
    Number.isInteger(vmmUid) &&
    vmmUid > 0 &&
    Number.isInteger(vmmGid) &&
    vmmGid > 0;
  if (!vmmUidOk) {
    reasons.push('invalid-non-root-vmm-uid-gid');
  }

  const resolvedFc = firecrackerBin ?? findInPath('firecracker');
  const resolvedJailer = jailerBin ?? findInPath('jailer');

  let firecrackerVersion = null;
  if (!resolvedFc) {
    reasons.push('firecracker-binary-missing');
  } else {
    const check = isRegularExecutable(resolvedFc);
    if (!check.ok) {
      reasons.push(`firecracker-binary:${check.reason}`);
    } else {
      const ver = probeBinaryVersion(check.resolvedPath);
      if (!ver.ok) reasons.push(`firecracker-version:${ver.reason}`);
      else firecrackerVersion = ver.version;
    }
  }

  let jailerVersion = null;
  if (!resolvedJailer) {
    reasons.push('jailer-binary-missing');
  } else {
    const check = isRegularExecutable(resolvedJailer);
    if (!check.ok) {
      reasons.push(`jailer-binary:${check.reason}`);
    } else {
      const ver = probeBinaryVersion(check.resolvedPath);
      if (!ver.ok) reasons.push(`jailer-version:${ver.reason}`);
      else jailerVersion = ver.version;
    }
  }

  const available =
    reasons.length === 0 &&
    kvmDeviceOk &&
    cgroupV2Ok &&
    vmmUidOk &&
    firecrackerVersion !== null &&
    jailerVersion !== null;

  return {
    available,
    kvmDeviceOk,
    cgroupV2Ok,
    firecrackerBin: resolvedFc,
    firecrackerVersion,
    jailerBin: resolvedJailer,
    jailerVersion,
    vmmUidOk,
    reasons,
  };
}

function probeMacVfkit({
  platform,
  arch,
  vfkitBin = null,
  seatbeltProfilePath = null,
  sandboxExecBin = DEFAULT_SANDBOX_EXEC,
  codesignBin = DEFAULT_CODESIGN,
  envBin = DEFAULT_ENV_BIN,
  probeParentDir = tmpdir(),
}) {
  const reasons = [];
  if (platform !== 'darwin' || arch !== 'arm64') {
    return {
      available: false,
      vfkitBin: null,
      vfkitVersion: null,
      hasVirtualizationEntitlement: false,
      seatbeltBinaryOk: false,
      seatbeltEnforcing: false,
      seatbeltProbe: null,
      reasons: ['requires-darwin-arm64'],
    };
  }

  const sbCheck = isRegularExecutable(sandboxExecBin);
  const seatbeltBinaryOk = sbCheck.ok;
  if (!seatbeltBinaryOk) {
    reasons.push(`sandbox-exec:${sbCheck.reason}`);
  }

  const resolvedVfkit = vfkitBin ?? findInPath('vfkit');
  let vfkitVersion = null;
  let hasVirtualizationEntitlement = false;

  if (!resolvedVfkit) {
    reasons.push('vfkit-binary-missing');
  } else {
    const binCheck = isRegularExecutable(resolvedVfkit);
    if (!binCheck.ok) {
      reasons.push(`vfkit-binary:${binCheck.reason}`);
    } else {
      const ver = probeBinaryVersion(binCheck.resolvedPath);
      if (!ver.ok) {
        reasons.push(`vfkit-version:${ver.reason}`);
      } else {
        vfkitVersion = ver.version;
      }
      const csCheck = isRegularExecutable(codesignBin);
      if (!csCheck.ok) {
        reasons.push(`codesign:${csCheck.reason}`);
      } else {
        const cs = spawnSync(
          csCheck.resolvedPath,
          ['-d', '--entitlements', ':-', binCheck.resolvedPath],
          { encoding: 'utf8', timeout: 5_000 },
        );
        const combined = `${cs.stdout ?? ''}\n${cs.stderr ?? ''}`;
        if (
          !cs.error &&
          cs.status === 0 &&
          combined.includes('com.apple.security.virtualization')
        ) {
          hasVirtualizationEntitlement = true;
        } else {
          reasons.push('vfkit-missing-virtualization-entitlement');
        }
      }
    }
  }

  const seatbeltProbe = seatbeltBinaryOk
    ? probeSeatbeltEnforcement({
        platform,
        sandboxExecBin,
        envBin,
        seatbeltProfilePath,
        vfkitBin: resolvedVfkit,
        probeParentDir,
      })
    : null;
  const seatbeltEnforcing = seatbeltProbe?.enforcing === true;
  if (!seatbeltEnforcing) {
    for (const reason of seatbeltProbe?.reasons ?? ['seatbelt-not-enforcing']) {
      reasons.push(`seatbelt:${reason}`);
    }
  }

  const available =
    reasons.length === 0 &&
    seatbeltBinaryOk &&
    seatbeltEnforcing &&
    vfkitVersion !== null &&
    hasVirtualizationEntitlement;

  return {
    available,
    vfkitBin: resolvedVfkit,
    vfkitVersion,
    hasVirtualizationEntitlement,
    seatbeltBinaryOk,
    seatbeltEnforcing,
    seatbeltProbe,
    reasons,
  };
}

/**
 * Probes real host hardware-isolation capabilities without silent downgrades.
 * Returns fields directly consumable by `selectBackend()`.
 */
export function probeHostCapabilities({
  platform = process.platform,
  arch = process.arch,
  kvmDevice = '/dev/kvm',
  cgroupControllersPath = '/sys/fs/cgroup/cgroup.controllers',
  firecrackerBin = null,
  jailerBin = null,
  vmmUid = 65534,
  vmmGid = 65534,
  vfkitBin = null,
  seatbeltProfilePath = null,
  sandboxExecBin = DEFAULT_SANDBOX_EXEC,
  codesignBin = DEFAULT_CODESIGN,
  envBin = DEFAULT_ENV_BIN,
  providerConfigured = false,
  probeParentDir = tmpdir(),
} = {}) {
  const firecracker = probeLinuxKvm({
    platform,
    kvmDevice,
    cgroupControllersPath,
    firecrackerBin,
    jailerBin,
    vmmUid,
    vmmGid,
  });
  const vfkit = probeMacVfkit({
    platform,
    arch,
    vfkitBin,
    seatbeltProfilePath,
    sandboxExecBin,
    codesignBin,
    envBin,
    probeParentDir,
  });

  return {
    platform,
    arch,
    kvmAvailable: firecracker.available,
    vfkitAvailable:
      vfkit.vfkitVersion !== null && vfkit.hasVirtualizationEntitlement,
    seatbeltEnforcing: vfkit.seatbeltEnforcing,
    providerConfigured: providerConfigured === true,
    firecracker,
    vfkit,
  };
}

function assertSafeSourceAsset(label, sourcePath, realVault) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new Error(`${label} is required`);
  }
  const abs = resolve(sourcePath);
  let st;
  try {
    st = lstatSync(abs);
  } catch (error) {
    throw new Error(`${label} unreadable (${error.code ?? 'ENOENT'})`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  if (!st.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (st.nlink !== 1) {
    throw new Error(
      `${label} must be a single-link regular file (nlink=${st.nlink})`,
    );
  }
  const real = realpathSync(abs);
  if (realVault && withinDir(realVault, real)) {
    throw new Error(`${label} must not reside inside vaultDir`);
  }
  return { abs, real, st };
}

function assertApprovedDestination(
  label,
  targetPath,
  approvedRoots,
  realVault,
) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error(`${label} path is required`);
  }
  const abs = resolve(targetPath);
  if (!isPathWithinApprovedRoots(abs, approvedRoots)) {
    throw new Error(`${label} ${abs} is outside approvedRoots`);
  }
  const canonical = canonicalizePreservingLeaf(abs);
  if (
    realVault &&
    (withinDir(realVault, abs) || withinDir(realVault, canonical))
  ) {
    throw new Error(`${label} ${canonical} must not reside inside vaultDir`);
  }
  return abs;
}

function ensureApprovedDirHierarchy(
  label,
  dirPath,
  mode,
  { approvedRoots, realVault, createdDirs = null },
) {
  const abs = assertApprovedDestination(
    label,
    dirPath,
    approvedRoots,
    realVault,
  );
  const missing = [];
  let cursor = abs;
  while (true) {
    let st = null;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (st !== null) {
      if (cursor === abs && (st.isSymbolicLink() || !st.isDirectory())) {
        throw new Error(`${label} must be a real directory: ${abs}`);
      }
      break;
    }
    assertApprovedDestination(label, cursor, approvedRoots, realVault);
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    const nextDir = missing[i];
    mkdirSync(nextDir, { mode });
    if (createdDirs) createdDirs.push(nextDir);
  }
  const realDir = realpathSync(abs);
  if (!isPathWithinApprovedRoots(realDir, approvedRoots)) {
    throw new Error(`${label} escaped approvedRoots: ${realDir}`);
  }
  if (realVault && withinDir(realVault, realDir)) {
    throw new Error(`${label} ${realDir} must not reside inside vaultDir`);
  }
  return realDir;
}

/**
 * Copies a single-link golden asset to an independently owned per-round file,
 * verifying independent `(dev, ino)`, `nlink === 1`, byte size, and SHA-256
 * parity without modifying the source. Refuses to overwrite existing targets.
 */
export function copyIsolatedAsset(
  sourcePath,
  destPath,
  {
    approvedRoots,
    vaultDir = null,
    mode = 0o640,
    chownUid = null,
    chownGid = null,
    createdDirs = null,
  } = {},
) {
  const realVault = vaultDir
    ? canonicalizePreservingLeaf(resolve(vaultDir))
    : null;
  const src = assertSafeSourceAsset('source asset', sourcePath, realVault);
  const absDest = assertApprovedDestination(
    'staged asset',
    destPath,
    approvedRoots,
    realVault,
  );
  if (absDest === src.real) {
    throw new Error('staged asset destination must differ from source asset');
  }
  try {
    lstatSync(absDest);
    throw new Error(`refusing to overwrite existing staged asset: ${absDest}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const parent = dirname(absDest);
  const realParent = ensureApprovedDirHierarchy(
    'staged asset parent',
    parent,
    0o750,
    { approvedRoots, realVault, createdDirs },
  );
  const safeDest = join(realParent, basename(absDest));
  if (!isPathWithinApprovedRoots(safeDest, approvedRoots)) {
    throw new Error(`staged asset parent escaped approvedRoots: ${realParent}`);
  }
  if (realVault && withinDir(realVault, safeDest)) {
    throw new Error(`staged asset ${safeDest} must not reside inside vaultDir`);
  }
  try {
    lstatSync(safeDest);
    throw new Error(`refusing to overwrite existing staged asset: ${safeDest}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const tmpPath = join(realParent, `.stage.${nextTempSuffix()}.tmp`);
  let srcFd;
  let dstFd;
  let promoted = false;
  try {
    srcFd = openSync(src.real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const srcFdStat = fstatSync(srcFd);
    if (
      !srcFdStat.isFile() ||
      srcFdStat.nlink !== 1 ||
      srcFdStat.dev !== src.st.dev ||
      srcFdStat.ino !== src.st.ino ||
      srcFdStat.size !== src.st.size
    ) {
      throw new Error('source asset changed identity before copy');
    }

    dstFd = openSync(
      tmpPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let copied = 0;
    for (;;) {
      const n = readSync(srcFd, buf, 0, buf.length, null);
      if (n === 0) break;
      copied += n;
      hash.update(buf.subarray(0, n));
      let offset = 0;
      while (offset < n) {
        offset += writeSync(dstFd, buf, offset, n - offset, null);
      }
    }
    if (copied !== srcFdStat.size) {
      throw new Error(
        `source asset changed size during copy (${copied} != ${srcFdStat.size})`,
      );
    }
    const dstStat = fstatSync(dstFd);
    if (
      !dstStat.isFile() ||
      dstStat.nlink !== 1 ||
      (dstStat.dev === srcFdStat.dev && dstStat.ino === srcFdStat.ino)
    ) {
      throw new Error('staged asset did not allocate an independent inode');
    }
    fchmodSync(dstFd, mode);
    if (Number.isInteger(chownUid) && Number.isInteger(chownGid)) {
      fchownSync(dstFd, chownUid, chownGid);
    }
    closeSync(dstFd);
    dstFd = undefined;
    renameSync(tmpPath, safeDest);
    promoted = true;
    return {
      path: safeDest,
      bytes: copied,
      sha256: hash.digest('hex'),
    };
  } finally {
    if (srcFd !== undefined) closeSync(srcFd);
    if (dstFd !== undefined) closeSync(dstFd);
    if (!promoted) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup of unpromoted temp file.
      }
    }
  }
}

function writeAtomicStagedFile(
  destPath,
  content,
  {
    approvedRoots,
    realVault,
    mode = 0o640,
    chownUid = null,
    chownGid = null,
    createdDirs = null,
  },
) {
  const absDest = assertApprovedDestination(
    'staged file',
    destPath,
    approvedRoots,
    realVault,
  );
  try {
    lstatSync(absDest);
    throw new Error(`refusing to overwrite existing staged file: ${absDest}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = dirname(absDest);
  const realParent = ensureApprovedDirHierarchy(
    'staged file parent',
    parent,
    0o750,
    { approvedRoots, realVault, createdDirs },
  );
  const safeDest = join(realParent, basename(absDest));
  if (!isPathWithinApprovedRoots(safeDest, approvedRoots)) {
    throw new Error(`staged file parent escaped approvedRoots: ${realParent}`);
  }
  if (realVault && withinDir(realVault, safeDest)) {
    throw new Error(`staged file ${safeDest} must not reside inside vaultDir`);
  }
  try {
    lstatSync(safeDest);
    throw new Error(`refusing to overwrite existing staged file: ${safeDest}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tmpPath = join(realParent, `.stage-file.${nextTempSuffix()}.tmp`);
  let fd;
  let promoted = false;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const data = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset, null);
    }
    fchmodSync(fd, mode);
    if (Number.isInteger(chownUid) && Number.isInteger(chownGid)) {
      fchownSync(fd, chownUid, chownGid);
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, safeDest);
    promoted = true;
    return safeDest;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!promoted) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup race.
      }
    }
  }
}

function parseVfkitPlanPaths(plan) {
  const argv = Array.isArray(plan?.argv) ? plan.argv : [];
  let seatbeltProfile = null;
  let pocDir = null;
  let socketDir = plan?.socketDir ?? null;
  let homeDir = null;
  let tmpDir = null;
  let initramfsPath = null;
  let vfkitBin = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-f' && argv[i + 1]) {
      seatbeltProfile = argv[i + 1];
      i += 1;
    } else if (arg === '-D' && typeof argv[i + 1] === 'string') {
      const def = argv[i + 1];
      if (def.startsWith('POC_DIR=')) pocDir = def.slice('POC_DIR='.length);
      if (def.startsWith('POC_SOCKET_DIR=')) {
        socketDir = def.slice('POC_SOCKET_DIR='.length);
      }
      i += 1;
    } else if (typeof arg === 'string' && arg.startsWith('HOME=')) {
      homeDir = arg.slice('HOME='.length);
    } else if (typeof arg === 'string' && arg.startsWith('TMPDIR=')) {
      tmpDir = arg.slice('TMPDIR='.length);
    } else if (arg === '--bootloader' && typeof argv[i + 1] === 'string') {
      const m = /(?:^|,)initrd=([^,]+)/.exec(argv[i + 1]);
      if (m) initramfsPath = m[1];
      i += 1;
    } else if (arg === '--cpus' && i > 0) {
      vfkitBin = argv[i - 1];
    }
  }
  return {
    seatbeltProfile,
    pocDir,
    socketDir,
    homeDir,
    tmpDir,
    initramfsPath,
    vfkitBin,
  };
}

/**
 * Verifies `<jailRoot>/config.json` on disk against `plan.vmConfig` so a
 * tampered on-disk Firecracker config (e.g. injected NIC or host drive) is
 * refused before launch.
 */
export function verifyFirecrackerDiskConfig(
  plan,
  { requireExists = false } = {},
) {
  if (!plan || plan.backend !== 'firecracker' || !plan.jailRoot) {
    return { ok: true, error: null, configPath: null };
  }
  const configPath = join(plan.jailRoot, 'config.json');
  const read = readSingleLinkFile(configPath);
  if (read.error) {
    if (!requireExists && read.error === 'unreadable:ENOENT') {
      return { ok: true, error: null, configPath };
    }
    return {
      ok: false,
      error: `firecracker config.json rejected (${read.error})`,
      configPath,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch (error) {
    return {
      ok: false,
      error: `firecracker config.json is invalid JSON (${error.message})`,
      configPath,
    };
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !isDeepStrictEqual(parsed, plan.vmConfig)
  ) {
    return {
      ok: false,
      error:
        'firecracker disk config.json does not match validated plan.vmConfig',
      configPath,
    };
  }
  return { ok: true, error: null, configPath };
}

/**
 * Stages per-round hardware VM assets (kernel, independent working disk,
 * Firecracker `config.json` / `console.log`, or macOS `vfkit` initramfs /
 * Seatbelt `.sb` profile and private directories) inside `approvedRoots`.
 * Rolls back every file/directory created by this call if any step fails.
 */
export function stageLocalVmRound({
  plan,
  sourceKernelPath,
  sourceRootfsPath,
  sourceInitramfsPath = null,
  approvedRoots = [],
  vaultDir = null,
  applyChown = null,
} = {}) {
  if (!plan || (plan.backend !== 'firecracker' && plan.backend !== 'vfkit')) {
    throw new Error(
      `stageLocalVmRound requires a firecracker or vfkit plan (got ${JSON.stringify(plan?.backend)})`,
    );
  }
  if (!Array.isArray(approvedRoots) || approvedRoots.length === 0) {
    throw new Error('stageLocalVmRound requires non-empty approvedRoots');
  }
  const realVault = vaultDir
    ? canonicalizePreservingLeaf(resolve(vaultDir))
    : null;
  const createdFiles = [];
  const createdDirs = [];
  let firecrackerJailRoot = null;

  const ensureApprovedDir = (label, dirPath, mode) =>
    ensureApprovedDirHierarchy(label, dirPath, mode, {
      approvedRoots,
      realVault,
      createdDirs,
    });

  const cleanup = () => {
    for (let i = createdFiles.length - 1; i >= 0; i -= 1) {
      const target = createdFiles[i];
      if (!isPathWithinApprovedRoots(target, approvedRoots)) continue;
      try {
        unlinkSync(target);
      } catch {
        // Best-effort rollback.
      }
    }
    const seen = new Set();
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      const dir = createdDirs[i];
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!isPathWithinApprovedRoots(dir, approvedRoots)) continue;
      if (realVault && withinDir(realVault, canonicalizePreservingLeaf(dir))) {
        continue;
      }
      if (firecrackerJailRoot !== null && dir === firecrackerJailRoot) {
        // Firecracker's jailer populates chroot device nodes and binary copies
        // inside jailRoot; clear only the per-round jailRoot we created.
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort rollback.
        }
        continue;
      }
      try {
        rmdirSync(dir);
      } catch {
        // Leave non-empty shared parent directories untouched.
      }
    }
  };

  try {
    if (plan.backend === 'firecracker') {
      const shouldChown =
        applyChown !== null
          ? applyChown === true
          : typeof process.getuid === 'function' &&
            process.getuid() === 0 &&
            Number.isInteger(plan.vmmUid) &&
            Number.isInteger(plan.vmmGid);
      const uid = shouldChown ? plan.vmmUid : null;
      const gid = shouldChown ? plan.vmmGid : null;

      const jailRootExisted = existsSync(resolve(plan.jailRoot));
      const jailRoot = ensureApprovedDir(
        'firecracker jailRoot',
        plan.jailRoot,
        0o750,
      );
      if (!jailRootExisted) {
        firecrackerJailRoot = resolve(plan.jailRoot);
      }
      const kernel = copyIsolatedAsset(sourceKernelPath, plan.kernelPath, {
        approvedRoots,
        vaultDir,
        mode: 0o640,
        chownUid: uid,
        chownGid: gid,
        createdDirs,
      });
      createdFiles.push(kernel.path);

      const disk = copyIsolatedAsset(
        sourceRootfsPath,
        plan.ownershipTemplate.workDiskPath,
        {
          approvedRoots,
          vaultDir,
          mode: 0o640,
          chownUid: uid,
          chownGid: gid,
          createdDirs,
        },
      );
      createdFiles.push(disk.path);

      const configPath = writeAtomicStagedFile(
        join(jailRoot, 'config.json'),
        `${JSON.stringify(plan.vmConfig, null, 2)}\n`,
        {
          approvedRoots,
          realVault,
          mode: 0o640,
          chownUid: uid,
          chownGid: gid,
          createdDirs,
        },
      );
      createdFiles.push(configPath);

      const consoleLogPath = writeAtomicStagedFile(
        join(jailRoot, 'console.log'),
        '',
        {
          approvedRoots,
          realVault,
          mode: 0o640,
          chownUid: uid,
          chownGid: gid,
          createdDirs,
        },
      );
      createdFiles.push(consoleLogPath);

      if (shouldChown) {
        chmodSync(jailRoot, 0o750);
        chownSync(jailRoot, uid, gid);
      }

      return {
        backend: 'firecracker',
        jailRoot,
        kernelPath: kernel.path,
        kernelSha256: kernel.sha256,
        workDiskPath: disk.path,
        rootfsSha256: disk.sha256,
        configPath,
        consoleLogPath,
        createdFiles: [...createdFiles],
        cleanup,
      };
    }

    // macOS sandboxed vfkit staging
    const parsed = parseVfkitPlanPaths(plan);
    if (!parsed.initramfsPath) {
      throw new Error('vfkit plan bootloader must declare an initrd path');
    }
    if (!sourceInitramfsPath) {
      throw new Error('vfkit staging requires sourceInitramfsPath');
    }
    if (!parsed.seatbeltProfile) {
      throw new Error('vfkit plan must declare a Seatbelt profile path');
    }
    if (parsed.pocDir) ensureApprovedDir('vfkit pocDir', parsed.pocDir, 0o700);
    if (parsed.socketDir) {
      ensureApprovedDir('vfkit socketDir', parsed.socketDir, 0o700);
    }
    if (parsed.homeDir) {
      ensureApprovedDir('vfkit homeDir', parsed.homeDir, 0o700);
    }
    if (parsed.tmpDir) ensureApprovedDir('vfkit tmpDir', parsed.tmpDir, 0o700);

    const kernel = copyIsolatedAsset(sourceKernelPath, plan.kernelPath, {
      approvedRoots,
      vaultDir,
      mode: 0o600,
      createdDirs,
    });
    createdFiles.push(kernel.path);

    const initramfs = copyIsolatedAsset(
      sourceInitramfsPath,
      parsed.initramfsPath,
      {
        approvedRoots,
        vaultDir,
        mode: 0o600,
        createdDirs,
      },
    );
    createdFiles.push(initramfs.path);

    const disk = copyIsolatedAsset(
      sourceRootfsPath,
      plan.ownershipTemplate.workDiskPath,
      {
        approvedRoots,
        vaultDir,
        mode: 0o600,
        createdDirs,
      },
    );
    createdFiles.push(disk.path);

    let seatbeltProfilePath = parsed.seatbeltProfile;
    const expectedProfile = renderVfkitSeatbeltProfile({
      vfkitBin: parsed.vfkitBin,
    });
    let existingProfileStat = null;
    try {
      existingProfileStat = lstatSync(seatbeltProfilePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(
          `existing vfkit Seatbelt profile unreadable (${error.code})`,
        );
      }
    }
    if (existingProfileStat !== null) {
      assertApprovedDestination(
        'vfkit Seatbelt profile',
        seatbeltProfilePath,
        approvedRoots,
        realVault,
      );
      const check = readSingleLinkFile(seatbeltProfilePath);
      if (check.error) {
        throw new Error(
          `existing vfkit Seatbelt profile rejected (${check.error})`,
        );
      }
      if (check.text !== expectedProfile) {
        throw new Error(
          'existing vfkit Seatbelt profile does not match the deny-default profile',
        );
      }
      if (process.platform === 'darwin') {
        const probe = probeSeatbeltEnforcement({
          seatbeltProfilePath,
          vfkitBin: parsed.vfkitBin,
        });
        if (!probe.enforcing) {
          throw new Error(
            `existing vfkit Seatbelt profile failed live enforcement probe (${probe.reasons.join(', ')})`,
          );
        }
      }
    } else {
      seatbeltProfilePath = writeAtomicStagedFile(
        seatbeltProfilePath,
        expectedProfile,
        {
          approvedRoots,
          realVault,
          mode: 0o600,
          createdDirs,
        },
      );
      createdFiles.push(seatbeltProfilePath);
    }

    return {
      backend: 'vfkit',
      kernelPath: kernel.path,
      kernelSha256: kernel.sha256,
      initramfsPath: initramfs.path,
      initramfsSha256: initramfs.sha256,
      workDiskPath: disk.path,
      rootfsSha256: disk.sha256,
      seatbeltProfilePath,
      createdFiles: [...createdFiles],
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
