/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manifest fetching, file downloading, and SHA256 verification.
 *
 * Aligned with Go source:
 *   - cmd/update/common.go: FetchManifest(), VerifySHA256()
 *   - cmd/update/curlbash_updater.go: HttpDownload()
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BRAND_FIXED_CLI_BIN, runLogger } from '@qwen-code/core';
import { valid as isValidSemver } from 'semver';

import type { ManifestJSON, ManifestFile } from './updateTypes.js';
import { withErrorContext } from './updateErrors.js';
import {
  MANIFEST_FETCH_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_STALL_TIMEOUT_MS,
  DOWNLOAD_MAX_RETRIES,
  LATEST_VERSION_FILENAME,
} from './updateTypes.js';

const USER_AGENT = `${BRAND_FIXED_CLI_BIN}-updater`;

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a download stalls (no data received within the stall timeout).
 */
export class ErrDownloadStalled extends Error {
  constructor(url: string, stallSeconds: number) {
    super(
      `Download stalled: no data received for ${stallSeconds}s from ${url}`,
    );
    this.name = 'ErrDownloadStalled';
  }
}

class ManifestFetchError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    url: string,
  ) {
    super(`Manifest fetch failed: ${status} ${statusText} [url: ${url}]`);
    this.name = 'ManifestFetchError';
  }
}

const PROXY_ENV_NAMES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
];

function proxyEnvSummary(): string {
  const set = PROXY_ENV_NAMES.filter((name) => process.env[name]);
  return set.length ? `proxy env: ${set.join(', ')}` : 'no proxy env set';
}

// Core's network-error-classifier holds a similar list; it is not exported.
const TLS_CERT_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Append URL / timeout context to bare fetch and socket errors so error
 * messages are self-contained. Certificate errors also record which proxy or CA
 * env vars are set (names only, never values) — matched on the errno code as
 * well as the message, because OpenSSL's numeric form ("error:0A000086") and
 * localized OS text carry no English keyword.
 */
export function annotateNetworkError(
  error: unknown,
  url: string,
  timeoutMs?: number,
): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (base.message.includes(url)) return base;

  const parts = [`url: ${url}`];
  if (timeoutMs) parts.push(`timeout: ${timeoutMs}ms`);

  const code = (base as { code?: unknown }).code;
  const certCode =
    typeof code === 'string' &&
    (TLS_CERT_ERROR_CODES.has(code) || code.startsWith('ERR_CERT_'));
  if (
    certCode ||
    /certificate|self[- ]signed|unable to verify|error:0a[0-9a-f]{6}/i.test(
      base.message,
    )
  ) {
    parts.push(proxyEnvSummary());
  }

  return withErrorContext(base, parts.join(', '));
}

// ---------------------------------------------------------------------------
// HTTPS enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce that the URL uses HTTPS.
 * Throws for plain HTTP URLs, except localhost/127.0.0.1 for local dev.
 */
