#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(packageDir, '../..');
const sourceRoot = process.env.QWEN_CODE_ROOT
  ? path.resolve(process.env.QWEN_CODE_ROOT)
  : repoRoot;
const runtimeDir = path.join(packageDir, 'runtime');
const finalPackageRoot = path.join(runtimeDir, 'qwen-code');
const refreshChecksums = process.argv.indexOf('--refresh-checksums');
if (refreshChecksums !== -1) {
  const root = process.argv[refreshChecksums + 1]
    ? path.resolve(process.argv[refreshChecksums + 1])
    : finalPackageRoot;
  writeChecksums(root);
  console.log(`Refreshed desktop runtime checksums at ${root}`);
  process.exit(0);
}
fs.mkdirSync(runtimeDir, { recursive: true });
recoverInterruptedRuntime();
const stagingRoot = fs.mkdtempSync(path.join(runtimeDir, '.prepare-'));
const packageRoot = path.join(stagingRoot, 'qwen-code');
const libDir = path.join(packageRoot, 'lib');
const nodeDir = path.join(packageRoot, 'node');
const qwenCodeVersion = JSON.parse(
  fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'),
).version;
const desktopVersion = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
).version;
const binDir = path.join(packageRoot, 'bin');

const target = desktopTarget();
const skipBuild = process.env.QWEN_DESKTOP_SKIP_BUILD === '1';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('npm_execpath is unavailable. Run through npm.');

if (!skipBuild) {
  execFileSync(process.execPath, [npm, 'run', 'build', '--', '--cli-only'], {
    cwd: sourceRoot,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [npm, 'run', 'bundle'], {
    cwd: sourceRoot,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [npm, 'run', 'prepare:package'], {
    cwd: sourceRoot,
    stdio: 'inherit',
  });
}

const distDir = path.join(sourceRoot, 'dist');
for (const required of [
  'cli.js',
  'cli-entry.js',
  'web-shell/index.html',
  'web-shell/assets',
]) {
  const candidate = path.join(distDir, required);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Missing bundled runtime asset: ${candidate}`);
  }
}

try {
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, '.gitkeep'), '');
  fs.mkdirSync(binDir, { recursive: true });
  copyDirectory(distDir, libDir);
  await installNodeRuntime(nodeDir, target);
  writeLaunchers(target);
  copyRequiredFile(
    path.join(sourceRoot, 'LICENSE'),
    path.join(packageRoot, 'LICENSE'),
  );
  copyRequiredFile(
    path.join(packageDir, 'NOTICE'),
    path.join(packageRoot, 'NOTICE'),
  );
  const nodeLicense = path.join(nodeDir, 'LICENSE');
  if (!fs.existsSync(nodeLicense)) {
    throw new Error(`Bundled Node.js license is missing: ${nodeLicense}`);
  }
  fs.writeFileSync(
    path.join(packageRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        name: '@qwen-code/qwen-code',
        desktopVersion,
        qwenCodeVersion,
        qwenCodeCommit: process.env.QWEN_CODE_COMMIT || gitCommit(sourceRoot),
        target,
        node: `v${process.versions.node}`,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  writeChecksums();
  replaceRuntime();
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
console.log(
  `Prepared desktop runtime at ${path.relative(repoRoot, finalPackageRoot)}`,
);

async function installNodeRuntime(destination, desktopTarget) {
  const nvmrc = fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
  const nodeVersion = process.versions.node;
  if (!nodeVersion.startsWith(`${nvmrc}.`)) {
    throw new Error(
      `Node ${nodeVersion} does not match .nvmrc major version ${nvmrc}. ` +
        'Run the correct Node or update .nvmrc.',
    );
  }
  const archiveName = nodeArchiveName(nodeVersion, desktopTarget);
  const downloadRoot = `https://nodejs.org/dist/v${nodeVersion}`;
  const cacheRoot = process.env.QWEN_DESKTOP_NODE_CACHE_DIR
    ? path.resolve(process.env.QWEN_DESKTOP_NODE_CACHE_DIR)
    : path.join(os.tmpdir(), 'qwen-desktop-node-cache');
  const cacheDir = path.join(cacheRoot, `v${nodeVersion}`);
  const cachedArchivePath = path.join(cacheDir, archiveName);
  fs.rmSync(path.join(cacheDir, 'SHASUMS256.txt'), { force: true });
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qwen-desktop-node-'),
  );
  try {
    const checksumsPath = path.join(temporaryRoot, 'SHASUMS256.txt');
    const archivePath = path.join(temporaryRoot, archiveName);
    await download(`${downloadRoot}/SHASUMS256.txt`, checksumsPath);
    const checksums = fs.readFileSync(checksumsPath, 'utf8');
    if (
      copyValidCachedArchive(
        cachedArchivePath,
        archivePath,
        archiveName,
        checksums,
      )
    ) {
      console.log(`Using cached Node.js runtime ${archiveName}`);
    } else {
      await download(`${downloadRoot}/${archiveName}`, archivePath);
      verifyChecksum(archivePath, archiveName, checksums);
      fs.mkdirSync(cacheDir, { recursive: true });
      const temporaryCachePath = `${cachedArchivePath}.${process.pid}.tmp`;
      try {
        fs.copyFileSync(archivePath, temporaryCachePath);
        fs.renameSync(temporaryCachePath, cachedArchivePath);
      } finally {
        fs.rmSync(temporaryCachePath, { force: true });
      }
    }
    extractNodeArchive(archivePath, temporaryRoot);
    const extractedRoot = path.join(
      temporaryRoot,
      archiveName.replace(/\.(tar\.gz|tar\.xz|zip)$/, ''),
    );
    if (!fs.existsSync(extractedRoot)) {
      throw new Error(`Extracted Node runtime is missing: ${extractedRoot}`);
    }
    copyDirectory(extractedRoot, destination);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function copyValidCachedArchive(
  cachedArchivePath,
  archivePath,
  archiveName,
  checksums,
) {
  if (!fs.existsSync(cachedArchivePath)) return false;
  try {
    fs.copyFileSync(cachedArchivePath, archivePath);
    verifyChecksum(archivePath, archiveName, checksums);
    return true;
  } catch {
    fs.rmSync(cachedArchivePath, { force: true });
    fs.rmSync(archivePath, { force: true });
    return false;
  }
}

function desktopTarget() {
  const target =
    process.env.QWEN_DESKTOP_TARGET || `${process.platform}-${process.arch}`;
  const aliases = {
    'aarch64-apple-darwin': 'darwin-arm64',
    'x86_64-apple-darwin': 'darwin-x64',
    'aarch64-unknown-linux-gnu': 'linux-arm64',
    'x86_64-unknown-linux-gnu': 'linux-x64',
    'x86_64-pc-windows-msvc': 'win32-x64',
  };
  const resolved = aliases[target] || target;
  if (
    ![
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ].includes(resolved)
  ) {
    throw new Error(`Unsupported desktop target: ${target}`);
  }
  return resolved;
}

function nodeArchiveName(version, desktopTarget) {
  const nodeTarget = desktopTarget === 'win32-x64' ? 'win-x64' : desktopTarget;
  const extension = desktopTarget.startsWith('darwin-')
    ? 'tar.gz'
    : desktopTarget.startsWith('linux-')
      ? 'tar.xz'
      : 'zip';
  return `node-v${version}-${nodeTarget}.${extension}`;
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(response.body, fs.createWriteStream(destination));
}

function verifyChecksum(archivePath, archiveName, checksums) {
  const expected = checksums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, fileName]) => fileName === archiveName)?.[0];
  if (!expected) {
    throw new Error(`Node checksums do not list ${archiveName}`);
  }
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');
  if (actual !== expected) {
    throw new Error(`Node runtime checksum mismatch for ${archiveName}`);
  }
}

