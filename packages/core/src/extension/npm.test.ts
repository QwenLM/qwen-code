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
import { promises as dns } from 'node:dns';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  createReadStream: vi.fn(() => ({ destroy: vi.fn() }) as never),
  createWriteStream: vi.fn(),
  promises: {
    readdir: vi.fn(),
    rename: vi.fn(),
    rmdir: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

describe('parseNpmPackageSource', () => {
  it.each<[string, string, string | undefined]>([
    ['without version', '@ali/openclaw-tmcp-dingtalk', undefined],
    ['with version', '@ali/openclaw-tmcp-dingtalk', '1.2.0'],
    ['with latest tag', '@scope/pkg', 'latest'],
    ['with semver range', '@scope/pkg', '^1.0.0'],
  ])('should parse scoped package %s', (_, name, version) => {
    const result = parseNpmPackageSource(version ? `${name}@${version}` : name);
    expect(result.name).toBe(name);
    expect(result.version).toBe(version);
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
  it.each([
    ['scoped package', '@ali/openclaw-tmcp-dingtalk'],
    ['scoped package with version', '@ali/openclaw-tmcp-dingtalk@1.2.0'],
    ['scoped package with dots', '@my.org/my.pkg'],
  ])('should return true for %s', (_, source) => {
    expect(isScopedNpmPackage(source)).toBe(true);
  });

  it.each([
    ['owner/repo format', 'owner/repo'],
    ['unscoped package', 'some-package'],
    ['git URL', 'https://github.com/owner/repo'],
    ['local path', '/path/to/extension'],
  ])('should return false for %s', (_, source) => {
    expect(isScopedNpmPackage(source)).toBe(false);
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

/**
 * Answers the n-th https.get call (1-based) with the response `reply` returns
 * (none when it returns undefined; it may answer later through `respond`),
 * and returns `request(n)` as the client request.
 */
function mockGet(
  reply: (n: number, respond: (res: object) => void) => object | void,
  request: (n: number) => object = () => ({
    on: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  }),
) {
  let n = 0;
  vi.mocked(https.get).mockImplementation(
    (_url: unknown, _options: unknown, callback: unknown) => {
      n += 1;
      const respond = (res: object) => {
        if (typeof callback === 'function') callback(res as never);
      };
      const res = reply(n, respond);
      if (res) respond(res);
      return request(n) as never;
    },
  );
}

/** `{ statusCode, headers: {}, on }`, with `extra` adding or replacing fields. */
const response = <T extends object>(statusCode: number, extra: T) => ({
  statusCode,
  headers: {},
  on: vi.fn(),
  ...extra,
});

/** Metadata redirects are drained with `resume`, tarball ones `destroy`ed. */
const redirect = (location: string, cleanup: 'resume' | 'destroy') =>
  response(302, { headers: { location }, [cleanup]: vi.fn() });

const tarball = (destroy = vi.fn()) =>
  response(200, { pipe: vi.fn(), destroy });

/** A 200 response that emits `data` as one JSON chunk and then ends. */
const jsonResponse = (data: object) =>
  response(200, {
    on: vi.fn((event: string, handler: (data?: Buffer) => void) => {
      if (event === 'data') handler(Buffer.from(JSON.stringify(data)));
      if (event === 'end') handler();
    }),
  });

/** Metadata whose only version, 1.0.0 (latest), has this tarball. */
const npmMetadataResponse = (tarball: string) =>
  jsonResponse({
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { dist: { tarball } } },
  });

const TGZ = 'https://registry.example.com/pkg.tgz';

function mockNpmDownload(tarballUrl: string, tarballBytes?: number) {
  mockGet((n) =>
    n === 1
      ? npmMetadataResponse(tarballUrl)
      : response(200, {
          on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
            if (event === 'data' && tarballBytes !== undefined) {
              handler({ length: tarballBytes } as Buffer);
            }
          }),
          pipe: vi.fn(),
          destroy: vi.fn(),
        }),
  );
}

/** Downloads @scope/pkg from registry.example.com; `meta` overrides fields. */
const download = (
  meta: Partial<ExtensionInstallMetadata> = {},
  signal?: AbortSignal,
) =>
  downloadFromNpmRegistry(
    {
      source: '@scope/pkg',
      type: 'npm',
      registryUrl: 'https://registry.example.com',
      ...meta,
    },
    '/tmp/qwen-extension',
    signal,
  );

/** Serves one tar entry list to the next tar.t inspection. */
function mockTarEntries(...entries: Array<{ type: string; path: string }>) {
  mockNpmDownload(TGZ);
  vi.mocked(tar.t).mockImplementationOnce(async (options) => {
    for (const entry of entries) options.onReadEntry?.(entry as never);
  });
}

/** Crosses the 120s download deadline; `outcome` must reject with it. */
async function expectTimedOut(outcome: Promise<unknown>) {
  const settled = outcome.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(settled).resolves.toMatchObject({
    message: 'npm tarball download timed out after 120000ms',
  });
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
    vi.unstubAllEnvs();
  });

  it('does not send the ambient npm token to an override registry', async () => {
    vi.stubEnv('NPM_TOKEN', 'ambient-secret');
    mockNpmDownload(TGZ);

    await download();

    expect(vi.mocked(https.get).mock.calls[0]?.[1]).toMatchObject({
      headers: {},
    });
  });

  it('sends the ambient npm token to the configured registry origin', async () => {
    vi.stubEnv('NPM_TOKEN', 'ambient-secret');
    mockNpmDownload('https://registry.npmjs.org/pkg.tgz');

    await download({ registryUrl: 'https://registry.npmjs.org/custom-path' });

    expect(vi.mocked(https.get).mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer ambient-secret' },
    });
  });

  it('redacts credentialed registry URLs in metadata request errors', async () => {
    const res = response(404, { resume: vi.fn() });
    mockGet(() => res);

    await expect(
      download({ registryUrl: 'https://user:token@registry.example.com' }),
    ).rejects.toThrow(
      'npm registry request failed with status 404: https://***REDACTED***@registry.example.com/@scope%2fpkg',
    );
    expect(res.resume).toHaveBeenCalled();
  });

  it('rejects npm metadata response stream errors', async () => {
    const responseError = new Error('metadata response interrupted');
    mockGet(() =>
      response(200, {
        on: vi.fn((event: string, handler: (error?: Error) => void) => {
          if (event === 'error') queueMicrotask(() => handler(responseError));
        }),
      }),
    );

    await expect(download()).rejects.toBe(responseError);
  });

  it('destroys npm metadata responses that exceed the size limit', async () => {
    const res = response(200, {
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (data?: Buffer) => void) => {
        if (event === 'data') {
          handler(Buffer.alloc(6 * 1024 * 1024));
          handler(Buffer.alloc(6 * 1024 * 1024));
        }
        if (event === 'end') handler();
      }),
    });
    mockGet(() => res);

    await expect(download()).rejects.toThrow(
      'npm package metadata exceeded maximum size',
    );
    expect(res.destroy).toHaveBeenCalledOnce();
  });

  it('destroys non-200 npm tarball responses before rejecting', async () => {
    const res = response(503, { destroy: vi.fn() });
    mockGet((n) => (n === 1 ? npmMetadataResponse(TGZ) : res));

    await expect(download()).rejects.toThrow(
      'Failed to download npm tarball: status 503',
    );
    expect(res.destroy).toHaveBeenCalled();
  });

  it('preserves the original reason for a pre-aborted npm download', async () => {
    const controller = new AbortController();
    const reason = new Error('download cancelled');
    controller.abort(reason);

    await expect(download({}, controller.signal)).rejects.toBe(reason);
    expect(https.get).not.toHaveBeenCalled();
    expect(tar.t).not.toHaveBeenCalled();
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('uses the HTTPS client for uppercase HTTPS tarball URLs', async () => {
    vi.mocked(http.get).mockImplementation(() => {
      throw new Error('wrong client');
    });
    mockNpmDownload('HTTPS://registry.example.com/@scope/pkg/-/pkg-1.0.0.tgz');

    await expect(
      download({ registryUrl: 'HTTPS://registry.example.com' }),
    ).resolves.toEqual({ version: '1.0.0', type: 'npm' });
    expect(https.get).toHaveBeenCalledTimes(2);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('rejects a public-policy tarball URL targeting the private network', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ] as never);
    mockGet(() => npmMetadataResponse('http://127.0.0.1/internal.tgz'));

    await expect(download({ networkPolicy: 'public' })).rejects.toThrow(
      'must use HTTPS',
    );

    expect(https.get).toHaveBeenCalledTimes(1);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('resolves relative npm metadata redirects', async () => {
    mockGet((n) =>
      n === 1
        ? redirect('/redirected-metadata', 'resume')
        : n === 2
          ? npmMetadataResponse(TGZ)
          : tarball(),
    );

    await expect(download()).resolves.toEqual({
      version: '1.0.0',
      type: 'npm',
    });
    expect(vi.mocked(https.get).mock.calls[1]?.[0]).toBe(
      'https://registry.example.com/redirected-metadata',
    );
  });

  it('rejects an invalid npm metadata redirect from an async response', async () => {
    mockGet((_n, respond) => {
      queueMicrotask(() => respond(redirect('http://[', 'resume')));
    });

    await expect(download()).rejects.toThrow(
      'Invalid npm redirect URL: http://[',
    );
    expect(tar.t).not.toHaveBeenCalled();
  });

  it('stops following npm metadata redirect loops', async () => {
    mockGet(() => redirect('/metadata-loop', 'resume'));

    await expect(download()).rejects.toThrow(
      'Too many redirects while fetching npm package metadata',
    );
    expect(https.get).toHaveBeenCalledTimes(11);
  });

  it('resolves relative npm tarball redirects', async () => {
    mockGet((n) =>
      n === 1
        ? npmMetadataResponse(TGZ)
        : n === 2
          ? redirect('/pkg-final.tgz', 'destroy')
          : tarball(),
    );

    await expect(download()).resolves.toEqual({
      version: '1.0.0',
      type: 'npm',
    });
    expect(vi.mocked(https.get).mock.calls[2]?.[0]).toBe(
      'https://registry.example.com/pkg-final.tgz',
    );
  });

  it('stops following npm tarball redirect loops', async () => {
    mockGet((n) =>
      n === 1 ? npmMetadataResponse(TGZ) : redirect('/tarball-loop', 'destroy'),
    );

    await expect(download()).rejects.toThrow(
      'Too many redirects while downloading npm package',
    );
    expect(https.get).toHaveBeenCalledTimes(12);
  });

  it('preserves the original abort reason during a redirected npm download', async () => {
    const controller = new AbortController();
    const reason = new Error('download cancelled');
    let finalRequestError: ((error: Error) => void) | undefined;
    mockGet(
      (n) =>
        n === 1
          ? npmMetadataResponse(TGZ)
          : n === 2
            ? redirect('/pkg-final.tgz', 'destroy')
            : undefined,
      (n) => ({
        on: vi.fn(function (
          this: unknown,
          event: string,
          handler: (error: Error) => void,
        ) {
          if (n === 3 && event === 'error') finalRequestError = handler;
          return this;
        }),
        destroy: vi.fn(),
      }),
    );

    const outcome = download({}, controller.signal);
    await vi.waitFor(() => expect(https.get).toHaveBeenCalledTimes(3));
    expect(
      (vi.mocked(https.get).mock.calls[2]?.[1] as { signal?: AbortSignal })
        .signal?.aborted,
    ).toBe(false);

    controller.abort(reason);
    finalRequestError?.(new Error('request aborted'));

    await expect(outcome).rejects.toBe(reason);
    expect(tar.t).not.toHaveBeenCalled();
    expect(tar.x).not.toHaveBeenCalled();
  });

  it.each(['SymbolicLink', 'Link'] as const)(
    'rejects npm tarballs containing %s entries before extraction',
    async (type) => {
      mockTarEntries({ type, path: 'package/escape' });

      await expect(download()).rejects.toThrow(
        'Tar archive contains unsupported link entry: package/escape',
      );
      expect(tar.x).not.toHaveBeenCalled();
    },
  );

  it('sanitizes and bounds rejected tar entry paths', async () => {
    mockTarEntries({
      type: 'SymbolicLink',
      path: `escape\n\u001b]8;;https://example.com\u0007${'x'.repeat(300)}`,
    });

    let message = '';
    try {
      await download();
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
    mockTarEntries({ type: 'SymbolicLink', path: '\u001b[31m\u001b[0m\u0007' });

    await expect(download()).rejects.toThrow(
      'Tar archive contains unsupported link entry: <sanitized empty path>',
    );
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('reports every rejected tar link', async () => {
    mockTarEntries(
      { type: 'SymbolicLink', path: 'package/first-link' },
      { type: 'Link', path: 'package/second-link' },
    );

    await expect(download()).rejects.toThrow(
      'Tar archive contains 2 unsupported link entries: package/first-link, package/second-link',
    );
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('bounds rejected tar link collection', async () => {
    mockTarEntries(
      ...Array.from({ length: 101 }, (_, index) => ({
        type: 'SymbolicLink',
        path: `package/link-${index}`,
      })),
    );

    await expect(download()).rejects.toThrow(
      'more than 100 unsupported link entries',
    );
    expect(tar.x).not.toHaveBeenCalled();

    // Tripping the link-count cap makes failValidation destroy the read
    // stream, so the mocked stream must be destroyable: before it was, this
    // path raised a TypeError inside the tar.t mock instead of completing.
    const createdStream = vi.mocked(fs.createReadStream).mock.results[0]
      ?.value as { destroy: ReturnType<typeof vi.fn> } | undefined;
    expect(createdStream?.destroy).toHaveBeenCalled();
    await expect(
      vi.mocked(tar.t).mock.results[0]?.value as Promise<unknown>,
    ).resolves.toBeUndefined();
  });

  it('stops between tar inspection and extraction when cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('inspection cancelled');
    mockNpmDownload(TGZ);
    vi.mocked(tar.t).mockImplementationOnce(async () => {
      controller.abort(reason);
    });

    await expect(download({}, controller.signal)).rejects.toBe(reason);
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('rejects npm tarballs larger than 100 MB', async () => {
    mockNpmDownload(TGZ, 100 * 1024 * 1024 + 1);

    await expect(download()).rejects.toThrow(
      'npm extension archive download exceeded maximum size of 104857600 bytes',
    );
    expect(tar.t).not.toHaveBeenCalled();
  });

  it('times out a stalled npm tarball download', async () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    mockGet(
      (n) => (n === 1 ? npmMetadataResponse(TGZ) : undefined),
      () => ({ on: vi.fn().mockReturnThis(), destroy }),
    );

    await expectTimedOut(download());
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not start a tarball request when DNS outlives the deadline', async () => {
    vi.useFakeTimers();
    let resolveTarballDns: ((value: unknown) => void) | undefined;
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTarballDns = resolve;
          }) as never,
      );
    mockGet(() => npmMetadataResponse('https://cdn.example.com/pkg.tgz'));

    const outcome = download({ networkPolicy: 'public' }).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    await expectTimedOut(outcome);
    expect(https.get).toHaveBeenCalledOnce();
    resolveTarballDns?.([{ address: '8.8.4.4', family: 4 }]);
    await Promise.resolve();
    expect(https.get).toHaveBeenCalledOnce();
  });

  it('destroys a stalled npm response and file at the download deadline', async () => {
    vi.useFakeTimers();
    const responseDestroy = vi.fn();
    const fileDestroy = vi.fn();
    vi.mocked(fs.createWriteStream).mockReturnValue({
      on: vi.fn(),
      close: vi.fn(),
      destroy: fileDestroy,
    } as never);
    mockGet((n) =>
      n === 1 ? npmMetadataResponse(TGZ) : tarball(responseDestroy),
    );

    await expectTimedOut(download());
    expect(responseDestroy).toHaveBeenCalledOnce();
    expect(fileDestroy).toHaveBeenCalledOnce();
    expect(tar.t).not.toHaveBeenCalled();
    expect(tar.x).not.toHaveBeenCalled();
  });

  it('times out the active request across npm tarball redirects', async () => {
    vi.useFakeTimers();
    const childDestroy = vi.fn();
    mockGet(
      (n, respond) => {
        if (n === 2) {
          setTimeout(
            () =>
              respond(redirect('https://cdn.example.com/pkg.tgz', 'destroy')),
            119_999,
          );
        }
        return n === 1 ? npmMetadataResponse(TGZ) : undefined;
      },
      (n) => ({
        on: vi.fn().mockReturnThis(),
        destroy: n === 3 ? childDestroy : vi.fn(),
      }),
    );

    await expectTimedOut(download());
    expect(childDestroy).toHaveBeenCalledOnce();
    expect(tar.t).not.toHaveBeenCalled();
    expect(tar.x).not.toHaveBeenCalled();
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

  /** Serves these dist-tags and versions, then checks `source`@`releaseTag`. */
  const check = (
    source: string,
    releaseTag: string,
    tags: Record<string, string>,
    versions: string[],
    registryUrl = 'https://registry.npmjs.org',
  ) => {
    mockGet(() =>
      jsonResponse({
        'dist-tags': tags,
        versions: Object.fromEntries(
          versions.map((v) => [v, { dist: { tarball: '' } }]),
        ),
      }),
    );
    return checkNpmUpdate({ source, type: 'npm', releaseTag, registryUrl });
  };

  it('should report UPDATE_AVAILABLE when latest is newer', async () => {
    const result = await check('@scope/pkg', '1.0.0', { latest: '2.0.0' }, [
      '2.0.0',
    ]);
    expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
  });

  it('uses the HTTPS client for uppercase HTTPS registry URLs', async () => {
    vi.mocked(http.get).mockImplementation(() => {
      throw new Error('wrong client');
    });

    const result = await check(
      '@scope/pkg',
      '1.0.0',
      { latest: '1.0.0' },
      ['1.0.0'],
      'HTTPS://registry.npmjs.org',
    );

    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
    expect(https.get).toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('should report UP_TO_DATE when latest matches', async () => {
    const result = await check('@scope/pkg', '1.0.0', { latest: '1.0.0' }, [
      '1.0.0',
    ]);
    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
  });

  it('should report UP_TO_DATE for pinned exact version', async () => {
    const result = await check(
      '@scope/pkg@1.0.0',
      '1.0.0',
      { latest: '2.0.0' },
      ['1.0.0', '2.0.0'],
    );
    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
  });

  it('should check correct dist-tag for non-latest tag installs', async () => {
    const result = await check(
      '@scope/pkg@beta',
      '2.0.0-beta.1',
      { latest: '1.0.0', beta: '2.0.0-beta.2' },
      ['1.0.0', '2.0.0-beta.1', '2.0.0-beta.2'],
    );
    expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
  });

  it('should report UP_TO_DATE for beta tag when on latest beta', async () => {
    const result = await check(
      '@scope/pkg@beta',
      '2.0.0-beta.2',
      { latest: '1.0.0', beta: '2.0.0-beta.2' },
      ['1.0.0', '2.0.0-beta.2'],
    );
    expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
  });
});
