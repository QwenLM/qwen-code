#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import {
  getArgs,
  isExpectedMissingGitHubRelease,
  readJson,
  validateVersion,
} from './lib/release-helpers.js';

function getVersionFromNPM(distTag) {
  const command = `npm view @qwen-code/qwen-code version --tag=${distTag}`;
  try {
    return execSync(command).toString().trim();
  } catch (error) {
    if (error.message?.includes('E404')) {
      return '';
    }
    throw error;
  }
}

function getAllVersionsFromNPM() {
  const command = `npm view @qwen-code/qwen-code versions --json`;
  try {
    const versionsJson = execSync(command).toString().trim();
    return JSON.parse(versionsJson);
  } catch (error) {
    if (error.message?.includes('E404')) {
      return [];
    }
    throw error;
  }
}

function isVersionDeprecated(version) {
  const command = `npm view @qwen-code/qwen-code@${version} deprecated`;
  try {
    const output = execSync(command).toString().trim();
    return output.length > 0;
  } catch (error) {
    // This command shouldn't fail for existing versions, but as a safeguard:
    console.error(
      `Failed to check deprecation status for ${version}: ${error.message}`,
    );
    return false; // Assume not deprecated on error to avoid breaking the release.
  }
}

function detectRollbackAndGetBaseline(npmDistTag) {
  // Get the current dist-tag version
  const distTagVersion = getVersionFromNPM(npmDistTag);

  // Get all published versions
  let allVersions;
  try {
    allVersions = getAllVersionsFromNPM();
  } catch (error) {
    if (distTagVersion) {
      console.error(
        `Could not fetch versions list, proceeding with dist-tag: ${error.message}`,
      );
      return { baseline: distTagVersion, isRollback: false };
    }
    throw error;
  }

  if (!distTagVersion) {
    // Dist-tag is missing — try to derive baseline from published versions
    if (allVersions.length === 0) return { baseline: '', isRollback: false };

    let matchingVersions;
    if (npmDistTag === 'latest') {
      matchingVersions = allVersions.filter(
        (v) => semver.valid(v) && !semver.prerelease(v),
      );
    } else if (npmDistTag === 'preview') {
      matchingVersions = allVersions.filter(
        (v) => semver.valid(v) && v.includes('-preview'),
      );
    } else if (npmDistTag === 'nightly') {
      matchingVersions = allVersions.filter(
        (v) => semver.valid(v) && v.includes('-nightly'),
      );
    } else {
      return { baseline: '', isRollback: false };
    }

    if (matchingVersions.length === 0)
      return { baseline: '', isRollback: false };

    matchingVersions.sort((a, b) => semver.rcompare(a, b));

    let highestExistingVersion = '';
    for (const version of matchingVersions) {
      if (!isVersionDeprecated(version)) {
        highestExistingVersion = version;
        break;
      } else {
        console.error(`Ignoring deprecated version: ${version}`);
      }
    }

    if (!highestExistingVersion) return { baseline: '', isRollback: false };

    return {
      baseline: highestExistingVersion,
      isRollback: false,
      highestExistingVersion,
    };
  }

  if (allVersions.length === 0)
    return { baseline: distTagVersion, isRollback: false };

  // Filter versions by type to match the dist-tag
  let matchingVersions;
  if (npmDistTag === 'latest') {
    // Stable versions: no prerelease identifiers
    matchingVersions = allVersions.filter(
      (v) => semver.valid(v) && !semver.prerelease(v),
    );
  } else if (npmDistTag === 'preview') {
    // Preview versions: contain -preview
    matchingVersions = allVersions.filter(
      (v) => semver.valid(v) && v.includes('-preview'),
    );
  } else if (npmDistTag === 'nightly') {
    // Nightly versions: contain -nightly
    matchingVersions = allVersions.filter(
      (v) => semver.valid(v) && v.includes('-nightly'),
    );
  } else {
    // For other dist-tags, just use the dist-tag version
    return { baseline: distTagVersion, isRollback: false };
  }

  if (matchingVersions.length === 0)
    return { baseline: distTagVersion, isRollback: false };

  // Sort by semver to get a list from highest to lowest
  matchingVersions.sort((a, b) => semver.rcompare(a, b));

  // Find the highest non-deprecated version
  let highestExistingVersion = '';
  for (const version of matchingVersions) {
    if (!isVersionDeprecated(version)) {
      highestExistingVersion = version;
      break; // Found the one we want
    } else {
      console.error(`Ignoring deprecated version: ${version}`);
    }
  }

  // If all matching versions were deprecated, fall back to the dist-tag version
  if (!highestExistingVersion) {
    highestExistingVersion = distTagVersion;
  }

  // Check if we're in a rollback scenario
  const isRollback = semver.gt(highestExistingVersion, distTagVersion);

  return {
    baseline: isRollback ? highestExistingVersion : distTagVersion,
    isRollback,
    distTagVersion,
    highestExistingVersion,
  };
}