function extractNodeArchive(archivePath, destination) {
  execFileSync('tar', ['-xf', archivePath, '-C', destination]);
}

function writeLaunchers(desktopTarget) {
  if (desktopTarget.startsWith('win32-')) {
    fs.writeFileSync(
      path.join(binDir, 'qwen.cmd'),
      '@echo off\r\nsetlocal\r\nset "ROOT=%~dp0.."\r\n"%ROOT%\\node\\node.exe" "%ROOT%\\lib\\cli-entry.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
    );
    return;
  }
  const launcher =
    '#!/usr/bin/env sh\nset -e\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$ROOT/node/bin/node" "$ROOT/lib/cli-entry.js" "$@"\n';
  const launcherPath = path.join(binDir, 'qwen');
  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);
}

function copyRequiredFile(source, destination) {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Required desktop runtime file is missing: ${source}`);
  }
  fs.copyFileSync(source, destination);
}

function gitCommit(directory) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function writeChecksums(root = packageRoot) {
  const checksums = {};
  for (const file of runtimeFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative === 'checksums.json') continue;
    checksums[relative] = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
  }
  fs.writeFileSync(
    path.join(root, 'checksums.json'),
    `${JSON.stringify(checksums, null, 2)}\n`,
  );
}

function runtimeFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? runtimeFiles(absolute) : [absolute];
    })
    .sort();
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => path.basename(entry) !== '.DS_Store',
  });
}

function recoverInterruptedRuntime() {
  for (const entry of fs.readdirSync(runtimeDir)) {
    if (!entry.startsWith('.prepare-')) continue;
    const staleRoot = path.join(runtimeDir, entry);
    const previousRoot = path.join(staleRoot, 'previous');
    if (!fs.existsSync(finalPackageRoot) && fs.existsSync(previousRoot)) {
      fs.renameSync(previousRoot, finalPackageRoot);
    }
    fs.rmSync(staleRoot, { recursive: true, force: true });
  }
}

function replaceRuntime() {
  const previousRoot = path.join(stagingRoot, 'previous');
  if (fs.existsSync(finalPackageRoot)) {
    fs.renameSync(finalPackageRoot, previousRoot);
  }
  try {
    fs.renameSync(packageRoot, finalPackageRoot);
  } catch (error) {
    if (fs.existsSync(previousRoot)) {
      fs.renameSync(previousRoot, finalPackageRoot);
    }
    throw error;
  }
}
