/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getPackageJson,
  runLogger,
  BRAND_CLI_NAME,
} from '@qwen-code/core';
import type { InstallationSettings } from '../../installation/settings.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FETCH_TIMEOUT_MS = 2000;

import type { UpdateObject } from '../../ui/utils/updateCheck.js';

function normalizeVersionForCompare(version: string): string {
  return version.trim().replace(/^v(?=\d)/i, '');
}

function versionsDiffer(currentVersion: string, latestUpdate: string): boolean {
  return (
    normalizeVersionForCompare(currentVersion) !==
    normalizeVersionForCompare(latestUpdate)
  );
}

/**
 * Wraps a promise with a timeout. Rejects with a timeout error if the
 * promise does not settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function checkForUpdates(
  settings: InstallationSettings,
): Promise<UpdateObject | null> {
  try {
    if (!settings.merged.general.enableAutoUpdateNotification) {
      return null;
    }
    // Skip update check when running from source (development mode)
    if (process.env['DEV'] === 'true') {
      return null;
    }
    const packageJson = await getPackageJson(__dirname);
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }

    const { name, version: currentVersion } = packageJson;
    const { default: latestVersion } = await import('latest-version');
    const latestUpdate = await withTimeout(
      latestVersion(name),
      FETCH_TIMEOUT_MS,
    );

    if (latestUpdate && versionsDiffer(currentVersion, latestUpdate)) {
      const message = `${BRAND_CLI_NAME} update available! ${currentVersion} → ${latestUpdate}`;
      return {
        message,
        update: {
          latest: latestUpdate,
          current: currentVersion,
          name,
        },
      };
    }

    return null;
  } catch (e) {
    runLogger.warn('Failed to check for updates: ' + e);
    return null;
  }
}
