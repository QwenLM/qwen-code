/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  checkForUpdates,
  checkForUpdatesDetailed,
  fetchGlobalNpmUpdateInfo,
  FETCH_TIMEOUT_MS,
  isGlobalNpmInstallation,
  runGlobalNpm,
  UpdateCheckTimeoutError,
} from './updateCheck.js';

const getPackageJson = vi.hoisted(() => vi.fn());
vi.mock('../../utils/package.js', () => ({
  getPackageJson,
}));

const updateNotifier = vi.hoisted(() => vi.fn());
vi.mock('update-notifier', () => ({
  default: updateNotifier,
}));

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    // Clear DEV environment variable before each test
    delete process.env['DEV'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return null when running from source (DEV=true)', async () => {
    process.env['DEV'] = 'true';
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi
        .fn()
        .mockResolvedValue({ current: '1.0.0', latest: '1.1.0' }),
    });
    const result = await checkForUpdates();
    expect(result).toBeNull();
    expect(getPackageJson).not.toHaveBeenCalled();
    expect(updateNotifier).not.toHaveBeenCalled();
  });

  it('should return null if package.json is missing', async () => {
    getPackageJson.mockResolvedValue(null);
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if there is no update', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi.fn().mockResolvedValue(null),
    });
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return a message if a newer version is available', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi
        .fn()
        .mockResolvedValue({ current: '1.0.0', latest: '1.1.0' }),
    });

    const result = await checkForUpdates();
    expect(result?.message).toContain('1.0.0 → 1.1.0');
    expect(result?.update).toEqual({ current: '1.0.0', latest: '1.1.0' });
  });

  it('should return null if the latest version is the same as the current version', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi
        .fn()
        .mockResolvedValue({ current: '1.0.0', latest: '1.0.0' }),
    });
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if the latest version is older than the current version', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.1.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi
        .fn()
        .mockResolvedValue({ current: '1.1.0', latest: '1.0.0' }),
    });
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if fetchInfo rejects', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi.fn().mockRejectedValue(new Error('Timeout')),
    });

    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return a detailed skipped result in DEV mode', async () => {
    process.env['DEV'] = 'true';

    const result = await checkForUpdatesDetailed();

    expect(result).toEqual({ status: 'skipped', reason: 'development mode' });
    expect(getPackageJson).not.toHaveBeenCalled();
    expect(updateNotifier).not.toHaveBeenCalled();
  });

  it('should return a detailed skipped result if package metadata is missing', async () => {
    getPackageJson.mockResolvedValue(null);

    const result = await checkForUpdatesDetailed();

    expect(result).toEqual({
      status: 'skipped',
      reason: 'package metadata unavailable',
    });
  });

  it('should return a detailed up-to-date result when there is no update', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi.fn().mockResolvedValue(null),
    });

    const result = await checkForUpdatesDetailed();

    expect(result).toEqual({ status: 'up-to-date', currentVersion: '1.0.0' });
  });

  it('should return a detailed error result if fetchInfo rejects', async () => {
    const error = new Error('Timeout');
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi.fn().mockRejectedValue(error),
    });

    const result = await checkForUpdatesDetailed();

    expect(result).toEqual({
      status: 'error',
      error,
      currentVersion: '1.0.0',
    });
  });

  it('should return a detailed update result when a newer version is available', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi
        .fn()
        .mockResolvedValue({ current: '1.0.0', latest: '1.1.0' }),
    });

    const result = await checkForUpdatesDetailed();

    expect(result).toEqual({
      status: 'update',
      info: {
        message: 'Qwen Code update available! 1.0.0 → 1.1.0',
        update: { current: '1.0.0', latest: '1.1.0' },
      },
    });
  });

  it('checks npm updates in the global npm context', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '"1.1.0"\n',
      stderr: '',
    });

    await expect(
      fetchGlobalNpmUpdateInfo(
        '@qwen-code/qwen-code',
        '1.0.0',
        'latest',
        run as unknown as NonNullable<
          Parameters<typeof fetchGlobalNpmUpdateInfo>[3]
        >,
      ),
    ).resolves.toMatchObject({ current: '1.0.0', latest: '1.1.0' });
    const npmArgs = [
      'view',
      '@qwen-code/qwen-code',
      'dist-tags.latest',
      '--json',
      '--global',
    ];
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/npm-cli\.js$/), ...npmArgs],
      expect.objectContaining({
        timeout: FETCH_TIMEOUT_MS,
      }),
    );
  });

  it('selects the global npm registry for global npm installs', async () => {
    getPackageJson.mockResolvedValue({
      name: '@qwen-code/qwen-code',
      version: '1.0.0',
    });
    const detectGlobalNpm = vi.fn().mockResolvedValue(true);
    const fetchGlobalNpm = vi.fn().mockResolvedValue({
      current: '1.0.0',
      latest: '1.1.0',
    });

    await expect(
      checkForUpdatesDetailed(detectGlobalNpm, fetchGlobalNpm),
    ).resolves.toMatchObject({
      status: 'update',
      info: { update: { current: '1.0.0', latest: '1.1.0' } },
    });

    expect(detectGlobalNpm).toHaveBeenCalledOnce();
    expect(fetchGlobalNpm).toHaveBeenCalledWith(
      '@qwen-code/qwen-code',
      '1.0.0',
      'latest',
    );
    expect(updateNotifier).not.toHaveBeenCalled();
  });

  it('does not treat pnpm installs as global npm installs', async () => {
    const run = vi.fn();

    await expect(
      isGlobalNpmInstallation(
        '/home/user/.pnpm/@qwen-code+qwen-code/node_modules/@qwen-code/qwen-code/dist/index.js',
        run as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[1]
        >,
      ),
    ).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves a bin symlink before matching the npm package path', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '/usr/local/lib/node_modules\n',
      stderr: '',
    });
    const canonicalize = vi.fn(async (candidate: string) =>
      candidate === '/usr/local/bin/qwen'
        ? '/usr/local/lib/node_modules/@qwen-code/qwen-code/dist/cli.js'
        : '/usr/local/lib/node_modules',
    );

    await expect(
      isGlobalNpmInstallation(
        '/usr/local/bin/qwen',
        run as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[1]
        >,
        canonicalize as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[2]
        >,
      ),
    ).resolves.toBe(true);
  });

  it('runs the Windows npm CLI through Node without a shell', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '"1.1.0"', stderr: '' });
    const resolveNpmCliPath = vi
      .fn()
      .mockReturnValue(
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      );

    await runGlobalNpm(
      ['view', '@qwen-code/qwen-code'],
      run as unknown as NonNullable<Parameters<typeof runGlobalNpm>[1]>,
      'win32',
      'C:\\Program Files\\nodejs\\node.exe',
      resolveNpmCliPath,
    );

    expect(run).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'view',
        '@qwen-code/qwen-code',
      ],
      expect.not.objectContaining({ shell: true }),
    );
    expect(resolveNpmCliPath).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      'win32',
    );
  });

  it('canonicalizes the global npm root before comparing paths', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '/linked/node_modules\n',
      stderr: '',
    });
    const canonicalize = vi.fn(async (candidate: string) =>
      candidate === '/linked/node_modules'
        ? '/real/node_modules'
        : '/real/node_modules/@qwen-code/qwen-code/cli.js',
    );

    await expect(
      isGlobalNpmInstallation(
        '/linked/node_modules/@qwen-code/qwen-code/cli.js',
        run as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[1]
        >,
        canonicalize as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[2]
        >,
      ),
    ).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/npm-cli\.js$/), 'root', '--global'],
      expect.objectContaining({ timeout: FETCH_TIMEOUT_MS }),
    );
  });

  it('does not treat a missing global npm root as a global install', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '/missing/node_modules\n',
      stderr: '',
    });
    const canonicalize = vi.fn(async (candidate: string) => {
      if (candidate === '/missing/node_modules') {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return '/local/node_modules/@qwen-code/qwen-code/cli.js';
    });

    await expect(
      isGlobalNpmInstallation(
        '/local/node_modules/@qwen-code/qwen-code/cli.js',
        run as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[1]
        >,
        canonicalize as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[2]
        >,
      ),
    ).resolves.toBe(false);
  });

  it('does not treat local npm installs as global npm installs', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '/global/node_modules\n',
      stderr: '',
    });
    const canonicalize = vi.fn(async (candidate: string) =>
      candidate === '/global/node_modules'
        ? '/global/node_modules'
        : '/repo/node_modules/@qwen-code/qwen-code/cli.js',
    );

    await expect(
      isGlobalNpmInstallation(
        '/repo/node_modules/@qwen-code/qwen-code/cli.js',
        run as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[1]
        >,
        canonicalize as unknown as NonNullable<
          Parameters<typeof isGlobalNpmInstallation>[2]
        >,
      ),
    ).resolves.toBe(false);
  });

  it('does not fall back when the global npm query fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('npm view failed'));

    await expect(
      fetchGlobalNpmUpdateInfo(
        '@qwen-code/qwen-code',
        '1.0.0',
        'latest',
        run as unknown as NonNullable<
          Parameters<typeof fetchGlobalNpmUpdateInfo>[3]
        >,
      ),
    ).rejects.toThrow('npm view failed');
  });

  it('treats an empty dist-tag response as no update', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });

    await expect(
      fetchGlobalNpmUpdateInfo(
        '@qwen-code/qwen-code',
        '1.0.0',
        'nightly',
        run as unknown as NonNullable<
          Parameters<typeof fetchGlobalNpmUpdateInfo>[3]
        >,
      ),
    ).resolves.toMatchObject({ current: '1.0.0', latest: '1.0.0' });
  });

  it('should pass a non-optional package version to update-notifier', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    updateNotifier.mockReturnValue({
      fetchInfo: vi.fn().mockResolvedValue(null),
    });

    await checkForUpdatesDetailed();

    expect(updateNotifier).toHaveBeenCalledWith(
      expect.objectContaining({
        pkg: { name: 'test-package', version: '1.0.0' },
      }),
    );
  });

  it('should handle errors gracefully', async () => {
    getPackageJson.mockRejectedValue(new Error('test error'));
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  describe('nightly updates', () => {
    it('should notify for a newer nightly version when current is nightly', async () => {
      getPackageJson.mockResolvedValue({
        name: 'test-package',
        version: '1.2.3-nightly.1',
      });

      const fetchInfoMock = vi.fn().mockImplementation(({ distTag }) => {
        if (distTag === 'nightly') {
          return Promise.resolve({
            latest: '1.2.3-nightly.2',
            current: '1.2.3-nightly.1',
          });
        }
        if (distTag === 'latest') {
          return Promise.resolve({
            latest: '1.2.3',
            current: '1.2.3-nightly.1',
          });
        }
        return Promise.resolve(null);
      });

      updateNotifier.mockImplementation(({ pkg, distTag }) => ({
        fetchInfo: () => fetchInfoMock({ pkg, distTag }),
      }));

      const result = await checkForUpdates();
      expect(result?.message).toContain('1.2.3-nightly.1 → 1.2.3-nightly.2');
      expect(result?.update.latest).toBe('1.2.3-nightly.2');
    });
  });

  describe('fetchInfo timeout (#6857)', () => {
    it('returns a detailed error when fetchInfo does not resolve within FETCH_TIMEOUT_MS', async () => {
      // update-notifier's fetchInfo() takes no timeout option, so an
      // unreachable registry (proxy, offline, corporate mirror without
      // scoped .npmrc auth) would hang the check. We race it against a
      // bounded timer instead — this asserts the timer actually fires and
      // surfaces a real error rather than silently reporting "up to date".
      getPackageJson.mockResolvedValue({
        name: 'test-package',
        version: '1.0.0',
      });
      updateNotifier.mockReturnValue({
        // never resolves
        fetchInfo: vi.fn().mockReturnValue(new Promise(() => {})),
      });

      // Stub the global-npm probe: the real isGlobalNpmInstallation runs a
      // real realpath() I/O before the timeout is armed, which races with the
      // fake-timer advance below and makes this test hang non-deterministically
      // on slow/loaded runners.
      const resultPromise = checkForUpdatesDetailed(async () => false);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
      const result = await resultPromise;

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toBeInstanceOf(UpdateCheckTimeoutError);
        expect(result.error.message).toContain(`${FETCH_TIMEOUT_MS}ms`);
        // Non-nightly path only queries the `latest` dist-tag; the message
        // must name it so oncall can tell which registry endpoint stalled.
        expect(result.error.message).toContain('for latest');
        expect(result.currentVersion).toBe('1.0.0');
      }
    });

    it('still resolves the update path when fetchInfo returns before the timeout', async () => {
      // Guards against the timer accidentally firing on a healthy fast fetch —
      // if it did, every /update call would silently drop back to error.
      getPackageJson.mockResolvedValue({
        name: 'test-package',
        version: '1.0.0',
      });
      updateNotifier.mockReturnValue({
        fetchInfo: vi
          .fn()
          .mockResolvedValue({ current: '1.0.0', latest: '1.1.0' }),
      });

      const result = await checkForUpdatesDetailed(async () => false);

      expect(result.status).toBe('update');
      if (result.status === 'update') {
        expect(result.info.update.latest).toBe('1.1.0');
      }
    });

    it('surfaces a timeout when only the nightly dist-tag stalls', async () => {
      // The nightly path fires `latest` and `nightly` fetches concurrently via
      // Promise.all — if the timer wiring is wrong (e.g. only the outer race
      // has one, or the reject reaches Promise.all and Promise.all doesn't
      // propagate), a single stalled fetch would let /update silently degrade.
      // Assert Promise.all propagates the timeout AND names the exact dist-tag
      // that stalled so oncall reading logs can point at the endpoint.
      getPackageJson.mockResolvedValue({
        name: 'test-package',
        version: '1.0.0-nightly.1',
      });
      updateNotifier.mockImplementation(({ distTag }) => ({
        fetchInfo: () =>
          distTag === 'nightly'
            ? new Promise(() => {}) // never resolves
            : Promise.resolve({
                current: '1.0.0-nightly.1',
                latest: '1.0.0',
              }),
      }));

      const resultPromise = checkForUpdatesDetailed(async () => false);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
      const result = await resultPromise;

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toBeInstanceOf(UpdateCheckTimeoutError);
        expect(result.error.message).toContain('for nightly');
        expect(result.currentVersion).toBe('1.0.0-nightly.1');
      }
    });

    it('surfaces a timeout when both nightly dist-tags stall', async () => {
      // Full outage / offline network — both fetches hang, both timers fire.
      // The first rejection Promise.all sees wins; assert only that we get a
      // typed UpdateCheckTimeoutError for one of the two dist-tags (either is
      // a valid symptom of the same failure).
      getPackageJson.mockResolvedValue({
        name: 'test-package',
        version: '1.0.0-nightly.1',
      });
      updateNotifier.mockImplementation(() => ({
        fetchInfo: () => new Promise(() => {}),
      }));

      const resultPromise = checkForUpdatesDetailed(async () => false);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
      const result = await resultPromise;

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.error).toBeInstanceOf(UpdateCheckTimeoutError);
        expect(result.error.message).toMatch(/for (nightly|latest)/);
      }
    });
  });
});
