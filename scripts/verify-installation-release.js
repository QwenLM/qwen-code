#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TARGETS } from './build-standalone-release.js';
import {
  fail,
  isMainModule,
  parseArgs,
  parseSha256Sums,
  sha256File,
} from './release-script-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const EXPECTED_STANDALONE_ARCHIVE_NAMES =
  standaloneArchiveNamesFromReleaseTargets(RELEASE_TARGETS);
// Release artifacts that the installer chain expects in a GitHub Release.
// Hosted installer scripts are served from a separate endpoint and are
// intentionally not part of this set; they have their own staging path in
// `package:hosted-installation`.
const EXPECTED_RELEASE_ASSET_NAMES = [
  ...EXPECTED_STANDALONE_ARCHIVE_NAMES,
  'SHA256SUMS',
];
const REMOTE_FETCH_TIMEOUT_MS = 30_000;

function standaloneArchiveNamesFromReleaseTargets(releaseTargets) {
  return releaseTargets.map(
    ({ qwenTarget }) =>
      `qwen-code-${qwenTarget}.${qwenTarget.startsWith('win-') ? 'zip' : 'tar.gz'}`,
  );
}

const ARG_DEFS = {
  '--dir': { key: 'dir', type: 'value' },
  '--base-url': { key: 'baseUrl', type: 'value' },
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
  const args = parseArgs(process.argv.slice(2), ARG_DEFS);
  if (args.help) {
    printUsage();
    return;
  }
  if (args.dir && args.baseUrl) {
    fail('Pass --dir or --base-url, not both.');
  }
  if (args.baseUrl) {
    await verifyReleaseBaseUrl(args.baseUrl);
    return;
  }
  await verifyReleaseDirectory(
    path.resolve(args.dir || path.join(rootDir, 'dist', 'standalone')),
  );
}

function printUsage() {
  console.log(`Usage: npm run verify:installation-release -- [options]

Verifies that an installation release directory contains the expected standalone
archives with matching SHA256SUMS entries. For a release URL, verifies that
SHA256SUMS is reachable, lists the expected archives, and that each archive URL
is reachable without downloading the full archive.

Options:
  --dir PATH         Verify a local release directory. Defaults to dist/standalone.
  --base-url URL     Verify a remote release URL (e.g. a GitHub release download
                     prefix). Cannot be combined with --dir.
  -h, --help         Show this help message.
`);
}

async function verifyReleaseDirectory(dir) {
  const checksums = readReleaseChecksums(dir);
  assertExpectedChecksumEntries(checksums);
  assertExpectedArchiveFiles(dir);

  for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
    const assetPath = path.join(dir, assetName);
    if (!fs.existsSync(assetPath)) {
      fail(`Missing release asset: ${assetName}`);
    }

    const actual = await sha256File(assetPath);
    if (actual !== checksums.get(assetName)) {
      fail(`Checksum verification failed for ${assetName}`);
    }
  }

  console.log(
    `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release assets in ${dir}`,
  );
}

async function verifyReleaseBaseUrl(baseUrl, options = {}) {
  const { fetchImpl = fetch } = options;
  const normalizedBaseUrl = normalizeHttpsBaseUrl(baseUrl);
  const checksumUrl = new URL('SHA256SUMS', normalizedBaseUrl).toString();
  const checksums = parseSha256Sums(await fetchText(checksumUrl, fetchImpl));
  assertExpectedChecksumEntries(checksums);
  console.warn(
    'WARNING: Remote release verification checks URL reachability only; it does not download archive bodies or verify archive hashes. Run --dir against downloaded assets for checksum verification.',
  );

  await assertRemoteAssetsAvailable(normalizedBaseUrl, fetchImpl);

  console.log(
    `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release asset URLs at ${baseUrl}`,
  );
}

function readReleaseChecksums(dir) {
  const checksumPath = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`SHA256SUMS was not found at ${checksumPath}`);
  }

  return parseSha256Sums(fs.readFileSync(checksumPath, 'utf8'));
}

function assertExpectedChecksumEntries(checksums) {
  const expected = new Set(EXPECTED_STANDALONE_ARCHIVE_NAMES);
  const missing = EXPECTED_STANDALONE_ARCHIVE_NAMES.filter(
    (assetName) => !checksums.has(assetName),
  );
  const extra = Array.from(checksums.keys()).filter(
    (assetName) => !expected.has(assetName),
  );

  if (missing.length > 0) {
    fail(`Missing release asset checksum: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    fail(`Unexpected release asset checksum: ${extra.join(', ')}`);
  }
}

function assertExpectedArchiveFiles(dir) {
  const expected = new Set(EXPECTED_RELEASE_ASSET_NAMES);
  const extra = fs
    .readdirSync(dir)
    .filter((assetName) => !expected.has(assetName))
    .sort();

  if (extra.length > 0) {
    fail(`Unexpected release asset: ${extra.join(', ')}`);
  }
}

async function assertRemoteAssetsAvailable(normalizedBaseUrl, fetchImpl) {
  const failures = [];
  for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
    try {
      await assertRemoteAssetAvailable(
        new URL(assetName, normalizedBaseUrl).toString(),
        fetchImpl,
      );
    } catch (reason) {
      failures.push({
        assetName,
        reason: formatErrorReason(reason),
      });
    }
  }

  if (failures.length === 0) {
    return;
  }
  if (failures.length === EXPECTED_STANDALONE_ARCHIVE_NAMES.length) {
    fail(
      `All ${failures.length} release asset URLs are unavailable; check --base-url: ${normalizedBaseUrl}`,
    );
  }
  fail(
    `Unavailable release asset URL(s): ${failures
      .map(({ assetName, reason }) => `${assetName} (${reason})`)
      .join('; ')}`,
  );
}

async function assertRemoteAssetAvailable(url, fetchImpl) {
  let response = await fetchWithTimeout(fetchImpl, url, { method: 'HEAD' });
  if (response.ok) {
    await response.body?.cancel?.();
    return;
  }
  await response.body?.cancel?.();

  // Some object-storage hosts disable HEAD; fall back to a 1-byte ranged GET
  // so the verifier can confirm reachability without downloading the archive.
  response = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      Range: 'bytes=0-0',
    },
  });
  if (!response.ok) {
    fail(`Release asset URL is not available: ${url}`);
  }
  await response.body?.cancel?.();
}

function formatErrorReason(reason) {
  if (reason instanceof Error) {
    return reason.message.replace(/^ERROR:\s*/, '');
  }
  return String(reason);
}

async function fetchText(url, fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, url);
  if (!response.ok) {
    fail(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

function fetchWithTimeout(fetchImpl, url, options = {}) {
  return fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  });
}

function normalizeHttpsBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail(`--base-url must be a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    fail(`--base-url must use https: ${baseUrl}`);
  }
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

export {
  EXPECTED_STANDALONE_ARCHIVE_NAMES,
  verifyReleaseBaseUrl,
  verifyReleaseDirectory,
};
