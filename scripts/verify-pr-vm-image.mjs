#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Offline read-only golden ext4 image derivation tool for `/verify-pr` microVMs.
 *
 * Extracts a read-only golden ext4 rootfs via `debugfs rdump` (without loop
 * mounting or opening the golden image for writing), injects the repository's
 * audited guest scripts (`guest-vsock.py`, `guest-runner.py`, `/opt/poc/init`,
 * plus optional workload/extra files), rebuilds an independent ext4 image via
 * `mkfs.ext4 -d`, and re-verifies that the golden base image SHA-256 is
 * unchanged. Fails closed on symlinks, hardlinks, vault paths, path traversal,
 * overwrite attempts, or SHA mismatches, and cleans up all temporary staging
 * on error.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
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
const DEFAULT_IMAGE_SIZE_MIB = 512;
const MIN_IMAGE_SIZE_MIB = 32;
const MAX_IMAGE_SIZE_MIB = 16 * 1024;

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

function findExecutable(explicitPath, fallbackNames) {
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
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
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
    const spaceHint = /No space left|ENOSPC|Could not allocate/i.test(detail)
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

/**
 * Walks every path component beneath `extractTree` before any `mkdirSync` or
 * `rmSync` so a symlink unpacked from an untrusted base image can never cause
 * host-side directory creation, deletion, or writes outside `extractTree`.
 */
function ensureSafeExtractPath(
  extractTree,
  guestTargetPath,
  { createParents = false, checkLeafAsDir = false } = {},
) {
  const realTree = realpathSync(extractTree);
  const normalized = normalizeImageTargetPath(guestTargetPath);
  const segments = normalized.split('/').filter(Boolean);
  const dirSegments = checkLeafAsDir ? segments : segments.slice(0, -1);
  let cursor = realTree;
  for (const seg of dirSegments) {
    cursor = join(cursor, seg);
    let st = null;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (st !== null) {
      if (st.isSymbolicLink()) {
        throw new Error(
          `injected path parent escaped extract tree via symlink: ${guestTargetPath}`,
        );
      }
      if (!st.isDirectory()) {
        throw new Error(
          `cannot traverse non-directory inside image: ${guestTargetPath}`,
        );
      }
    } else if (createParents) {
      mkdirSync(cursor, { mode: 0o755 });
    }
  }
  if (createParents || existsSync(cursor)) {
    const realParent = realpathSync(cursor);
    if (!withinDir(realTree, realParent)) {
      throw new Error(
        `injected path parent escaped extract tree via symlink: ${guestTargetPath}`,
      );
    }
  }
  return checkLeafAsDir ? cursor : join(cursor, segments[segments.length - 1]);
}

function escapeDebugfsArg(value) {
  if (/[\0\r\n]/.test(value)) {
    throw new Error('extract tree path must not contain newlines or NUL bytes');
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function bundleHostPythonIntoTree(
  treeDir,
  { pythonBin, pythonLibDir, lddBin },
) {
  const realPy = realpathSync(pythonBin);
  const pyName = basename(realPy);
  const pyRoot = ensureSafeExtractPath(treeDir, '/opt/python', {
    createParents: false,
    checkLeafAsDir: true,
  });
  rmSync(pyRoot, { recursive: true, force: true });
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
  runTool('/bin/cp', ['-a', pythonLibDir, targetStdlib]);

  const dynloadDir = join(pythonLibDir, 'lib-dynload');
  const binariesToScan = [realPy];
  if (existsSync(dynloadDir)) {
    const findOut = runTool('/usr/bin/find', [
      dynloadDir,
      '-maxdepth',
      '1',
      '-name',
      '*.so',
    ]);
    for (const line of findOut.split(/\r?\n/)) {
      if (line.trim()) binariesToScan.push(line.trim());
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
  }
  for (const pair of aliases) {
    const [alias, target] = pair.split('=>');
    if (alias !== target && !existsSync(join(pyLibTargetDir, alias))) {
      symlinkSync(target, join(pyLibTargetDir, alias));
    }
  }
  return [...copiedLibs.values()].sort();
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
  imageSizeMib = DEFAULT_IMAGE_SIZE_MIB,
  debugfsBin = null,
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
  if (
    !Number.isSafeInteger(imageSizeMib) ||
    imageSizeMib < MIN_IMAGE_SIZE_MIB ||
    imageSizeMib > MAX_IMAGE_SIZE_MIB
  ) {
    throw new Error(
      `imageSizeMib must be an integer in ${MIN_IMAGE_SIZE_MIB}..${MAX_IMAGE_SIZE_MIB}`,
    );
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

  const resolvedDebugfs = findExecutable(debugfsBin, ['debugfs']);
  if (!resolvedDebugfs) {
    throw new Error('debugfs executable not found (e2fsprogs required)');
  }
  const resolvedMkfs = findExecutable(mkfsExt4Bin, ['mkfs.ext4', 'mke2fs']);
  if (!resolvedMkfs) {
    throw new Error('mkfs.ext4 executable not found (e2fsprogs required)');
  }

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
  const extractTree = join(workDir, 'rootfs');
  mkdirSync(extractTree, { mode: 0o755 });
  const tmpOut = join(
    realOutParent,
    `.derive.${process.pid}.${Date.now()}.tmp`,
  );
  let promoted = false;
  let bundledLibraries = [];

  try {
    const extract = runToolFull(resolvedDebugfs, [
      '-R',
      `rdump / "${escapeDebugfsArg(extractTree)}"`,
      baseInfo.path,
    ]);
    if (
      /^rdump:/m.test(extract.stderr) ||
      /while trying to open|Bad magic number|Filesystem not open|Operation not permitted|Permission denied|No such file or directory|Input\/output error/i.test(
        extract.stderr,
      )
    ) {
      throw new Error(`debugfs extraction failed: ${extract.stderr.trim()}`);
    }
    if (readdirSync(extractTree).length === 0) {
      throw new Error('debugfs extraction produced an empty rootfs tree');
    }

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
      bundledLibraries = bundleHostPythonIntoTree(extractTree, {
        pythonBin,
        pythonLibDir: pyLib,
        lddBin: resolvedLdd,
      });
    }

    for (const item of verifiedInjects) {
      // Verify every ancestor segment BEFORE creating directories so an
      // unpacked symlink ancestor cannot create host directories outside extractTree.
      const safeDest = ensureSafeExtractPath(extractTree, item.target, {
        createParents: true,
        checkLeafAsDir: false,
      });
      try {
        const existing = lstatSync(safeDest);
        if (existing.isSymbolicLink() || existing.isFile()) {
          unlinkSync(safeDest);
        } else {
          throw new Error(
            `cannot overwrite non-file path inside image: ${item.target}`,
          );
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      copyFileSync(item.srcReal, safeDest);
      chmodSync(safeDest, item.mode);
    }

    const tmpFd = openSync(
      tmpOut,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    closeSync(tmpFd);
    truncateSync(tmpOut, imageSizeMib * 1024 * 1024);

    const mkfsArgs =
      basename(resolvedMkfs) === 'mke2fs'
        ? [
            '-t',
            'ext4',
            '-F',
            '-b',
            '4096',
            '-U',
            'random',
            '-d',
            extractTree,
            tmpOut,
          ]
        : ['-F', '-b', '4096', '-U', 'random', '-d', extractTree, tmpOut];
    runTool(resolvedMkfs, mkfsArgs);
    chmodSync(tmpOut, 0o644);
    renameSync(tmpOut, safeOut);
    promoted = true;

    const afterBase = sha256SingleLinkRegularFile(
      baseInfo.path,
      'baseImagePath',
      realVault,
    );
    if (afterBase.sha256 !== baseInfo.sha256) {
      throw new Error('golden baseImagePath changed digest during derivation');
    }
    const outInfo = sha256SingleLinkRegularFile(
      safeOut,
      'outputImagePath',
      realVault,
    );

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
    if (!promoted) {
      try {
        unlinkSync(tmpOut);
      } catch {
        // Ignore temp cleanup error.
      }
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
    imageSizeMib: DEFAULT_IMAGE_SIZE_MIB,
    debugfsBin: null,
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
        '  node scripts/verify-pr-vm-image.mjs derive --base <golden.ext4> --out <derived.ext4> --approved-root <dir> [--expected-base-sha256 <hex>] [--vault-dir <dir>] [--workload <script>] [--size-mib <n>] [--debugfs-bin <path>] [--mkfs-ext4-bin <path>] [--bundle-host-python]\n',
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
