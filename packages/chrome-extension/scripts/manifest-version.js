/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const CHROME_COMPONENT_MAX = 65535;
const STABLE_BUILD = CHROME_COMPONENT_MAX;
const PREVIEW_BUILD_START = 60000;
const NIGHTLY_FALLBACK_EPOCH_DAYS = Math.floor(
  Date.UTC(2000, 0, 1) / 86_400_000,
);

function gitCommitCount() {
  try {
    const shallow = execFileSync(
      'git',
      ['rev-parse', '--is-shallow-repository'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    if (shallow === 'true') return undefined;
    const count = Number(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim(),
    );
    return Number.isInteger(count) && count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

// Deterministic stand-in when git history is unavailable (tarball, sparse or
// shallow checkout): days since a fixed epoch, derived from the nightly date
// already embedded in the version. Monotonic across dates, but two nightlies
// built on the same day share a build number, so callers warn when using it.
function dateDerivedBuildNumber(packageVersion) {
  const match = packageVersion.match(/-nightly\.(\d{8})(?:\.|$)/);
  if (!match) return undefined;
  const digits = Number(match[1]);
  const year = Math.floor(digits / 10000);
  const month = Math.floor((digits % 10000) / 100);
  const day = digits % 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  const validDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!validDate) return undefined;
  const buildNumber =
    Math.floor(date.getTime() / 86_400_000) - NIGHTLY_FALLBACK_EPOCH_DAYS;
  return buildNumber > 0 && buildNumber < PREVIEW_BUILD_START
    ? buildNumber
    : undefined;
}

export function resolveNightlyBuildNumber(packageVersion) {
  if (!packageVersion.includes('-nightly.')) return undefined;
  const configured = process.env.QWEN_CHROME_EXTENSION_BUILD_NUMBER?.trim();
  if (configured) {
    const parsed = Number(configured);
    if (
      !Number.isInteger(parsed) ||
      parsed <= 0 ||
      parsed >= PREVIEW_BUILD_START
    ) {
      throw new Error(
        `Invalid QWEN_CHROME_EXTENSION_BUILD_NUMBER "${configured}": ` +
          `expected a positive integer less than ${PREVIEW_BUILD_START}.`,
      );
    }
    return parsed;
  }
  // Monotonic within a single branch only; cross-branch ordering is not
  // guaranteed, so a nightly built on a side branch can carry a lower number
  // than one built on main. Chrome refuses to treat a lower version as an
  // upgrade. The count must stay below PREVIEW_BUILD_START (60000); beyond
  // that, toChromeManifestVersion rejects it as colliding with the preview
  // range.
  const fromGit = gitCommitCount();
  if (fromGit !== undefined) return fromGit;
  const fromDate = dateDerivedBuildNumber(packageVersion);
  if (fromDate === undefined) {
    throw new Error(
      'Unable to derive the nightly extension build number from git history. ' +
        'Set QWEN_CHROME_EXTENSION_BUILD_NUMBER to an explicit build number.',
    );
  }
  console.warn(
    'warning: git history unavailable for the nightly extension build ' +
      `number; falling back to the date-derived value ${fromDate}. Set ` +
      'QWEN_CHROME_EXTENSION_BUILD_NUMBER for a monotonic value.',
  );
  return fromDate;
}

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
