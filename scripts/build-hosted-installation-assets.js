#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const HOSTED_INSTALLATION_ASSETS = [
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-standalone.sh'],
    output: 'install-qwen-standalone.sh',
    mode: 0o755,
  },
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-standalone.bat'],
    output: 'install-qwen-standalone.bat',
    lineEndings: 'crlf',
  },
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-standalone.ps1'],
    output: 'install-qwen-standalone.ps1',
  },
];
const HOSTED_INSTALLATION_ASSET_NAMES = HOSTED_INSTALLATION_ASSETS.map(
  ({ output }) => output,
);
const HOSTED_INSTALLER_BEHAVIOR_PATTERNS = {
  'install-qwen-standalone.sh': [
    {
      name: 'QWEN_INSTALL_VERSION',
      pattern: /QWEN_INSTALL_VERSION/,
    },
    {
      name: '--version parser',
      pattern: /--version\)|--version=\*\)/,
    },
  ],
  'install-qwen-standalone.bat': [
    {
      name: 'QWEN_INSTALL_VERSION',
      pattern: /QWEN_INSTALL_VERSION/,
    },
    {
      name: '--version parser',
      pattern: /ARG_KEY!"=="--version"|"%~1"=="--version"/,
    },
  ],
  'install-qwen-standalone.ps1': [
    {
      name: 'argument forwarding',
      pattern: /& \$qwenInstallerPath @args/,
    },
    {
      name: 'QWEN_INSTALL_VERSION documentation',
      pattern: /QWEN_INSTALL_VERSION/,
    },
  ],
};
// Narrow regexes that pin the default-version assignment to `latest`.
// Substring matching alone would let the word "latest" leak in via comments
// or help text even when the actual default has been changed. The patterns
// allow whitespace flexibility but require the literal default value.
const HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS = {
  'install-qwen-standalone.sh':
    /VERSION\s*=\s*"\$\{QWEN_INSTALL_VERSION:-latest\}"/,
  'install-qwen-standalone.bat': /set\s+"VERSION=latest"/,
};
// SHA256SUMS is allowed in an existing output directory because every staging
// run rewrites it from scratch after copying the hosted installer assets.
const HOSTED_INSTALLATION_OUTPUT_NAMES = new Set([
  ...HOSTED_INSTALLATION_ASSET_NAMES,
  'SHA256SUMS',
]);

if (isMainModule(import.meta.url)) {
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

  const outDir = path.resolve(
    args.outDir || path.join(rootDir, 'dist', 'installation'),
  );
  await buildHostedInstallationAssets(outDir);
}

function printUsage() {
  console.log(`Usage: npm run package:hosted-installation -- [options]

Stages hosted installer entrypoint assets for CDN/OSS upload.

Options:
  --out-dir PATH        Output directory. Defaults to dist/installation.
  -h, --help            Show this help message.
`);
}

function parseArgs(argv) {
  const args = {
    help: false,
    outDir: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--out-dir':
        args.outDir = readOptionValue(argv, index, arg);
        index += 1;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return args;
}

async function buildHostedInstallationAssets(outDir, options = {}) {
  const root = options.root || rootDir;
  fs.mkdirSync(outDir, { recursive: true });
  assertNoUnexpectedHostedFiles(outDir);

  for (const asset of HOSTED_INSTALLATION_ASSETS) {
    const source = path.join(root, ...asset.sourcePath);
    if (!fs.existsSync(source)) {
      fail(`Hosted installer source asset not found: ${source}`);
    }
    assertHostedInstallerSource(source, asset.output);

    const destination = path.join(outDir, asset.output);
    copyHostedInstallationAsset(source, destination, asset);
    if (asset.mode !== undefined) {
      fs.chmodSync(destination, asset.mode);
    }
  }

  await writeHostedSha256Sums(outDir);
  await assertHostedInstallationAssetChecksums(outDir);
}

function assertNoUnexpectedHostedFiles(outDir) {
  const unexpected = fs
    .readdirSync(outDir)
    .filter((entryName) => !HOSTED_INSTALLATION_OUTPUT_NAMES.has(entryName))
    .sort();

  if (unexpected.length > 0) {
    fail(`Unexpected hosted installer asset: ${unexpected.join(', ')}`);
  }
}

function copyHostedInstallationAsset(source, destination, asset) {
  if (asset.lineEndings === 'crlf') {
    const contents = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(destination, contents.replace(/\r?\n/g, '\r\n'));
    return;
  }

  fs.copyFileSync(source, destination);
}

function assertHostedInstallerSource(source, output) {
  const contents = fs.readFileSync(source, 'utf8');
  const missing = (HOSTED_INSTALLER_BEHAVIOR_PATTERNS[output] || [])
    .filter(({ pattern }) => !pattern.test(contents))
    .map(({ name }) => name);
  if (missing.length > 0) {
    fail(
      `${output} is missing hosted installer behavior: ${missing.join(', ')}`,
    );
  }

  const defaultPattern = HOSTED_INSTALLER_DEFAULT_VERSION_PATTERNS[output];
  if (defaultPattern && !defaultPattern.test(contents)) {
    fail(
      `${output} default install version must be 'latest' for the hosted entrypoint`,
    );
  }
}

async function writeHostedSha256Sums(outDir) {
  const lines = [];
  const assets = [...HOSTED_INSTALLATION_ASSETS].sort((left, right) =>
    left.output.localeCompare(right.output),
  );
  for (const { output } of assets) {
    const hash = await sha256File(path.join(outDir, output));
    lines.push(`${hash}  ${output}`);
  }
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

async function assertHostedInstallationAssetChecksums(outDir) {
  const checksumsPath = path.join(outDir, 'SHA256SUMS');
  const checksums = parseSha256Sums(fs.readFileSync(checksumsPath, 'utf8'));

  for (const { output } of HOSTED_INSTALLATION_ASSETS) {
    const expected = checksums.get(output);
    if (!expected) {
      fail(`Missing checksum entry for ${output}`);
    }

    const actual = await sha256File(path.join(outDir, output));
    if (actual !== expected) {
      fail(`Checksum verification failed for ${output}`);
    }
  }
}

function isMainModule(importMetaUrl) {
  const filename = fileURLToPath(importMetaUrl);
  return process.argv[1] && path.resolve(process.argv[1]) === filename;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    fail(`${optionName} requires a value`);
  }
  return value;
}

function parseSha256Sums(content) {
  const checksums = new Map();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) {
      fail(`Malformed SHA256SUMS line ${index + 1}: ${trimmed}`);
    }
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function fail(message) {
  throw new Error(`ERROR: ${message}`);
}

export {
  HOSTED_INSTALLATION_ASSETS,
  HOSTED_INSTALLATION_ASSET_NAMES,
  assertHostedInstallationAssetChecksums,
  buildHostedInstallationAssets,
};