/**
 * All packages that share the same release version. A version is considered
 * "taken" if it exists on *any* of them — not just the main package.
 */
export const PUBLISHED_PACKAGES = [
  '@qwen-code/qwen-code',
  '@qwen-code/audio-capture',
  '@qwen-code/channel-base',
  '@qwen-code/channel-dingtalk',
  '@qwen-code/channel-dws',
  '@qwen-code/channel-feishu',
  '@qwen-code/channel-github',
  '@qwen-code/channel-qqbot',
  '@qwen-code/channel-telegram',
  '@qwen-code/channel-wecom',
  '@qwen-code/channel-weixin',
];

function doesVersionExist(version, { strict = false, shippedTo } = {}) {
  // Check NPM across all published packages
  const shippedPackages = [];
  for (const pkg of PUBLISHED_PACKAGES) {
    try {
      // The best-effort path silences npm's expected E404 noise; strict
      // mode needs that stderr to tell "absent" from a failed probe.
      const command = strict
        ? `npm view ${pkg}@${version} version`
        : `npm view ${pkg}@${version} version 2>/dev/null`;
      const output = execSync(command).toString().trim();
      if (output === version) {
        if (!strict) {
          console.error(`Version ${version} already exists on NPM (${pkg}).`);
          return true;
        }
        shippedPackages.push(pkg);
      }
    } catch (error) {
      // E404 means the version is absent from this package. Strict mode
      // guards the force push, so any other probe failure is "cannot
      // verify" and must throw instead of passing — but once a package
      // has shipped the refusal is decided, and a throw would mask its
      // recovery guidance with a probe-failure exit.
      if (
        strict &&
        shippedPackages.length === 0 &&
        !error.message?.includes('E404')
      ) {
        throw new Error(
          `Failed to verify ${pkg}@${version} on npm: ${error.message}`,
        );
      }
    }
  }
  // Strict mode scans every package instead of stopping at the first hit
  // so a partial publish's refusal can name everything that shipped. A hit
  // ends the check: the remaining probes can no longer change the outcome,
  // and a failed one would mask the refusal's recovery guidance.
  if (shippedPackages.length > 0) {
    console.error(
      `Version ${version} already exists on NPM (${shippedPackages.join(', ')}).`,
    );
    shippedTo?.push(...shippedPackages);
    return true;
  }

  // Check Git tags. Push-time callers pass strict: the checkout at job
  // start can only know tags that existed when the job began, and the
  // version may ship between that fetch and this push — check origin.
  try {
    if (strict) {
      execSync(`git ls-remote --exit-code origin "refs/tags/v${version}"`);
      console.error(`Git tag v${version} already exists on origin.`);
      shippedTo?.push(`origin tag v${version}`);
      return true;
    }
    const command = `git tag -l 'v${version}'`;
    const tagOutput = execSync(command).toString().trim();
    if (tagOutput === `v${version}`) {
      console.error(`Git tag v${version} already exists.`);
      return true;
    }
  } catch (error) {
    if (strict) {
      // ls-remote exits 2 when no ref matches; that is "tag absent". Any
      // other failure means the check could not run — fail the push
      // instead of reading a failed check as "unreleased".
      if (error.status !== 2) {
        throw new Error(
          `Failed to verify tag v${version} on origin: ${error.message}`,
        );
      }
    } else {
      console.error(`Failed to check git tags for conflicts: ${error.message}`);
    }
  }

  // Check GitHub releases
  try {
    const command = `gh release view "v${version}" --json tagName --jq .tagName`;
    const output = execSync(command).toString().trim();
    if (output === `v${version}`) {
      console.error(`GitHub release v${version} already exists.`);
      shippedTo?.push(`GitHub release v${version}`);
      return true;
    }
  } catch (error) {
    if (!isExpectedMissingGitHubRelease(error)) {
      if (strict) {
        throw new Error(
          `Failed to verify release v${version} on GitHub: ${error.message}`,
        );
      }
      console.error(
        `Failed to check GitHub releases for conflicts: ${error.message}`,
      );
    }
  }

  return false;
}