export function enforceHTTPS(url: string): void {
  const lower = url.toLowerCase();
  if (
    lower.startsWith('http://') &&
    !lower.startsWith('http://localhost') &&
    !lower.startsWith('http://127.0.0.1')
  ) {
    throw new Error(`HTTPS required: refusing plaintext URL ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is retryable (stall / network).
 * HTTP 4xx errors are NOT retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ErrDownloadStalled) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network errors are retryable
    if (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('epipe') ||
      msg.includes('socket hang up')
    )
      return true;
    // HTTP 4xx are NOT retryable
    if (msg.includes('http 4') || msg.includes('status 4')) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OS / Arch mapping
// ---------------------------------------------------------------------------

/**
 * Map Node.js `process.platform` to manifest OS values.
 */
const OS_MAP: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};

/**
 * Map Node.js `process.arch` to manifest arch values.
 * Also handles common aliases seen in Go-sourced manifests.
 */
const ARCH_MAP: Record<string, string> = {
  arm64: 'arm64',
  x64: 'x64',
  // Aliases (Go / Rust conventions)
  aarch64: 'arm64',
  x86_64: 'x64',
  amd64: 'x64',
};

// Source of truth: scripts/build-config.json → windows.bunMinBuild
// A test in __tests__/manifest.test.ts asserts this stays in sync.
const WINDOWS_BUN_MIN_BUILD = 17763;
const WINDOWS_AVX2_FEATURE_ID = 40;
const WINDOWS_AVX2_CHECK_TIMEOUT_MS = 3000;

const WINDOWS_AVX2_POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $signature = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=false)] public static extern bool IsProcessorFeaturePresent(uint ProcessorFeature);'
  if (-not ('CliProcessorFeature.ProcessorFeature' -as [type])) {
    Add-Type -Namespace CliProcessorFeature -Name ProcessorFeature -MemberDefinition $signature -ErrorAction Stop
  }
  if ([CliProcessorFeature.ProcessorFeature]::IsProcessorFeaturePresent(${WINDOWS_AVX2_FEATURE_ID})) { 'true' } else { 'false' }
} catch {
  'unknown'
}
`.trim();

export function getWindowsBuildNumber(release = osRelease()): number | null {
  const parts = release.split('.');
  const build = Number(parts[2]);
  return Number.isFinite(build) && build > 0 ? build : null;
}

export function needsNodeSEA(
  platform: NodeJS.Platform | string = process.platform,
  windowsBuild: number | null = getWindowsBuildNumber(),
): boolean {
  if (platform !== 'win32') return false;
  return windowsBuild !== null && windowsBuild < WINDOWS_BUN_MIN_BUILD;
}

function isLegacyWindowsFile(file: ManifestFile): boolean {
  return file.variant === 'legacy' || file.runtime === 'node-sea';
}

function isWindowsBuildCompatible(
  file: ManifestFile,
  windowsBuild: number | null,
  enforceMaxBuild = true,
): boolean {
  if (file.os.toLowerCase() !== 'windows' || windowsBuild === null) {
    return true;
  }
  if (
    typeof file.min_windows_build === 'number' &&
    windowsBuild < file.min_windows_build
  ) {
    return false;
  }
  if (
    enforceMaxBuild &&
    typeof file.max_windows_build === 'number' &&
    windowsBuild > file.max_windows_build
  ) {
    return false;
  }
  return true;
}

export function parseWindowsAvx2Support(output: string): boolean | null {
  const lastLine = output.trim().split(/\r?\n/).pop()?.trim().toLowerCase();
  if (lastLine === 'true') return true;
  if (lastLine === 'false') return false;
  return null;
}

// ---------------------------------------------------------------------------
// CPU feature detection
// ---------------------------------------------------------------------------

export const BUN_BASELINE_X64_REQUIRED_CPU_FLAGS = [
  'sse4_2',
  'popcnt',
] as const;

export const BUN_OPTIMIZED_X64_REQUIRED_CPU_FLAGS = [
  ...BUN_BASELINE_X64_REQUIRED_CPU_FLAGS,
  'avx',
  'avx2',
  'bmi1',
  'bmi2',
  'fma',
] as const;

export function parseLinuxCpuFlags(cpuinfo: string): Set<string> {
  const match = cpuinfo.match(/^flags\s*:\s*(.*)$/im);
  if (!match) return new Set();
  return new Set(match[1].toLowerCase().trim().split(/\s+/).filter(Boolean));
}

function hasRequiredLinuxCpuFlags(
  cpuinfo: string,
  requiredFlags: readonly string[],
): boolean {
  const flags = parseLinuxCpuFlags(cpuinfo);
  return requiredFlags.every((flag) => flags.has(flag));
}

export function linuxCpuSupportsBunBaselineX64(cpuinfo: string): boolean {
  return hasRequiredLinuxCpuFlags(cpuinfo, BUN_BASELINE_X64_REQUIRED_CPU_FLAGS);
}

export function linuxCpuSupportsBunOptimizedX64(cpuinfo: string): boolean {
  return hasRequiredLinuxCpuFlags(
    cpuinfo,
    BUN_OPTIMIZED_X64_REQUIRED_CPU_FLAGS,
  );
}

/**
 * Check whether the current Linux x64 host satisfies Bun's optimized x64
 * profile. Bun documents this target as Haswell/Excavator-class; in practice
 * an AVX2-only gate is not sufficient because the optimized binary also uses
 * BMI/FMA instructions.
 */
let _hasBunOptimizedX64Cpu: boolean | null = null;
export function hasBunOptimizedX64Cpu(): boolean {
  if (_hasBunOptimizedX64Cpu !== null) return _hasBunOptimizedX64Cpu;
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    _hasBunOptimizedX64Cpu = true;
    return true;
  }
  try {
    const cpuinfo = readFileSync('/proc/cpuinfo', 'utf-8');
    _hasBunOptimizedX64Cpu = linuxCpuSupportsBunOptimizedX64(cpuinfo);
  } catch {
    _hasBunOptimizedX64Cpu = false;
  }
  return _hasBunOptimizedX64Cpu;
}

/**
 * Check if the CPU supports AVX2 instructions by reading /proc/cpuinfo.
 * Binary selection uses hasBunOptimizedX64Cpu() instead; this probe stays
 * available for install diagnostics.
 */
let _hasAVX2: boolean | null = null;
export function hasAVX2(): boolean {
  if (_hasAVX2 !== null) return _hasAVX2;
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    _hasAVX2 = true;
    return true;
  }
  try {
    const cpuinfo = readFileSync('/proc/cpuinfo', 'utf-8');
    _hasAVX2 = hasRequiredLinuxCpuFlags(cpuinfo, ['avx2']);
  } catch {
    _hasAVX2 = true;
  }
  return _hasAVX2;
}

/**
 * Check Windows AVX2 runtime availability with the OS API.
 *
 * IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE = 40) accounts for
 * both CPU support and Windows enabling the required processor state.
 * Returns null when the OS API cannot be queried.
 */
let _hasWindowsAVX2: boolean | null | undefined;
export function getWindowsAvx2Support(
  platform: NodeJS.Platform | string = process.platform,
): boolean | null {
  if (platform !== 'win32') return true;
  if (_hasWindowsAVX2 !== undefined) return _hasWindowsAVX2;

  for (const command of ['powershell.exe', 'pwsh.exe']) {
    const result = spawnSync(
      command,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_AVX2_POWERSHELL_SCRIPT,
      ],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: WINDOWS_AVX2_CHECK_TIMEOUT_MS,
        windowsHide: true,
      },
    );

    if (result.error) {
      continue;
    }

    const detected = parseWindowsAvx2Support(result.stdout);
    if (detected !== null) {
      _hasWindowsAVX2 = detected;
      return detected;
    }
  }

  _hasWindowsAVX2 = null;
  runLogger.debug('[Manifest] Unable to determine Windows AVX2 support');
  return null;
}

