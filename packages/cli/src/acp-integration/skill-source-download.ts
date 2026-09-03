/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import { createGunzip } from 'node:zlib';

const debugLogger = createDebugLogger('ACP_AGENT');

function toRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = readOptionalString(value, fieldName);
  if (!stringValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing ${fieldName}`,
    );
  }
  return stringValue;
}

type DownloadedSkillFile = {
  relativePath: string;
  content: Uint8Array;
};

type DownloadedSkill = {
  skillContent: string;
  files: DownloadedSkillFile[];
};

type GitHubBlobSkillUrl = {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
};

// Skill downloads must come from the GitHub host set. Restricting the host
// here prevents the client-supplied `sourceUrl` from driving server-side
// fetches at internal/loopback/link-local endpoints (SSRF), e.g.
// `http://169.254.169.254/` cloud-metadata or `http://localhost:<port>/`.
const ALLOWED_SKILL_SOURCE_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
]);

function assertAllowedSkillSourceUrl(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be a valid URL',
    );
  }
  // Require HTTPS: a plaintext http: fetch of skill content (which can include
  // executable hooks) is MITM-able by a network-position attacker, so the host
  // allowlist alone is not sufficient. All supported GitHub hosts serve HTTPS.
  if (parsed.protocol !== 'https:') {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be an HTTPS URL',
    );
  }
  if (!ALLOWED_SKILL_SOURCE_HOSTS.has(parsed.hostname)) {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl host is not allowed (only github.com sources are supported)',
    );
  }
}

function parseGitHubBlobSkillUrl(sourceUrl: string): GitHubBlobSkillUrl | null {
  const parsed = new URL(sourceUrl);
  // HTTPS-only, consistent with assertAllowedSkillSourceUrl (skill content can
  // include executable hooks, so plaintext http: is MITM-able).
  if (parsed.protocol !== 'https:') {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be an HTTPS URL',
    );
  }

  if (parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[2] !== 'blob') return null;

  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const filePathParts = parts.slice(4);
  if (!owner || !repo || !ref || filePathParts.length === 0) return null;

  return {
    owner,
    repo,
    ref,
    filePath: filePathParts.join('/'),
  };
}

function toRawGitHubUrl(githubUrl: GitHubBlobSkillUrl): string {
  return `https://raw.githubusercontent.com/${githubUrl.owner}/${githubUrl.repo}/${githubUrl.ref}/${githubUrl.filePath}`;
}

