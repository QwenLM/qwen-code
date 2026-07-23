/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPackageJson } from '../../utils/package.js';
import { getNpmCliPath } from '../../utils/installationInfo.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

const debugLogger = createDebugLogger('UPDATE_CHECK');

/**
 * Result of an update lookup. Mirrors the subset of update-notifier's
 * UpdateInfo that the CLI consumes — kept local so version checking no longer
 * depends on update-notifier at all (#7515).
 */
export interface UpdateInfo {
  latest: string;
  current: string;
  type: string;
  name: string;
}

// 5s matches comparable CLIs (e.g. Claude Code's autoUpdater uses
// AbortSignal.timeout(5000)) and gives slow mirrors and corporate proxies a
// realistic budget. Related: #7049.
export const FETCH_TIMEOUT_MS = 5000;

/**
 * Sentinel error thrown when `fetchInfo()` does not resolve within
 * `FETCH_TIMEOUT_MS`. `npm view` is bounded by the `timeout` option passed to
 * `execFile` (see `runGlobalNpm`), but we still race it here as a second,
 * independent bound so a slow / unreachable registry (corporate proxy,
 * offline network, DNS failure) can never hang the check indefinitely. Race
 * the call against a bounded timer and surface a real error so `/update` can
 * report "check failed" instead of silently returning "up to date". The
 * `distTag` is carried on the message so an oncall reading logs can tell
 * which registry endpoint stalled — the nightly path fires two concurrent
 * fetches, and only one of them may be blocked (e.g. a corporate proxy that
 * lets `nightly` through but not `latest`). Related: #6857.
 */
export class UpdateCheckTimeoutError extends Error {
  readonly distTag?: string;
  constructor(timeoutMs: number, distTag?: string) {
    const suffix = distTag ? ` for ${distTag}` : '';
    super(`update check timed out after ${timeoutMs}ms${suffix}`);
    this.name = 'UpdateCheckTimeoutError';
    this.distTag = distTag;
  }
}

export type UpdateCheckFailureReason = 'timeout' | 'offline' | 'registry';

const NETWORK_ERROR_CODES = [
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
];

/**
 * Buckets an update-check failure so callers can tell the user what actually
 * happened instead of a generic "check your network" message. Matches error
 * codes both on the `code` property and inside the message text, because the
 * global-npm path surfaces network failures only through `npm` child-process
 * stderr embedded in the error message. Related: #7049.
 */
export function classifyUpdateCheckError(
  error: unknown,
): UpdateCheckFailureReason {
  if (error instanceof UpdateCheckTimeoutError) return 'timeout';
  if (error instanceof Error) {
    if (
      'killed' in error &&
      error.killed === true &&
      'signal' in error &&
      error.signal === 'SIGTERM'
    ) {
      return 'timeout';
    }
    const errors = [error];
    if (error.cause instanceof Error) errors.push(error.cause);
    const matchesCode = (code: string) =>
      errors.some(
        (error) =>
          (error as NodeJS.ErrnoException).code === code ||
          error.message.includes(code),
      );

    if (NETWORK_ERROR_CODES.some(matchesCode)) return 'offline';
  }
  return 'registry';
}

/**
 * Short human-readable reason for an update-check failure, for embedding in
 * status messages, e.g. "registry did not respond within 5s".
 */
export function describeUpdateCheckFailure(
  error: unknown,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): string {
  switch (classifyUpdateCheckError(error)) {
    case 'timeout':
      return t('registry did not respond within {{seconds}}s', {
        seconds: String(Math.round(timeoutMs / 1000)),
      });
    case 'offline':
      return t('registry unreachable');
    default:
      return t('registry error');
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

const execFileAsync = promisify(execFile);

export async function runGlobalNpm(
  args: string[],
  run: typeof execFileAsync = execFileAsync,
  platform = process.platform,
  nodePath = process.execPath,
  resolveNpmCliPath = getNpmCliPath,
): Promise<string> {
  const { stdout } = await run(
    nodePath,
    [resolveNpmCliPath(nodePath, platform), ...args],
    {
      encoding: 'utf8',
      timeout: FETCH_TIMEOUT_MS,
    },
  );
  return String(stdout).trim();
}

export async function fetchGlobalNpmUpdateInfo(
  packageName: string,
  currentVersion: string,
  distTag: 'latest' | 'nightly',
  run: typeof execFileAsync = execFileAsync,
): Promise<UpdateInfo> {
  const output = await runGlobalNpm(
    ['view', packageName, `dist-tags.${distTag}`, '--json', '--global'],
    run,
  );
  if (output === '') {
    // `npm view <pkg> dist-tags.<tag> --json` exits 0 with empty stdout when the
    // configured registry/mirror publishes no version under this dist-tag (e.g.
    // a private mirror that doesn't carry `nightly`). Treat that as "no newer
    // version for this tag" instead of throwing — otherwise the empty result
    // reaches JSON.parse and, via the Promise.all in checkForUpdatesDetailed,
    // fails the whole check and discards the other tag's result.
    return {
      latest: currentVersion,
      current: currentVersion,
      type: 'latest',
      name: packageName,
    };
  }
  // npm ≤11 prints the field as a bare JSON string ("0.20.1"); npm 12+ wraps
  // single `view` field results in an array (["0.20.1"]). Accept both.
  const parsed: unknown = JSON.parse(output);
  const latest =
    typeof parsed === 'string'
      ? parsed
      : Array.isArray(parsed) &&
          parsed.length === 1 &&
          typeof parsed[0] === 'string'
        ? parsed[0]
        : undefined;
  if (latest === undefined) {
    throw new Error(`Invalid npm ${distTag} version response`);
  }
  return {
    latest,
    current: currentVersion,
    type: 'latest',
    name: packageName,
  };
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

export async function checkForUpdatesDetailed(
  fetchGlobalNpm = fetchGlobalNpmUpdateInfo,
): Promise<UpdateCheckResult> {
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
    // Always resolve via `npm view` (see fetchGlobalNpmUpdateInfo), regardless
    // of installation type. update-notifier's fetchInfo() requests the
    // abbreviated metadata format (Accept: application/vnd.npm.install-v1+json),
    // which registry.npmjs.org now answers with an empty HTTP 406 response,
    // breaking the check for every non-global install. `npm view` doesn't send
    // that header and is unaffected. Related: #7515.
    const createNotifier = (distTag: 'latest' | 'nightly') => ({
      fetchInfo: () => fetchGlobalNpm(name, version, distTag),
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

export async function checkForUpdates(
  fetchGlobalNpm = fetchGlobalNpmUpdateInfo,
): Promise<UpdateObject | null> {
  const result = await checkForUpdatesDetailed(fetchGlobalNpm);
  return result.status === 'update' ? result.info : null;
}
