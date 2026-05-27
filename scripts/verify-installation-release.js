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
import { TARGETS } from './create-standalone-package.js';
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
  return releaseTargets.map(({ qwenTarget }) =>
    standaloneArchiveName(qwenTarget),
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

  const unexpected = fs
    .readdirSync(dir)
    .filter((fileName) => !EXPECTED_RELEASE_ASSET_NAMES.includes(fileName))
    .sort();
  if (unexpected.length > 0) {
    fail(`Unexpected file(s) in release directory: ${unexpected.join(', ')}`);
  }

  for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
    const assetPath = path.join(dir, assetName);
    if (!fs.existsSync(assetPath)) {
      fail(`Missing release asset: ${assetName}`);
    }
    if (!fs.lstatSync(assetPath).isFile()) {
      fail(`Release asset is not a regular file: ${assetName}`);
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
  const displayBaseUrl = redactUrlForLog(normalizedBaseUrl);
  const checksumUrl = new URL('SHA256SUMS', normalizedBaseUrl).toString();
  const checksums = parseSha256Sums(await fetchText(checksumUrl, fetchImpl));
  assertExpectedChecksumEntries(checksums);

  await assertRemoteAssetChecksums(normalizedBaseUrl, checksums, fetchImpl);

  console.log(
    `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release assets at ${displayBaseUrl}`,
  );
}

function readReleaseChecksums(dir) {
  const checksumPath = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`SHA256SUMS was not found at ${checksumPath}`);
  }
  if (!fs.lstatSync(checksumPath).isFile()) {
    fail('SHA256SUMS is not a regular file');
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
    const displayBaseUrl = redactUrlForLog(normalizedBaseUrl);
    fail(
      `All ${failures.length} release asset URLs are unavailable; check --base-url: ${displayBaseUrl}`,
    );
  }
  fail(
    `Unavailable or invalid release asset(s): ${failures
      .map(({ assetName, reason }) => `${assetName} (${reason})`)
      .join('; ')}`,
  );
}

async function fetchSha256(url, fetchImpl) {
  const displayUrl = redactUrlForLog(url);
  const response = await fetchWithTimeout(fetchImpl, url);
  assertNotRedirectResponse(response, displayUrl);
  if (!response.ok) {
    fail(
      `Failed to download ${displayUrl}: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    fail(`Downloaded response has no body: ${displayUrl}`);
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
  const displayUrl = redactUrlForLog(url);
  const response = await fetchWithTimeout(fetchImpl, url);
  assertNotRedirectResponse(response, displayUrl);
  if (!response.ok) {
    fail(
      `Failed to download ${displayUrl}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

function fetchWithTimeout(fetchImpl, url, options = {}) {
  return fetchImpl(url, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  });
}

function assertNotRedirectResponse(response, displayUrl) {
  if (response.status >= 300 && response.status < 400) {
    fail(`Redirect responses are not allowed: ${displayUrl}`);
  }
}

function normalizeHttpsBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail(`--base-url must be a valid URL: ${redactUrlForLog(baseUrl)}`);
  }
  const displayBaseUrl = redactUrlForLog(parsed.toString());
  if (parsed.protocol !== 'https:') {
    fail(`--base-url must use https: ${displayBaseUrl}`);
  }
  if (isPrivateOrReservedHost(parsed.hostname)) {
    fail(`--base-url must not target a private network: ${displayBaseUrl}`);
  }
  parsed.username = '';
  parsed.password = '';
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function redactUrlForLog(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const value = String(url);
    return value.includes('@') || value.includes('?') || value.includes('#')
      ? '<redacted URL>'
      : value;
  }
}

function standaloneArchiveName(qwenTarget) {
  const targetConfig = TARGETS.get(qwenTarget);
  if (!targetConfig) {
    fail(`Unknown release target: ${qwenTarget}`);
  }
  return `qwen-code-${qwenTarget}.${targetConfig.outputExtension}`;
}

function isPrivateOrReservedHost(hostname) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!normalized) {
    return true;
  }
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }

  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  if (mappedIpv4) {
    return isPrivateOrReservedIpv4(mappedIpv4);
  }

  if (parseIpv4Octets(normalized)) {
    return isPrivateOrReservedIpv4(normalized);
  }

  if (!normalized.includes(':')) {
    return false;
  }

  return isPrivateOrReservedIpv6(normalized);
}

function parseIpv4Octets(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPrivateOrReservedIpv4(value) {
  const octets = parseIpv4Octets(value);
  if (!octets) {
    return false;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function ipv4FromMappedIpv6(value) {
  const match = value.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/i);
  if (!match) {
    return null;
  }

  const suffix = match[1];
  if (parseIpv4Octets(suffix)) {
    return suffix;
  }

  // Node.js normalizes IPv4-mapped IPv6 to hex form. Handle both 2-part
  // (::ffff:7f00:1) and 3-part (::ffff:0:7f00:1) representations.
  const hexParts = suffix.split(':');
  if (
    (hexParts.length !== 2 && hexParts.length !== 3) ||
    !hexParts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))
  ) {
    return null;
  }

  // For 3 parts like "0:7f00:1", skip the leading zero segment.
  const relevantParts =
    hexParts.length === 3
      ? hexParts[0] === '0'
        ? hexParts.slice(-2)
        : null
      : hexParts;
  if (!relevantParts) {
    return null;
  }
  const high = Number.parseInt(relevantParts[0], 16);
  const low = Number.parseInt(relevantParts[1], 16);
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function isPrivateOrReservedIpv6(value) {
  if (value === '::' || value === '::1' || value === '0:0:0:0:0:0:0:1') {
    return true;
  }

  const firstHextet = Number.parseInt(value.split(':', 1)[0] || '0', 16);
  if (Number.isNaN(firstHextet)) {
    return false;
  }

  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  );
}

export {
  EXPECTED_STANDALONE_ARCHIVE_NAMES,
  EXPECTED_RELEASE_ASSET_NAMES,
  isPrivateOrReservedHost,
  redactUrlForLog,
  releaseAssetPaths,
  verifyReleaseBaseUrl,
  verifyReleaseDirectory,
};
