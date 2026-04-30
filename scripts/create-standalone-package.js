#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const DIST_REQUIRED_PATHS = ['cli.js', 'vendor', 'bundled/qc-helper/docs'];
const ROOT_REQUIRED_PATHS = ['README.md', 'LICENSE'];

main();

function main() {
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

    copyRuntimeAssets(packageRoot);
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
    writeSha256Sums(outDir);

    console.log(`Created ${path.relative(rootDir, outputPath)}`);
    console.log(
      `Updated ${path.relative(rootDir, path.join(outDir, 'SHA256SUMS'))}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {
    help: false,
    outDir: undefined,
    nodeArchive: undefined,
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

function copyRuntimeAssets(packageRoot) {
  const libDir = path.join(packageRoot, 'lib');
  fs.mkdirSync(libDir, { recursive: true });

  for (const entry of fs.readdirSync(distDir)) {
    if (entry === 'standalone') {
      continue;
    }
    fs.cpSync(path.join(distDir, entry), path.join(libDir, entry), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  for (const fileName of ROOT_REQUIRED_PATHS) {
    fs.copyFileSync(
      path.join(rootDir, fileName),
      path.join(packageRoot, fileName),
    );
  }

  const distPackageJson = path.join(distDir, 'package.json');
  if (fs.existsSync(distPackageJson)) {
    fs.copyFileSync(distPackageJson, path.join(packageRoot, 'package.json'));
  } else {
    fs.copyFileSync(
      path.join(rootDir, 'package.json'),
      path.join(packageRoot, 'package.json'),
    );
  }
}

function extractNodeArchive(nodeArchive, extractDir) {
  if (nodeArchive.endsWith('.zip')) {
    run('unzip', ['-q', nodeArchive, '-d', extractDir]);
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

  fs.cpSync(sourceRoot, nodeDir, {
    recursive: true,
    verbatimSymlinks: true,
  });
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
    run('zip', ['-qr', outputPath, 'qwen-code'], { cwd });
    return;
  }

  run('tar', ['-czf', outputPath, '-C', cwd, 'qwen-code']);
}

function writeSha256Sums(outDir) {
  const entries = fs
    .readdirSync(outDir)
    .filter(
      (entry) =>
        entry.startsWith('qwen-code-') &&
        (entry.endsWith('.tar.gz') || entry.endsWith('.zip')),
    )
    .sort();

  const lines = entries.map((entry) => {
    const filePath = path.join(outDir, entry);
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');
    return `${hash}  ${entry}`;
  });

  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
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
  console.error(`Error: ${message}`);
  process.exit(1);
}
