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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  TARGET_CLIPBOARD_PACKAGE,
  standaloneArchiveName,
  writeSha256Sums,
} from './create-standalone-package.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const RELEASE_TARGETS = [
  {
    qwenTarget: 'darwin-arm64',
    nodeTarget: 'darwin-arm64',
    nodeArchiveExtension: 'tar.gz',
    bunAsset: 'bun-darwin-aarch64',
  },
  {
    qwenTarget: 'darwin-x64',
    nodeTarget: 'darwin-x64',
    nodeArchiveExtension: 'tar.gz',
    bunAsset: 'bun-darwin-x64',
  },
  {
    qwenTarget: 'linux-arm64',
    nodeTarget: 'linux-arm64',
    nodeArchiveExtension: 'tar.xz',
    bunAsset: 'bun-linux-aarch64',
  },
  {
    qwenTarget: 'linux-x64',
    nodeTarget: 'linux-x64',
    nodeArchiveExtension: 'tar.xz',
    bunAsset: 'bun-linux-x64',
  },
  {
    qwenTarget: 'win-x64',
    nodeTarget: 'win-x64',
    nodeArchiveExtension: 'zip',
    bunAsset: 'bun-windows-x64',
  },
];
// Classic Node.js packaging stays the default. --runtime=bun opts into the
// temporary OpenTUI preview (the renderer needs bun:ffi; Node without FFI
// falls back to ink). --include-opentui-preview adds the bun flavor's
// archives (suffixed -opentui-preview) to the same release directory.
const DEFAULT_RUNTIME = 'node';
const DEFAULT_BUN_VERSION = '1.3.14';
const BUN_RELEASE_BASE_URL = 'https://github.com/oven-sh/bun/releases/download';

