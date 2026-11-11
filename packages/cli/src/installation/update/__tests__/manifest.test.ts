/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  BUN_OPTIMIZED_X64_REQUIRED_CPU_FLAGS,
  annotateNetworkError,
  fetchManifest,
  fetchVersionManifest,
  getWindowsBuildNumber,
  needsNodeSEA,
  pickFile,
  pickFileForPlatform,
  verifySHA256,
  downloadFile,
  enforceHTTPS,
  isRetryableError,
  ErrDownloadStalled,
  parseLinuxCpuFlags,
  linuxCpuSupportsBunBaselineX64,
  linuxCpuSupportsBunOptimizedX64,
} from '../manifest.js';
import type { ManifestFile, ManifestJSON } from '../updateTypes.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@qwen-code/core', () => ({
  BRAND_FIXED_CLI_BIN: 'qwen',
  runLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const VALID_MANIFEST: ManifestJSON = {
  latest: '0.3.0',
  published_at: '2026-04-24T12:00:00Z',
  files: [
    {
      os: 'darwin',
      arch: 'arm64',
      url: 'https://cdn.example.com/test-cli-darwin-arm64.tar.gz',
      sha256: 'aabbccdd',
    },
    {
      os: 'darwin',
      arch: 'x64',
      url: 'https://cdn.example.com/test-cli-darwin-x64.tar.gz',
      sha256: 'eeff0011',
    },
    {
      os: 'linux',
      arch: 'x64',
      url: 'https://cdn.example.com/test-cli-linux-x64.tar.gz',
      sha256: '22334455',
    },
    {
      os: 'linux',
      arch: 'arm64',
      url: 'https://cdn.example.com/test-cli-linux-arm64.tar.gz',
      sha256: '66778899',
    },
    {
      os: 'windows',
      arch: 'x64',
      url: 'https://cdn.example.com/test-cli-windows-x64.zip',
      sha256: 'aabb0011',
    },
  ],
  rollback_versions: ['0.2.0', '0.1.9'],
};

// ---------------------------------------------------------------------------
// fetchManifest / fetchVersionManifest
// ---------------------------------------------------------------------------

describe('fetchManifest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('should fetch and parse a valid manifest', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
      );
    globalThis.fetch = mockFn;

    const result = await fetchManifest('https://cdn.example.com/test-cli');

    expect(mockFn).toHaveBeenCalledWith(
      'https://cdn.example.com/test-cli/channels/manifest.json',
      expect.objectContaining({
        headers: { 'User-Agent': 'qwen-updater' },
      }),
    );
    expect(result.latest).toBe('0.3.0');
    expect(result.files).toHaveLength(5);
    expect(result.rollback_versions).toEqual(['0.2.0', '0.1.9']);
  });

  it('should strip trailing slash from baseURL', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
      );
    globalThis.fetch = mockFn;

    await fetchManifest('https://cdn.example.com/test-cli/');

    expect(mockFn).toHaveBeenCalledWith(
      'https://cdn.example.com/test-cli/channels/manifest.json',
      expect.anything(),
    );
  });

  it('should throw on HTTP 404', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

    await expect(
      fetchManifest('https://cdn.example.com/test-cli'),
    ).rejects.toThrow('Manifest fetch failed: 404 Not Found');
  });

  it('should throw on HTTP 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    await expect(
      fetchManifest('https://cdn.example.com/test-cli'),
    ).rejects.toThrow('Manifest fetch failed: 500');
  });

  it('should throw on invalid manifest format (missing latest)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [] }), { status: 200 }),
      );

    await expect(
      fetchManifest('https://cdn.example.com/test-cli'),
    ).rejects.toThrow('Invalid manifest format');
  });

  it('should throw on invalid manifest format (missing files)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ latest: '1.0.0' }), { status: 200 }),
      );

    await expect(
      fetchManifest('https://cdn.example.com/test-cli'),
    ).rejects.toThrow('Invalid manifest format');
  });

  it('should throw on network error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network error'));

    await expect(
      fetchManifest('https://cdn.example.com/test-cli'),
    ).rejects.toThrow('Network error');
  });

  it('should annotate a bare fetch error with the url and timeout', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('fetch failed'));

    await expect(
      fetchManifest('https://cdn.example.com/test-cli'),
    ).rejects.toThrow(
      'fetch failed [url: https://cdn.example.com/test-cli/channels/manifest.json, timeout:',
    );
  });

  it('should keep the error code and add proxy env names for certificate errors', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:8080');
    globalThis.fetch = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    );

    const error = await fetchManifest('https://cdn.example.com/test-cli').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('proxy env: HTTPS_PROXY');
    expect((error as { code?: string }).code).toBe(
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    );
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('should not annotate the HTTP status error twice', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

    const error = await fetchManifest('https://cdn.example.com/test-cli').catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe(
      'Manifest fetch failed: 404 Not Found [url: https://cdn.example.com/test-cli/channels/manifest.json]',
    );
  });
});

