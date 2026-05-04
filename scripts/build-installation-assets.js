#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSha256Sums } from './create-standalone-package.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const INSTALLATION_ASSETS = [
  {
    source: path.join(
      rootDir,
      'scripts',
      'installation',
      'install-qwen-with-source.sh',
    ),
    output: 'install-qwen.sh',
    mode: 0o755,
  },
  {
    source: path.join(
      rootDir,
      'scripts',
      'installation',
      'install-qwen-with-source.bat',
    ),
    output: 'install-qwen.bat',
  },
];

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

async function buildInstallationAssets(outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  for (const asset of INSTALLATION_ASSETS) {
    if (!fs.existsSync(asset.source)) {
      fail(`Installation source asset not found: ${asset.source}`);
    }

    const destination = path.join(outDir, asset.output);
    fs.copyFileSync(asset.source, destination);
    if (asset.mode !== undefined && process.platform !== 'win32') {
      fs.chmodSync(destination, asset.mode);
    }
  }

  await writeSha256Sums(outDir);
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

export { buildInstallationAssets, INSTALLATION_ASSETS };
