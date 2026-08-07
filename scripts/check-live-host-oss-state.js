#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { fail, isMainModule, parseArgs } from './release-script-utils.js';

const MANIFEST_NAME = 'Qwen-Live-Host-manifest.json';
const REQUEST_TIMEOUT_MS = 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const command = argv[0];
  const args = parseArgs(argv.slice(1), {
    '--base-url': { key: 'baseUrl', type: 'value' },
    '--manifest': { key: 'manifestPath', type: 'value' },
    '--version': { key: 'version', type: 'value' },
  });
  if (args.help || !command) {
    printUsage();
    return;
  }
  if (!args.baseUrl || !args.manifestPath) {
    fail('--base-url and --manifest are required');
  }
  if (command === 'prefix') {
    if (!args.version) fail('--version is required for prefix checks');
    console.log(
      await checkImmutablePrefix({
        baseUrl: args.baseUrl,
        manifestPath: args.manifestPath,
        version: args.version,
      }),
    );
    return;
  }
  if (command === 'latest') {
    console.log(
      await shouldUpdateLatest({
        baseUrl: args.baseUrl,
        manifestPath: args.manifestPath,
      }),
    );
    return;
  }
  fail(`Unknown command: ${command}`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/check-live-host-oss-state.js prefix --base-url URL --version X.Y.Z --manifest PATH
  node scripts/check-live-host-oss-state.js latest --base-url URL --manifest PATH
`);
}

async function fetchManifest(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Unable to read OSS manifest at ${url}.`, { cause: error });
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `OSS manifest request failed with HTTP ${response.status} at ${url}.`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function checkImmutablePrefix({
  baseUrl,
  version,
  manifestPath,
  fetchImpl = fetch,
}) {
  if (!VERSION_PATTERN.test(version)) fail(`Invalid version: ${version}`);
  const localManifest = await readFile(manifestPath);
  const url = `${baseUrl.replace(/\/+$/, '')}/live-host/v${version}/${MANIFEST_NAME}`;
  const remoteManifest = await fetchManifest(url, fetchImpl);
  if (!remoteManifest) return false;
  if (!localManifest.equals(remoteManifest)) {
    fail('The immutable OSS version manifest has different contents');
  }
  return true;
}

async function shouldUpdateLatest({
  baseUrl,
  manifestPath,
  fetchImpl = fetch,
}) {
  const localManifest = await readFile(manifestPath);
  const nextVersion = readVersion(localManifest, 'local');
  const url = `${baseUrl.replace(/\/+$/, '')}/live-host/latest/${MANIFEST_NAME}`;
  const currentManifest = await fetchManifest(url, fetchImpl);
  if (!currentManifest) return true;

  const currentVersion = readVersion(currentManifest, 'current OSS latest');
  const comparison = compareVersions(nextVersion, currentVersion);
  if (comparison < 0) return false;
  if (comparison === 0) {
    if (!localManifest.equals(currentManifest)) {
      fail(
        'The OSS latest manifest has different contents for the same version',
      );
    }
    return false;
  }
  return true;
}

function readVersion(bytes, source) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`The ${source} manifest is not valid JSON`);
  }
  if (!VERSION_PATTERN.test(manifest?.version)) {
    fail(`The ${source} manifest version is invalid`);
  }
  return manifest.version;
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

export { checkImmutablePrefix, shouldUpdateLatest };
