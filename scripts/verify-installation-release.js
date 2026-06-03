#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

// Mirrors `build-standalone-release.js`'s archive-name derivation. The two
// must stay aligned: any new platform/extension landing in RELEASE_TARGETS
// has to be reflected here (and there) before a new target ships, otherwise
// the verify and the build will disagree on expected filenames.
function standaloneArchiveNamesFromReleaseTargets(releaseTargets) {
  return releaseTargets.map(
    ({ qwenTarget }) =>
      `qwen-code-${qwenTarget}.${qwenTarget === 'win-x64' ? 'zip' : 'tar.gz'}`,
  );
}

const ARG_DEFS = {
  '--dir': { key: 'dir', type: 'value' },
  '--base-url': { key: 'baseUrl', type: 'value' },
  '--list-release-asset-paths': {
    key: 'listReleaseAssetPaths',
    type: 'flag',
  },
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
  if (args.listReleaseAssetPaths && args.baseUrl) {
    fail('Pass --list-release-asset-paths with --dir, not --base-url.');
  }
  if (args.listReleaseAssetPaths) {
    const dir = path.resolve(
      args.dir || path.join(rootDir, 'dist', 'standalone'),
    );
    await verifyReleaseDirectory(dir, { silent: true });
    for (const assetPath of releaseAssetPaths(dir)) {
      console.log(assetPath);
    }
    return;
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
archives with matching SHA256SUMS entries. For a release URL, downloads
SHA256SUMS and the expected archives, then verifies each archive hash.

Options:
  --dir PATH         Verify a local release directory. Defaults to dist/standalone.
  --base-url URL     Verify a remote release URL (e.g. a GitHub release download
                     prefix). Cannot be combined with --dir.
  --list-release-asset-paths
                     Verify --dir, then print explicit asset paths for upload.
  -h, --help         Show this help message.
`);
}

async function verifyReleaseDirectory(dir, options = {}) {
  const { silent = false } = options;
  const checksums = readReleaseChecksums(dir);
  assertExpectedChecksumEntries(checksums);
  assertExpectedArchiveFiles(dir);

  for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
    const assetPath = path.join(dir, assetName);
    if (!fs.existsSync(assetPath)) {
      fail(`Missing release asset: ${assetName}`);
    }

    const actual = await sha256File(assetPath);
    const expected = checksums.get(assetName);
    if (actual !== expected) {
      fail(
        `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`,
      );
    }
  }

  if (!silent) {
    console.log(
      `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release assets in ${dir}`,
    );
  }
}

async function verifyReleaseBaseUrl(baseUrl, options = {}) {
  const { fetchImpl = fetch } = options;
  const normalizedBaseUrl = normalizeHttpsBaseUrl(baseUrl);
  const checksumUrl = new URL('SHA256SUMS', normalizedBaseUrl).toString();
  const checksums = parseSha256Sums(await fetchText(checksumUrl, fetchImpl));
  assertExpectedChecksumEntries(checksums);

  await assertRemoteAssetChecksums(normalizedBaseUrl, checksums, fetchImpl);

  console.log(
    `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release assets at ${baseUrl}`,
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

function releaseAssetPaths(dir) {
  return EXPECTED_RELEASE_ASSET_NAMES.map((assetName) =>
    path.join(dir, assetName),
  );
}

async function assertRemoteAssetChecksums(
  normalizedBaseUrl,
  checksums,
  fetchImpl,
) {
  const failures = [];
  for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
    try {
      const assetUrl = new URL(assetName, normalizedBaseUrl).toString();
      const actual = await fetchSha256(assetUrl, fetchImpl);
      const expected = checksums.get(assetName);
      if (actual !== expected) {
        fail(
          `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`,
        );
      }
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
    `Unavailable or invalid release asset(s): ${failures
      .map(({ assetName, reason }) => `${assetName} (${reason})`)
      .join('; ')}`,
  );
}

async function fetchSha256(url, fetchImpl) {
  const response = await fetchWithTimeout(fetchImpl, url);
  if (!response.ok) {
    fail(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    fail(`Downloaded response has no body: ${url}`);
  }

  const hash = crypto.createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), hash);
  return hash.digest('hex');
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
  EXPECTED_RELEASE_ASSET_NAMES,
  releaseAssetPaths,
  verifyReleaseBaseUrl,
  verifyReleaseDirectory,
};