describe('fetchVersionManifest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fetch version-specific manifest with correct URL', async () => {
    const versionManifest = { ...VALID_MANIFEST, latest: '0.2.0' };
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(versionManifest), { status: 200 }),
      );
    globalThis.fetch = mockFn;

    const result = await fetchVersionManifest(
      'https://cdn.example.com/test-cli',
      '0.2.0',
    );

    expect(mockFn).toHaveBeenCalledWith(
      'https://cdn.example.com/test-cli/channels/0.2.0/manifest.json',
      expect.anything(),
    );
    expect(result.latest).toBe('0.2.0');
  });

  it('accepts a leading v and fetches the normalized version channel', async () => {
    const versionManifest = { ...VALID_MANIFEST, latest: '1.2.3' };
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(versionManifest), { status: 200 }),
      );
    globalThis.fetch = mockFn;

    await fetchVersionManifest(
      'https://cdn.example.com/test-cli',
      'v1.2.3',
    );

    expect(mockFn).toHaveBeenCalledWith(
      'https://cdn.example.com/test-cli/channels/1.2.3/manifest.json',
      expect.anything(),
    );
  });

  it('accepts valid SemVer build metadata', async () => {
    const versionManifest = {
      ...VALID_MANIFEST,
      latest: '1.2.3+build.1',
    };
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(versionManifest), { status: 200 }),
      );
    globalThis.fetch = mockFn;

    await fetchVersionManifest(
      'https://cdn.example.com/test-cli',
      '1.2.3+build.1',
    );

    expect(mockFn).toHaveBeenCalledWith(
      'https://cdn.example.com/test-cli/channels/1.2.3+build.1/manifest.json',
      expect.anything(),
    );
  });

  it('reports a missing requested version without falling back to latest', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    globalThis.fetch = mockFn;

    await expect(
      fetchVersionManifest(
        'https://cdn.example.com/test-cli',
        'v1.1.5-task1',
      ),
    ).rejects.toThrow('Requested version v1.1.5-task1 was not found');

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith(
      'https://cdn.example.com/test-cli/channels/1.1.5-task1/manifest.json',
      expect.anything(),
    );
  });

  it('rejects a version manifest that resolves to a different version', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
      );
    globalThis.fetch = mockFn;

    await expect(
      fetchVersionManifest('https://cdn.example.com/test-cli', '1.2.3'),
    ).rejects.toThrow(
      'Version manifest mismatch: requested 1.2.3, received 0.3.0',
    );
  });

  it.each(['../1.2.3', '01.2.3', '1.2.3.4', '1.2.3-foo..bar'])(
    'rejects invalid version %s without making a request',
    async (version) => {
      const mockFn = vi.fn();
      globalThis.fetch = mockFn;

      await expect(
        fetchVersionManifest('https://cdn.example.com/test-cli', version),
      ).rejects.toThrow(`Invalid version: ${version}`);
      expect(mockFn).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// pickFile
// ---------------------------------------------------------------------------

describe('pickFile', () => {
  const files: ManifestFile[] = VALID_MANIFEST.files;

  it('should pick darwin-arm64 on macOS ARM', () => {
    const result = pickFileForPlatform(files, 'darwin', 'arm64');
    expect(result).not.toBeNull();
    expect(result!.os).toBe('darwin');
    expect(result!.arch).toBe('arm64');
  });

  it('should pick linux-x64 on Linux x64', () => {
    const result = pickFileForPlatform(files, 'linux', 'x64');
    expect(result).not.toBeNull();
    expect(result!.os).toBe('linux');
    expect(result!.arch).toBe('x64');
  });

  it('should return null for empty files array', () => {
    const result = pickFile([]);
    expect(result).toBeNull();
  });

  it('should return null when no matching platform', () => {
    const onlyWindows: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'x64',
        url: 'https://example.com/win.zip',
        sha256: 'abc',
      },
    ];

    expect(pickFileForPlatform(onlyWindows, 'darwin', 'arm64')).toBeNull();
  });

  it('should handle arch aliases (aarch64 -> arm64)', () => {
    const aliasFiles: ManifestFile[] = [
      {
        os: 'darwin',
        arch: 'aarch64',
        url: 'https://example.com/darwin-aarch64.tar.gz',
        sha256: 'xyz',
      },
    ];

    const result = pickFileForPlatform(aliasFiles, 'darwin', 'arm64');
    expect(result).not.toBeNull();
    expect(result!.arch).toBe('aarch64');
  });

  it('picks for the current platform the same file as an explicit lookup', () => {
    expect(pickFile(files)).toEqual(
      pickFileForPlatform(files, process.platform, process.arch),
    );
  });

  it('parses Windows build numbers from os.release()', () => {
    expect(getWindowsBuildNumber('10.0.14393')).toBe(14393);
    expect(getWindowsBuildNumber('10.0.17763')).toBe(17763);
    expect(getWindowsBuildNumber('invalid')).toBeNull();
  });

  it('requires node-sea only on pre-1809 Windows builds', () => {
    expect(needsNodeSEA('win32', 17762)).toBe(true);
    expect(needsNodeSEA('win32', 17763)).toBe(false);
    expect(needsNodeSEA('win32', 19045)).toBe(false);
    expect(needsNodeSEA('win32', null)).toBe(false);
    expect(needsNodeSEA('linux', null)).toBe(false);
    expect(needsNodeSEA('darwin', null)).toBe(false);
  });

  it('detects the full Linux x64 CPU profile needed for Bun optimized builds', () => {
    const optimizedCpuinfo = [
      'processor : 0',
      'flags : fpu sse4_2 popcnt avx avx2 bmi1 bmi2 fma',
    ].join('\n');

    expect(parseLinuxCpuFlags(optimizedCpuinfo)).toEqual(
      new Set(['fpu', 'sse4_2', 'popcnt', 'avx', 'avx2', 'bmi1', 'bmi2', 'fma']),
    );
    expect(linuxCpuSupportsBunBaselineX64(optimizedCpuinfo)).toBe(true);
    expect(linuxCpuSupportsBunOptimizedX64(optimizedCpuinfo)).toBe(true);
  });

  it('rejects AVX2-only Linux x64 CPUs for Bun optimized builds', () => {
    const avx2OnlyCpuinfo = [
      'processor : 0',
      'flags : fpu sse4_2 popcnt avx avx2',
    ].join('\n');

    expect(linuxCpuSupportsBunBaselineX64(avx2OnlyCpuinfo)).toBe(true);
    expect(linuxCpuSupportsBunOptimizedX64(avx2OnlyCpuinfo)).toBe(false);
  });

  it('picks the Linux x64 baseline file when optimized CPU flags are missing', () => {
    const linuxFiles: ManifestFile[] = [
      {
        os: 'linux',
        arch: 'amd64',
        url: 'https://example.com/test-cli-linux-x64.tar.gz',
        sha256: 'standard',
      },
      {
        os: 'linux',
        arch: 'amd64-baseline',
        url: 'https://example.com/test-cli-linux-x64-baseline.tar.gz',
        sha256: 'baseline',
      },
    ];

    const result = pickFileForPlatform(
      linuxFiles,
      'linux',
      'x64',
      null,
      false,
    );

    expect(result?.arch).toBe('amd64-baseline');
    expect(result?.url).toContain('baseline');
  });

  it('picks the standard Linux x64 file when optimized CPU flags are present', () => {
    const linuxFiles: ManifestFile[] = [
      {
        os: 'linux',
        arch: 'amd64-baseline',
        url: 'https://example.com/test-cli-linux-x64-baseline.tar.gz',
        sha256: 'baseline',
      },
      {
        os: 'linux',
        arch: 'amd64',
        url: 'https://example.com/test-cli-linux-x64.tar.gz',
        sha256: 'standard',
      },
    ];

    const result = pickFileForPlatform(
      linuxFiles,
      'linux',
      'x64',
      null,
      true,
    );

    expect(result?.arch).toBe('amd64');
    expect(result?.url).not.toContain('baseline');
  });

  it('picks the node-sea legacy Windows file on pre-1809 builds', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard',
      },
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'node-sea',
        variant: 'legacy',
        max_windows_build: 17762,
        url: 'https://example.com/test-cli-windows-x64-legacy.zip',
        sha256: 'legacy',
      },
    ];

    const result = pickFileForPlatform(windowsFiles, 'win32', 'x64', 14393);
    expect(result?.runtime).toBe('node-sea');
    expect(result?.url).toContain('legacy');
  });

  it('picks the node-sea legacy Windows file when the manifest uses x64 arch', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'x64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard',
      },
      {
        os: 'windows',
        arch: 'x64',
        runtime: 'node-sea',
        variant: 'legacy',
        max_windows_build: 17762,
        url: 'https://example.com/test-cli-windows-x64-legacy.zip',
        sha256: 'legacy',
      },
    ];

    const result = pickFileForPlatform(windowsFiles, 'win32', 'x64', 17762);
    expect(result?.runtime).toBe('node-sea');
    expect(result?.arch).toBe('x64');
  });

  it('picks the standard Windows file on 1809+ builds', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard',
      },
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'node-sea',
        variant: 'legacy',
        max_windows_build: 17762,
        url: 'https://example.com/test-cli-windows-x64-legacy.zip',
        sha256: 'legacy',
      },
    ];

    const result = pickFileForPlatform(windowsFiles, 'win32', 'x64', 17763);
    expect(result?.runtime).toBe('bun');
    expect(result?.url).not.toContain('legacy');
  });

  it('picks the Bun Windows file on 1809+ builds without consulting AVX2', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard',
      },
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'node-sea',
        variant: 'legacy',
        max_windows_build: 17762,
        url: 'https://example.com/test-cli-windows-x64-legacy.zip',
        sha256: 'legacy',
      },
    ];

    const result = pickFileForPlatform(windowsFiles, 'win32', 'x64', 19045);
    expect(result?.runtime).toBe('bun');
    expect(result?.url).not.toContain('legacy');
  });

  it('returns null on pre-1809 Windows when only incompatible Bun files exist', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard',
      },
    ];

    expect(
      pickFileForPlatform(windowsFiles, 'win32', 'x64', 14393),
    ).toBeNull();
  });

  it('picks the native Windows arm64 file', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard-x64',
      },
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'node-sea',
        variant: 'legacy',
        max_windows_build: 17762,
        url: 'https://example.com/test-cli-windows-x64-legacy.zip',
        sha256: 'legacy',
      },
      {
        os: 'windows',
        arch: 'arm64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-arm64.zip',
        sha256: 'standard-arm64',
      },
    ];

    const result = pickFileForPlatform(windowsFiles, 'win32', 'arm64', 26100);
    expect(result?.arch).toBe('arm64');
    expect(result?.runtime).toBe('bun');
    expect(result?.url).toContain('arm64');
  });

  it('returns null for Windows arm64 when the release ships no arm64 file', () => {
    const windowsFiles: ManifestFile[] = [
      {
        os: 'windows',
        arch: 'amd64',
        runtime: 'bun',
        variant: 'standard',
        min_windows_build: 17763,
        url: 'https://example.com/test-cli-windows-x64.zip',
        sha256: 'standard-x64',
      },
    ];

    expect(
      pickFileForPlatform(windowsFiles, 'win32', 'arm64', 26100),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// build-config.json drift prevention
// ---------------------------------------------------------------------------

describe('build-config.json sync', () => {
  it('Linux install.sh uses the same Bun optimized x64 CPU flags as TypeScript selection', async () => {
    const { resolve } = await import('node:path');
    const root = resolve(__dirname, '../../../../../../');
    const installScript = readFileSync(
      resolve(root, 'scripts/install.sh'),
      'utf-8',
    );
    const match = installScript.match(
      /^BUN_OPTIMIZED_X64_REQUIRED_CPU_FLAGS=\(([^)]*)\)$/m,
    );

    expect(match).not.toBeNull();
    expect(match?.[1].trim().split(/\s+/)).toEqual([
      ...BUN_OPTIMIZED_X64_REQUIRED_CPU_FLAGS,
    ]);
  });

  it('WINDOWS_BUN_MIN_BUILD matches scripts/build-config.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // Walk up from __tests__ → update → utils → src → cli → packages → root
    const root = resolve(__dirname, '../../../../../../');
    const config = JSON.parse(
      readFileSync(resolve(root, 'scripts/build-config.json'), 'utf-8'),
    );
    // needsNodeSEA uses WINDOWS_BUN_MIN_BUILD internally — verify via boundary:
    // build 17762 (legacyMaxBuild) → needs SEA; build 17763 (bunMinBuild) → does not.
    expect(config.windows.bunMinBuild).toBe(17763);
    expect(config.windows.legacyMaxBuild).toBe(17762);
    expect(needsNodeSEA('win32', config.windows.legacyMaxBuild)).toBe(true);
    expect(needsNodeSEA('win32', config.windows.bunMinBuild)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySHA256
// ---------------------------------------------------------------------------

describe('verifySHA256', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should pass for matching SHA256', async () => {
    const content = 'hello world';
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, content);

    await expect(
      verifySHA256(
        filePath,
        'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      ),
    ).resolves.toBeUndefined();
  });

  it('should pass for case-insensitive SHA256 comparison', async () => {
    const content = 'hello world';
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, content);

    await expect(
      verifySHA256(
        filePath,
        'B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9',
      ),
    ).resolves.toBeUndefined();
  });

  it('should throw on SHA256 mismatch', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await writeFile(filePath, 'hello world');

    await expect(
      verifySHA256(filePath, '0000000000000000000000000000000000000000'),
    ).rejects.toThrow('SHA256 mismatch');
  });

  it('should throw on non-existent file', async () => {
    await expect(
      verifySHA256(join(tmpDir, 'nonexistent.txt'), 'abc'),
    ).rejects.toThrow();
  });

  it('should handle empty file', async () => {
    const filePath = join(tmpDir, 'empty.txt');
    await writeFile(filePath, '');

    await expect(
      verifySHA256(
        filePath,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// downloadFile
// ---------------------------------------------------------------------------

describe('downloadFile', () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'download-test-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should download file successfully', async () => {
    const content = 'binary-content-here';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(content, { status: 200 }));

    const destPath = join(tmpDir, 'downloaded.bin');
    await downloadFile('https://cdn.example.com/file.tar.gz', destPath);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(destPath, 'utf-8');
    expect(written).toBe(content);
  });

  it('should throw on HTTP error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

    const destPath = join(tmpDir, 'should-not-exist.bin');
    await expect(
      downloadFile('https://cdn.example.com/missing.tar.gz', destPath),
    ).rejects.toThrow('Download failed: 404 Not Found');
  });

  it('should throw on empty response body', async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'body', { value: null });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(response);

    const destPath = join(tmpDir, 'empty.bin');
    await expect(
      downloadFile('https://cdn.example.com/empty.tar.gz', destPath),
    ).rejects.toThrow('empty response body');
  });

  it('should name the failing url when a download error is propagated', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

    const destPath = join(tmpDir, 'annotated.bin');
    await expect(
      downloadFile('https://cdn.example.com/missing.tar.gz', destPath),
    ).rejects.toThrow(
      'Download failed: 404 Not Found [url: https://cdn.example.com/missing.tar.gz, timeout:',
    );
  });
});

