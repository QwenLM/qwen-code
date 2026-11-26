/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface ParsedVersion {
  segments: number[];
  prerelease: string | null;
}

/**
 * Parse a version string into numeric segments and an optional pre-release tag.
 * Strips a leading 'v' / 'V' prefix if present.
 */
function parseVersion(v: string): ParsedVersion {
  const cleaned = v.replace(/^[vV]/, '');
  const [core, ...rest] = cleaned.split('-');
  const prerelease = rest.length > 0 ? rest.join('-') : null;
  const segments = (core ?? '').split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return { segments, prerelease };
}

/**
 * Compare pre-release identifiers per semver §11:
 *   – Identifiers consisting of only digits are compared numerically.
 *   – Alphanumeric identifiers are compared lexically (ASCII sort).
 *   – Numeric identifiers always have lower precedence than alphanumeric.
 *   – Fewer identifiers → lower precedence when all preceding are equal.
 */
function comparePrerelease(a: string, b: string): -1 | 0 | 1 {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];

    if (pa === undefined && pb !== undefined) return -1;
    if (pa !== undefined && pb === undefined) return 1;
    if (pa === undefined || pb === undefined) return 0;

    const aIsNum = /^\d+$/.test(pa);
    const bIsNum = /^\d+$/.test(pb);

    if (aIsNum && bIsNum) {
      const diff = parseInt(pa, 10) - parseInt(pb, 10);
      if (diff > 0) return 1;
      if (diff < 0) return -1;
    } else if (aIsNum && !bIsNum) {
      return -1;
    } else if (!aIsNum && bIsNum) {
      return 1;
    } else {
      if (pa > pb) return 1;
      if (pa < pb) return -1;
    }
  }

  return 0;
}

/**
 * Compare two semver-like version strings.
 *
 * Returns:
 *    1  if a is newer than b
 *    0  if a and b are equal
 *   -1  if a is older than b
 *
 * Handles:
 *   – Numeric segment comparison (major.minor.patch.…)
 *   – Pre-release ordering per semver §11 (e.g. 1.0.0-alpha < 1.0.0-beta < 1.0.0)
 *   – Leading 'v' prefix stripping
 *   – Segments of different lengths (missing segments treated as 0)
 *
 * Exported for unit testing.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  // Compare numeric segments (major.minor.patch…)
  const maxLen = Math.max(parsedA.segments.length, parsedB.segments.length);
  for (let i = 0; i < maxLen; i++) {
    const segA = parsedA.segments[i] ?? 0;
    const segB = parsedB.segments[i] ?? 0;
    if (segA > segB) return 1;
    if (segA < segB) return -1;
  }

  // Numeric parts are equal — compare pre-release.
  // No pre-release > has pre-release (e.g. 1.0.0 > 1.0.0-beta).
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (parsedA.prerelease && parsedB.prerelease) {
    return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Local version file helpers
// ---------------------------------------------------------------------------
