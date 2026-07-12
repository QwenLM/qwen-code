/**
 * Tests for npm registry extension support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNpmPackageSource,
  isScopedNpmPackage,
  resolveNpmRegistry,
  checkNpmUpdate,
  downloadFromNpmRegistry,
} from './npm.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { ExtensionUpdateState } from './extensionManager.js';
import * as fs from 'node:fs';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  createWriteStream: vi.fn(),
  promises: {
    readdir: vi.fn(),
    rename: vi.fn(),
    rmdir: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  },
}));

describe('parseNpmPackageSource', () => {
  it('should parse scoped package without version', () => {
    const result = parseNpmPackageSource('@ali/openclaw-tmcp-dingtalk');
    expect(result.name).toBe('@ali/openclaw-tmcp-dingtalk');
    expect(result.version).toBeUndefined();
  });

  it('should parse scoped package with version', () => {
    const result = parseNpmPackageSource('@ali/openclaw-tmcp-dingtalk@1.2.0');
    expect(result.name).toBe('@ali/openclaw-tmcp-dingtalk');
    expect(result.version).toBe('1.2.0');
  });

  it('should parse scoped package with latest tag', () => {
    const result = parseNpmPackageSource('@scope/pkg@latest');
    expect(result.name).toBe('@scope/pkg');
    expect(result.version).toBe('latest');
  });

  it('should parse scoped package with semver range', () => {
    const result = parseNpmPackageSource('@scope/pkg@^1.0.0');
    expect(result.name).toBe('@scope/pkg');
    expect(result.version).toBe('^1.0.0');
  });

  it('should throw for invalid source', () => {
    expect(() => parseNpmPackageSource('not-scoped')).toThrow(
      'Invalid scoped npm package source',
    );
  });

  it('should throw for unscoped package', () => {
    expect(() => parseNpmPackageSource('some-package')).toThrow(
      'Invalid scoped npm package source',
    );
  });

  it('should redact URL credentials in invalid source errors', () => {
    const source = 'https://user:token@example.com/some-package';

    let message = '';
    try {
      parseNpmPackageSource(source);
    } catch (error: unknown) {
      message = String(error);
    }

    expect(message).toContain(
      'https://***REDACTED***@example.com/some-package',
    );
    expect(message).not.toContain('user');
    expect(message).not.toContain('token');
  });
});

describe('isScopedNpmPackage', () => {
  it('should return true for scoped package', () => {
    expect(isScopedNpmPackage('@ali/openclaw-tmcp-dingtalk')).toBe(true);
  });

  it('should return true for scoped package with version', () => {
    expect(isScopedNpmPackage('@ali/openclaw-tmcp-dingtalk@1.2.0')).toBe(true);
  });

  it('should return true for scoped package with dots', () => {
    expect(isScopedNpmPackage('@my.org/my.pkg')).toBe(true);
  });

  it('should return false for owner/repo format', () => {
    expect(isScopedNpmPackage('owner/repo')).toBe(false);
  });

  it('should return false for unscoped package', () => {
    expect(isScopedNpmPackage('some-package')).toBe(false);
  });

  it('should return false for git URL', () => {
    expect(isScopedNpmPackage('https://github.com/owner/repo')).toBe(false);
  });

  it('should return false for local path', () => {
    expect(isScopedNpmPackage('/path/to/extension')).toBe(false);
  });
});

describe('resolveNpmRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return CLI override when provided', () => {
    const result = resolveNpmRegistry(
      '@ali',
      'https://registry.npmmirror.com/',
    );
    expect(result).toBe('https://registry.npmmirror.com');
  });

  it('should return scoped registry from .npmrc', () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      '@ali:registry=https://registry.npmmirror.com/\nregistry=https://custom.registry.com/',
    );

    const result = resolveNpmRegistry('@ali');
    expect(result).toBe('https://registry.npmmirror.com');
  });

  it('should return default registry from .npmrc when no scoped match', () => {
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      'registry=https://custom.registry.com/',
    );

    const result = resolveNpmRegistry('@other');
    expect(result).toBe('https://custom.registry.com');
  });

  it('should return npmjs.org as fallback', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = resolveNpmRegistry('@ali');
    expect(result).toBe('https://registry.npmjs.org');
  });
});

// Mock https/http for checkNpmUpdate tests
vi.mock('node:https', () => ({
  get: vi.fn(),
}));

vi.mock('node:http', () => ({
  get: vi.fn(),
}));

vi.mock('tar', () => ({
  t: vi.fn(),
  x: vi.fn(),
}));

// We need to import https after mocking
const https = await import('node:https');
const http = await import('node:http');
const tar = await import('tar');

function mockNpmRegistryResponse(data: object) {
  vi.mocked(https.get).mockImplementation(
    (_url: unknown, _options: unknown, callback: unknown) => {
      const mockRes = {
        statusCode: 200,
        on: vi.fn((event: string, handler: (data?: Buffer) => void) => {
          if (event === 'data') {
            handler(Buffer.from(JSON.stringify(data)));
          }
          if (event === 'end') {
            handler();
          }
        }),
      };
      if (typeof callback === 'function') {
        callback(mockRes as never);
      }
      return { on: vi.fn() } as never;
    },
  );
}

function mockNpmRegistryStatus(statusCode: number) {
  vi.mocked(https.get).mockImplementation(
    (_url: unknown, _options: unknown, callback: unknown) => {
      const mockRes = {
        statusCode,
        headers: {},
        on: vi.fn(),
      };
      if (typeof callback === 'function') {
        callback(mockRes as never);
      }
      return { on: vi.fn() } as never;
    },
  );
}

function mockNpmDownload(tarballUrl: string, tarballBytes?: number) {
  let requestCount = 0;
  vi.mocked(https.get).mockImplementation(
    (_url: unknown, _options: unknown, callback: unknown) => {
      requestCount += 1;
      const mockRes =
        requestCount === 1
          ? {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: (data?: Buffer) => void) => {
                if (event === 'data') {
                  handler(
                    Buffer.from(
                      JSON.stringify({
                        'dist-tags': { latest: '1.0.0' },
                        versions: {
                          '1.0.0': { dist: { tarball: tarballUrl } },
                        },
                      }),
                    ),
                  );
                }
                if (event === 'end') handler();
              }),
            }
          : {
              statusCode: 200,
              headers: {},
              on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
                if (event === 'data' && tarballBytes !== undefined) {
                  handler({ length: tarballBytes } as Buffer);
                }
              }),
              pipe: vi.fn(),
              destroy: vi.fn(),
            };
      if (typeof callback === 'function') callback(mockRes as never);
      return {
        on: vi.fn().mockReturnThis(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      } as never;
    },
  );
}

describe('downloadFromNpmRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.createWriteStream).mockReturnValue({
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'finish') {
          handler();
        }
      }),
      close: vi.fn((callback: () => void) => callback()),
      destroy: vi.fn(),
    } as never);
    vi.mocked(tar.t).mockResolvedValue(undefined);
    vi.mocked(tar.x).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('redacts credentialed registry URLs in metadata request errors', async () => {
    mockNpmRegistryStatus(404);

    await expect(
      downloadFromNpmRegistry(
        {
          source: '@scope/pkg',
          type: 'npm',
          registryUrl: 'https://user:token@registry.example.com',
        },
        '/tmp/qwen-extension',
      ),
    ).rejects.toThrow(
      'npm registry request failed with status 404: https://***REDACTED***@registry.example.com/@scope%2fpkg',
    );
  });

  it('uses the HTTPS client for uppercase HTTPS tarball URLs', async () => {
    vi.mocked(http.get).mockImplementation(() => {
      throw new Error('wrong client');
    });
    mockNpmDownload('HTTPS://registry.example.com/@scope/pkg/-/pkg-1.0.0.tgz');

    await expect(
      downloadFromNpmRegistry(
        {
          source: '@scope/pkg',
          type: 'npm',
          registryUrl: 'HTTPS://registry.example.com',
        },
        '/tmp/qwen-extension',
      ),
    ).resolves.toEqual({ version: '1.0.0', type: 'npm' });
    expect(https.get).toHaveBeenCalledTimes(2);
    expect(http.get).not.toHaveBeenCalled();
  });

  it.each(['SymbolicLink', 'Link'] as const)(
    'rejects npm tarballs containing %s entries before extraction',
    async (type) => {
      mockNpmDownload('https://registry.example.com/pkg.tgz');
      vi.mocked(tar.t).mockImplementationOnce(async (options) => {
        options.onReadEntry?.({
          type,
          path: 'package/escape',
        } as never);
      });

      await expect(
        downloadFromNpmRegistry(
          {
            source: '@scope/pkg',
            type: 'npm',
            registryUrl: 'https://registry.example.com',
          },
          '/tmp/qwen-extension',
        ),
      ).rejects.toThrow(
        'Tar archive contains unsupported link entry: package/escape',
      );
      expect(tar.x).not.toHaveBeenCalled();
    },
  );

  it('sanitizes and bounds rejected tar entry paths', async () => {
    mockNpmDownload('https://registry.example.com/pkg.tgz');
    vi.mocked(tar.t).mockImplementationOnce(async (options) => {
      options.onReadEntry?.({
        type: 'SymbolicLink',
        path: `escape\n\u001b]8;;https://example.com\u0007${'x'.repeat(300)}`,
      } as never);
    });

    let message = '';
    try {
      await downloadFromNpmRegistry(
        {
          source: '@scope/pkg',
          type: 'npm',
          registryUrl: 'https://registry.example.com',
        },
        '/tmp/qwen-extension',
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain('\n');
    expect(message).not.toContain('\r');
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('\u0007');
    expect(message).toContain('Tar archive contains unsupported link entry:');
    expect(message).toHaveLength(
      'Tar archive contains unsupported link entry: '.length + 200,
    );
    expect(message.endsWith('...')).toBe(true);
  });

  it('rejects tar links whose sanitized path is empty', async () => {
    mockNpmDownload('https://registry.example.com/pkg.tgz');
    vi.mocked(tar.t).mockImplementationOnce(async (options) => {
      options.onReadEntry?.({
        type: 'SymbolicLink',
        path: '\u001b[31m\u001b[0m\u0007',
      } as never);
    });

    await expect(
      downloadFromNpmRegistry(
        {
          source: '@scope/pkg',
          type: 'npm',
          registryUrl: 'https://registry.example.com',
        },
        '/tmp/qwen-extension',
      ),
    ).rejects.toThrow(
      'Tar archive contains unsupported link entry: <sanitized empty path>',
    );
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('rejects npm tarballs larger than 100 MB', async () => {
    mockNpmDownload(
      'https://registry.example.com/pkg.tgz',
      100 * 1024 * 1024 + 1,
    );

    await expect(
      downloadFromNpmRegistry(
        {
          source: '@scope/pkg',
          type: 'npm',
          registryUrl: 'https://registry.example.com',
        },
        '/tmp/qwen-extension',
      ),
    ).rejects.toThrow(
      'npm extension archive download exceeded maximum size of 104857600 bytes',
    );
    expect(tar.t).not.toHaveBeenCalled();
  });

  it('times out a stalled npm tarball download', async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    const destroy = vi.fn();
    vi.mocked(https.get).mockImplementation(
      (_url: unknown, _options: unknown, callback: unknown) => {
        requestCount += 1;
        if (requestCount === 1 && typeof callback === 'function') {
          callback({
            statusCode: 200,
            headers: {},
            on: vi.fn((event: string, handler: (data?: Buffer) => void) => {
              if (event === 'data') {
                handler(
                  Buffer.from(
                    JSON.stringify({
                      'dist-tags': { latest: '1.0.0' },
                      versions: {
                        '1.0.0': {
                          dist: {
                            tarball: 'https://registry.example.com/pkg.tgz',
                          },
                        },
                      },
                    }),
                  ),
                );
              }
              if (event === 'end') handler();
            }),
          } as never);
        }
        return {
          on: vi.fn().mockReturnThis(),
          setTimeout: vi.fn(),
          destroy,
        } as never;
      },
    );

    const outcome = downloadFromNpmRegistry(
      {
        source: '@scope/pkg',
        type: 'npm',
        registryUrl: 'https://registry.example.com',
      },
      '/tmp/qwen-extension',
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(outcome).resolves.toMatchObject({
      message: 'npm tarball download timed out after 120000ms',
    });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('checkNpmUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report UPDATE_AVAILABLE when latest is newer', async () => {
    mockNpmRegistryResponse({
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { dist: { tarball: '' } } },
    });

    const metadata: ExtensionInstallMetadata = {
      source: '@scope/pkg',
      type: 'npm',
      releaseTag: '1.0.0',
      registryUrl: 'https://registry.npmjs.org',
    };

    const result = await checkNpmUpdate(metadata);
    expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
  });

  it('uses the HTTPS client for uppercase HTTPS registry URLs', async () => {
    vi.mocked(http.get).mockImplementation(() => {
      throw new Error('wrong client');
    });
    mockNpmRegistryResponse({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dist: { tarball: '' } } },
    });

    const metadata: ExtensionInstallMetadata = {
      source: '@scope/pkg',
      type: 'npm',
      releaseTag: '1.0.0',
      registryUrl: 'HTTPS://registry.npmjs.org',
    };

    const result = await checkNpmUpdate(metadata);

    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
    expect(https.get).toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('should report UP_TO_DATE when latest matches', async () => {
    mockNpmRegistryResponse({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dist: { tarball: '' } } },
    });

    const metadata: ExtensionInstallMetadata = {
      source: '@scope/pkg',
      type: 'npm',
      releaseTag: '1.0.0',
      registryUrl: 'https://registry.npmjs.org',
    };

    const result = await checkNpmUpdate(metadata);
    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
  });

  it('should report UP_TO_DATE for pinned exact version', async () => {
    mockNpmRegistryResponse({
      'dist-tags': { latest: '2.0.0' },
      versions: {
        '1.0.0': { dist: { tarball: '' } },
        '2.0.0': { dist: { tarball: '' } },
      },
    });

    const metadata: ExtensionInstallMetadata = {
      source: '@scope/pkg@1.0.0',
      type: 'npm',
      releaseTag: '1.0.0',
      registryUrl: 'https://registry.npmjs.org',
    };

    const result = await checkNpmUpdate(metadata);
    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
  });

  it('should check correct dist-tag for non-latest tag installs', async () => {
    mockNpmRegistryResponse({
      'dist-tags': { latest: '1.0.0', beta: '2.0.0-beta.2' },
      versions: {
        '1.0.0': { dist: { tarball: '' } },
        '2.0.0-beta.1': { dist: { tarball: '' } },
        '2.0.0-beta.2': { dist: { tarball: '' } },
      },
    });

    const metadata: ExtensionInstallMetadata = {
      source: '@scope/pkg@beta',
      type: 'npm',
      releaseTag: '2.0.0-beta.1',
      registryUrl: 'https://registry.npmjs.org',
    };

    const result = await checkNpmUpdate(metadata);
    expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
  });

  it('should report UP_TO_DATE for beta tag when on latest beta', async () => {
    mockNpmRegistryResponse({
      'dist-tags': { latest: '1.0.0', beta: '2.0.0-beta.2' },
      versions: {
        '1.0.0': { dist: { tarball: '' } },
        '2.0.0-beta.2': { dist: { tarball: '' } },
      },
    });

    const metadata: ExtensionInstallMetadata = {
      source: '@scope/pkg@beta',
      type: 'npm',
      releaseTag: '2.0.0-beta.2',
      registryUrl: 'https://registry.npmjs.org',
    };

    const result = await checkNpmUpdate(metadata);
    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
  });
});