describe('annotateNetworkError', () => {
  const url = 'https://cdn.example.com/test-cli-darwin-arm64.tar.gz';

  it('returns the original error when its message already names the url', () => {
    const stalled = new ErrDownloadStalled(url, 60);
    expect(annotateNetworkError(stalled, url, 1000)).toBe(stalled);
  });

  it('appends url and timeout while preserving name and code', () => {
    const original = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    original.name = 'SocketError';

    const annotated = annotateNetworkError(original, url, 300000);

    expect(annotated.message).toBe(
      `socket hang up [url: ${url}, timeout: 300000ms]`,
    );
    expect(annotated.name).toBe('SocketError');
    expect((annotated as { code?: string }).code).toBe('ECONNRESET');
    expect(annotated.cause).toBe(original);
  });

  it('wraps non-Error throws', () => {
    const annotated = annotateNetworkError('boom', url);
    expect(annotated.message).toBe(`boom [url: ${url}]`);
  });

  it('notes when no proxy env is set for certificate errors', () => {
    const annotated = annotateNetworkError(
      new Error('self-signed certificate in certificate chain'),
      url,
    );
    expect(annotated.message).toMatch(/proxy env: |no proxy env set/);
  });

  // Localized OS text and OpenSSL's numeric form carry none of the English
  // keywords, so the errno code has to trigger the proxy hint too.
  it('flags a certificate errno code when the message has no keywords', () => {
    const annotated = annotateNetworkError(
      Object.assign(new Error('ssl handshake aborted'), {
        code: 'CERT_HAS_EXPIRED',
      }),
      url,
    );
    expect(annotated.message).toMatch(/proxy env: |no proxy env set/);
  });

  it('flags the OpenSSL numeric error form without a code', () => {
    const annotated = annotateNetworkError(
      new Error('error:0A000086:X509 routines::verify failed'),
      url,
    );
    expect(annotated.message).toMatch(/proxy env: |no proxy env set/);
  });

  it('does not add a proxy hint to a plain socket error', () => {
    const annotated = annotateNetworkError(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      url,
    );
    expect(annotated.message).not.toMatch(/proxy env: |no proxy env set/);
  });
});

