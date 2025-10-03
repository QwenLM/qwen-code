/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getReleaseVersion } from '../get-release-version';

// Mock child_process so we can spy on execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

describe('getReleaseVersion', async () => {
  // Dynamically import execSync and fs after mocking
  const { execSync } = await import('node:child_process');
  const fs = await import('fs');
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    // Mock date to be consistent
    vi.setSystemTime(new Date('2025-08-20T00:00:00.000Z'));
    // Provide a default mock for execSync to avoid toString() on undefined
    vi.mocked(execSync).mockReturnValue('');
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('should generate a nightly version and get previous tag', () => {
    process.env.IS_NIGHTLY = 'true';
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({ version: '0.1.0' }),
    );

    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('git tag --list "v*.*.*"')) {
        return 'v0.1.0\nv0.0.1'; // Mock stable tags for getLatestStableTag
      }
      if (command.includes('git tag -l "v0.1.1-nightly.*"')) {
        return ''; // No existing nightly tags
      }
      if (command.includes('gh release list')) {
        return 'v0.1.0-nightly.5'; // Previous nightly release
      }
      return '';
    });

    const { releaseTag, releaseVersion, npmTag, previousReleaseTag } =
      getReleaseVersion();
    expect(releaseTag).toBe('v0.1.1-nightly.0');
    expect(releaseVersion).toBe('0.1.1-nightly.0');
    expect(npmTag).toBe('nightly');
    expect(previousReleaseTag).toBe('v0.1.0-nightly.5');
  });

  it('should use the manual version and get previous tag', () => {
    process.env.MANUAL_VERSION = 'v0.1.1';

    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('gh release list')) {
        return 'v0.1.0'; // Previous stable release
      }
      return '';
    });

    const result = getReleaseVersion();

    expect(result).toEqual({
      releaseTag: 'v0.1.1',
      releaseVersion: '0.1.1',
      npmTag: 'latest',
      previousReleaseTag: 'v0.1.0',
    });
  });

  it('should prepend v to manual version if missing', () => {
    process.env.MANUAL_VERSION = '1.2.3';
    const { releaseTag } = getReleaseVersion();
    expect(releaseTag).toBe('v1.2.3');
  });

  it('should handle pre-release versions correctly', () => {
    process.env.MANUAL_VERSION = 'v1.2.3-beta.1';
    const { releaseTag, releaseVersion, npmTag } = getReleaseVersion();
    expect(releaseTag).toBe('v1.2.3-beta.1');
    expect(releaseVersion).toBe('1.2.3-beta.1');
    expect(npmTag).toBe('beta');
  });

  it('should throw an error for invalid version format', () => {
    process.env.MANUAL_VERSION = '1.2';
    expect(() => getReleaseVersion()).toThrow(
      'Error: Version must be in the format vX.Y.Z or vX.Y.Z-prerelease',
    );
  });

  it('should throw an error if no version is provided for non-nightly/preview release', () => {
    expect(() => getReleaseVersion()).toThrow(
      'Error: No version specified and this is not a nightly or preview release.',
    );
  });

  it('should throw an error for versions with build metadata', () => {
    process.env.MANUAL_VERSION = 'v1.2.3+build456';
    expect(() => getReleaseVersion()).toThrow(
      'Error: Versions with build metadata (+) are not supported for releases.',
    );
  });

  it('should generate nightly version with existing nightly tags', () => {
    process.env.IS_NIGHTLY = 'true';
    vi.mocked(fs.default.readFileSync).mockReturnValue(
      JSON.stringify({ version: '1.2.3' }),
    );

    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('git tag --list "v*.*.*"')) {
        return 'v1.2.3\nv1.2.2\nv1.2.1\nv1.2.0\nv1.1.0';
      }
      if (command.includes('git tag -l "v1.2.4-nightly.*"')) {
        return 'v1.2.4-nightly.0\nv1.2.4-nightly.1\nv1.2.4-nightly.2'; // Existing nightly tags
      }
      if (command.includes('gh release list')) {
        return 'v1.2.4-nightly.2'; // Previous nightly release
      }
      return '';
    });

    const result = getReleaseVersion();

    expect(result.releaseTag).toBe('v1.2.4-nightly.3');
    expect(result.releaseVersion).toBe('1.2.4-nightly.3');
    expect(result.npmTag).toBe('nightly');
    expect(result.previousReleaseTag).toBe('v1.2.4-nightly.2');
  });
});
