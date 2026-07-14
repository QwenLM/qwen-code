/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  checkForUpdates,
  checkForUpdatesDetailed,
  FETCH_TIMEOUT_MS,
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

      const resultPromise = checkForUpdatesDetailed();
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

      const result = await checkForUpdatesDetailed();

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

      const resultPromise = checkForUpdatesDetailed();
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

      const resultPromise = checkForUpdatesDetailed();
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