function encodeGitHubPath(filePath: string): string {
  if (!filePath || filePath === '.') return '';
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function readTarString(
  archive: Uint8Array,
  offset: number,
  length: number,
): string {
  const bytes = archive.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.length;
  return Buffer.from(bytes.subarray(0, end)).toString('utf8').trim();
}

function readTarSize(archive: Uint8Array, offset: number): number {
  const raw = readTarString(archive, offset + 124, 12);
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroTarBlock(archive: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 512; i += 1) {
    if (archive[offset + i] !== 0) return false;
  }
  return true;
}

function readTarPath(archive: Uint8Array, offset: number): string {
  const name = readTarString(archive, offset, 100);
  const prefix = readTarString(archive, offset + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function stripArchiveRoot(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : '';
}

// Bound the work done on untrusted skill archives so a malicious or oversized
// download cannot exhaust memory. Decompression is streamed (createGunzip) and
// aborted the moment the cumulative inflated size crosses the cap, so a
// decompression bomb can never fully inflate into memory.
const MAX_SKILL_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB compressed
const MAX_SKILL_DECOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB decompressed
// Bounds for the GitHub Contents-API directory walk (the archive path is
// already bounded by the byte caps above).
const MAX_SKILL_API_DIR_DEPTH = 16;
const MAX_SKILL_API_FILE_COUNT = 2000;

// Sentinel so the streaming decompression's size-limit abort can be told apart
// from a genuine gunzip/format error in the catch below.
class DecompressedSizeExceededError extends Error {}

export async function extractFilesFromTarGz(
  archiveBytes: Uint8Array,
  directoryPath: string,
  // Limits are injectable so the size-guard branches can be exercised in tests
  // without allocating the 100MB/500MB production thresholds.
  limits: {
    maxCompressedBytes?: number;
    maxDecompressedBytes?: number;
  } = {},
): Promise<DownloadedSkillFile[]> {
  const maxCompressedBytes =
    limits.maxCompressedBytes ?? MAX_SKILL_DOWNLOAD_BYTES;
  const maxDecompressedBytes =
    limits.maxDecompressedBytes ?? MAX_SKILL_DECOMPRESSED_BYTES;

  if (archiveBytes.length > maxCompressedBytes) {
    throw RequestError.invalidParams(
      undefined,
      'Skill archive exceeds the maximum allowed size',
    );
  }

  let archive: Buffer;
  try {
    // Stream the inflate so we can abort as soon as the cumulative output
    // exceeds the cap, instead of materializing the entire decompressed buffer
    // first (a ~1000:1 gzip ratio could otherwise inflate a small archive to
    // many GB before any post-hoc length check fires).
    const chunks: Buffer[] = [];
    let total = 0;
    await pipeline(
      // Wrap in an array so the whole archive is emitted as a single chunk;
      // `Readable.from(uint8array)` would otherwise iterate it byte-by-byte.
      Readable.from([Buffer.from(archiveBytes)]),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          total += chunk.length;
          if (total > maxDecompressedBytes) {
            cb(new DecompressedSizeExceededError());
            return;
          }
          chunks.push(chunk);
          cb();
        },
      }),
    );
    archive = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof DecompressedSizeExceededError) {
      throw RequestError.invalidParams(
        undefined,
        'Decompressed skill archive exceeds the maximum allowed size',
      );
    }
    throw RequestError.invalidParams(
      undefined,
      `Failed to decompress skill archive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const normalizedDirectory = directoryPath.replace(/^\/+|\/+$/g, '');
  // Treat '.' (SKILL.md at the repository root) as the empty prefix; otherwise
  // the prefix becomes './' and never matches the root-stripped archive paths
  // (e.g. 'SKILL.md'), yielding zero extracted files.
  const directoryPrefix =
    normalizedDirectory && normalizedDirectory !== '.'
      ? `${normalizedDirectory}/`
      : '';
  const files: DownloadedSkillFile[] = [];

  for (let offset = 0; offset + 512 <= archive.length; ) {
    if (isZeroTarBlock(archive, offset)) break;

    const fullPath = readTarPath(archive, offset);
    const typeFlag = String.fromCharCode(archive[offset + 156] || 0);
    const size = readTarSize(archive, offset);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;

    if (typeFlag === '0' || typeFlag === '\0') {
      const repoPath = stripArchiveRoot(fullPath);
      if (repoPath.startsWith(directoryPrefix)) {
        const relativePath = repoPath.slice(directoryPrefix.length);
        if (relativePath) {
          files.push({
            relativePath,
            content: archive.subarray(dataOffset, dataOffset + size),
          });
        }
      }
    }

    offset = nextOffset;
  }

  return files;
}

// GitHub host suffixes a download may legitimately redirect to (raw/codeload
// commonly 302 to their object CDN for geo/CDN routing). Redirects to anything
// outside these are rejected, preserving the SSRF guard while not breaking
// real downloads.
const ALLOWED_REDIRECT_HOST_SUFFIXES = [
  '.githubusercontent.com',
  '.github.com',
  // Note: '.github.io' is intentionally excluded — *.github.io are
  // user-controlled GitHub Pages sites, so allowing redirects there would
  // reopen the SSRF/exfiltration surface this allowlist exists to close.
];

function isAllowedSkillFetchHost(hostname: string): boolean {
  if (ALLOWED_SKILL_SOURCE_HOSTS.has(hostname)) return true;
  return ALLOWED_REDIRECT_HOST_SUFFIXES.some((suffix) =>
    hostname.endsWith(suffix),
  );
}

/**
 * Fetch that follows redirects manually, validating every hop stays on an
 * allowed GitHub host over HTTPS. This keeps the SSRF protection of
 * `redirect: 'manual'` (a malicious repo cannot bounce the fetch to an internal
 * endpoint) while still following GitHub's legitimate CDN redirects, which
 * plain `redirect: 'manual'` would surface as a download failure.
 */
export async function fetchAllowedGitHub(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers?.get('location');
    if (!location) return response;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw RequestError.invalidParams(
        undefined,
        'Skill download redirected to an invalid URL',
      );
    }
    if (next.protocol !== 'https:' || !isAllowedSkillFetchHost(next.hostname)) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download redirected to a disallowed host',
      );
    }
    current = next.toString();
  }
  throw RequestError.invalidParams(
    undefined,
    'Skill download exceeded the maximum number of redirects',
  );
}

// Read a response body while enforcing a hard byte cap against the *actual*
// streamed bytes. The Content-Length pre-checks at the call sites are advisory
// only — a server that omits the header (chunked transfer, CDN redirect) could
// otherwise stream an arbitrarily large body straight into memory via
// `arrayBuffer()`.
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetchAllowedGitHub(url);
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to download skill (${response.status})`,
    );
  }

  const contentLength = response.headers?.get('content-length');
  if (contentLength) {
    const declaredSize = Number.parseInt(contentLength, 10);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > MAX_SKILL_DOWNLOAD_BYTES
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
  }

  return readBodyWithLimit(response, MAX_SKILL_DOWNLOAD_BYTES);
}

async function downloadSingleSkillFile(
  sourceUrl: string,
): Promise<DownloadedSkill> {
  const githubUrl = parseGitHubBlobSkillUrl(sourceUrl);
  const fetchUrl = githubUrl ? toRawGitHubUrl(githubUrl) : sourceUrl;
  const content = await fetchBytes(fetchUrl);
  return {
    skillContent: Buffer.from(content).toString('utf8'),
    files: [{ relativePath: 'SKILL.md', content }],
  };
}

