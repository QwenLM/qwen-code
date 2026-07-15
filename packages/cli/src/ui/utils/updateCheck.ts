/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateInfo } from 'update-notifier';
import updateNotifier from 'update-notifier';
import semver from 'semver';
import { getPackageJson } from '../../utils/package.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

const debugLogger = createDebugLogger('UPDATE_CHECK');

export const FETCH_TIMEOUT_MS = 2000;

/**
 * Sentinel error thrown when `fetchInfo()` does not resolve within
 * `FETCH_TIMEOUT_MS`. `update-notifier`'s `fetchInfo()` does not accept a
 * timeout option, so slow / unreachable registries (corporate proxies, offline
 * networks, DNS failures) would otherwise hang the check indefinitely or fall
 * through to a stale configstore cache. Race the call against a bounded timer
 * and surface a real error so `/update` can report "check failed" instead of
 * silently returning "up to date". The `distTag` is carried on the message so
 * an oncall reading logs can tell which registry endpoint stalled — the
 * nightly path fires two concurrent fetches, and only one of them may be
 * blocked (e.g. a corporate proxy that lets `nightly` through but not
 * `latest`). Related: #6857.
 */
export class UpdateCheckTimeoutError extends Error {
  readonly distTag?: string;
  constructor(timeoutMs: number, distTag?: string) {
    const suffix = distTag ? ` for ${distTag}` : '';
    super(`update-notifier fetchInfo timed out after ${timeoutMs}ms${suffix}`);
    this.name = 'UpdateCheckTimeoutError';
    this.distTag = distTag;
  }
}

async function fetchInfoWithTimeout(
  notifier: { fetchInfo(): UpdateInfo | Promise<UpdateInfo> },
  timeoutMs: number,
  distTag?: string,
): Promise<UpdateInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(notifier.fetchInfo()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpdateCheckTimeoutError(timeoutMs, distTag)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface UpdateObject {
  message: string;
  update: UpdateInfo;
}

export type UpdateCheckResult =
  | { status: 'update'; info: UpdateObject }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'skipped'; reason: string; currentVersion?: string }
  | { status: 'error'; error: Error; currentVersion?: string };

/**
 * From a nightly and stable update, determines which is the "best" one to offer.
 * The rule is to always prefer nightly if the base versions are the same.
 */
function getBestAvailableUpdate(
  nightly?: UpdateInfo,
  stable?: UpdateInfo,
): UpdateInfo | null {
  if (!nightly) return stable || null;
  if (!stable) return nightly || null;

  const nightlyVer = nightly.latest;
  const stableVer = stable.latest;

  if (
    semver.coerce(stableVer)?.version === semver.coerce(nightlyVer)?.version
  ) {
    return nightly;
  }

  return semver.gt(stableVer, nightlyVer) ? stable : nightly;
}

export async function checkForUpdatesDetailed(): Promise<UpdateCheckResult> {
  let currentVersion: string | undefined;
  try {
    // Skip update check when running from source (development mode)
    if (process.env['DEV'] === 'true') {
      return { status: 'skipped', reason: 'development mode' };
    }
    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return { status: 'skipped', reason: 'package metadata unavailable' };
    }

    const { name, version } = packageJson;
    currentVersion = version;
    const isNightly = version.includes('nightly');
    const createNotifier = (distTag: 'latest' | 'nightly') =>
      updateNotifier({
        pkg: {
          name,
          version,
        },
        updateCheckInterval: 0,
        shouldNotifyInNpmScript: true,
        distTag,
      });

    if (isNightly) {
      const [nightlyUpdateInfo, latestUpdateInfo] = await Promise.all([
        fetchInfoWithTimeout(
          createNotifier('nightly'),
          FETCH_TIMEOUT_MS,
          'nightly',
        ),
        fetchInfoWithTimeout(
          createNotifier('latest'),
          FETCH_TIMEOUT_MS,
          'latest',
        ),
      ]);

      debugLogger.debug(
        `fetchInfo returned nightly=${JSON.stringify(nightlyUpdateInfo)} latest=${JSON.stringify(latestUpdateInfo)} for current=${version}`,
      );

      const bestUpdate = getBestAvailableUpdate(
        nightlyUpdateInfo,
        latestUpdateInfo,
      );

      if (bestUpdate && semver.gt(bestUpdate.latest, version)) {
        return {
          status: 'update',
          info: {
            message: t(
              'A new version of Qwen Code is available! {{current}} → {{latest}}',
              { current: version, latest: bestUpdate.latest },
            ),
            update: { ...bestUpdate, current: version },
          },
        };
      }
    } else {
      const updateInfo = await fetchInfoWithTimeout(
        createNotifier('latest'),
        FETCH_TIMEOUT_MS,
        'latest',
      );

      debugLogger.debug(
        `fetchInfo returned ${JSON.stringify(updateInfo)} for current=${version}`,
      );

      if (updateInfo && semver.gt(updateInfo.latest, version)) {
        return {
          status: 'update',
          info: {
            message: t('Qwen Code update available! {{current}} → {{latest}}', {
              current: version,
              latest: updateInfo.latest,
            }),
            update: { ...updateInfo, current: version },
          },
        };
      }
    }

    return { status: 'up-to-date', currentVersion: version };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    debugLogger.warn('Failed to check for updates: ' + error);
    return { status: 'error', error, currentVersion };
  }
}

export async function checkForUpdates(): Promise<UpdateObject | null> {
  const result = await checkForUpdatesDetailed();
  return result.status === 'update' ? result.info : null;
}
