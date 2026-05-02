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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const EXPECTED_ARCHIVE_COUNT = 5;
const RELEASE_TARGETS = [
  {
    qwenTarget: 'darwin-arm64',
    nodeTarget: 'darwin-arm64',
    extension: 'tar.gz',
  },
  {
    qwenTarget: 'darwin-x64',
    nodeTarget: 'darwin-x64',
    extension: 'tar.gz',
  },
  {
    qwenTarget: 'linux-arm64',
    nodeTarget: 'linux-arm64',
    extension: 'tar.xz',
  },
  { qwenTarget: 'linux-x64', nodeTarget: 'linux-x64', extension: 'tar.xz' },
  { qwenTarget: 'win-x64', nodeTarget: 'win-x64', extension: 'zip' },
];

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const nodeVersion = args.nodeVersion || process.versions.node;
  const outDir = path.resolve(
    args.outDir || path.join(rootDir, 'dist', 'standalone'),
  );
  const runtimeParent = path.resolve(
    args.runtimeDir || process.env.RUNNER_TEMP || os.tmpdir(),
  );
  fs.mkdirSync(runtimeParent, { recursive: true });
  const runtimeDir = fs.mkdtempSync(
    path.join(runtimeParent, 'qwen-node-runtime-'),
  );
  const nodeDistUrl = `https://nodejs.org/dist/v${nodeVersion}`;

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const checksumsPath = path.join(runtimeDir, 'SHASUMS256.txt');
    await downloadFile(`${nodeDistUrl}/SHASUMS256.txt`, checksumsPath);
    const checksums = parseChecksums(fs.readFileSync(checksumsPath, 'utf8'));

    for (const target of RELEASE_TARGETS) {
      await packageTarget({
        ...target,
        nodeDistUrl,
        nodeVersion,
        outDir,
        releaseVersion: args.version,
        runtimeDir,
        checksums,
      });
    }

    assertStandaloneOutput(outDir);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function packageTarget({
  qwenTarget,
  nodeTarget,
  extension,
  nodeDistUrl,
  nodeVersion,
  outDir,
  releaseVersion,
  runtimeDir,
  checksums,
}) {
  const archiveName = `node-v${nodeVersion}-${nodeTarget}.${extension}`;
  const archivePath = path.join(runtimeDir, archiveName);

  await downloadFile(`${nodeDistUrl}/${archiveName}`, archivePath);
  verifyNodeArchive(archivePath, archiveName, checksums);

  const args = [
    'scripts/create-standalone-package.js',
    '--target',
    qwenTarget,
    '--node-archive',
    archivePath,
    '--out-dir',
    outDir,
  ];
  if (releaseVersion) {
    args.push('--version', releaseVersion);
  }

  execFileSync(process.execPath, args, {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

async function downloadFile(url, destination) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    fail(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
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

function verifyNodeArchive(archivePath, archiveName, checksums) {
  const expected = checksums.get(archiveName);
  if (!expected) {
    fail(`Node.js SHASUMS256.txt does not list ${archiveName}`);
  }

  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');
  if (actual !== expected) {
    fail(`Checksum verification failed for ${archiveName}`);
  }

  console.log(`Verified Node.js runtime checksum for ${archiveName}`);
}

function assertStandaloneOutput(outDir) {
  const checksumPath = path.join(outDir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`Standalone SHA256SUMS was not created at ${checksumPath}`);
  }

  const archiveNames = fs
    .readFileSync(checksumPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[0-9a-f]{64}\s+/.test(line))
    .map((line) => line.trim().split(/\s+/, 2)[1]?.replace(/^\*/, ''))
    .filter(Boolean)
    .sort();
  const expectedArchiveNames = RELEASE_TARGETS.map(
    ({ qwenTarget }) =>
      `qwen-code-${qwenTarget}.${qwenTarget === 'win-x64' ? 'zip' : 'tar.gz'}`,
  ).sort();
  const missing = expectedArchiveNames.filter(
    (archiveName) => !archiveNames.includes(archiveName),
  );
  const extra = archiveNames.filter(
    (archiveName) => !expectedArchiveNames.includes(archiveName),
  );

  if (
    archiveNames.length !== EXPECTED_ARCHIVE_COUNT ||
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
    nodeVersion: undefined,
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
      case '--node-version':
        args.nodeVersion = readOptionValue(argv, index, arg);
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
`);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
