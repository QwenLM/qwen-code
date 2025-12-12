#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_NAME = '@qwen-code/sdk';
const TAG_PREFIX = 'sdk-typescript-v';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function getArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--')) {
      const [key, value] = arg.substring(2).split('=');
      args[key] = value === undefined ? true : value;
    }
  });
  return args;
}

function getVersionFromNPM(distTag) {
  const command = `npm view ${PACKAGE_NAME} version --tag=${distTag}`;
  try {
    return execSync(command).toString().trim();
  } catch (error) {
    console.error(
      `Failed to get NPM version for dist-tag "${distTag}": ${error.message}`,
    );
    return '';
  }
}

function getAllVersionsFromNPM() {
  const command = `npm view ${PACKAGE_NAME} versions --json`;
  try {
    const versionsJson = execSync(command).toString().trim();
    const result = JSON.parse(versionsJson);
    // npm returns a string if there's only one version, array otherwise
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    console.error(`Failed to get all NPM versions: ${error.message}`);
    return [];
  }
}

function isVersionDeprecated(version) {
  const command = `npm view ${PACKAGE_NAME}@${version} deprecated`;
  try {
    const output = execSync(command).toString().trim();
    return output.length > 0;
  } catch (error) {
    console.error(
      `Failed to check deprecation status for ${version}: ${error.message}`,
    );
    return false;
  }
}

function semverCompare(a, b) {
  const parseVersion = (v) => {
    const [main, prerelease] = v.split('-');
    const [major, minor, patch] = main.split('.').map(Number);
    return { major, minor, patch, prerelease: prerelease || '' };
  };

  const va = parseVersion(a);
  const vb = parseVersion(b);

  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;

  // Handle prerelease comparison
  if (!va.prerelease && vb.prerelease) return 1; // stable > prerelease
  if (va.prerelease && !vb.prerelease) return -1; // prerelease < stable
  if (va.prerelease && vb.prerelease) {
    return va.prerelease.localeCompare(vb.prerelease);
  }
  return 0;
}

function detectRollbackAndGetBaseline(npmDistTag) {
  const distTagVersion = getVersionFromNPM(npmDistTag);
  if (!distTagVersion) return { baseline: '', isRollback: false };

  const allVersions = getAllVersionsFromNPM();
  if (allVersions.length === 0)
    return { baseline: distTagVersion, isRollback: false };

  let matchingVersions;
  if (npmDistTag === 'latest') {
    matchingVersions = allVersions.filter((v) => !v.includes('-'));
  } else if (npmDistTag === 'preview') {
    matchingVersions = allVersions.filter((v) => v.includes('-preview'));
  } else if (npmDistTag === 'nightly') {
    matchingVersions = allVersions.filter((v) => v.includes('-nightly'));
  } else {
    return { baseline: distTagVersion, isRollback: false };
  }

  if (matchingVersions.length === 0)
    return { baseline: distTagVersion, isRollback: false };

  matchingVersions.sort((a, b) => -semverCompare(a, b));

  let highestExistingVersion = '';
  for (const version of matchingVersions) {
    if (!isVersionDeprecated(version)) {
      highestExistingVersion = version;
      break;
    } else {
      console.error(`Ignoring deprecated version: ${version}`);
    }
  }

  if (!highestExistingVersion) {
    highestExistingVersion = distTagVersion;
  }

  const isRollback = semverCompare(highestExistingVersion, distTagVersion) > 0;

  return {
    baseline: isRollback ? highestExistingVersion : distTagVersion,
    isRollback,
    distTagVersion,
    highestExistingVersion,
  };
}

