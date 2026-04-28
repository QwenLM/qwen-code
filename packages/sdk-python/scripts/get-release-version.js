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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_NAME = 'qwen-code-sdk';
const TAG_PREFIX = 'sdk-python-';

function readPyprojectVersion() {
  const pyprojectPath = join(__dirname, '..', 'pyproject.toml');
  const content = readFileSync(pyprojectPath, 'utf8');
  const match = content.match(/^version = "([^"]+)"$/m);
  if (!match) {
    throw new Error(`Could not find version in ${pyprojectPath}`);
  }
  return match[1];
}

function getArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) {
      continue;
    }
    const [key, value] = arg.slice(2).split('=');
    args[key] = value === undefined ? true : value;
  }
  return args;
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
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PyPI metadata: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  return Object.keys(payload.releases ?? {}).filter(
    (version) => parseVersion(version) !== null,
  );
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

function getNextPatchBaseVersion(versions) {
  const latestStable = getLatestStableVersion(versions);
  const baseline = latestStable || getCurrentPackageBaseVersion();
  const parsed = parseVersion(baseline);
  if (!parsed) {
    throw new Error(`Unsupported baseline version: ${baseline}`);
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
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
  return execSync('git rev-parse --short HEAD').toString().trim();
}

function validateVersion(version, format, name) {
  const versionRegex = {
    stable: /^\d+\.\d+\.\d+$/,
    preview: /^\d+\.\d+\.\d+-preview\.\d+$/,
  };

  if (!versionRegex[format]?.test(version)) {
    throw new Error(`Invalid ${name}: ${version}`);
  }
}

async function doesVersionExist({ packageVersion, releaseTag }, versions) {
  if (versions.includes(packageVersion)) {
    console.error(`PyPI version ${packageVersion} already exists.`);
    return true;
  }

  const fullTag = `${TAG_PREFIX}${releaseTag}`;
  try {
    const tagOutput = execSync(`git tag -l '${fullTag}'`).toString().trim();
    if (tagOutput === fullTag) {
      console.error(`Git tag ${fullTag} already exists.`);
      return true;
    }
  } catch (error) {
    console.error(`Failed to check git tags: ${error.message}`);
  }

  try {
    const output = execSync(
      `gh release view "${fullTag}" --json tagName --jq .tagName 2>/dev/null`,
    )
      .toString()
      .trim();
    if (output === fullTag) {
      console.error(`GitHub release ${fullTag} already exists.`);
      return true;
    }
  } catch (error) {
    const isExpectedNotFound =
      error.message.includes('release not found') ||
      error.message.includes('Not Found') ||
      error.message.includes('not found') ||
      error.status === 1;
    if (!isExpectedNotFound) {
      console.error(
        `Failed to check GitHub releases for conflicts: ${error.message}`,
      );
    }
  }

  return false;
}

function getNightlyVersion(versions) {
  const baseVersion = getNextPatchBaseVersion(versions);
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
    validateVersion(overrideVersion, 'preview', 'preview_version_override');
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

  const baseVersion = getNextPatchBaseVersion(versions);
  return {
    releaseVersion: `${baseVersion}-preview.0`,
    packageVersion: `${baseVersion}rc0`,
    publishChannel: 'preview',
  };
}

function getStableVersion(args, versions) {
  if (args.stable_version_override) {
    const overrideVersion = args.stable_version_override.replace(/^v/, '');
    validateVersion(overrideVersion, 'stable', 'stable_version_override');
    return {
      releaseVersion: overrideVersion,
      packageVersion: overrideVersion,
      publishChannel: 'latest',
    };
  }

  const previewBase = getLatestPreviewBaseVersion(versions);
  const releaseVersion = previewBase || getCurrentPackageBaseVersion();
  return {
    releaseVersion,
    packageVersion: releaseVersion,
    publishChannel: 'latest',
  };
}

function bumpVersion(versionData, type) {
  if (type === 'preview') {
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

  if (type === 'stable') {
    const parsed = parseVersion(versionData.packageVersion);
    if (!parsed) {
      throw new Error(
        `Cannot bump stable version: ${versionData.packageVersion}`,
      );
    }
    const nextVersion = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    return {
      ...versionData,
      releaseVersion: nextVersion,
      packageVersion: nextVersion,
    };
  }

  throw new Error(`Nightly version conflict for ${versionData.packageVersion}`);
}

async function getVersion(options = {}) {
  const args = { ...getArgs(), ...options };
  const type = args.type || 'nightly';
  const versions = await getAllVersionsFromPyPI();

  let versionData;
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

  while (
    await doesVersionExist(
      {
        packageVersion: versionData.packageVersion,
        releaseTag: `v${versionData.releaseVersion}`,
      },
      versions,
    )
  ) {
    versionData = bumpVersion(versionData, type);
  }

  const latestStableVersion = getLatestStableVersion(versions);

  return {
    releaseTag: `v${versionData.releaseVersion}`,
    releaseVersion: versionData.releaseVersion,
    packageVersion: versionData.packageVersion,
    previousReleaseTag: latestStableVersion ? `v${latestStableVersion}` : '',
    publishChannel: versionData.publishChannel,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await getVersion(getArgs());
  console.log(JSON.stringify(result, null, 2));
}

export { getVersion };
