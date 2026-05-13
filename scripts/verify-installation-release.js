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
  RELEASE_TARGETS,
  standaloneArchiveName,
} from './build-standalone-release.js';
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

// This import-time computation intentionally asserts release/package target
// consistency via standaloneArchiveName(); keep RELEASE_TARGETS backed by TARGETS.
const EXPECTED_STANDALONE_ARCHIVE_NAMES = RELEASE_TARGETS.map(
  ({ qwenTarget }) => standaloneArchiveName(qwenTarget),
);
// Release artifacts that the installer chain expects in a GitHub Release.
// Hosted installer scripts (install-qwen.sh / install-qwen.bat /
// install-qwen.ps1) are served from a separate hosted endpoint and are
// intentionally not part of this set; they have their own staging path in
// `package:hosted-installation`.
const EXPECTED_RELEASE_ASSET_NAMES = [
  ...EXPECTED_STANDALONE_ARCHIVE_NAMES,
  'SHA256SUMS',
];

const CLI_OPTIONS = {
  '--help': { name: 'help', type: 'boolean' },
  '-h': { name: 'help', type: 'boolean' },
  '--dir': { name: 'dir' },
  '--base-url': { name: 'baseUrl' },
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
    dir: undefined,
    baseUrl: undefined,
  });
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
  const results = await Promise.allSettled(
    EXPECTED_STANDALONE_ARCHIVE_NAMES.map(async (assetName) => {
      await assertRemoteAssetAvailable(
        new URL(assetName, normalizedBaseUrl).toString(),
        fetchImpl,
      );
      return assetName;
    }),
  );
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          {
            assetName: EXPECTED_STANDALONE_ARCHIVE_NAMES[index],
            reason: formatErrorReason(result.reason),
          },
        ]
      : [],
  );

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
  let response = await fetchImpl(url, { method: 'HEAD' });
  if (response.ok) {
    await response.body?.cancel?.();
    return;
  }
  await response.body?.cancel?.();

  // Some object-storage hosts disable HEAD; fall back to a 1-byte ranged GET
  // so the verifier can still confirm reachability without downloading the
  // full archive.
  response = await fetchImpl(url, {
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
  const response = await fetchImpl(url);
  if (!response.ok) {
    fail(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

function normalizeHttpsBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail(`--base-url must be a valid URL: ${baseUrl}`);
  }
  // Real release URLs are always HTTPS. Tests use injected fetchImpl, so
  // they don't need a real protocol. Rejecting non-https early prevents an
  // operator from accidentally pointing the verifier at a plain-http mirror.
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
