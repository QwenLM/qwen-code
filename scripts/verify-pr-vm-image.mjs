#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline read-only golden ext4 image derivation tool for `/verify-pr` microVMs.
 *
 * Copies a read-only golden ext4 rootfs into an isolated temporary file inside
 * an approved root (never mutating the golden source, zero loop mounts, zero
 * root required), optionally grows it via `resize2fs -f`, inspects in-image
 * target ancestors via read-only `debugfs -f` to refuse symlink/non-directory
 * traversal, injects the repository's audited guest scripts (`guest-vsock.py`,
 * `guest-runner.py`, `/opt/poc/init`, plus optional workload/extra files and
 * bundled host Python) directly into the independent copy via `debugfs -w -f`
 * with explicit `0:0` ownership and POSIX modes, randomizes the filesystem UUID
 * via `tune2fs -U random` when available, re-verifies the golden base image
 * SHA-256 and hashes the temporary output before atomic `linkSync` publication.
 *
 * Because the base image is never unpacked through the host filesystem, every
 * existing inode in the golden source — including arbitrary UID/GID ownership
 * on files and symlinks, FIFOs, sockets, device nodes, hard links, extended
 * attributes (xattrs), and modes — is preserved bit-for-bit.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './lib/entry-point.js';
import {
  canonicalizePreservingLeaf,
  canonicalizeVaultDir,
  normalizeApprovedRoots,
} from './verify-pr-vm-host.mjs';
import { isPathWithinApprovedRoots } from './verify-pr-vm-lifecycle.mjs';

const HASH_CHUNK_BYTES = 256 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MIN_IMAGE_SIZE_MIB = 32;
const MAX_IMAGE_SIZE_MIB = 16 * 1024;
const TOOL_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const DEBUGFS_BANNER_LINE = /^debugfs \d/;
const SPACE_ERR_RE =
  /No space left|ENOSPC|Could not allocate|EXT2_ET_BLOCK_ALLOC_FAIL|no space/i;

const DEFAULT_GUEST_VSOCK_SRC = fileURLToPath(
  new URL('./verify-pr-vm-guest-vsock.py', import.meta.url),
);
const DEFAULT_GUEST_RUNNER_SRC = fileURLToPath(
  new URL('./verify-pr-vm-guest-runner.py', import.meta.url),
);
const DEFAULT_GUEST_INIT_SRC = fileURLToPath(
  new URL('./verify-pr-vm-guest-init.sh', import.meta.url),
);

function withinDir(root, target) {
  return (
    target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

function sha256SingleLinkRegularFile(filePath, label, realVault) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error(`${label} is required`);
  }
  const abs = resolve(filePath);
  let fd;
  try {
    fd = openSync(
      abs,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    const st = fstatSync(fd);
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
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      hash.update(buf.subarray(0, n));
    }
    if (total !== st.size) {
      throw new Error(`${label} changed size while hashing`);
    }
    return {
      path: real,
      bytes: total,
      sha256: hash.digest('hex'),
    };
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error(`${label} must not be a symlink`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Validates and normalizes an in-image target path (e.g. `/opt/qwen/guest-runner.py`).
 * Rejects relative paths, `..` traversal, control characters, NUL bytes, and
 * root-level overwrites.
 */
export function normalizeImageTargetPath(guestPath) {
  if (
    typeof guestPath !== 'string' ||
    !guestPath.startsWith('/') ||
    /[\0\r\n\\]/.test(guestPath)
  ) {
    throw new Error(
      `invalid guest image target path: ${JSON.stringify(guestPath)}`,
    );
  }
  const segments = guestPath.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      `guest image target path must be nested below a top-level directory: ${guestPath}`,
    );
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error(
        `guest image target path must not traverse: ${guestPath}`,
      );
    }
  }
  return `/${segments.join('/')}`;
}

function findExecutable(explicitPath, fallbackNames, extraSearchDirs = []) {
  if (explicitPath !== null && explicitPath !== undefined) {
    if (typeof explicitPath !== 'string' || explicitPath.trim() === '') {
      throw new Error('explicit tool path must be a non-empty string');
    }
    // Resolve symlinks because Debian/Ubuntu ship /usr/sbin/mkfs.ext4 -> mke2fs.
    const real = realpathSync(explicitPath);
    const st = lstatSync(real);
    if (!st.isFile()) {
      throw new Error(`tool must be a regular file: ${explicitPath}`);
    }
    accessSync(real, fsConstants.X_OK);
    return real;
  }
  const searchDirs = [
    ...extraSearchDirs,
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    '/opt/homebrew/opt/e2fsprogs/sbin',
    '/usr/local/opt/e2fsprogs/sbin',
    ...(process.env.PATH ?? '').split(':'),
  ];
  for (const name of fallbackNames) {
    for (const dir of searchDirs) {
      if (!dir) continue;
      const candidate = join(dir, name);
      try {
        const real = realpathSync(candidate);
        const st = lstatSync(real);
        if (st.isFile()) {
          accessSync(real, fsConstants.X_OK);
          return real;
        }
      } catch {
        // Try next directory.
      }
    }
  }
  return null;
}

