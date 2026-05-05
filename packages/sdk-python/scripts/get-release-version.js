#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getArgs,
  isExpectedMissingGitHubRelease,
  validateVersion,
} from '../../../scripts/lib/release-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_NAME = 'qwen-code-sdk';
const TAG_PREFIX = 'sdk-python-';
const NETWORK_COMMAND_TIMEOUT_MS = 30_000;
const LOCAL_COMMAND_TIMEOUT_MS = 10_000;

function readPyprojectVersion() {
  const pyprojectPath = join(__dirname, '..', 'pyproject.toml');
  const content = readFileSync(pyprojectPath, 'utf8');
  const match = content.match(/^version = "([^"]+)"$/m);
  if (!match) {
    throw new Error(`Could not find version in ${pyprojectPath}`);
  }
  return match[1];
}

function parseVersion(version) {
  let match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      stage: 'stable',
      stageNumber: 0,
      raw: version,
    };
  }

  match = version.match(/^(\d+)\.(\d+)\.(\d+)rc(\d+)$/);
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      stage: 'preview',
      stageNumber: Number(match[4]),
      raw: version,
    };
  }

  match = version.match(/^(\d+)\.(\d+)\.(\d+)\.dev(\d+)$/);
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      stage: 'nightly',
      stageNumber: Number(match[4]),
      raw: version,
    };
  }

  return null;
}

function compareVersions(a, b) {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) {
    throw new Error(`Cannot compare unsupported versions: ${a}, ${b}`);
  }

  if (parsedA.major !== parsedB.major) {
    return parsedA.major - parsedB.major;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor - parsedB.minor;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch - parsedB.patch;
  }

  const stageOrder = {
    nightly: 0,
    preview: 1,
    stable: 2,
  };

  if (stageOrder[parsedA.stage] !== stageOrder[parsedB.stage]) {
    return stageOrder[parsedA.stage] - stageOrder[parsedB.stage];
  }

  return parsedA.stageNumber - parsedB.stageNumber;
}

function sortDescending(versions) {
  return [...versions].sort((a, b) => compareVersions(b, a));
}

function toBaseVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

async function getAllVersionsFromPyPI() {
  const response = await fetch(`https://pypi.org/pypi/${PACKAGE_NAME}/json`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(NETWORK_COMMAND_TIMEOUT_MS),
  });

  if (response.status === 404) {
    return { versions: [], allVersions: [] };
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PyPI metadata: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  const releases = payload.releases ?? {};
  const allVersions = Object.keys(releases).filter(
    (version) => parseVersion(version) !== null,
  );
  // Yanked versions still occupy PyPI slots (re-upload fails), so allVersions
  // includes them for conflict detection. The filtered list excludes yanked
  // versions so base-version computation uses only live releases.
  const versions = allVersions.filter((version) => {
    const files = releases[version];
    if (Array.isArray(files) && files.length > 0) {
      return !files.every((file) => file.yanked === true);
    }
    return true;
  });
  return { versions, allVersions };
}

function getCurrentPackageBaseVersion() {
  return toBaseVersion(readPyprojectVersion());
}

function getLatestStableVersion(versions) {
  const stableVersions = versions.filter(
    (version) => parseVersion(version)?.stage === 'stable',
  );

  if (stableVersions.length === 0) {
    return '';
  }

  return sortDescending(stableVersions)[0];
}

function getLatestPreviewBaseVersion(versions) {
  const previewVersions = versions.filter(
    (version) => parseVersion(version)?.stage === 'preview',
  );

  if (previewVersions.length === 0) {
    return '';
  }

  return toBaseVersion(sortDescending(previewVersions)[0]);
}

function getLatestNightlyBaseVersion(versions) {
  const nightlyVersions = versions.filter(
    (version) => parseVersion(version)?.stage === 'nightly',
  );

  if (nightlyVersions.length === 0) {
    return '';
  }

  return toBaseVersion(sortDescending(nightlyVersions)[0]);
}

function incrementPatchVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Unsupported baseline version: ${version}`);
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function getNextBaseVersion(versions) {
  const stableVersions = versions.filter(
    (version) => parseVersion(version)?.stage === 'stable',
  );
  const stableBaseline = sortDescending([
    ...stableVersions,
    getCurrentPackageBaseVersion(),
  ])[0];
  const latestPrereleaseBase = sortDescending(
    [
      getLatestPreviewBaseVersion(versions),
      getLatestNightlyBaseVersion(versions),
    ].filter(Boolean),
  )[0];

  if (
    latestPrereleaseBase &&
    compareVersions(latestPrereleaseBase, stableBaseline) >= 0
  ) {
    return latestPrereleaseBase;
  }

  // On first release (no stable versions on PyPI), use the pyproject.toml
  // version directly instead of incrementing it.
  if (stableVersions.length === 0) {
    return stableBaseline;
  }

  return incrementPatchVersion(stableBaseline);
}

function getUtcTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

function getGitShortHash() {
  try {
    return execSync('git rev-parse --short HEAD', {
      timeout: LOCAL_COMMAND_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `git rev-parse timed out after ${LOCAL_COMMAND_TIMEOUT_MS / 1000}s — local git may be unresponsive`,
      );
    }
    throw error;
  }
}

function isTimeoutError(error) {
  // Node.js execSync timeout: `code` is 'ETIMEDOUT' on POSIX; on some
  // versions/platforms `killed` is true with signal 'SIGTERM' or null.
  // Match the pattern used in packages/core/src/utils/pdf.ts.
  return (
    error.code === 'ETIMEDOUT' ||
    (error.killed === true &&
      (error.signal === 'SIGTERM' ||
        error.signal === undefined ||
        error.signal === null))
  );
}

async function getReleaseState({ packageVersion, releaseTag }, allVersions) {
  const state = {
    packageVersionExistsOnPyPI: allVersions.includes(packageVersion),
    gitTagExists: false,
    githubReleaseExists: false,
  };
  const fullTag = `${TAG_PREFIX}${releaseTag}`;
  try {
    const tagOutput = execSync(`git tag -l '${fullTag}'`, {
      timeout: LOCAL_COMMAND_TIMEOUT_MS,
    })
      .toString()
      .trim();
    if (tagOutput === fullTag) {
      state.gitTagExists = true;
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `git tag -l timed out after ${LOCAL_COMMAND_TIMEOUT_MS / 1000}s — local git may be unresponsive`,
      );
    }
    throw new Error(`Failed to check git tags for conflicts: ${error.message}`);
  }

  try {
    const output = execSync(
      `gh release view "${fullTag}" --json tagName --jq .tagName`,
      { timeout: NETWORK_COMMAND_TIMEOUT_MS },
    )
      .toString()
      .trim();
    if (output === fullTag) {
      state.githubReleaseExists = true;
    }
  } catch (error) {
    // Timeout check must precede isExpectedMissingGitHubRelease — a timed-out
    // process may emit partial stderr matching "release not found".
    if (isTimeoutError(error)) {
      throw new Error(
        `gh release view timed out after ${NETWORK_COMMAND_TIMEOUT_MS / 1000}s checking "${fullTag}" — GitHub API may be unavailable`,
      );
    }
    if (!isExpectedMissingGitHubRelease(error)) {
      throw new Error(
        `Failed to check GitHub releases for conflicts: ${error.message}`,
      );
    }
  }

  return state;
}

function getNightlyVersion(versions) {
  const baseVersion = getNextBaseVersion(versions);
  const timestamp = getUtcTimestamp();
  const gitShortHash = getGitShortHash();

  return {
    releaseVersion: `${baseVersion}-nightly.${timestamp}.${gitShortHash}`,
    packageVersion: `${baseVersion}.dev${timestamp}`,
    publishChannel: 'nightly',
  };
}

function getPreviewVersion(args, versions) {
  if (args.preview_version_override) {
    const overrideVersion = args.preview_version_override.replace(/^v/, '');
    validateVersion(
      overrideVersion,
      'X.Y.Z-preview.N',
      'preview_version_override',
    );
    const match = overrideVersion.match(/^(\d+\.\d+\.\d+)-preview\.(\d+)$/);
    if (!match) {
      throw new Error(`Invalid preview override: ${overrideVersion}`);
    }
    return {
      releaseVersion: overrideVersion,
      packageVersion: `${match[1]}rc${match[2]}`,
      publishChannel: 'preview',
    };
  }

  const baseVersion = getNextBaseVersion(versions);
  return {
    releaseVersion: `${baseVersion}-preview.0`,
    packageVersion: `${baseVersion}rc0`,
    publishChannel: 'preview',
  };
}

function getStableVersion(args, versions) {
  if (args.stable_version_override) {
    const overrideVersion = args.stable_version_override.replace(/^v/, '');
    validateVersion(overrideVersion, 'X.Y.Z', 'stable_version_override');
    const latestStable = getLatestStableVersion(versions);
    if (latestStable && compareVersions(overrideVersion, latestStable) < 0) {
      throw new Error(
        `stable_version_override ${overrideVersion} is older than latest stable ${latestStable}. ` +
          `Publishing an older stable version is unusual — provide a newer version or contact a maintainer.`,
      );
    }
    return {
      releaseVersion: overrideVersion,
      packageVersion: overrideVersion,
      publishChannel: 'latest',
    };
  }

  const latestPrerelease = [
    { baseVersion: getLatestPreviewBaseVersion(versions), source: 'preview' },
    { baseVersion: getLatestNightlyBaseVersion(versions), source: 'nightly' },
  ]
    .filter(({ baseVersion }) => Boolean(baseVersion))
    .sort((a, b) => compareVersions(b.baseVersion, a.baseVersion))[0];
  const latestStable = getLatestStableVersion(versions);

  if (latestPrerelease) {
    if (latestPrerelease.source !== 'preview') {
      console.error(
        `::warning::Stable release ${latestPrerelease.baseVersion} derived from ${latestPrerelease.source} (no preview release found with this base version).`,
      );
    }
    if (
      latestStable &&
      compareVersions(latestPrerelease.baseVersion, latestStable) < 0
    ) {
      throw new Error(
        `Latest ${latestPrerelease.source} base ${latestPrerelease.baseVersion} is not newer than latest stable ${latestStable}. Provide stable_version_override to continue.`,
      );
    }
    return {
      releaseVersion: latestPrerelease.baseVersion,
      packageVersion: latestPrerelease.baseVersion,
      publishChannel: 'latest',
      source: latestPrerelease.source,
    };
  }

  const releaseVersion = getCurrentPackageBaseVersion();
  return {
    releaseVersion,
    packageVersion: releaseVersion,
    publishChannel: 'latest',
    source: 'current',
  };
}

function getConflictSources(releaseState) {
  const sources = [];
  if (releaseState.packageVersionExistsOnPyPI) {
    sources.push('PyPI');
  }
  if (releaseState.githubReleaseExists) {
    sources.push('GitHub releases');
  }
  if (releaseState.gitTagExists) {
    sources.push('git tags');
  }
  return sources.length > 0 ? sources.join(', ') : 'unknown release state';
}

function bumpVersion(versionData) {
  const match = versionData.releaseVersion.match(
    /^(\d+\.\d+\.\d+)-preview\.(\d+)$/,
  );
  if (!match) {
    throw new Error(
      `Cannot bump preview version: ${versionData.releaseVersion}`,
    );
  }
  const nextNumber = Number(match[2]) + 1;
  return {
    ...versionData,
    releaseVersion: `${match[1]}-preview.${nextNumber}`,
    packageVersion: `${match[1]}rc${nextNumber}`,
  };
}

async function getVersion(options = {}) {
  const args = { ...getArgs(), ...options };
  const type = args.type || 'nightly';
  const { versions, allVersions } = await getAllVersionsFromPyPI();
  const hasManualOverride =
    (type === 'preview' && Boolean(args.preview_version_override)) ||
    (type === 'stable' && Boolean(args.stable_version_override));

  let versionData;
  let resumeExistingRelease = false;
  switch (type) {
    case 'nightly':
      versionData = getNightlyVersion(versions);
      break;
    case 'preview':
      versionData = getPreviewVersion(args, versions);
      break;
    case 'stable':
      versionData = getStableVersion(args, versions);
      break;
    default:
      throw new Error(`Unknown release type: ${type}`);
  }

  while (true) {
    const releaseState = await getReleaseState(
      {
        packageVersion: versionData.packageVersion,
        releaseTag: `v${versionData.releaseVersion}`,
      },
      allVersions,
    );

    const versionExists =
      releaseState.packageVersionExistsOnPyPI ||
      releaseState.gitTagExists ||
      releaseState.githubReleaseExists;
    if (!versionExists) {
      break;
    }

    if (
      !hasManualOverride &&
      releaseState.packageVersionExistsOnPyPI &&
      !releaseState.githubReleaseExists
    ) {
      console.error(
        `PyPI version ${versionData.packageVersion} already exists without a matching GitHub release. Reusing the same release version.`,
      );
      resumeExistingRelease = true;
      break;
    }

    if (
      !hasManualOverride &&
      type === 'stable' &&
      releaseState.packageVersionExistsOnPyPI &&
      releaseState.githubReleaseExists
    ) {
      console.error(
        `Stable release ${versionData.releaseVersion} already has a matching GitHub release. Reusing the same release version for post-release recovery.`,
      );
      resumeExistingRelease = true;
      break;
    }

    if (hasManualOverride) {
      throw new Error(
        `Requested ${type} release ${versionData.releaseVersion} already exists on ${getConflictSources(releaseState)}.`,
      );
    }

    if (releaseState.githubReleaseExists) {
      console.error(
        `GitHub release ${TAG_PREFIX}v${versionData.releaseVersion} already exists.`,
      );
    } else if (releaseState.gitTagExists) {
      console.error(
        `::warning::Orphan git tag ${TAG_PREFIX}v${versionData.releaseVersion} exists without a PyPI version or GitHub release. Skipping to next version slot.`,
      );
    } else if (releaseState.packageVersionExistsOnPyPI) {
      console.error(
        `PyPI version ${versionData.packageVersion} already exists.`,
      );
    }

    if (type === 'stable') {
      if (
        versionData.source === 'preview' ||
        versionData.source === 'nightly'
      ) {
        throw new Error(
          `Stable release ${versionData.releaseVersion} derived from the latest ${versionData.source} already exists.`,
        );
      }

      throw new Error(
        `Stable release ${versionData.releaseVersion} already exists. Provide stable_version_override to release a different stable version.`,
      );
    }

    if (type === 'nightly') {
      throw new Error(
        `Nightly version conflict for ${versionData.packageVersion}`,
      );
    }

    versionData = bumpVersion(versionData);
  }

  const previousVersion =
    type === 'stable'
      ? getLatestStableVersion(
          versions.filter((v) => v !== versionData.releaseVersion),
        )
      : '';

  return {
    releaseTag: `v${versionData.releaseVersion}`,
    releaseVersion: versionData.releaseVersion,
    packageVersion: versionData.packageVersion,
    previousReleaseTag: previousVersion ? `v${previousVersion}` : '',
    publishChannel: versionData.publishChannel,
    resumeExistingRelease,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await getVersion(getArgs());
  console.log(JSON.stringify(result, null, 2));
}

export { getVersion };
