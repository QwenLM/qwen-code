#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
const runtimeDir = path.join(packageDir, 'runtime');
const packageRoot = path.join(runtimeDir, 'qwen-code');
const libDir = path.join(packageRoot, 'lib');
const nodeDir = path.join(packageRoot, 'node');
const binDir = path.join(packageRoot, 'bin');

const target = desktopTarget();

execFileSync('npm', ['run', 'build', '--', '--cli-only'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
execFileSync('npm', ['run', 'build', '--workspace=packages/webui'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
execFileSync('npm', ['run', 'build', '--workspace=packages/web-shell'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
execFileSync('npm', ['run', 'bundle'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, DEV: 'true' },
});
execFileSync('npm', ['run', 'prepare:package'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const distDir = path.join(repoRoot, 'dist');
for (const required of ['cli.js', 'cli-entry.js', 'web-shell/index.html', 'web-shell/assets']) {
  const candidate = path.join(distDir, required);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Missing bundled runtime asset: ${candidate}`);
  }
}

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
copyDirectory(distDir, libDir);
await installNodeRuntime(nodeDir, target);
writeLaunchers();
fs.writeFileSync(
  path.join(packageRoot, 'manifest.json'),
  `${JSON.stringify({
    name: '@qwen-code/qwen-code',
    version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
    target,
    node: process.version,
  }, null, 2)}\n`,
);
console.log(`Prepared desktop runtime at ${path.relative(repoRoot, packageRoot)}`);

async function installNodeRuntime(destination, desktopTarget) {
  const nodeVersion = process.versions.node;
  const archiveName = nodeArchiveName(nodeVersion, desktopTarget);
  const downloadRoot = `https://nodejs.org/dist/v${nodeVersion}`;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-desktop-node-'));
  try {
    const checksumsPath = path.join(temporaryRoot, 'SHASUMS256.txt');
    const archivePath = path.join(temporaryRoot, archiveName);
    await download(`${downloadRoot}/SHASUMS256.txt`, checksumsPath);
    await download(`${downloadRoot}/${archiveName}`, archivePath);
    verifyChecksum(
      archivePath,
      archiveName,
      fs.readFileSync(checksumsPath, 'utf8'),
    );
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

function desktopTarget() {
  const target = `${process.platform}-${process.arch}`;
  if (
    ![
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ].includes(target)
  ) {
    throw new Error(`Unsupported desktop PoC target: ${target}`);
  }
  return target;
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
  const response = await fetch(url);
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
  if (archivePath.endsWith('.zip')) {
    execFileSync('tar', ['-xf', archivePath, '-C', destination]);
    return;
  }
  execFileSync('tar', ['-xf', archivePath, '-C', destination]);
}

function writeLaunchers() {
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, 'qwen.cmd'),
      '@echo off\r\nsetlocal\r\nset "ROOT=%~dp0.."\r\n"%ROOT%\\node\\node.exe" "%ROOT%\\lib\\cli-entry.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
    );
    return;
  }
  const launcher = '#!/usr/bin/env sh\nset -e\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$ROOT/node/bin/node" "$ROOT/lib/cli-entry.js" "$@"\n';
  const launcherPath = path.join(binDir, 'qwen');
  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => path.basename(entry) !== '.DS_Store',
  });
}
