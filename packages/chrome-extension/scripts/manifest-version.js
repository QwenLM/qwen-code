/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';

const CHROME_COMPONENT_MAX = 65535;
const STABLE_BUILD = CHROME_COMPONENT_MAX;
const PREVIEW_BUILD_START = 60000;

/**
 * Convert an npm package version into Chrome's numeric manifest format.
 * Chrome rejects prerelease labels such as `-alpha.1`.
 */
export function toChromeManifestVersion(packageVersion, nightlyBuildNumber) {
  const parsed = semver.parse(packageVersion);
  if (!parsed) {
    throw new Error(`Invalid extension package version: ${packageVersion}`);
  }
  const core = [parsed.major, parsed.minor, parsed.patch];
  if (core.some((part) => part > CHROME_COMPONENT_MAX)) {
    throw new Error(`Invalid extension package version: ${packageVersion}`);
  }

  let build = STABLE_BUILD;
  if (parsed.prerelease.length > 0) {
    const [channel, value] = parsed.prerelease;
    if (channel === 'preview' && Number.isInteger(value)) {
      if (value < 0 || PREVIEW_BUILD_START + value >= STABLE_BUILD) {
        throw new Error(`Invalid extension package version: ${packageVersion}`);
      }
      build = PREVIEW_BUILD_START + value;
    } else if (
      channel === 'nightly' &&
      typeof value === 'number' &&
      /^\d{8}$/.test(String(value))
    ) {
      const year = Math.floor(value / 10000);
      const month = Math.floor((value % 10000) / 100);
      const day = value % 100;
      const date = new Date(Date.UTC(year, month - 1, day));
      const validDate =
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
      if (!validDate) {
        throw new Error(`Invalid extension package version: ${packageVersion}`);
      }
      if (nightlyBuildNumber === undefined) {
        throw new Error('Nightly extension build number is required');
      }
      if (
        !Number.isInteger(nightlyBuildNumber) ||
        nightlyBuildNumber <= 0 ||
        nightlyBuildNumber >= PREVIEW_BUILD_START
      ) {
        throw new Error('Invalid nightly extension build number');
      }
      build = nightlyBuildNumber;
    } else {
      throw new Error(`Unsupported extension prerelease: ${packageVersion}`);
    }
  }
  return [...core, build].join('.');
}