// ---------------------------------------------------------------------------
// Manifest fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the latest release manifest.
 *
 * URL: `{baseURL}/channels/manifest.json`
 * Timeout: MANIFEST_FETCH_TIMEOUT_MS (20s)
 *
 * Aligned with Go `FetchManifest()`.
 */
export async function fetchManifest(baseURL: string): Promise<ManifestJSON> {
  const url = `${baseURL.replace(/\/$/, '')}/channels/manifest.json`;
  enforceHTTPS(url);
  return fetchManifestFromURL(url);
}

/**
 * Fetch a version-specific manifest (used for rollback).
 *
 * URL: `{baseURL}/channels/{version}/manifest.json`
 */
export async function fetchVersionManifest(
  baseURL: string,
  version: string,
): Promise<ManifestJSON> {
  const normalizedVersion = version.startsWith('v')
    ? version.slice(1)
    : version;
  if (!isValidSemver(normalizedVersion)) {
    throw new Error(`Invalid version: ${version}`);
  }

  const url = `${baseURL.replace(/\/$/, '')}/channels/${normalizedVersion}/manifest.json`;
  enforceHTTPS(url);
  let manifest: ManifestJSON;
  try {
    manifest = await fetchManifestFromURL(url);
  } catch (error) {
    if (error instanceof ManifestFetchError && error.status === 404) {
      throw new Error(`Requested version ${version} was not found`);
    }
    throw error;
  }
  if (manifest.latest !== normalizedVersion) {
    throw new Error(
      `Version manifest mismatch: requested ${normalizedVersion}, received ${manifest.latest}`,
    );
  }
  return manifest;
}

