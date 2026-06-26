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

const debugLogger = createDebugLogger('UPDATE_CHECK');

export const FETCH_TIMEOUT_MS = 2000;

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
        createNotifier('nightly').fetchInfo(),
        createNotifier('latest').fetchInfo(),
      ]);

      const bestUpdate = getBestAvailableUpdate(
        nightlyUpdateInfo,
        latestUpdateInfo,
      );

      if (bestUpdate && semver.gt(bestUpdate.latest, version)) {
        const message = `A new version of Qwen Code is available! ${version} → ${bestUpdate.latest}`;
        return {
          status: 'update',
          info: {
            message,
            update: { ...bestUpdate, current: version },
          },
        };
      }
    } else {
      const updateInfo = await createNotifier('latest').fetchInfo();

      if (updateInfo && semver.gt(updateInfo.latest, version)) {
        const message = `Qwen Code update available! ${version} → ${updateInfo.latest}`;
        return {
          status: 'update',
          info: {
            message,
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