/**
 * Push-time re-validation of prepare's doesVersionExist invariant, for the
 * release branch force push. Throws when the version has shipped anywhere
 * (an error coded VERSION_SHIPPED, naming where it was found), or when a
 * probe cannot run — a failed probe must not read as "unreleased".
 */
export function assertVersionUnreleased(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      'assert-unreleased requires a version, e.g. --assert-unreleased=1.2.3',
    );
  }
  const shippedTo = [];
  if (doesVersionExist(version, { strict: true, shippedTo })) {
    const error = new Error(
      `Version ${version} has already shipped; refusing to force-push the release branch over it. Found on: ${shippedTo.join(', ')}. If a previous attempt published only part of the release, complete the remaining artifacts manually — re-running this job will keep failing here while the version stays published.`,
    );
    error.code = 'VERSION_SHIPPED';
    throw error;
  }
}

function getAndVerifyTags(npmDistTag, _gitTagPattern) {
  // Detect rollback scenarios and get the correct baseline
  const rollbackInfo = detectRollbackAndGetBaseline(npmDistTag);
  const baselineVersion = rollbackInfo.baseline;

  if (!baselineVersion) {
    console.error(
      `No baseline version found for dist-tag "${npmDistTag}" — returning null`,
    );
    return null;
  }

  if (rollbackInfo.isRollback) {
    // Rollback scenario: warn about the rollback but don't fail
    console.error(
      `Rollback detected! NPM ${npmDistTag} tag is ${rollbackInfo.distTagVersion}, but using ${baselineVersion} as baseline for next version calculation (highest existing version).`,
    );
  }

  // Not verifying against git tags or GitHub releases as per user request.

  return {
    latestVersion: baselineVersion,
    latestTag: `v${baselineVersion}`,
  };
}

function getLatestStableReleaseTag() {
  try {
    const result = getAndVerifyTags('latest', 'v[0-9].[0-9].[0-9]');
    return result ? result.latestTag : '';
  } catch (error) {
    console.error(
      `Failed to determine latest stable release tag: ${error.message}`,
    );
    return '';
  }
}

function promoteNightlyVersion() {
  const result = getAndVerifyTags('nightly', 'v*-nightly*');
  if (!result) {
    throw new Error(
      'Unable to determine baseline version for nightly (required for promote-nightly)',
    );
  }
  const baseVersion = result.latestVersion.split('-')[0];
  const versionParts = baseVersion.split('.');
  const major = versionParts[0];
  const minor = versionParts[1] ? parseInt(versionParts[1]) : 0;
  const nextMinor = minor + 1;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const gitShortHash = execSync('git rev-parse --short HEAD').toString().trim();
  return {
    releaseVersion: `${major}.${nextMinor}.0-nightly.${date}.${gitShortHash}`,
    npmTag: 'nightly',
  };
}

function getNightlyVersion() {
  const packageJson = readJson('package.json');
  const baseVersion = packageJson.version.split('-')[0];
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const gitShortHash = execSync('git rev-parse --short HEAD').toString().trim();
  const releaseVersion = `${baseVersion}-nightly.${date}.${gitShortHash}`;
  return {
    releaseVersion,
    npmTag: 'nightly',
  };
}

