#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const TARGETS = new Map([
  [
    'darwin-arm64',
    { outputExtension: 'tar.gz', nodeExecutable: ['bin', 'node'] },
  ],
  [
    'darwin-x64',
    { outputExtension: 'tar.gz', nodeExecutable: ['bin', 'node'] },
  ],
  [
    'linux-arm64',
    { outputExtension: 'tar.gz', nodeExecutable: ['bin', 'node'] },
  ],
  ['linux-x64', { outputExtension: 'tar.gz', nodeExecutable: ['bin', 'node'] }],
  ['win-x64', { outputExtension: 'zip', nodeExecutable: ['node.exe'] }],
]);

const DIST_REQUIRED_PATHS = [
  'cli.js',
  'chunks',
  'vendor',
  'bundled/qc-helper/docs',
];
const DIST_ALLOWED_ENTRIES = new Set([
  'cli.js',
  'chunks',
  'vendor',
  'bundled',
  'package.json',
  'README.md',
  'LICENSE',
  'locales',
  'examples',
]);
const DIST_ALLOWED_ENTRY_PATTERNS = [
  /^sandbox-macos-(permissive|restrictive)-(open|closed|proxied)\.sb$/,
];
const ROOT_REQUIRED_PATHS = ['README.md', 'LICENSE'];

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const target = args.target;
  if (!target || !TARGETS.has(target)) {
    fail(`--target must be one of: ${Array.from(TARGETS.keys()).join(', ')}`);
  }

  if (!args.nodeArchive) {
    fail('--node-archive is required');
  }

  const nodeArchive = path.resolve(args.nodeArchive);
  if (!fs.existsSync(nodeArchive)) {
    fail(`Node.js archive not found: ${nodeArchive}`);
  }

  assertRequiredInputs();

  const version = args.version || readPackageVersion();
  const outDir = path.resolve(args.outDir || path.join(distDir, 'standalone'));
  fs.mkdirSync(outDir, { recursive: true });

  const targetConfig = TARGETS.get(target);
  const outputName = `qwen-code-${target}.${targetConfig.outputExtension}`;
  const outputPath = path.join(outDir, outputName);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-standalone-'));

  try {
    const packageRoot = path.join(tempRoot, 'qwen-code');
    const runtimeExtractDir = path.join(tempRoot, 'runtime');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(runtimeExtractDir, { recursive: true });

    copyRuntimeAssets(packageRoot, outDir);
    extractNodeArchive(nodeArchive, runtimeExtractDir);
    const nodeDir = path.join(packageRoot, 'node');
    copyExtractedNode(runtimeExtractDir, nodeDir);
    validateNodeRuntime(target, nodeDir);
    writeShims(packageRoot);
    writeManifest(packageRoot, {
      version,
      target,
      nodeArchive: path.basename(nodeArchive),
    });

    if (fs.existsSync(outputPath)) {
      fs.rmSync(outputPath, { force: true });
    }
    createArchive(targetConfig.outputExtension, outputPath, tempRoot);
    if (!args.skipChecksums) {
      await writeSha256Sums(outDir);
    }

    console.log(`Created ${path.relative(rootDir, outputPath)}`);
    if (!args.skipChecksums) {
      console.log(
        `Updated ${path.relative(rootDir, path.join(outDir, 'SHA256SUMS'))}`,
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

function parseArgs(argv) {
  const args = {
    help: false,
    outDir: undefined,
    nodeArchive: undefined,
    skipChecksums: false,
    target: undefined,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--target':
        args.target = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--node-archive':
        args.nodeArchive = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--out-dir':
        args.outDir = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--version':
        args.version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--skip-checksums':
        args.skipChecksums = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    fail(`${optionName} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Qwen Code standalone package builder

Usage:
  npm run package:standalone -- --target TARGET --node-archive PATH [OPTIONS]

Options:
  --target TARGET         One of: ${Array.from(TARGETS.keys()).join(', ')}
  --node-archive PATH    Downloaded Node.js runtime archive.
  --out-dir DIR          Output directory. Defaults to dist/standalone.
  --version VERSION      Qwen Code version. Defaults to package.json version.
  --skip-checksums       Do not update SHA256SUMS. Used by release packaging.
  -h, --help             Show this help message.`);
}

function assertRequiredInputs() {
  if (!fs.existsSync(distDir)) {
    fail('dist/ directory not found. Run "npm run bundle" first.');
  }

  for (const relativePath of DIST_REQUIRED_PATHS) {
    const fullPath = path.join(distDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      fail(`Required dist asset missing: ${fullPath}`);
    }
  }

  for (const relativePath of ROOT_REQUIRED_PATHS) {
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      fail(`Required repository file missing: ${fullPath}`);
    }
  }
}

function readPackageVersion() {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

function copyRuntimeAssets(packageRoot, outDir) {
  const libDir = path.join(packageRoot, 'lib');
  const skippedDistEntry = topLevelDistEntryForPath(outDir);
  fs.mkdirSync(libDir, { recursive: true });

  for (const entry of fs.readdirSync(distDir)) {
    if (entry === skippedDistEntry || entry === '.DS_Store') {
      continue;
    }
    if (!isAllowedDistEntry(entry)) {
      fail(`Unexpected dist asset: ${path.join(distDir, entry)}`);
    }
    fs.cpSync(path.join(distDir, entry), path.join(libDir, entry), {
      recursive: true,
      dereference: true,
      verbatimSymlinks: false,
    });
  }
  assertNoSymlinks(libDir, 'Copied runtime assets still contain symlinks.');

  for (const fileName of ROOT_REQUIRED_PATHS) {
    fs.copyFileSync(
      path.join(rootDir, fileName),
      path.join(packageRoot, fileName),
    );
  }

  fs.copyFileSync(
    path.join(rootDir, 'package.json'),
    path.join(packageRoot, 'package.json'),
  );
}

function topLevelDistEntryForPath(candidatePath) {
  const relative = path.relative(distDir, candidatePath);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }

  return relative.split(path.sep)[0];
}

function isAllowedDistEntry(entry) {
  return (
    DIST_ALLOWED_ENTRIES.has(entry) ||
    DIST_ALLOWED_ENTRY_PATTERNS.some((pattern) => pattern.test(entry))
  );
}

function extractNodeArchive(nodeArchive, extractDir) {
  if (nodeArchive.endsWith('.zip')) {
    extractZipArchive(nodeArchive, extractDir);
    return;
  }

  if (
    nodeArchive.endsWith('.tar.gz') ||
    nodeArchive.endsWith('.tgz') ||
    nodeArchive.endsWith('.tar.xz')
  ) {
    run('tar', ['-xf', nodeArchive, '-C', extractDir]);
    return;
  }

  fail(
    `Unsupported Node.js archive format: ${nodeArchive}. Expected .zip, .tar.gz, .tgz, or .tar.xz.`,
  );
}

function extractZipArchive(nodeArchive, extractDir) {
  if (process.platform === 'win32') {
    run(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:QWEN_NODE_ARCHIVE -DestinationPath $env:QWEN_EXTRACT_DIR -Force',
      ],
      {
        env: {
          ...process.env,
          QWEN_NODE_ARCHIVE: nodeArchive,
          QWEN_EXTRACT_DIR: extractDir,
        },
      },
    );
    return;
  }

  run('unzip', ['-q', nodeArchive, '-d', extractDir]);
}

function copyExtractedNode(extractDir, nodeDir) {
  const entries = fs
    .readdirSync(extractDir)
    .filter((entry) => entry !== '.DS_Store');
  if (entries.length === 0) {
    fail('Node.js archive did not contain any files.');
  }

  const sourceRoot =
    entries.length === 1 &&
    fs.statSync(path.join(extractDir, entries[0])).isDirectory()
      ? path.join(extractDir, entries[0])
      : extractDir;

  // Official Unix Node.js archives include internal npm/npx symlinks.
  // The installer rejects symlinks in final archives, so keep safe internal
  // targets by copying their referents during a single checked traversal.
  copyNodeRuntimeEntry(sourceRoot, nodeDir, {
    realRoot: fs.realpathSync(sourceRoot),
    sourceRoot,
    activeDirectories: new Set(),
  });
}

function copyNodeRuntimeEntry(source, destination, state) {
  const lstat = fs.lstatSync(source);

  if (lstat.isSymbolicLink()) {
    copyNodeRuntimeEntry(
      resolveRuntimeSymlink(source, state),
      destination,
      state,
    );
    return;
  }

  if (lstat.isDirectory()) {
    const realSource = fs.realpathSync(source);
    if (state.activeDirectories.has(realSource)) {
      fail(
        `Node.js runtime contains a symlink cycle at ${displayRuntimePath(
          state,
          source,
        )}`,
      );
    }

    state.activeDirectories.add(realSource);
    fs.mkdirSync(destination, { recursive: true });
    fs.chmodSync(destination, lstat.mode);
    for (const entry of fs.readdirSync(source)) {
      copyNodeRuntimeEntry(
        path.join(source, entry),
        path.join(destination, entry),
        state,
      );
    }
    state.activeDirectories.delete(realSource);
    return;
  }

  if (lstat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, lstat.mode);
    return;
  }

  fail(`Unsupported Node.js runtime entry type: ${source}`);
}

function resolveRuntimeSymlink(source, state) {
  const target = fs.readlinkSync(source);
  const resolvedTarget = path.resolve(path.dirname(source), target);
  let realTarget;
  try {
    realTarget = fs.realpathSync(resolvedTarget);
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    const reason =
      errorCode === 'ELOOP' ? 'a symlink cycle' : 'a missing target';
    fail(
      `Node.js runtime symlink points to ${reason}: ${displayRuntimePath(
        state,
        source,
      )} -> ${target}`,
    );
  }

  if (!isPathInside(state.realRoot, realTarget)) {
    fail(
      `Node.js runtime symlink escapes the archive: ${displayRuntimePath(
        state,
        source,
      )} -> ${target}`,
    );
  }

  return resolvedTarget;
}

function displayRuntimePath(state, source) {
  return path.relative(state.sourceRoot, source) || '.';
}

function assertNoSymlinks(root, message) {
  for (const entry of walkDirectory(root)) {
    if (fs.lstatSync(entry).isSymbolicLink()) {
      fail(`${message} First symlink: ${path.relative(root, entry)}`);
    }
  }
}

function* walkDirectory(root) {
  for (const entry of fs.readdirSync(root)) {
    const fullPath = path.join(root, entry);
    yield fullPath;
    if (fs.lstatSync(fullPath).isDirectory()) {
      yield* walkDirectory(fullPath);
    }
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function validateNodeRuntime(target, nodeDir) {
  const targetConfig = TARGETS.get(target);
  const executablePath = path.join(nodeDir, ...targetConfig.nodeExecutable);
  const displayPath = targetConfig.nodeExecutable.join('/');

  if (!fs.existsSync(executablePath)) {
    fail(`Node.js runtime for ${target} must contain ${displayPath}.`);
  }

  if (target !== 'win-x64') {
    const mode = fs.statSync(executablePath).mode;
    if ((mode & 0o111) === 0) {
      fail(
        `Node.js runtime for ${target} must provide executable ${displayPath}.`,
      );
    }
  }
}

function writeShims(packageRoot) {
  const binDir = path.join(packageRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const unixShim = `#!/usr/bin/env sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$ROOT/node/bin/node" "$ROOT/lib/cli.js" "$@"
`;
  const unixShimPath = path.join(binDir, 'qwen');
  fs.writeFileSync(unixShimPath, unixShim);
  fs.chmodSync(unixShimPath, 0o755);

  const windowsShim = `@echo off
setlocal
set "ROOT=%~dp0.."
"%ROOT%\\node\\node.exe" "%ROOT%\\lib\\cli.js" %*
`;
  fs.writeFileSync(path.join(binDir, 'qwen.cmd'), windowsShim);
}

function writeManifest(packageRoot, manifest) {
  const manifestPath = path.join(packageRoot, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: '@qwen-code/qwen-code',
        version: manifest.version,
        target: manifest.target,
        nodeArchive: manifest.nodeArchive,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
}

function createArchive(outputExtension, outputPath, cwd) {
  if (outputExtension === 'zip') {
    createZipArchive(outputPath, cwd);
    return;
  }

  run('tar', ['-czf', outputPath, '-C', cwd, 'qwen-code']);
}

function createZipArchive(outputPath, cwd) {
  if (process.platform === 'win32') {
    run(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Compress-Archive -LiteralPath $env:QWEN_PACKAGE_ROOT -DestinationPath $env:QWEN_OUTPUT_PATH -Force',
      ],
      {
        env: {
          ...process.env,
          QWEN_PACKAGE_ROOT: path.join(cwd, 'qwen-code'),
          QWEN_OUTPUT_PATH: outputPath,
        },
      },
    );
    return;
  }

  run('zip', ['-qr', outputPath, 'qwen-code'], { cwd });
}

async function writeSha256Sums(outDir) {
  const entries = fs
    .readdirSync(outDir)
    .filter(
      (entry) =>
        entry.startsWith('qwen-code-') &&
        (entry.endsWith('.tar.gz') || entry.endsWith('.zip')),
    )
    .sort();

  if (entries.length === 0) {
    fail(
      `No qwen-code archives found in ${outDir}; refusing to write empty SHA256SUMS.`,
    );
  }

  const lines = [];
  for (const entry of entries) {
    const filePath = path.join(outDir, entry);
    const hash = await sha256File(filePath);
    lines.push(`${hash}  ${entry}`);
  }

  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  try {
    execFileSync(command, args, {
      stdio: 'inherit',
      ...options,
    });
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'message' in error
        ? `: ${error.message}`
        : '';
    fail(`Command failed: ${command} ${args.join(' ')}${detail}`);
  }
}

function fail(message) {
  throw new Error(`Error: ${message}`);
}

export { writeSha256Sums };