// Temporary OpenTUI preview: the bundled OpenTUI backend resolves its native
// render library at runtime via `import('@opentui/core-<platform>-<arch>')`,
// so each standalone archive must ship the matching platform package(s).
// Stage every platform variant (like the clipboard addons) because release
// packaging cross-builds all targets from a single host. Linux is glibc-only
// on purpose: RELEASE_TARGETS bundles glibc-linked Bun binaries that cannot
// start on musl hosts, so the -musl render packages would be dead weight
// claiming support the archive cannot deliver. Declared before the
// top-level `main()` call below (ESM const TDZ).
const OPENTUI_PLATFORM_PACKAGES = [
  '@opentui/core-darwin-arm64',
  '@opentui/core-darwin-x64',
  '@opentui/core-linux-arm64',
  '@opentui/core-linux-x64',
  '@opentui/core-win32-arm64',
  '@opentui/core-win32-x64',
];

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

  const runtime = args.runtime || DEFAULT_RUNTIME;
  if (runtime !== 'node' && runtime !== 'bun') {
    fail('--runtime must be either "node" or "bun"');
  }
  // The bun flavor is additive: with --include-opentui-preview the release
  // directory carries both the classic Node.js archives and the bun/OpenTUI
  // preview archives; every downstream check derives its expected set from
  // this list.
  const flavors =
    args.includeOpentuiPreview && runtime !== 'bun'
      ? ['node', 'bun']
      : [runtime];

  const nodeVersion = args.nodeVersion || process.versions.node;
  const bunVersion = args.bunVersion || DEFAULT_BUN_VERSION;
  const outDir = path.resolve(
    args.outDir || path.join(rootDir, 'dist', 'standalone'),
  );
  const runtimeParent = path.resolve(
    args.runtimeDir || process.env.RUNNER_TEMP || os.tmpdir(),
  );
  fs.mkdirSync(runtimeParent, { recursive: true });
  const runtimeDir = fs.mkdtempSync(
    path.join(runtimeParent, `qwen-${runtime}-runtime-`),
  );
  const nodeDistUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const bunDistUrl = `${BUN_RELEASE_BASE_URL}/bun-v${bunVersion}`;

  try {
    fs.mkdirSync(outDir, { recursive: true });
    // Each flavor verifies its runtime archive against its own publisher's
    // checksum list (Node.js SHASUMS256.txt vs Bun's), so fetch one per flavor.
    const checksums = {};
    for (const flavor of flavors) {
      const checksumsPath = path.join(runtimeDir, `${flavor}-SHASUMS256.txt`);
      await downloadFile(
        `${flavor === 'bun' ? bunDistUrl : nodeDistUrl}/SHASUMS256.txt`,
        checksumsPath,
      );
      checksums[flavor] = parseChecksums(
        fs.readFileSync(checksumsPath, 'utf8'),
      );
    }
    const nativeModulesDir = stageClipboardPackages(runtimeDir);
    // Only the bun runtime consumes the staged OpenTUI packages; the classic
    // Node packaging must not install them (nor fail on a missing lockfile
    // entry) at all.
    const opentuiModulesDir = flavors.includes('bun')
      ? stageOpenTuiPackages(runtimeDir)
      : undefined;

    for (const flavor of flavors) {
      for (const target of RELEASE_TARGETS) {
        await packageTarget({
          ...target,
          runtime: flavor,
          bunDistUrl,
          nodeDistUrl,
          nodeVersion,
          outDir,
          releaseVersion: args.version,
          runtimeDir,
          checksums: checksums[flavor],
          nativeModulesDir,
          opentuiModulesDir,
        });
      }
    }

    await writeSha256Sums(outDir);
    assertStandaloneOutput(outDir, flavors);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

async function packageTarget({
  qwenTarget,
  nodeTarget,
  nodeArchiveExtension,
  bunAsset,
  runtime,
  bunDistUrl,
  nodeDistUrl,
  nodeVersion,
  outDir,
  releaseVersion,
  runtimeDir,
  checksums,
  nativeModulesDir,
  opentuiModulesDir,
}) {
  let archiveName;
  let archiveUrlBase;
  if (runtime === 'bun') {
    archiveName = `${bunAsset}.zip`;
    archiveUrlBase = bunDistUrl;
  } else {
    archiveName = `node-v${nodeVersion}-${nodeTarget}.${nodeArchiveExtension}`;
    archiveUrlBase = nodeDistUrl;
  }
  const archivePath = path.join(runtimeDir, archiveName);

  await downloadFile(`${archiveUrlBase}/${archiveName}`, archivePath);
  await verifyNodeArchive(
    archivePath,
    archiveName,
    checksums,
    runtime === 'bun' ? 'Bun' : 'Node.js',
  );

  const args = [
    'scripts/create-standalone-package.js',
    '--target',
    qwenTarget,
    '--node-archive',
    archivePath,
    '--native-modules-dir',
    nativeModulesDir,
    '--out-dir',
    outDir,
    '--skip-checksums',
  ];
  if (runtime === 'bun') {
    args.push('--runtime', 'bun');
    args.push('--opentui-modules-dir', opentuiModulesDir);
  }
  if (releaseVersion) {
    args.push('--version', releaseVersion);
  }

  execFileSync(process.execPath, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

function readClipboardPackageSpecs() {
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
  );
  const cliPackage = JSON.parse(
    fs.readFileSync(
      path.join(rootDir, 'packages', 'cli', 'package.json'),
      'utf8',
    ),
  );
  const packageNames = [
    '@teddyzhu/clipboard',
    ...new Set(TARGET_CLIPBOARD_PACKAGE.values()),
  ];

  return packageNames.map((packageName) => {
    const version =
      packageLock.packages?.[`node_modules/${packageName}`]?.version;
    const declaredVersion = cliPackage.optionalDependencies?.[packageName];
    if (!version || ![version, `^${version}`].includes(declaredVersion)) {
      fail(`Clipboard package version is not locked for ${packageName}`);
    }
    return `${packageName}@${version}`;
  });
}

function stageClipboardPackages(runtimeDir) {
  const installDir = path.join(runtimeDir, 'clipboard-modules');
  fs.mkdirSync(installDir, { recursive: true });
  console.log('Staging standalone clipboard native packages');
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    fail('npm_execpath is unavailable; run package:standalone:release via npm');
  }
  execFileSync(
    process.execPath,
    [
      npmExecPath,
      'install',
      '--prefix',
      installDir,
      '--package-lock=false',
      '--no-save',
      '--ignore-scripts',
      '--force',
      '--no-audit',
      '--no-fund',
      ...readClipboardPackageSpecs(),
    ],
    {
      cwd: rootDir,
      stdio: 'inherit',
    },
  );
  return path.join(installDir, 'node_modules');
}

// Temporary OpenTUI preview: the bundled OpenTUI backend resolves its native
// render library at runtime via `import('@opentui/core-<platform>-<arch>')`,
// so each standalone archive must ship the matching platform package(s).
function readOpenTuiPackageSpecs() {
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
  );

  return OPENTUI_PLATFORM_PACKAGES.map((packageName) => {
    const version =
      packageLock.packages?.[`node_modules/${packageName}`]?.version;
    if (!version) {
      fail(`OpenTUI platform package version is not locked for ${packageName}`);
    }
    return `${packageName}@${version}`;
  });
}