async function fetchManifestFromURL(url: string): Promise<ManifestJSON> {
  runLogger.debug(`[Manifest] Fetching: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MANIFEST_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ManifestFetchError(response.status, response.statusText, url);
    }

    const data: ManifestJSON = await response.json();

    // Basic validation
    if (!data.latest || !Array.isArray(data.files)) {
      throw new Error('Invalid manifest format: missing "latest" or "files"');
    }

    runLogger.debug(
      `[Manifest] Latest version: ${data.latest}, files: ${data.files.length}`,
    );
    return data;
  } catch (error) {
    if (error instanceof ManifestFetchError) throw error;
    throw annotateNetworkError(error, url, MANIFEST_FETCH_TIMEOUT_MS);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the latest version string from channels/latest.txt.
 * Returns the trimmed version string (e.g. "0.2.5"), or null on any failure.
 * This is a lightweight check (~30 bytes) to avoid fetching the full manifest.
 */
export async function fetchLatestVersion(
  baseURL: string,
): Promise<string | null> {
  const url = `${baseURL.replace(/\/$/, '')}/channels/${LATEST_VERSION_FILENAME}`;
  try {
    enforceHTTPS(url);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      MANIFEST_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text.trim() || null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File matching
// ---------------------------------------------------------------------------

/**
 * Pick the manifest file entry matching the current OS and architecture.
 *
 * Returns null if no compatible binary is found.
 * Aligned with Go `ManifestJSON.Pick()`.
 */
export function pickFile(files: ManifestFile[]): ManifestFile | null {
  return pickFileForPlatform(files, process.platform, process.arch);
}

export function pickFileForPlatform(
  files: ManifestFile[],
  platform: NodeJS.Platform | string,
  arch: NodeJS.Architecture | string,
  windowsBuild = platform === 'win32' ? getWindowsBuildNumber() : null,
  linuxHasBunOptimizedX64?: boolean | null,
): ManifestFile | null {
  const targetOS = OS_MAP[platform];
  const targetArch = ARCH_MAP[arch];

  if (!targetOS || !targetArch) {
    runLogger.debug(`[Manifest] Unsupported platform: ${platform}/${arch}`);
    return null;
  }

  const detectedLinuxHasBunOptimizedX64 =
    linuxHasBunOptimizedX64 !== undefined
      ? linuxHasBunOptimizedX64
      : targetOS === 'linux' &&
          platform === process.platform &&
          targetArch === ARCH_MAP[process.arch]
        ? hasBunOptimizedX64Cpu()
        : null;

  // On Linux x64 without the full Bun optimized x64 CPU profile, prefer the
  // baseline variant. AVX2 alone is not enough: Bun's optimized target can
  // execute BMI/FMA instructions before JS code starts.
  const needsBaseline =
    targetOS === 'linux' &&
    targetArch === 'x64' &&
    detectedLinuxHasBunOptimizedX64 === false;

  if (needsBaseline) {
    runLogger.debug(
      '[Manifest] CPU lacks Bun optimized x64 requirements, looking for baseline variant',
    );
    const baselineMatch = files.find((f) => {
      const fileOS = f.os.toLowerCase();
      const fileArch = f.arch.toLowerCase();
      return (
        fileOS === targetOS &&
        (fileArch === 'amd64-baseline' || fileArch === 'x64-baseline')
      );
    });
    if (baselineMatch) {
      return baselineMatch;
    }
    runLogger.debug(
      '[Manifest] No baseline variant in manifest, falling back to standard',
    );
  }

  const matches = files.filter((f) => {
    const fileOS = f.os.toLowerCase();
    const fileArch = (ARCH_MAP[f.arch.toLowerCase()] ?? f.arch).toLowerCase();
    return fileOS === targetOS && fileArch === targetArch;
  });

  if (targetOS === 'windows') {
    // Bun 1.4+ Windows x64 releases use the baseline-compatible runtime for
    // both standard and baseline targets. The legacy Node-SEA variant is only
    // needed on pre-1809 x64 Windows, where Bun's static ConPTY imports cannot
    // be loaded. AVX2 is a diagnostic dimension, not a selector.
    const legacyApplies = targetArch === 'x64';
    const needsLegacyForBuild =
      legacyApplies &&
      platform === 'win32' &&
      windowsBuild !== null &&
      windowsBuild < WINDOWS_BUN_MIN_BUILD;
    const needsLegacy = legacyApplies && needsNodeSEA(platform, windowsBuild);
    const compatible = matches.filter((f) =>
      isWindowsBuildCompatible(f, windowsBuild),
    );

    if (needsLegacy) {
      const legacy = matches
        .filter(isLegacyWindowsFile)
        .find((f) =>
          isWindowsBuildCompatible(f, windowsBuild, needsLegacyForBuild),
        );
      if (legacy) {
        return legacy;
      }
      runLogger.debug(
        `[Manifest] No legacy binary for windows/${targetArch} build ${windowsBuild ?? 'unknown'}`,
      );
      return null;
    }

    const standard =
      compatible.find((f) => !isLegacyWindowsFile(f)) ?? compatible[0];
    if (standard) {
      return standard;
    }
  }

  const match = matches[0] ?? null;

  if (!match) {
    runLogger.debug(
      `[Manifest] No binary for ${targetOS}/${targetArch} in manifest`,
    );
  }

  return match;
}

// ---------------------------------------------------------------------------
// SHA256 verification
// ---------------------------------------------------------------------------

/**
 * Verify a file's SHA256 hash against an expected hex digest.
 *
 * Uses streaming hash to handle large files without loading into memory.
 * Throws on mismatch.
 *
 * Aligned with Go `VerifySHA256()`.
 */
export async function verifySHA256(
  filePath: string,
  expected: string,
): Promise<void> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const actual = hash.digest('hex');

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
  }

  runLogger.debug(`[Manifest] SHA256 verified: ${actual.slice(0, 12)}...`);
}

// ---------------------------------------------------------------------------
// File download (single attempt with stall detection)
// ---------------------------------------------------------------------------

/**
 * Perform a single download attempt with stall detection.
 *
 * - Overall timeout: DOWNLOAD_TIMEOUT_MS (5 minutes) as a safety net.
 * - Stall timeout: DOWNLOAD_STALL_TIMEOUT_MS (60s) — if no data arrives
 *   within this window the download is aborted with ErrDownloadStalled.
 */
async function downloadFileOnce(
  url: string,
  destPath: string,
  privateUrl = false,
  assertAllowed?: () => void,
): Promise<void> {
  const controller = new AbortController();

  const authTimer = assertAllowed
    ? setInterval(() => {
        try {
          assertAllowed();
        } catch {
          controller.abort();
        }
      }, 250)
    : undefined;

  // --- Overall safety-net timeout ---
  const overallTimeout = setTimeout(
    () => controller.abort(),
    DOWNLOAD_TIMEOUT_MS,
  );

  // --- Stall detection state ---
  let lastDataTime = Date.now();
  let bytesReceived = 0;
  let stallCheckInterval: ReturnType<typeof setInterval> | undefined;
  let stallRejector: ((err: ErrDownloadStalled) => void) | undefined;

  const startStallCheck = (): void => {
    stallCheckInterval = setInterval(() => {
      const elapsed = Date.now() - lastDataTime;
      if (elapsed > DOWNLOAD_STALL_TIMEOUT_MS) {
        const err = new ErrDownloadStalled(
          url,
          DOWNLOAD_STALL_TIMEOUT_MS / 1000,
        );
        controller.abort();
        if (stallRejector) {
          stallRejector(err);
        }
      }
    }, 5000);
  };

  const clearTimers = (): void => {
    clearTimeout(overallTimeout);
    clearInterval(authTimer);
    if (stallCheckInterval) {
      clearInterval(stallCheckInterval);
    }
  };

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: privateUrl ? 'error' : 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Download failed: ${response.status} ${response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error('Download failed: empty response body');
    }

    // Wrap the response body in a transform that tracks bytes & resets the
    // stall timer on every chunk.
    const reader = response.body.getReader();

    const trackedStream = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          return;
        }
        bytesReceived += value.byteLength;
        lastDataTime = Date.now();
        runLogger.debug(
          `[Manifest] Download heartbeat: ${bytesReceived} bytes received`,
        );
        streamController.enqueue(value);
      },
      cancel() {
        void reader.cancel();
      },
    });

    // Start the stall check before we begin piping
    startStallCheck();

    // Race: pipeline vs stall rejection
    const fileStream = createWriteStream(destPath);
    const nodeStream = Readable.fromWeb(
      trackedStream as import('stream/web').ReadableStream,
    );

    await new Promise<void>((resolve, reject) => {
      // Stall detection feeds into this rejector
      stallRejector = reject;

      pipeline(nodeStream, fileStream).then(resolve).catch(reject);
    });

    runLogger.debug(
      `[Manifest] Download complete: ${destPath} (${bytesReceived} bytes)`,
    );
  } finally {
    clearTimers();
  }
}

// ---------------------------------------------------------------------------
// File download (public, with retry logic)
// ---------------------------------------------------------------------------

/**
 * Download a file from URL to a local path.
 *
 * Features:
 * - HTTPS enforcement (except localhost / 127.0.0.1)
 * - Stall detection: aborts if no data received for 60 s
 * - Overall timeout: 5 minutes safety net
 * - Retry: up to DOWNLOAD_MAX_RETRIES attempts for retryable errors
 *
 * Aligned with Go `HttpDownload()`.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  options?: { privateUrl?: boolean; assertAllowed?: () => void },
): Promise<void> {
  enforceHTTPS(url);

  runLogger.debug(
    `[Manifest] Downloading: ${options?.privateUrl ? '[candidate]' : url} -> ${destPath}`,
  );

  let lastError: unknown;

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      options?.assertAllowed?.();
      await downloadFileOnce(
        url,
        destPath,
        options?.privateUrl,
        options?.assertAllowed,
      );
      return; // success
    } catch (error) {
      if (options?.privateUrl)
        throw new Error('Candidate archive download failed');
      lastError = error;

      if (attempt < DOWNLOAD_MAX_RETRIES && isRetryableError(error)) {
        runLogger.debug(
          `[Manifest] Download attempt ${attempt}/${DOWNLOAD_MAX_RETRIES} failed ` +
            `(${error instanceof Error ? error.message : String(error)}), retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        continue;
      }

      // Non-retryable or final attempt — propagate
      break;
    }
  }

  throw annotateNetworkError(lastError, url, DOWNLOAD_TIMEOUT_MS);
}
