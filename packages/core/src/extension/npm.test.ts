/**
 * Tests for npm registry extension support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNpmPackageSource,
  isScopedNpmPackage,
  resolveNpmRegistry,
  checkNpmUpdate,
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

// We need to import https after mocking
const https = await import('node:https');

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
