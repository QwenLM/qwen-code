/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'child_process';

/**
 * Determines the correct previous tag for release notes generation.
 * This function handles the complexity of mixed tag types (regular releases vs nightly releases).
 *
 * @param {string} currentTag - The current release tag (e.g., "v0.1.23")
 * @returns {string|null} - The previous tag to compare against, or null if no suitable tag found
 */
export function getPreviousTag(currentTag) {
  try {
    // Parse the current tag to understand its type
    const currentTagInfo = parseTag(currentTag);
    if (!currentTagInfo) {
      console.error(`Invalid current tag format: ${currentTag}`);
      return null;
    }

    // Find the appropriate previous tag based on the current tag type
    let previousTag = null;

    if (currentTagInfo.isNightly) {
      // For nightly releases, find the last stable release
      previousTag = findLastStableTag(currentTagInfo);
    } else {
      // For stable releases, find the previous stable release
      previousTag = findPreviousStableTag(currentTagInfo);
    }

    return previousTag;
  } catch (error) {
    console.error('Error getting previous tag:', error.message);
    return null;
  }
}

/**
 * Parses a tag string to extract version information and type
 */
function parseTag(tag) {
  // Remove 'v' prefix if present
  const cleanTag = tag.startsWith('v') ? tag.substring(1) : tag;

  // Match pattern: X.Y.Z or X.Y.Z-prerelease
  const match = cleanTag.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) {
    return null;
  }

  const [, major, minor, patch, prerelease] = match;

  return {
    original: tag,
    major: parseInt(major),
    minor: parseInt(minor),
    patch: parseInt(patch),
    prerelease: prerelease || null,
    isNightly: prerelease && prerelease.startsWith('nightly'),
    isPreview: prerelease && prerelease.startsWith('preview'),
    version: `${major}.${minor}.${patch}`,
  };
}

/**
 * Finds the last stable tag for a nightly release
 * Assumes version numbers are incremental and checks backwards from current version
 */
function findLastStableTag(currentTagInfo) {
  // For nightly releases, find the stable version of the same version number first
  const baseVersion = `v${currentTagInfo.version}`;

  // Check if the stable version of the current version exists
  if (tagExists(baseVersion)) {
    return baseVersion;
  }

  // If not, look for the previous stable versions by decrementing version numbers
  let { major, minor, patch } = currentTagInfo;

  // Try decrementing patch version first
  while (patch > 0) {
    patch--;
    const candidateTag = `v${major}.${minor}.${patch}`;
    if (tagExists(candidateTag)) {
      return candidateTag;
    }
  }

  // Try decrementing minor version
  while (minor > 0) {
    minor--;
    patch = 999; // Start from a high patch number and work backwards
    while (patch >= 0) {
      const candidateTag = `v${major}.${minor}.${patch}`;
      if (tagExists(candidateTag)) {
        return candidateTag;
      }
      patch--;
      // Don't check too many patch versions to avoid infinite loops
      if (patch < 0) break;
    }
  }

  // Try decrementing major version
  while (major > 0) {
    major--;
    minor = 999; // Start from a high minor number and work backwards
    while (minor >= 0) {
      patch = 999;
      while (patch >= 0) {
        const candidateTag = `v${major}.${minor}.${patch}`;
        if (tagExists(candidateTag)) {
          return candidateTag;
        }
        patch--;
        if (patch < 0) break;
      }
      minor--;
      if (minor < 0) break;
    }
  }

  return null;
}

/**
 * Finds the previous stable tag for a stable release
 * Assumes version numbers are incremental and checks backwards from current version
 */
function findPreviousStableTag(currentTagInfo) {
  let { major, minor, patch } = currentTagInfo;

  // Try decrementing patch version first
  while (patch > 0) {
    patch--;
    const candidateTag = `v${major}.${minor}.${patch}`;
    if (tagExists(candidateTag)) {
      return candidateTag;
    }
  }

  // Try decrementing minor version
  while (minor > 0) {
    minor--;
    patch = 999; // Start from a high patch number and work backwards
    while (patch >= 0) {
      const candidateTag = `v${major}.${minor}.${patch}`;
      if (tagExists(candidateTag)) {
        return candidateTag;
      }
      patch--;
      // Don't check too many patch versions to avoid infinite loops
      if (patch < 0) break;
    }
  }

  // Try decrementing major version
  while (major > 0) {
    major--;
    minor = 999; // Start from a high minor number and work backwards
    while (minor >= 0) {
      patch = 999;
      while (patch >= 0) {
        const candidateTag = `v${major}.${minor}.${patch}`;
        if (tagExists(candidateTag)) {
          return candidateTag;
        }
        patch--;
        if (patch < 0) break;
      }
      minor--;
      if (minor < 0) break;
    }
  }

  return null;
}

/**
 * Checks if a git tag exists
 */
function tagExists(tag) {
  try {
    execSync(`git rev-parse --verify ${tag}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// CLI usage
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const currentTag = process.argv[2];

  if (!currentTag) {
    console.error('Usage: node get-previous-tag.js <current-tag>');
    process.exit(1);
  }

  const previousTag = getPreviousTag(currentTag);
  if (previousTag) {
    console.log(previousTag);
  } else {
    console.error('No suitable previous tag found');
    process.exit(1);
  }
}