function getStableVersion(args) {
  const tagResult = getAndVerifyTags('preview', 'v*-preview*');
  let releaseVersion;
  if (args.stable_version_override) {
    const overrideVersion = args.stable_version_override.replace(/^v/, '');
    validateVersion(overrideVersion, 'X.Y.Z', 'stable_version_override');
    releaseVersion = overrideVersion;
  } else if (tagResult) {
    releaseVersion = tagResult.latestVersion.replace(/-preview.*/, '');
    validateVersion(releaseVersion, 'X.Y.Z', 'derived from preview dist-tag');
    const latestStable = getVersionFromNPM('latest');
    if (
      latestStable &&
      semver.valid(latestStable) &&
      semver.gt(latestStable, releaseVersion)
    ) {
      throw new Error(
        `Derived stable version ${releaseVersion} is lower than published latest ${latestStable}. Refusing retrograde baseline.`,
      );
    }
  } else {
    const packageJson = readJson('package.json');
    releaseVersion = packageJson.version.split('-')[0];
    validateVersion(releaseVersion, 'X.Y.Z', 'package.json version');
  }

  return {
    releaseVersion,
    npmTag: 'latest',
  };
}

function getPreviewVersion(args) {
  const tagResult = getAndVerifyTags('nightly', 'v*-nightly*');
  let releaseVersion;
  if (args.preview_version_override) {
    const overrideVersion = args.preview_version_override.replace(/^v/, '');
    validateVersion(
      overrideVersion,
      'X.Y.Z-preview.N',
      'preview_version_override',
    );
    releaseVersion = overrideVersion;
  } else if (tagResult) {
    let baseVersion = tagResult.latestVersion.replace(/-nightly.*/, '');
    // When the nightly base is already published as stable, the preview must
    // target the next patch — otherwise the scheduled Tuesday release derives
    // a version whose channel packages already exist on npm (E403).
    // Use the rollback-aware lookup so a rolled-back dist-tag doesn't produce
    // a retrograde preview base.
    const latestTagResult = getAndVerifyTags('latest', 'v[0-9].[0-9].[0-9]');
    const latestStable = latestTagResult?.latestVersion ?? '';
    if (
      latestStable &&
      semver.valid(latestStable) &&
      semver.valid(baseVersion)
    ) {
      if (semver.gte(latestStable, baseVersion)) {
        const bumped = semver.inc(latestStable, 'patch');
        console.error(
          `Nightly base ${baseVersion} is at or below published latest ${latestStable}; bumping preview base to ${bumped}.`,
        );
        baseVersion = bumped;
      }
    }
    releaseVersion = baseVersion + '-preview.0';
    validateVersion(
      releaseVersion,
      'X.Y.Z-preview.N',
      'derived from nightly dist-tag',
    );
  } else {
    const packageJson = readJson('package.json');
    const baseVersion = packageJson.version.split('-')[0];
    releaseVersion = baseVersion + '-preview.0';
    validateVersion(baseVersion, 'X.Y.Z', 'package.json version');
  }

  return {
    releaseVersion,
    npmTag: 'preview',
  };
}

function getPatchVersion(patchFrom) {
  if (!patchFrom || (patchFrom !== 'stable' && patchFrom !== 'preview')) {
    throw new Error(
      'Patch type must be specified with --patch-from=stable or --patch-from=preview',
    );
  }
  const distTag = patchFrom === 'stable' ? 'latest' : 'preview';
  const pattern = distTag === 'latest' ? 'v[0-9].[0-9].[0-9]' : 'v*-preview*';
  const tagResult = getAndVerifyTags(distTag, pattern);
  if (!tagResult) {
    throw new Error(
      `Unable to determine baseline version for ${distTag} (required for patch)`,
    );
  }
  const { latestVersion } = tagResult;

  if (patchFrom === 'stable') {
    // For stable versions, increment the patch number: 0.5.4 -> 0.5.5
    const versionParts = latestVersion.split('.');
    const major = versionParts[0];
    const minor = versionParts[1];
    const patch = versionParts[2] ? parseInt(versionParts[2]) : 0;
    const releaseVersion = `${major}.${minor}.${patch + 1}`;
    return {
      releaseVersion,
      npmTag: distTag,
    };
  } else {
    // For preview versions, increment the preview number: 0.6.0-preview.2 -> 0.6.0-preview.3
    const [version, prereleasePart] = latestVersion.split('-');
    if (!prereleasePart || !prereleasePart.startsWith('preview.')) {
      throw new Error(
        `Invalid preview version format: ${latestVersion}. Expected format like "0.6.0-preview.2"`,
      );
    }

    const previewNumber = parseInt(prereleasePart.split('.')[1]);
    if (isNaN(previewNumber)) {
      throw new Error(`Could not parse preview number from: ${prereleasePart}`);
    }

    const releaseVersion = `${version}-preview.${previewNumber + 1}`;
    return {
      releaseVersion,
      npmTag: distTag,
    };
  }
}