function doesVersionExist(version) {
  // Check NPM
  try {
    const command = `npm view ${PACKAGE_NAME}@${version} version 2>/dev/null`;
    const output = execSync(command).toString().trim();
    if (output === version) {
      console.error(`Version ${version} already exists on NPM.`);
      return true;
    }
  } catch (_error) {
    // This is expected if the version doesn't exist.
  }

  // Check Git tags
  try {
    const command = `git tag -l '${TAG_PREFIX}${version}'`;
    const tagOutput = execSync(command).toString().trim();
    if (tagOutput === `${TAG_PREFIX}${version}`) {
      console.error(`Git tag ${TAG_PREFIX}${version} already exists.`);
      return true;
    }
  } catch (error) {
    console.error(`Failed to check git tags for conflicts: ${error.message}`);
  }

  // Check GitHub releases
  try {
    const command = `gh release view "${TAG_PREFIX}${version}" --json tagName --jq .tagName 2>/dev/null`;
    const output = execSync(command).toString().trim();
    if (output === `${TAG_PREFIX}${version}`) {
      console.error(`GitHub release ${TAG_PREFIX}${version} already exists.`);
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

function getAndVerifyTags(npmDistTag) {
  const rollbackInfo = detectRollbackAndGetBaseline(npmDistTag);
  const baselineVersion = rollbackInfo.baseline;

  if (!baselineVersion) {
    // First release for this dist-tag, use package.json version as baseline
    const packageJson = readJson(join(__dirname, '..', 'package.json'));
    return {
      latestVersion: packageJson.version.split('-')[0],
      latestTag: `v${packageJson.version.split('-')[0]}`,
    };
  }

  if (rollbackInfo.isRollback) {
    console.error(
      `Rollback detected! NPM ${npmDistTag} tag is ${rollbackInfo.distTagVersion}, but using ${baselineVersion} as baseline for next version calculation.`,
    );
  }

  return {
    latestVersion: baselineVersion,
    latestTag: `v${baselineVersion}`,
  };
}

function getLatestStableReleaseTag() {
  try {
    const { latestTag } = getAndVerifyTags('latest');
    return latestTag;
  } catch (error) {
    console.error(
      `Failed to determine latest stable release tag: ${error.message}`,
    );
    return '';
  }
}

function getNightlyVersion() {
  const packageJson = readJson(join(__dirname, '..', 'package.json'));
  const baseVersion = packageJson.version.split('-')[0];
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const gitShortHash = execSync('git rev-parse --short HEAD').toString().trim();
  const releaseVersion = `${baseVersion}-nightly.${date}.${gitShortHash}`;
  return {
    releaseVersion,
    npmTag: 'nightly',
  };
}

function validateVersion(version, format, name) {
  const versionRegex = {
    'X.Y.Z': /^\d+\.\d+\.\d+$/,
    'X.Y.Z-preview.N': /^\d+\.\d+\.\d+-preview\.\d+$/,
  };

  if (!versionRegex[format] || !versionRegex[format].test(version)) {
    throw new Error(
      `Invalid ${name}: ${version}. Must be in ${format} format.`,
    );
  }
}

function getStableVersion(args) {
  let releaseVersion;
  if (args.stable_version_override) {
    const overrideVersion = args.stable_version_override.replace(/^v/, '');
    validateVersion(overrideVersion, 'X.Y.Z', 'stable_version_override');
    releaseVersion = overrideVersion;
  } else {
    // Try to get from preview, fallback to package.json for first release
    const { latestVersion: latestPreviewVersion } = getAndVerifyTags('preview');
    releaseVersion = latestPreviewVersion.replace(/-preview.*/, '');
  }

  return {
    releaseVersion,
    npmTag: 'latest',
  };
}

function getPreviewVersion(args) {
  let releaseVersion;
  if (args.preview_version_override) {
    const overrideVersion = args.preview_version_override.replace(/^v/, '');
    validateVersion(
      overrideVersion,
      'X.Y.Z-preview.N',
      'preview_version_override',
    );
    releaseVersion = overrideVersion;
  } else {
    // Try to get from nightly, fallback to package.json for first release
    const { latestVersion: latestNightlyVersion } = getAndVerifyTags('nightly');
    releaseVersion =
      latestNightlyVersion.replace(/-nightly.*/, '') + '-preview.0';
  }

  return {
    releaseVersion,
    npmTag: 'preview',
  };
}

export function getVersion(options = {}) {
  const args = { ...getArgs(), ...options };
  const type = args.type || 'nightly';

  let versionData;
  switch (type) {
    case 'nightly':
      versionData = getNightlyVersion();
      if (doesVersionExist(versionData.releaseVersion)) {
        throw new Error(
          `Version conflict! Nightly version ${versionData.releaseVersion} already exists.`,
        );
      }
      break;
    case 'stable':
      versionData = getStableVersion(args);
      break;
    case 'preview':
      versionData = getPreviewVersion(args);
      break;
    default:
      throw new Error(`Unknown release type: ${type}`);
  }

  // For stable and preview versions, check for existence and increment if needed.
  if (type === 'stable' || type === 'preview') {
    let releaseVersion = versionData.releaseVersion;
    while (doesVersionExist(releaseVersion)) {
      console.error(`Version ${releaseVersion} exists, incrementing.`);
      if (releaseVersion.includes('-preview.')) {
        const [version, prereleasePart] = releaseVersion.split('-');
        const previewNumber = parseInt(prereleasePart.split('.')[1]);
        releaseVersion = `${version}-preview.${previewNumber + 1}`;
      } else {
        const versionParts = releaseVersion.split('.');
        const major = versionParts[0];
        const minor = versionParts[1];
        const patch = parseInt(versionParts[2]);
        releaseVersion = `${major}.${minor}.${patch + 1}`;
      }
    }
    versionData.releaseVersion = releaseVersion;
  }

  const result = {
    releaseTag: `v${versionData.releaseVersion}`,
    ...versionData,
  };

  result.previousReleaseTag = getLatestStableReleaseTag();

  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = JSON.stringify(getVersion(getArgs()), null, 2);
  console.log(version);
}