// ---------------------------------------------------------------------------
// enforceHTTPS
// ---------------------------------------------------------------------------

describe('enforceHTTPS', () => {
  it('should allow https URLs', () => {
    expect(() =>
      enforceHTTPS('https://cdn.example.com/file.tar.gz'),
    ).not.toThrow();
  });

  it('should allow http://localhost', () => {
    expect(() =>
      enforceHTTPS('http://localhost:8080/file.tar.gz'),
    ).not.toThrow();
  });

  it('should allow http://127.0.0.1', () => {
    expect(() =>
      enforceHTTPS('http://127.0.0.1:3000/file.tar.gz'),
    ).not.toThrow();
  });

  it('should reject http:// non-local URLs', () => {
    expect(() => enforceHTTPS('http://cdn.example.com/file.tar.gz')).toThrow(
      'HTTPS required',
    );
  });

  it('should reject HTTP with uppercase', () => {
    expect(() => enforceHTTPS('HTTP://cdn.example.com/file.tar.gz')).toThrow(
      'HTTPS required',
    );
  });

  it('should allow HTTPS with mixed case', () => {
    expect(() =>
      enforceHTTPS('HTTPS://cdn.example.com/file.tar.gz'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  it('should return true for ErrDownloadStalled', () => {
    const err = new ErrDownloadStalled('https://example.com/file', 60);
    expect(isRetryableError(err)).toBe(true);
  });

  it('should return true for network errors (fetch failed)', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });

  it('should return true for ECONNRESET', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  it('should return true for ECONNREFUSED', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('should return true for ETIMEDOUT', () => {
    expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('should return true for socket hang up', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
  });

  it('should return true for EPIPE', () => {
    expect(isRetryableError(new Error('EPIPE'))).toBe(true);
  });

  it('should return true for network error', () => {
    expect(isRetryableError(new Error('network error occurred'))).toBe(true);
  });

  it('should return false for HTTP 4xx errors', () => {
    expect(isRetryableError(new Error('HTTP 404 Not Found'))).toBe(false);
  });

  it('should return false for status 400', () => {
    expect(isRetryableError(new Error('status 403 Forbidden'))).toBe(false);
  });

  it('should return false for generic errors', () => {
    expect(isRetryableError(new Error('SHA256 mismatch'))).toBe(false);
  });

  it('should return false for non-Error objects', () => {
    expect(isRetryableError('string error')).toBe(false);
  });

  it('should return false for null', () => {
    expect(isRetryableError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ErrDownloadStalled
// ---------------------------------------------------------------------------

describe('ErrDownloadStalled', () => {
  it('should have correct name', () => {
    const err = new ErrDownloadStalled('https://example.com/file', 60);
    expect(err.name).toBe('ErrDownloadStalled');
  });

  it('should include URL and stall seconds in message', () => {
    const err = new ErrDownloadStalled('https://example.com/binary.tar.gz', 60);
    expect(err.message).toContain('no data received for 60s');
    expect(err.message).toContain('https://example.com/binary.tar.gz');
  });

  it('should be an instance of Error', () => {
    const err = new ErrDownloadStalled('https://example.com/file', 30);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// downloadFile retry behavior
// ---------------------------------------------------------------------------

describe('downloadFile retry', () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpDir = await mkdtemp(join(tmpdir(), 'retry-test-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should reject http:// URLs (HTTPS enforcement)', async () => {
    const { join } = await import('node:path');
    const destPath = join(tmpDir, 'file.bin');
    await expect(
      downloadFile('http://cdn.example.com/file.tar.gz', destPath),
    ).rejects.toThrow('HTTPS required');
  });

  it('should allow http://localhost for dev', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { join } = await import('node:path');
    const destPath = join(tmpDir, 'local-file.bin');
    await downloadFile('http://localhost:8080/file.tar.gz', destPath);

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(destPath, 'utf-8');
    expect(content).toBe('ok');
  });

  it('should not retry on HTTP 404 (non-retryable)', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValue(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );
    globalThis.fetch = mockFn;

    const { join } = await import('node:path');
    const destPath = join(tmpDir, 'missing.bin');
    await expect(
      downloadFile('https://cdn.example.com/missing.tar.gz', destPath),
    ).rejects.toThrow('404');

    // Should have been called only once (no retries for 4xx)
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on network errors', async () => {
    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = mockFn;

    const { join } = await import('node:path');
    const destPath = join(tmpDir, 'retried.bin');
    await downloadFile('https://cdn.example.com/file.tar.gz', destPath);

    // Should have retried once
    expect(mockFn).toHaveBeenCalledTimes(2);
  });
});