export function getVersion(options = {}) {
  const args = { ...getArgs(), ...options };
  const type = args.type || 'nightly';

  let versionData;
  switch (type) {
    case 'nightly':
      versionData = getNightlyVersion();
      // Nightly versions include a git hash, so conflicts are highly unlikely
      // and indicate a problem. We'll still validate but not auto-increment.
      if (doesVersionExist(versionData.releaseVersion)) {
        throw new Error(
          `Version conflict! Nightly version ${versionData.releaseVersion} already exists.`,
        );
      }
      break;
    case 'promote-nightly':
      versionData = promoteNightlyVersion();
      break;
    case 'stable':
      versionData = getStableVersion(args);
      break;
    case 'preview':
      versionData = getPreviewVersion(args);
      break;
    case 'patch':
      versionData = getPatchVersion(args['patch-from']);
      break;
    default:
      throw new Error(`Unknown release type: ${type}`);
  }

  // For patchable versions, check for existence and increment if needed.
  if (type === 'stable' || type === 'preview' || type === 'patch') {
    let releaseVersion = versionData.releaseVersion;
    while (doesVersionExist(releaseVersion)) {
      console.error(`Version ${releaseVersion} exists, incrementing.`);
      if (releaseVersion.includes('-preview.')) {
        // Increment preview number: 0.6.0-preview.2 -> 0.6.0-preview.3
        const [version, prereleasePart] = releaseVersion.split('-');
        const previewNumber = parseInt(prereleasePart.split('.')[1]);
        releaseVersion = `${version}-preview.${previewNumber + 1}`;
      } else {
        // Increment patch number: 0.5.4 -> 0.5.5
        const versionParts = releaseVersion.split('.');
        const major = versionParts[0];
        const minor = versionParts[1];
        const patch = parseInt(versionParts[2]);
        releaseVersion = `${major}.${minor}.${patch + 1}`;
      }
    }
    versionData.releaseVersion = releaseVersion;
  }

  // All checks are done, construct the final result.
  const result = {
    releaseTag: `v${versionData.releaseVersion}`,
    ...versionData,
  };

  result.previousReleaseTag = getLatestStableReleaseTag();

  return result;
}

/**
 * CLI dispatch, exported for tests: `--assert-unreleased=<version>` runs
 * the push-time guard; anything else prints the version JSON. Returns the
 * exit code. Guard codes: 0 = unreleased, 3 = already shipped (a decisive,
 * benign refusal the workflow marks to skip the release-failed
 * notification), 2 = probe or usage failure. 1 is never returned on
 * purpose: node exits 1 on uncaught errors, and those must stay on the
 * real-failure path.
 */
export function runCli(args) {
  if (args['assert-unreleased'] !== undefined) {
    try {
      assertVersionUnreleased(args['assert-unreleased']);
    } catch (error) {
      // stdout, not stderr: the runner parses workflow commands from
      // stdout only, so ::error:: on stderr would never annotate.
      console.log(`::error::${error.message}`);
      return error.code === 'VERSION_SHIPPED' ? 3 : 2;
    }
    return 0;
  }
  console.log(JSON.stringify(getVersion(args), null, 2));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = runCli(getArgs());
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
