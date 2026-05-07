#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fail,
  isMainModule,
  parseCliArgs,
  parseSha256Sums,
  sha256File,
} from './release-script-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const HOSTED_INSTALLATION_ASSETS = [
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-with-source.sh'],
    output: 'install-qwen.sh',
    mode: 0o755,
  },
  {
    sourcePath: ['scripts', 'installation', 'install-qwen-with-source.bat'],
    output: 'install-qwen.bat',
  },
];

const CLI_OPTIONS = {
  '--help': { name: 'help', type: 'boolean' },
  '-h': { name: 'help', type: 'boolean' },
  '--out-dir': { name: 'outDir' },
};

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), CLI_OPTIONS, {
    help: false,
    outDir: undefined,
  });
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

async function buildHostedInstallationAssets(outDir, options = {}) {
  const root = options.root || rootDir;
  fs.mkdirSync(outDir, { recursive: true });

  for (const asset of HOSTED_INSTALLATION_ASSETS) {
    const source = path.join(root, ...asset.sourcePath);
    if (!fs.existsSync(source)) {
      fail(`Hosted installer source asset not found: ${source}`);
    }
    assertHostedInstallerSource(source, asset.output);

    const destination = path.join(outDir, asset.output);
    fs.copyFileSync(source, destination);
    if (asset.mode !== undefined) {
      fs.chmodSync(destination, asset.mode);
    }
  }

  await writeHostedSha256Sums(outDir);
  await assertHostedInstallationAssetChecksums(outDir);
}

function assertHostedInstallerSource(source, output) {
  const contents = fs.readFileSync(source, 'utf8');
  if (!contents.includes('--version')) {
    fail(`${output} must support --version for pinned hosted installs`);
  }

  if (
    output.endsWith('.sh') &&
    !contents.includes('VERSION="${QWEN_INSTALL_VERSION:-latest}"')
  ) {
    fail(`${output} must default to latest for the hosted entrypoint`);
  }

  if (
    output.endsWith('.bat') &&
    (!contents.includes('set "VERSION=latest"') ||
      !contents.includes(
        'if defined QWEN_INSTALL_VERSION set "VERSION=!QWEN_INSTALL_VERSION!"',
      ))
  ) {
    fail(`${output} must default to latest for the hosted entrypoint`);
  }
}

async function writeHostedSha256Sums(outDir) {
  const lines = [];
  for (const { output } of HOSTED_INSTALLATION_ASSETS) {
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

export {
  HOSTED_INSTALLATION_ASSETS,
  assertHostedInstallationAssetChecksums,
  buildHostedInstallationAssets,
};