async function downloadGitHubSkillDirectoryFromArchive(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  const archiveUrl = `https://codeload.github.com/${githubUrl.owner}/${githubUrl.repo}/tar.gz/${encodeURIComponent(
    githubUrl.ref,
  )}`;
  const response = await fetchAllowedGitHub(archiveUrl, {
    headers: {
      'User-Agent': 'qwen-code',
    },
  });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to download GitHub skill archive (${response.status})`,
    );
  }

  // Reject oversized archives by declared Content-Length before buffering the
  // whole body into memory, mirroring the guard in fetchBytes.
  const contentLength = response.headers?.get('content-length');
  if (contentLength) {
    const declaredSize = Number.parseInt(contentLength, 10);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > MAX_SKILL_DOWNLOAD_BYTES
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Skill archive exceeds the maximum allowed size',
      );
    }
  }

  return extractFilesFromTarGz(
    await readBodyWithLimit(response, MAX_SKILL_DOWNLOAD_BYTES),
    directoryPath,
  );
}

async function fetchGitHubDirectoryItems(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<unknown[]> {
  const encodedPath = encodeGitHubPath(directoryPath);
  const apiUrl = `https://api.github.com/repos/${githubUrl.owner}/${githubUrl.repo}/contents/${encodedPath}?ref=${encodeURIComponent(githubUrl.ref)}`;
  const response = await fetchAllowedGitHub(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qwen-code',
    },
  });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to list GitHub skill files (${response.status})`,
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw RequestError.invalidParams(
      undefined,
      'GitHub skill URL must point to a directory-backed SKILL.md file',
    );
  }
  return data;
}

async function downloadGitHubSkillDirectoryFromApi(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
  relativeRoot = '',
  // Bound the recursive API walk so a crafted repo (deeply nested dirs, huge
  // file counts, or large cumulative size) can't exhaust memory/time. The
  // archive fallback already enforces size caps; this gives the API path
  // equivalent guards.
  depth = 0,
  budget: { files: number; bytes: number } = { files: 0, bytes: 0 },
): Promise<DownloadedSkillFile[]> {
  if (depth > MAX_SKILL_API_DIR_DEPTH) {
    throw RequestError.invalidParams(
      undefined,
      'Skill directory nesting exceeds the maximum allowed depth',
    );
  }
  const items = await fetchGitHubDirectoryItems(githubUrl, directoryPath);
  const files: DownloadedSkillFile[] = [];

  for (const item of items) {
    const record = toRecord(item);
    const name = readRequiredString(record['name'], 'github.name');
    const itemPath = readRequiredString(record['path'], 'github.path');
    const type = readRequiredString(record['type'], 'github.type');
    const relativePath = relativeRoot
      ? path.posix.join(relativeRoot, name)
      : name;

    if (type === 'dir') {
      files.push(
        ...(await downloadGitHubSkillDirectoryFromApi(
          githubUrl,
          itemPath,
          relativePath,
          depth + 1,
          budget,
        )),
      );
      continue;
    }

    if (type !== 'file') continue;
    budget.files += 1;
    if (budget.files > MAX_SKILL_API_FILE_COUNT) {
      throw RequestError.invalidParams(
        undefined,
        'Skill directory contains too many files',
      );
    }
    const downloadUrl = readRequiredString(
      record['download_url'],
      'github.download_url',
    );
    // SSRF defense: the API-provided download_url is attacker-influenced, so
    // run it through the same host allowlist + HTTPS check as the initial URL.
    assertAllowedSkillSourceUrl(downloadUrl);
    const content = await fetchBytes(downloadUrl);
    budget.bytes += content.length;
    if (budget.bytes > MAX_SKILL_DECOMPRESSED_BYTES) {
      throw RequestError.invalidParams(
        undefined,
        'Skill directory exceeds the maximum allowed size',
      );
    }
    files.push({
      relativePath,
      content,
    });
  }

  return files;
}

async function downloadGitHubSkillDirectory(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  const apiFiles = await downloadGitHubSkillDirectoryFromApi(
    githubUrl,
    directoryPath,
  ).catch((error) => {
    debugLogger.warn(
      'GitHub API directory listing failed, falling back to archive download:',
      error,
    );
    return null;
  });
  if (apiFiles) return apiFiles;

  return downloadGitHubSkillDirectoryFromArchive(githubUrl, directoryPath);
}

export async function downloadSkill(
  sourceUrl: string,
): Promise<DownloadedSkill> {
  assertAllowedSkillSourceUrl(sourceUrl);
  const githubUrl = parseGitHubBlobSkillUrl(sourceUrl);
  if (!githubUrl || path.posix.basename(githubUrl.filePath) !== 'SKILL.md') {
    return downloadSingleSkillFile(sourceUrl);
  }

  const skillDirectory = path.posix.dirname(githubUrl.filePath);
  const files = await downloadGitHubSkillDirectory(githubUrl, skillDirectory);
  const skillFile = files.find((file) => file.relativePath === 'SKILL.md');
  if (!skillFile) {
    throw RequestError.invalidParams(
      undefined,
      'GitHub skill directory does not contain SKILL.md',
    );
  }

  return {
    skillContent: Buffer.from(skillFile.content).toString('utf8'),
    files,
  };
}
