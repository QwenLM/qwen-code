#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { writeSha256Sums } from './create-standalone-package.js';
import { INSTALLATION_ASSETS } from './release-asset-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

if (isMainModule()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
    } else {
      await buildInstallationAssets(
        path.resolve(args.outDir || path.join(rootDir, 'dist', 'standalone')),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

async function buildInstallationAssets(outDir, options = {}) {
  const { assets = INSTALLATION_ASSETS, root = rootDir } = options;
  fs.mkdirSync(outDir, { recursive: true });

  for (const asset of assets) {
    const source = path.join(root, ...asset.sourcePath);
    if (!fs.existsSync(source)) {
      fail(`Installation source asset not found: ${source}`);
    }

    const destination = path.join(outDir, asset.output);
    fs.copyFileSync(source, destination);
    if (asset.mode !== undefined && process.platform !== 'win32') {
      fs.chmodSync(destination, asset.mode);
    }
  }

  await writeSha256Sums(outDir);
  await assertInstallationAssetChecksums(outDir, assets);
}

async function assertInstallationAssetChecksums(
  outDir,
  assets = INSTALLATION_ASSETS,
) {
  const checksumPath = path.join(outDir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`SHA256SUMS was not created at ${checksumPath}`);
  }

  const checksums = parseSha256Sums(fs.readFileSync(checksumPath, 'utf8'));
  for (const { output } of assets) {
    const expected = checksums.get(output);
    if (!expected) {
      fail(`Checksum entry for ${output} not found.`);
    }

    const actual = await sha256File(path.join(outDir, output));
    if (actual !== expected) {
      fail(`Checksum verification failed for ${output}.`);
    }
  }
}

function parseSha256Sums(content) {
  const checksums = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
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
  npm run package:installation-assets -- [OPTIONS]

Options:
  --out-dir PATH  Output directory. Defaults to dist/standalone.
`);
}

function fail(message) {
  throw new Error(`ERROR: ${message}`);
}

export {
  assertInstallationAssetChecksums,
  buildInstallationAssets,
  INSTALLATION_ASSETS,
};