function runToolFull(bin, args, { timeoutMs = 180_000 } = {}) {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: TOOL_MAX_BUFFER_BYTES,
    env: {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    },
  });
  if (res.error) {
    throw new Error(`${basename(bin)} failed to execute: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 600);
    const spaceHint = SPACE_ERR_RE.test(detail)
      ? ' (try a larger --size-mib)'
      : '';
    throw new Error(
      `${basename(bin)} exited ${res.status}${detail ? `: ${detail}` : ''}${spaceHint}`,
    );
  }
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function runTool(bin, args, options) {
  return runToolFull(bin, args, options).stdout;
}

function escapeDebugfsArg(value) {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('debugfs argument must not contain newlines or NUL bytes');
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function ancestorDirsOf(guestPath) {
  const parts = guestPath.split('/').filter(Boolean);
  const dirs = [];
  for (let i = 1; i < parts.length; i += 1) {
    dirs.push(`/${parts.slice(0, i).join('/')}`);
  }
  return dirs;
}

/**
 * Inspects exact inode types for a batch of guest paths inside `imagePath` via
 * read-only `debugfs -f`. Always checks `/` first to fail closed on corrupt or
 * non-ext4 inputs.
 */
function statImagePaths(debugfsBin, imagePath, guestPaths, workDir) {
  const unique = Array.from(
    new Set(['/', ...guestPaths.filter((p) => p !== '/')]),
  );
  const cmdLines = unique.map((p) => `stat "${escapeDebugfsArg(p)}"`);
  const cmdPath = join(workDir, 'stat-paths.debugfs');
  writeFileSync(cmdPath, `${cmdLines.join('\n')}\n`, { mode: 0o600 });

  const res = runToolFull(debugfsBin, ['-f', cmdPath, imagePath]);
  const fatalStderr = res.stderr
    .split(/\r?\n/)
    .find(
      (line) =>
        line.trim() !== '' &&
        !DEBUGFS_BANNER_LINE.test(line) &&
        !/: File not found by ext2_lookup\s*$/.test(line) &&
        !/: Not a directory\s*$/.test(line),
    );
  if (fatalStderr !== undefined) {
    throw new Error(
      `debugfs image inspection failed: ${fatalStderr.trim().slice(0, 600)}`,
    );
  }

  const types = new Map();
  let currentIdx = -1;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (/^debugfs:\s+stat\s+/.test(line)) {
      currentIdx += 1;
      if (currentIdx < unique.length) {
        types.set(unique[currentIdx], 'missing');
      }
      continue;
    }
    if (currentIdx >= 0 && currentIdx < unique.length) {
      const m = /^Inode:\s+\d+\s+Type:\s+(\S+)/.exec(line);
      if (m) {
        const rawType = m[1].toLowerCase();
        if (
          rawType === 'directory' ||
          rawType === 'regular' ||
          rawType === 'symlink'
        ) {
          types.set(unique[currentIdx], rawType);
        } else {
          types.set(unique[currentIdx], 'other');
        }
      }
    }
  }
  if (types.get('/') !== 'directory') {
    throw new Error(
      'debugfs image inspection failed: root / is not a valid ext4 directory',
    );
  }
  return types;
}

/**
 * Lists all existing entries beneath an existing directory `rootGuestPath`
 * inside `imagePath` so `--bundle-host-python` can cleanly replace an existing
 * `/opt/python` directory inside the image copy.
 */
function listImageSubtree(debugfsBin, imagePath, rootGuestPath, workDir) {
  const dirsToVisit = [rootGuestPath];
  const files = [];
  const dirs = [];
  let batchNo = 0;
  while (dirsToVisit.length > 0) {
    const batch = dirsToVisit.splice(0, dirsToVisit.length);
    const cmdLines = [];
    for (const d of batch) {
      cmdLines.push(`cd "${escapeDebugfsArg(d)}"`, 'pwd', 'ls -p');
    }
    batchNo += 1;
    const cmdPath = join(workDir, `list-subtree-${batchNo}.debugfs`);
    writeFileSync(cmdPath, `${cmdLines.join('\n')}\n`, { mode: 0o600 });
    const res = runToolFull(debugfsBin, ['-f', cmdPath, imagePath]);
    const fatal = res.stderr
      .split(/\r?\n/)
      .find((line) => line.trim() !== '' && !DEBUGFS_BANNER_LINE.test(line));
    if (fatal !== undefined) {
      throw new Error(
        `debugfs subtree listing failed: ${fatal.trim().slice(0, 600)}`,
      );
    }
    let cur = null;
    for (const line of res.stdout.split(/\r?\n/)) {
      const pm = /^\[pwd\]\s+INODE:\s+\d+\s+PATH:\s+(.+)$/.exec(line);
      if (pm) {
        cur = pm[1];
        continue;
      }
      if (cur === null) continue;
      const lm = /^\/(\d+)\/([0-7]+)\/(\d+)\/(\d+)\/(.+)\/(\d*)\/$/.exec(line);
      if (!lm) continue;
      const modeOct = parseInt(lm[2], 8);
      const name = lm[5];
      if (name === '.' || name === '..') continue;
      const child = cur === '/' ? `/${name}` : `${cur}/${name}`;
      if ((modeOct & 0o170000) === 0o040000) {
        dirs.push(child);
        dirsToVisit.push(child);
      } else {
        files.push(child);
      }
    }
  }
  return { files, dirs };
}

/**
 * Stages host Python 3, its stdlib, and `ldd`-resolved shared libraries into a
 * private staging directory and enumerates entries to inject under `/opt/python`.
 */
function stageHostPythonBundle(stageRoot, { pythonBin, pythonLibDir, lddBin }) {
  const realPy = realpathSync(pythonBin);
  const pyName = basename(realPy);
  const pyRoot = join(stageRoot, 'python');
  const pyBinDir = join(pyRoot, 'bin');
  const pyLibTargetDir = join(pyRoot, 'lib');
  mkdirSync(pyBinDir, { recursive: true, mode: 0o755 });
  mkdirSync(pyLibTargetDir, { recursive: true, mode: 0o755 });

  copyFileSync(realPy, join(pyBinDir, pyName));
  chmodSync(join(pyBinDir, pyName), 0o755);
  if (pyName !== 'python3') {
    symlinkSync(pyName, join(pyBinDir, 'python3'));
  }

  const libBasename = basename(pythonLibDir);
  const targetStdlib = join(pyLibTargetDir, libBasename);
  cpSync(pythonLibDir, targetStdlib, {
    recursive: true,
    verbatimSymlinks: true,
  });

  const dynloadDir = join(pythonLibDir, 'lib-dynload');
  const binariesToScan = [realPy];
  if (existsSync(dynloadDir)) {
    for (const entry of readdirSync(dynloadDir, { withFileTypes: true })) {
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith('.so')
      ) {
        binariesToScan.push(join(dynloadDir, entry.name));
      }
    }
  }

  const copiedLibs = new Map();
  const aliases = new Set();
  for (const binPath of binariesToScan) {
    const lddOut = runTool(lddBin, [binPath]);
    for (const line of lddOut.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 0) continue;
      const candidate =
        parts.length > 2 && parts[1] === '=>' ? parts[2] : parts[0];
      if (!candidate.startsWith('/')) continue;
      const resolved = realpathSync(candidate);
      const resolvedName = basename(resolved);
      if (resolvedName.startsWith('ld-linux')) continue;
      copiedLibs.set(resolved, resolvedName);
      aliases.add(`${basename(candidate)}=>${resolvedName}`);
    }
  }
  for (const [srcLib, destName] of copiedLibs) {
    copyFileSync(srcLib, join(pyLibTargetDir, destName));
    chmodSync(join(pyLibTargetDir, destName), 0o755);
  }
  for (const pair of aliases) {
    const [alias, target] = pair.split('=>');
    if (alias !== target && !existsSync(join(pyLibTargetDir, alias))) {
      symlinkSync(target, join(pyLibTargetDir, alias));
    }
  }

  const dirs = [];
  const files = [];
  const symlinks = [];
  const walk = (hostDir, guestDir) => {
    for (const name of readdirSync(hostDir).sort()) {
      const hostChild = join(hostDir, name);
      const guestChild = `${guestDir}/${name}`;
      const st = lstatSync(hostChild);
      if (st.isSymbolicLink()) {
        symlinks.push({
          guestPath: guestChild,
          linkTarget: readlinkSync(hostChild),
        });
      } else if (st.isDirectory()) {
        dirs.push({ guestPath: guestChild, mode: st.mode & 0o777 || 0o755 });
        walk(hostChild, guestChild);
      } else if (st.isFile()) {
        files.push({
          hostPath: hostChild,
          guestPath: guestChild,
          mode: st.mode & 0o777,
        });
      }
    }
  };
  walk(pyRoot, '/opt/python');

  return {
    bundledLibraries: [...copiedLibs.values()].sort(),
    dirs,
    files,
    symlinks,
  };
}

/**
 * Derives an independent guest ext4 image from a read-only golden ext4 base
 * image without modifying the golden source or mounting loop devices.
 */
export function deriveExt4GuestImage({
  baseImagePath,
  expectedBaseSha256 = null,
  outputImagePath,
  approvedRoots = [],
  vaultDir = null,
  guestVsockPath = DEFAULT_GUEST_VSOCK_SRC,
  guestRunnerPath = DEFAULT_GUEST_RUNNER_SRC,
  guestInitPath = DEFAULT_GUEST_INIT_SRC,
  extraFiles = [],
  imageSizeMib = null,
  debugfsBin = null,
  resize2fsBin = null,
  tune2fsBin = null,
  mkfsExt4Bin = null,
  bundleHostPython = false,
  pythonBin = '/usr/bin/python3',
  pythonLibDir = null,
  lddBin = null,
  tempParentDir = tmpdir(),
} = {}) {
  if (!Array.isArray(approvedRoots) || approvedRoots.length === 0) {
    throw new Error('deriveExt4GuestImage requires non-empty approvedRoots');
  }
  if (imageSizeMib !== null && imageSizeMib !== undefined) {
    if (
      !Number.isSafeInteger(imageSizeMib) ||
      imageSizeMib < MIN_IMAGE_SIZE_MIB ||
      imageSizeMib > MAX_IMAGE_SIZE_MIB
    ) {
      throw new Error(
        `imageSizeMib must be an integer in ${MIN_IMAGE_SIZE_MIB}..${MAX_IMAGE_SIZE_MIB}`,
      );
    }
  }
  if (expectedBaseSha256 !== null && !SHA256_RE.test(expectedBaseSha256)) {
    throw new Error(
      'expectedBaseSha256 must be a 64-char lowercase hex digest',
    );
  }

  const normalizedRoots = normalizeApprovedRoots(approvedRoots);
  const realVault = canonicalizeVaultDir(vaultDir);

  if (typeof outputImagePath !== 'string' || outputImagePath.trim() === '') {
    throw new Error('outputImagePath is required');
  }
  const absOut = resolve(outputImagePath);
  const canonicalOut = canonicalizePreservingLeaf(absOut);
  if (!isPathWithinApprovedRoots(absOut, normalizedRoots)) {
    throw new Error(`outputImagePath ${absOut} is outside approvedRoots`);
  }
  if (
    realVault &&
    (withinDir(realVault, absOut) || withinDir(realVault, canonicalOut))
  ) {
    throw new Error(
      `outputImagePath ${canonicalOut} must not reside inside vaultDir`,
    );
  }
  try {
    lstatSync(absOut);
    throw new Error(
      `refusing to overwrite existing outputImagePath: ${absOut}`,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const baseInfo = sha256SingleLinkRegularFile(
    baseImagePath,
    'baseImagePath',
    realVault,
  );
  if (expectedBaseSha256 !== null && baseInfo.sha256 !== expectedBaseSha256) {
    throw new Error(
      `baseImagePath SHA-256 mismatch: got ${baseInfo.sha256}, expected ${expectedBaseSha256}`,
    );
  }
  if (canonicalOut === baseInfo.path) {
    throw new Error('outputImagePath must differ from baseImagePath');
  }

  const targetBytes =
    imageSizeMib !== null && imageSizeMib !== undefined
      ? imageSizeMib * 1024 * 1024
      : baseInfo.bytes;
  if (targetBytes < baseInfo.bytes) {
    throw new Error(
      `imageSizeMib (${imageSizeMib} MiB) is smaller than baseImagePath (${baseInfo.bytes} bytes); shrinking is not supported`,
    );
  }

  const injectPlan = [
    {
      label: 'guestVsockPath',
      srcPath: guestVsockPath,
      target: '/opt/qwen/guest-vsock.py',
      mode: 0o755,
    },
    {
      label: 'guestRunnerPath',
      srcPath: guestRunnerPath,
      target: '/opt/qwen/guest-runner.py',
      mode: 0o755,
    },
    {
      label: 'guestInitPath',
      srcPath: guestInitPath,
      target: '/opt/poc/init',
      mode: 0o755,
    },
  ];
  for (let i = 0; i < extraFiles.length; i += 1) {
    const entry = extraFiles[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`extraFiles[${i}] must be an object`);
    }
    const target = normalizeImageTargetPath(entry.target);
    const mode = entry.mode ?? 0o644;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error(`extraFiles[${i}].mode must be a valid octal mode`);
    }
    injectPlan.push({
      label: `extraFiles[${i}]`,
      srcPath: entry.srcPath,
      target,
      mode,
    });
  }

  const verifiedInjects = injectPlan.map((item) => {
    const target = normalizeImageTargetPath(item.target);
    const info = sha256SingleLinkRegularFile(
      item.srcPath,
      item.label,
      realVault,
    );
    return { ...item, target, srcReal: info.path, sha256: info.sha256 };
  });

  // Preserve compatibility with callers passing explicit --mkfs-ext4-bin.
  if (mkfsExt4Bin !== null && mkfsExt4Bin !== undefined) {
    findExecutable(mkfsExt4Bin, ['mkfs.ext4', 'mke2fs']);
  }

  const resolvedDebugfs = findExecutable(debugfsBin, ['debugfs']);
  if (!resolvedDebugfs) {
    throw new Error('debugfs executable not found (e2fsprogs required)');
  }
  const toolSiblingDir = dirname(resolvedDebugfs);
  const needsResize = targetBytes > baseInfo.bytes;
  const resolvedResize2fs = needsResize
    ? findExecutable(resize2fsBin, ['resize2fs'], [toolSiblingDir])
    : null;
  if (needsResize && !resolvedResize2fs) {
    throw new Error(
      'resize2fs executable not found for image growth (e2fsprogs required)',
    );
  }
  const resolvedTune2fs = findExecutable(
    tune2fsBin,
    ['tune2fs'],
    [toolSiblingDir],
  );

  const outParent = dirname(absOut);
  const outParentCanonical = canonicalizePreservingLeaf(outParent);
  const outParentInApproved =
    normalizedRoots.includes(outParentCanonical) ||
    isPathWithinApprovedRoots(outParent, normalizedRoots);
  if (!outParentInApproved) {
    throw new Error(`output parent ${outParent} is outside approvedRoots`);
  }
  mkdirSync(outParent, { recursive: true, mode: 0o750 });
  const realOutParent = realpathSync(outParent);
  const safeOut = join(realOutParent, basename(absOut));
  if (!isPathWithinApprovedRoots(safeOut, normalizedRoots)) {
    throw new Error(`output parent escaped approvedRoots: ${realOutParent}`);
  }
  if (realVault && withinDir(realVault, safeOut)) {
    throw new Error(
      `outputImagePath ${safeOut} must not reside inside vaultDir`,
    );
  }

  const workDir = realpathSync(mkdtempSync(join(tempParentDir, 'qc-vm-img-')));
  chmodSync(workDir, 0o700);
  const stagedDir = join(workDir, 'staged');
  mkdirSync(stagedDir, { mode: 0o700 });
  const tmpOut = join(
    realOutParent,
    `.derive.${process.pid}.${Date.now()}.tmp`,
  );
  let bundledLibraries = [];

  try {
    // 1. Copy the read-only golden base image into an exclusive private temp file.
    const tmpFd = openSync(
      tmpOut,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    closeSync(tmpFd);
    copyFileSync(baseInfo.path, tmpOut);
    chmodSync(tmpOut, 0o600);

    // 2. Grow offline ext4 filesystem copy when a larger --size-mib was requested.
    if (needsResize) {
      truncateSync(tmpOut, targetBytes);
      runToolFull(resolvedResize2fs, ['-f', tmpOut]);
    }

    // 3. Stage verified copies of all injected files and verify post-copy SHA-256
    // so injectedFiles[].sha256 attests the exact bytes written into the image.
    const stagedInjects = verifiedInjects.map((item, idx) => {
      const stagedPath = join(stagedDir, `inject-${idx}`);
      copyFileSync(item.srcReal, stagedPath);
      chmodSync(stagedPath, 0o600);
      const writtenInfo = sha256SingleLinkRegularFile(
        stagedPath,
        item.label,
        realVault,
      );
      if (writtenInfo.sha256 !== item.sha256) {
        throw new Error(
          `${item.label} changed content between pre-hash and copy`,
        );
      }
      return { ...item, stagedPath };
    });

    // 4. Optional host Python bundling into private staging directory.
    let pythonBundle = null;
    if (bundleHostPython) {
      const resolvedLdd = findExecutable(lddBin, ['ldd']);
      if (!resolvedLdd) {
        throw new Error('ldd executable not found for --bundle-host-python');
      }
      const pyLib =
        pythonLibDir ??
        runTool(pythonBin, [
          '-c',
          'import sysconfig; print(sysconfig.get_path("stdlib"))',
        ]).trim();
      if (realVault) {
        const realPyBin = realpathSync(pythonBin);
        const realPyLib = realpathSync(pyLib);
        if (withinDir(realVault, realPyBin)) {
          throw new Error(
            `pythonBin ${realPyBin} must not reside inside vaultDir`,
          );
        }
        if (withinDir(realVault, realPyLib)) {
          throw new Error(
            `pythonLibDir ${realPyLib} must not reside inside vaultDir`,
          );
        }
      }
      pythonBundle = stageHostPythonBundle(join(workDir, 'py-stage'), {
        pythonBin,
        pythonLibDir: pyLib,
        lddBin: resolvedLdd,
      });
      bundledLibraries = pythonBundle.bundledLibraries;
    }

    // 5. Inspect in-image ancestors & target leaves via read-only debugfs stat
    // before mutating tmpOut, refusing symlinks or non-directories along ancestors.
    const ancestorDirs = new Set();
    const leafTargets = new Set();
    for (const item of stagedInjects) {
      for (const dir of ancestorDirsOf(item.target)) {
        ancestorDirs.add(dir);
      }
      leafTargets.add(item.target);
    }
    if (bundleHostPython) {
      ancestorDirs.add('/opt');
      leafTargets.add('/opt/python');
    }

    const inspectList = [
      ...Array.from(ancestorDirs).sort((a, b) => a.length - b.length),
      ...Array.from(leafTargets).sort(),
    ];
    const pathTypes = statImagePaths(
      resolvedDebugfs,
      tmpOut,
      inspectList,
      workDir,
    );

    for (const dir of ancestorDirs) {
      const t = pathTypes.get(dir) ?? 'missing';
      if (t === 'symlink') {
        throw new Error(
          `injected path parent traverses symlink inside image: ${dir}`,
        );
      }
      if (t !== 'directory' && t !== 'missing') {
        throw new Error(`cannot traverse non-directory inside image: ${dir}`);
      }
    }
    if (bundleHostPython) {
      const pyType = pathTypes.get('/opt/python') ?? 'missing';
      if (pyType === 'symlink') {
        throw new Error(
          'injected path parent traverses symlink inside image: /opt/python',
        );
      }
      if (pyType !== 'directory' && pyType !== 'missing') {
        throw new Error(
          'cannot traverse non-directory inside image: /opt/python',
        );
      }
    }
    for (const item of stagedInjects) {
      const t = pathTypes.get(item.target) ?? 'missing';
      if (t !== 'missing' && t !== 'regular' && t !== 'symlink') {
        throw new Error(
          `cannot overwrite non-file path inside image: ${item.target}`,
        );
      }
    }

    // 6. Inject files & optional Python bundle directly into tmpOut in a single
    // batched `debugfs -w -f` call, setting explicit `0:0` ownership and modes.
    const writeCmds = [];
    const createdDirs = new Set();
    const ensureDirCmd = (dirPath, mode = 0o755) => {
      if (createdDirs.has(dirPath)) return;
      if ((pathTypes.get(dirPath) ?? 'missing') === 'directory') {
        createdDirs.add(dirPath);
        return;
      }
      const q = `"${escapeDebugfsArg(dirPath)}"`;
      writeCmds.push(`mkdir ${q}`);
      writeCmds.push(
        `set_inode_field ${q} mode 040${mode.toString(8).padStart(3, '0')}`,
      );
      writeCmds.push(`set_inode_field ${q} uid 0`);
      writeCmds.push(`set_inode_field ${q} gid 0`);
      createdDirs.add(dirPath);
    };

    for (const dir of Array.from(ancestorDirs).sort(
      (a, b) => a.split('/').length - b.split('/').length,
    )) {
      ensureDirCmd(dir, 0o755);
    }

    if (pythonBundle !== null) {
      if (pathTypes.get('/opt/python') === 'directory') {
        const existingPy = listImageSubtree(
          resolvedDebugfs,
          tmpOut,
          '/opt/python',
          workDir,
        );
        for (const f of existingPy.files) {
          writeCmds.push(`rm "${escapeDebugfsArg(f)}"`);
        }
        for (const d of existingPy.dirs.sort((a, b) => b.length - a.length)) {
          writeCmds.push(`rmdir "${escapeDebugfsArg(d)}"`);
        }
        writeCmds.push('rmdir "/opt/python"');
        pathTypes.set('/opt/python', 'missing');
      }
      ensureDirCmd('/opt/python', 0o755);
      for (const d of pythonBundle.dirs) {
        const q = `"${escapeDebugfsArg(d.guestPath)}"`;
        writeCmds.push(`mkdir ${q}`);
        writeCmds.push(
          `set_inode_field ${q} mode 040${d.mode.toString(8).padStart(3, '0')}`,
        );
        writeCmds.push(`set_inode_field ${q} uid 0`);
        writeCmds.push(`set_inode_field ${q} gid 0`);
      }
      for (const f of pythonBundle.files) {
        const qSrc = `"${escapeDebugfsArg(f.hostPath)}"`;
        const qDst = `"${escapeDebugfsArg(f.guestPath)}"`;
        writeCmds.push(`write ${qSrc} ${qDst}`);
        writeCmds.push(
          `set_inode_field ${qDst} mode 0100${f.mode.toString(8).padStart(3, '0')}`,
        );
        writeCmds.push(`set_inode_field ${qDst} uid 0`);
        writeCmds.push(`set_inode_field ${qDst} gid 0`);
      }
      for (const s of pythonBundle.symlinks) {
        const qDst = `"${escapeDebugfsArg(s.guestPath)}"`;
        const qTarget = `"${escapeDebugfsArg(s.linkTarget)}"`;
        writeCmds.push(`symlink ${qDst} ${qTarget}`);
        writeCmds.push(`set_inode_field ${qDst} uid 0`);
        writeCmds.push(`set_inode_field ${qDst} gid 0`);
      }
    }

    const writtenTargets = new Set();
    for (const item of stagedInjects) {
      const qSrc = `"${escapeDebugfsArg(item.stagedPath)}"`;
      const qDst = `"${escapeDebugfsArg(item.target)}"`;
      const existingType = pathTypes.get(item.target) ?? 'missing';
      if (
        existingType === 'regular' ||
        existingType === 'symlink' ||
        writtenTargets.has(item.target)
      ) {
        writeCmds.push(`rm ${qDst}`);
      }
      writeCmds.push(`write ${qSrc} ${qDst}`);
      writeCmds.push(
        `set_inode_field ${qDst} mode 0100${item.mode.toString(8).padStart(3, '0')}`,
      );
      writeCmds.push(`set_inode_field ${qDst} uid 0`);
      writeCmds.push(`set_inode_field ${qDst} gid 0`);
      writtenTargets.add(item.target);
    }

    const injectCmdPath = join(workDir, 'inject.debugfs');
    writeFileSync(injectCmdPath, `${writeCmds.join('\n')}\n`, { mode: 0o600 });
    const injectRes = runToolFull(resolvedDebugfs, [
      '-w',
      '-f',
      injectCmdPath,
      tmpOut,
    ]);
    const injectFatal = injectRes.stderr
      .split(/\r?\n/)
      .find((line) => line.trim() !== '' && !DEBUGFS_BANNER_LINE.test(line));
    if (injectFatal !== undefined) {
      const detail = injectFatal.trim().slice(0, 600);
      const spaceHint = SPACE_ERR_RE.test(detail)
        ? ' (try a larger --size-mib)'
        : '';
      throw new Error(`debugfs injection failed: ${detail}${spaceHint}`);
    }

    // 7. Assign a fresh filesystem UUID when tune2fs is available (updating
    // ext4 journal & metadata_csum cleanly so e2fsck passes with 0 errors).
    if (resolvedTune2fs) {
      try {
        runToolFull(resolvedTune2fs, ['-U', 'random', tmpOut]);
      } catch {
        // Best-effort UUID randomization.
      }
    }

    chmodSync(tmpOut, 0o644);

    // 8. Re-hash read-only golden base and verify tmpOut BEFORE publishing so
    // linkSync is the single publication point and transient temp-unlink EBUSY
    // cannot fail the call.
    const afterBase = sha256SingleLinkRegularFile(
      baseInfo.path,
      'baseImagePath',
      realVault,
    );
    if (afterBase.sha256 !== baseInfo.sha256) {
      throw new Error('golden baseImagePath changed digest during derivation');
    }

    const outInfo = sha256SingleLinkRegularFile(
      tmpOut,
      'outputImagePath',
      realVault,
    );

    try {
      linkSync(tmpOut, safeOut);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`outputImagePath already exists: ${safeOut}`);
      }
      throw error;
    }
    try {
      unlinkSync(tmpOut);
    } catch {
      // Best-effort cleanup; finally also attempts temp-name removal.
    }

    return {
      outputImagePath: safeOut,
      imageSha256: outInfo.sha256,
      imageBytes: outInfo.bytes,
      baseImagePath: baseInfo.path,
      baseImageSha256: baseInfo.sha256,
      baseImageUnchanged: true,
      injectedFiles: verifiedInjects.map(({ target, sha256, mode }) => ({
        target,
        sha256,
        mode: mode.toString(8),
      })),
      bundledLibraries,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    try {
      unlinkSync(tmpOut);
    } catch {
      // Ignore temp cleanup error (already unlinked or never created).
    }
  }
}

function parseCliArgs(argv) {
  const opts = {
    baseImagePath: null,
    expectedBaseSha256: null,
    outputImagePath: null,
    approvedRoots: [],
    vaultDir: null,
    workloadPath: null,
    imageSizeMib: null,
    debugfsBin: null,
    resize2fsBin: null,
    tune2fsBin: null,
    mkfsExt4Bin: null,
    bundleHostPython: false,
    error: null,
  };
  const take = (flag, idx) => {
    const val = argv[idx + 1];
    if (val === undefined || val.trim() === '' || val.startsWith('--')) {
      opts.error = `missing value for ${flag}`;
      return null;
    }
    return val;
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      const v = take(arg, i);
      if (v === null) break;
      opts.baseImagePath = v;
      i += 1;
    } else if (arg === '--expected-base-sha256') {
      const v = take(arg, i);
      if (v === null) break;
      opts.expectedBaseSha256 = v;
      i += 1;
    } else if (arg === '--out') {
      const v = take(arg, i);
      if (v === null) break;
      opts.outputImagePath = v;
      i += 1;
    } else if (arg === '--approved-root') {
      const v = take(arg, i);
      if (v === null) break;
      opts.approvedRoots.push(v);
      i += 1;
    } else if (arg === '--vault-dir') {
      const v = take(arg, i);
      if (v === null) break;
      opts.vaultDir = v;
      i += 1;
    } else if (arg === '--workload') {
      const v = take(arg, i);
      if (v === null) break;
      opts.workloadPath = v;
      i += 1;
    } else if (arg === '--size-mib') {
      const v = take(arg, i);
      if (v === null) break;
      if (!/^[1-9]\d*$/.test(v)) {
        opts.error = '--size-mib must be a positive integer';
        break;
      }
      opts.imageSizeMib = Number(v);
      i += 1;
    } else if (arg === '--debugfs-bin') {
      const v = take(arg, i);
      if (v === null) break;
      opts.debugfsBin = v;
      i += 1;
    } else if (arg === '--resize2fs-bin') {
      const v = take(arg, i);
      if (v === null) break;
      opts.resize2fsBin = v;
      i += 1;
    } else if (arg === '--tune2fs-bin') {
      const v = take(arg, i);
      if (v === null) break;
      opts.tune2fsBin = v;
      i += 1;
    } else if (arg === '--mkfs-ext4-bin') {
      const v = take(arg, i);
      if (v === null) break;
      opts.mkfsExt4Bin = v;
      i += 1;
    } else if (arg === '--bundle-host-python') {
      opts.bundleHostPython = true;
    } else {
      opts.error = `unknown option ${arg}`;
      break;
    }
  }
  return opts;
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage:\n' +
        '  node scripts/verify-pr-vm-image.mjs derive --base <golden.ext4> --out <derived.ext4> --approved-root <dir> [--expected-base-sha256 <hex>] [--vault-dir <dir>] [--workload <script>] [--size-mib <n>] [--debugfs-bin <path>] [--resize2fs-bin <path>] [--tune2fs-bin <path>] [--bundle-host-python]\n',
    );
    return 0;
  }
  if (argv[0] !== 'derive') {
    process.stderr.write(`verify-pr vm-image: unknown subcommand ${argv[0]}\n`);
    return 2;
  }
  const opts = parseCliArgs(argv);
  if (opts.error) {
    process.stderr.write(`verify-pr vm-image derive: ${opts.error}\n`);
    return 2;
  }
  if (
    !opts.baseImagePath ||
    !opts.outputImagePath ||
    opts.approvedRoots.length === 0
  ) {
    process.stderr.write(
      'verify-pr vm-image derive: --base, --out, and at least one --approved-root are required\n',
    );
    return 2;
  }
  try {
    const extraFiles = opts.workloadPath
      ? [
          {
            srcPath: opts.workloadPath,
            target: '/opt/qwen/workload.sh',
            mode: 0o755,
          },
        ]
      : [];
    const result = deriveExt4GuestImage({
      baseImagePath: opts.baseImagePath,
      expectedBaseSha256: opts.expectedBaseSha256,
      outputImagePath: opts.outputImagePath,
      approvedRoots: opts.approvedRoots,
      vaultDir: opts.vaultDir,
      extraFiles,
      imageSizeMib: opts.imageSizeMib,
      debugfsBin: opts.debugfsBin,
      resize2fsBin: opts.resize2fsBin,
      tune2fsBin: opts.tune2fsBin,
      mkfsExt4Bin: opts.mkfsExt4Bin,
      bundleHostPython: opts.bundleHostPython,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`verify-pr vm-image derive: ${error.message}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