function stageOpenTuiPackages(runtimeDir) {
  const installDir = path.join(runtimeDir, 'opentui-modules');
  fs.mkdirSync(installDir, { recursive: true });
  console.log('Staging standalone OpenTUI native packages');
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    fail('npm_execpath is unavailable; run package:standalone:release via npm');
  }
  execFileSync(
    process.execPath,
    [
      npmExecPath,
      'install',
      '--prefix',
      installDir,
      '--package-lock=false',
      '--no-save',
      '--ignore-scripts',
      '--force',
      '--no-audit',
      '--no-fund',
      ...readOpenTuiPackageSpecs(),
    ],
    {
      cwd: rootDir,
      stdio: 'inherit',
    },
  );
  return path.join(installDir, 'node_modules');
}

async function downloadFile(url, destination) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    fail(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    fail(`Failed to download ${url}: response body was empty`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination),
  );
}

function parseChecksums(content) {
  const checksums = new Map();
  for (const line of content.split(/\r?\n/)) {
    const [hash, fileName] = line.trim().split(/\s+/, 2);
    if (hash && fileName) {
      checksums.set(fileName.replace(/^\*/, ''), hash);
    }
  }
  return checksums;
}

async function verifyNodeArchive(archivePath, archiveName, checksums, label) {
  const runtimeLabel = label || 'Node.js';
  const expected = checksums.get(archiveName);
  if (!expected) {
    fail(`${runtimeLabel} SHASUMS256.txt does not list ${archiveName}`);
  }

  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    fail(`Checksum verification failed for ${archiveName}`);
  }

  console.log(`Verified ${runtimeLabel} runtime checksum for ${archiveName}`);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function assertStandaloneOutput(outDir, runtimes = ['node']) {
  const checksumPath = path.join(outDir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`Standalone SHA256SUMS was not created at ${checksumPath}`);
  }

  const expectedArchiveNames = RELEASE_TARGETS.flatMap(({ qwenTarget }) =>
    runtimes.map((runtime) => standaloneArchiveName(qwenTarget, runtime)),
  ).sort();
  const archiveNames = fs
    .readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[0-9a-f]{64}\s+/.test(line))
    .map((line) => line.trim().split(/\s+/, 2)[1]?.replace(/^\*/, ''))
    .filter(Boolean)
    .sort();
  const missing = expectedArchiveNames.filter(
    (archiveName) => !archiveNames.includes(archiveName),
  );
  const extra = archiveNames.filter(
    (archiveName) => !expectedArchiveNames.includes(archiveName),
  );

  if (
    archiveNames.length !== expectedArchiveNames.length ||
    missing.length > 0 ||
    extra.length > 0
  ) {
    fail(
      [
        `Expected standalone checksums for ${expectedArchiveNames.join(', ')}`,
        `found ${archiveNames.join(', ') || 'none'}.`,
        missing.length > 0 ? `Missing: ${missing.join(', ')}.` : '',
        extra.length > 0 ? `Extra: ${extra.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  console.log(`Verified ${archiveNames.length} standalone release checksums.`);
}

function parseArgs(argv) {
  const args = {
    help: false,
    includeOpentuiPreview: false,
    nodeVersion: undefined,
    bunVersion: undefined,
    runtime: undefined,
    outDir: undefined,
    runtimeDir: undefined,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--include-opentui-preview':
        args.includeOpentuiPreview = true;
        break;
      case '--node-version':
        args.nodeVersion = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--bun-version':
        args.bunVersion = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--runtime':
        args.runtime = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--out-dir':
        args.outDir = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--runtime-dir':
        args.runtimeDir = readOptionValue(argv, index, arg);
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
  console.log(`
Usage:
  npm run package:standalone:release -- [OPTIONS]

Options:
  --version VERSION      Release version written to standalone manifests.
  --out-dir PATH         Output directory. Defaults to dist/standalone.
  --runtime-dir PATH     Temporary Node.js runtime download directory.
  --node-version VERSION Node.js version to download. Defaults to current Node.
  --runtime RUNTIME      Runtime to bundle: "node" (classic packaging) or
                         "bun" (temporary OpenTUI preview).
  --include-opentui-preview
                         Also build the bun/OpenTUI preview archives
                         (qwen-code-*-opentui-preview.*) into the same output
                         directory, alongside the classic archives.
  --bun-version VERSION  Bun version to download. Defaults to ${DEFAULT_BUN_VERSION}.
`);
}

function fail(message) {
  throw new Error(`ERROR: ${message}`);
}

export {
  assertStandaloneOutput,
  parseChecksums,
  readClipboardPackageSpecs,
  RELEASE_TARGETS,
};
