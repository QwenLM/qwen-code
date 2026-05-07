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
import { INSTALLATION_ASSETS } from './release-asset-config.js';
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

const CLI_OPTIONS = {
  '--help': { name: 'help', type: 'boolean' },
  '-h': { name: 'help', type: 'boolean' },
  '--out-dir': { name: 'outDir' },
  '--version': { name: 'version', validate: validateReleaseVersion },
};

if (isMainModule(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), CLI_OPTIONS, {
      help: false,
      outDir: undefined,
      version: undefined,
    });
    if (args.help) {
      printUsage();
    } else {
      await buildInstallationAssets(
        path.resolve(args.outDir || path.join(rootDir, 'dist', 'standalone')),
        {
          version: args.version,
        },
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function buildInstallationAssets(outDir, options = {}) {
  const { assets = INSTALLATION_ASSETS, root = rootDir, version } = options;
  fs.mkdirSync(outDir, { recursive: true });

  for (const asset of assets) {
    const source = path.join(root, ...asset.sourcePath);
    if (!fs.existsSync(source)) {
      fail(`Installation source asset not found: ${source}`);
    }

    const destination = path.join(outDir, asset.output);
    const contents = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(
      destination,
      version ? stampInstallerVersion(contents, asset, version) : contents,
    );
    if (asset.mode !== undefined && process.platform !== 'win32') {
      fs.chmodSync(destination, asset.mode);
    }
  }

  await writeSha256Sums(outDir);
  await assertInstallationAssetChecksums(outDir, assets);
}

function stampInstallerVersion(contents, asset, version) {
  validateReleaseVersion(version);

  const sourceName = asset.sourcePath.at(-1);
  if (sourceName.endsWith('.sh')) {
    const stampedDefault = replaceRequired(
      contents,
      'VERSION="${QWEN_INSTALL_VERSION:-latest}"',
      `VERSION="\${QWEN_INSTALL_VERSION:-${version}}"`,
      asset.output,
    );
    return stampVersionHelpText(stampedDefault, asset.output, version);
  }

  if (sourceName.endsWith('.bat')) {
    const stampedDefault = replaceRequired(
      contents,
      'set "VERSION=latest"',
      `set "VERSION=${version}"`,
      asset.output,
    );
    return stampVersionHelpText(stampedDefault, asset.output, version);
  }

  return contents;
}

function replaceRequired(contents, search, replacement, output) {
  if (!contents.includes(search)) {
    fail(`Unable to stamp release version in ${output}`);
  }
  // Use replaceAll so a future installer that adds a duplicate placeholder
  // doesn't silently leave the trailing occurrence as `latest`.
  return contents.replaceAll(search, replacement);
}

function stampVersionHelpText(contents, output, version) {
  return replaceRequired(
    contents,
    'Standalone release version. Defaults to latest.',
    `Standalone release version. Defaults to ${version}.`,
    output,
  );
}

function validateReleaseVersion(version) {
  if (/^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$/.test(version)) {
    return;
  }
  fail('--version must be a semver string');
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

function printUsage() {
  console.log(`
Usage:
  npm run package:installation-assets -- [OPTIONS]

Options:
  --out-dir PATH  Output directory. Defaults to dist/standalone.
  --version VERSION
                  Stamp release installers so their default version is VERSION.
`);
}

export { assertInstallationAssetChecksums, buildInstallationAssets };
