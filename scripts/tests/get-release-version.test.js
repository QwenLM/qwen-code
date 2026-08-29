/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertVersionUnreleased,
  getVersion,
  PUBLISHED_PACKAGES,
  runCli,
} from '../get-release-version.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');

describe('getVersion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.setSystemTime(new Date('2025-09-17T00:00:00.000Z'));
    // Mock package.json being read by getNightlyVersion
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: '0.8.0' }),
    );
  });

  // This is the base mock for a clean state with no conflicts or rollbacks
  const mockExecSync = (command) => {
    // NPM dist-tags
    if (command.includes('npm view') && command.includes('--tag=latest'))
      return '0.6.1';
    if (command.includes('npm view') && command.includes('--tag=preview'))
      return '0.7.0-preview.1';
    if (command.includes('npm view') && command.includes('--tag=nightly'))
      return '0.8.0-nightly.20250916.abcdef';

    // NPM versions list
    if (command.includes('npm view') && command.includes('versions --json'))
      return JSON.stringify([
        '0.6.0',
        '0.6.1',
        '0.7.0-preview.0',
        '0.7.0-preview.1',
        '0.8.0-nightly.20250916.abcdef',
      ]);

    // Deprecation checks (default to not deprecated)
    if (command.includes('deprecated')) return '';

    // Git Tag Mocks
    if (command.includes("git tag -l 'v*'")) return 'v0.6.0\nv0.6.1';
    if (command.includes("git tag -l 'v[0-9].[0-9].[0-9]'")) return 'v0.6.1';
    if (command.includes("git tag -l 'v*-preview*'")) return 'v0.7.0-preview.1';
    if (command.includes("git tag -l 'v*-nightly*'"))
      return 'v0.8.0-nightly.20250916.abcdef';

    // Git Hash Mock
    if (command.includes('git rev-parse --short HEAD')) return 'd3bf8a3d';

    // For doesVersionExist checks - default to not found on any package
    if (
      command.includes('npm view') &&
      command.includes('version 2>/dev/null')
    ) {
      throw new Error('NPM version not found');
    }
    if (command.includes('git tag -l')) return '';
    if (command.includes('gh release view')) {
      throw new Error('GH release not found');
    }

    return '';
  };

  describe('Happy Path - Version Calculation', () => {
    it('should calculate the next stable version from the latest preview', () => {
      vi.mocked(execSync).mockImplementation(mockExecSync);
      const result = getVersion({ type: 'stable' });
      expect(result.releaseVersion).toBe('0.7.0');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should calculate the next preview version from the latest nightly', () => {
      vi.mocked(execSync).mockImplementation(mockExecSync);
      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should calculate the next nightly version from package.json', () => {
      vi.mocked(execSync).mockImplementation(mockExecSync);
      const result = getVersion({ type: 'nightly' });
      // Note: The base version now comes from package.json, not the previous nightly tag.
      expect(result.releaseVersion).toBe('0.8.0-nightly.20250917.d3bf8a3d');
      expect(result.npmTag).toBe('nightly');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should calculate the next patch version for a stable release', () => {
      vi.mocked(execSync).mockImplementation(mockExecSync);
      const result = getVersion({ type: 'patch', 'patch-from': 'stable' });
      expect(result.releaseVersion).toBe('0.6.2');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should calculate the next patch version for a preview release', () => {
      vi.mocked(execSync).mockImplementation(mockExecSync);
      const result = getVersion({ type: 'patch', 'patch-from': 'preview' });
      expect(result.releaseVersion).toBe('0.7.0-preview.2');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });
  });

  describe('Advanced Scenarios', () => {
    it('should ignore a deprecated version and use the next highest', () => {
      const mockWithDeprecated = (command) => {
        // The highest nightly is 0.9.0, but it's deprecated
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([
            '0.8.0-nightly.20250916.abcdef',
            '0.9.0-nightly.20250917.deprecated', // This one is deprecated
          ]);
        // Mock the deprecation check
        if (
          command.includes(
            'npm view @qwen-code/qwen-code@0.9.0-nightly.20250917.deprecated deprecated',
          )
        )
          return 'This version is deprecated';
        // The dist-tag still points to the older, valid version
        if (command.includes('npm view') && command.includes('--tag=nightly'))
          return '0.8.0-nightly.20250916.abcdef';

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithDeprecated);

      const result = getVersion({ type: 'preview' });
      // It should base the preview off 0.8.0, not the deprecated 0.9.0
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
    });

    it('should auto-increment patch version if the calculated one already exists', () => {
      const mockWithConflict = (command) => {
        // The calculated version 0.7.0 already exists as a git tag
        if (command.includes("git tag -l 'v0.7.0'")) return 'v0.7.0';
        // The next version, 0.7.1, is available
        if (command.includes("git tag -l 'v0.7.1'")) return '';

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithConflict);

      const result = getVersion({ type: 'stable' });
      // Should have skipped 0.7.0 and landed on 0.7.1
      expect(result.releaseVersion).toBe('0.7.1');
    });

    it('should auto-increment preview number if the calculated one already exists', () => {
      const mockWithConflict = (command) => {
        // The calculated preview 0.8.0-preview.0 already exists on NPM
        if (
          command.includes(
            'npm view @qwen-code/qwen-code@0.8.0-preview.0 version',
          )
        )
          return '0.8.0-preview.0';
        // The next one is available
        if (
          command.includes(
            'npm view @qwen-code/qwen-code@0.8.0-preview.1 version',
          )
        )
          throw new Error('Not found');

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithConflict);

      const result = getVersion({ type: 'preview' });
      // Should have skipped preview.0 and landed on preview.1
      expect(result.releaseVersion).toBe('0.8.0-preview.1');
    });

    it('should auto-increment when the version exists only on a channel package', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (
          command.includes(
            'npm view @qwen-code/channel-telegram@0.8.0-preview.0 version',
          )
        )
          return '0.8.0-preview.0';

        return mockExecSync(command);
      });

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.0-preview.1');
    });

    it('should keep the nightly base when no stable is published yet (greenfield)', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        // No latest dist-tag
        if (command.includes('npm view') && command.includes('--tag=latest'))
          throw new Error('npm error code E404');
        // No versions published at all
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([]);
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('');
    });

    it('should bump the preview base when the latest stable matches it', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes('npm view') && command.includes('--tag=latest'))
          return '0.8.0';
        if (command.includes("git tag -l 'v*'"))
          return 'v0.6.0\nv0.6.1\nv0.8.0';
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.1-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.8.0');
    });

    it('should bump the preview base when the latest stable is ahead', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes('npm view') && command.includes('--tag=latest'))
          return '0.9.0';
        if (command.includes("git tag -l 'v*'"))
          return 'v0.6.0\nv0.6.1\nv0.9.0';
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.9.1-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.9.0');
    });

    it('should not bump the preview base when the latest stable is below it', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes('npm view') && command.includes('--tag=latest'))
          return '0.7.9';
        if (command.includes("git tag -l 'v*'"))
          return 'v0.6.0\nv0.6.1\nv0.7.9';
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.7.9');
    });

    it('should fall back to the latest existing git tag when the npm baseline has no tag (half-shipped release)', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes('npm view') && command.includes('--tag=latest'))
          // Published to npm, but its release run failed before the git
          // tag was created, so the base mock's tag list lacks v0.6.2.
          return '0.6.2';
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'stable' });
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should skip unparseable tags (e.g. leading zeros) when resolving the previous release tag', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes('npm view') && command.includes('--tag=latest'))
          return '0.6.2';
        if (command.includes("git tag -l 'v*'"))
          return 'v01.2.3\nv0.6.0\nv0.6.1';
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'stable' });
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should sort tags by semver order, not lexicographic order', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes("git tag -l 'v*'")) return 'v0.9.0\nv0.10.0';
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'stable' });
      // semver descending: v0.10.0 > v0.9.0 (lexicographic would pick v0.9.0)
      expect(result.previousReleaseTag).toBe('v0.10.0');
    });

    it('should keep the npm-derived previous tag when git tag listing fails', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes("git tag -l 'v*'")) {
          throw new Error('git not available');
        }
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'stable' });
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should return an empty previous tag when no stable git tags exist', () => {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command.includes("git tag -l 'v*'")) {
          // Only prerelease tags exist; the stable filter drops them all.
          return 'v0.7.0-preview.1\nv0.8.0-nightly.20250916.abcdef';
        }
        return mockExecSync(command);
      });

      const result = getVersion({ type: 'stable' });
      expect(result.previousReleaseTag).toBe('');
    });

    it('should fall back to package.json when no nightly dist-tag exists (preview)', () => {
      const mockWithNoNightly = (command) => {
        // No nightly dist-tag exists
        if (command.includes('npm view') && command.includes('--tag=nightly')) {
          throw new Error('npm error code E404');
        }
        // Stable versions exist but no nightly dist-tag
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify(['0.6.0', '0.6.1']);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNoNightly);

      const result = getVersion({ type: 'preview' });
      // Should fall back to package.json version (0.8.0) + -preview.0
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should fall back to package.json when no preview dist-tag exists (stable)', () => {
      const mockWithNoPreview = (command) => {
        // No preview dist-tag exists
        if (command.includes('npm view') && command.includes('--tag=preview')) {
          throw new Error('npm error code E404');
        }
        // Stable versions exist but no preview dist-tag
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify(['0.6.0', '0.6.1']);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNoPreview);

      const result = getVersion({ type: 'stable' });
      // Should fall back to package.json version (0.8.0)
      expect(result.releaseVersion).toBe('0.8.0');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should throw when no nightly dist-tag exists (promote-nightly)', () => {
      const mockWithNoNightly = (command) => {
        if (command.includes('npm view') && command.includes('--tag=nightly')) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify(['0.6.0', '0.6.1']);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNoNightly);

      expect(() => getVersion({ type: 'promote-nightly' })).toThrow(
        'Unable to determine baseline version for nightly',
      );
    });

    it('should throw when no dist-tag exists (patch)', () => {
      const mockWithNoLatest = (command) => {
        if (command.includes('npm view') && command.includes('--tag=latest')) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNoLatest);

      expect(() =>
        getVersion({ type: 'patch', 'patch-from': 'stable' }),
      ).toThrow('Unable to determine baseline version for latest');
    });

    it('should fall back to package.json in true greenfield scenario (all dist-tags missing)', () => {
      const mockGreenfield = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockGreenfield);

      const result = getVersion({ type: 'stable' });
      expect(result.releaseVersion).toBe('0.8.0');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('');
    });

    it('should handle E404 from versions list in true greenfield scenario', () => {
      const mockGreenfieldVersionsE404 = (command) => {
        if (command.includes('npm view') && command.includes('versions --json'))
          throw new Error('npm error code E404');
        if (
          command.includes('npm view') &&
          command.includes('--tag=') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockGreenfieldVersionsE404);

      const result = getVersion({ type: 'stable' });
      expect(result.releaseVersion).toBe('0.8.0');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('');
    });

    it('should derive baseline from versions list when dist-tag is missing but versions exist', () => {
      const mockWithVersionsButNoTag = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=preview') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([
            '0.6.0',
            '0.6.1',
            '0.7.0-preview.0',
            '0.7.0-preview.3',
          ]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithVersionsButNoTag);

      const result = getVersion({ type: 'stable' });
      expect(result.releaseVersion).toBe('0.7.0');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should propagate transient NPM errors from dist-tag lookup', () => {
      const mockWithTransientError = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=preview') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code ETIMEDOUT');
        }

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithTransientError);

      expect(() => getVersion({ type: 'stable' })).toThrow('ETIMEDOUT');
    });

    it('should fall back to dist-tag when versions list lookup fails transiently', () => {
      const mockWithTransientVersionsError = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('versions --json')
        ) {
          throw new Error('npm error code ECONNRESET');
        }

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithTransientVersionsError);

      const result = getVersion({ type: 'stable' });
      expect(result.releaseVersion).toBe('0.7.0');
      expect(result.npmTag).toBe('latest');
    });

    it('should propagate transient NPM errors from versions list when dist-tag is also missing', () => {
      const mockWithBothFailing = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=preview') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (
          command.includes('npm view') &&
          command.includes('versions --json')
        ) {
          throw new Error('npm error code ECONNRESET');
        }

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithBothFailing);

      expect(() => getVersion({ type: 'stable' })).toThrow('ECONNRESET');
    });

    it('should derive baseline from latest versions when latest dist-tag is missing', () => {
      const mockWithNoLatestTag = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=latest') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify(['0.5.0', '0.6.0', '0.6.1', '0.7.0-preview.0']);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNoLatestTag);

      const result = getVersion({ type: 'patch', 'patch-from': 'stable' });
      expect(result.releaseVersion).toBe('0.6.2');
      expect(result.npmTag).toBe('latest');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should fall back to package.json when all matching versions are deprecated (no dist-tag)', () => {
      const mockWithAllDeprecated = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=nightly') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify(['0.7.0-nightly.1', '0.7.0-nightly.2']);
        if (command.includes('deprecated')) return 'Deprecated';
        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithAllDeprecated);

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
    });

    it('should throw when no preview dist-tag exists (patch)', () => {
      const mockWithNoPreview = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=preview') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNoPreview);

      expect(() =>
        getVersion({ type: 'patch', 'patch-from': 'preview' }),
      ).toThrow('Unable to determine baseline version for preview');
    });

    it('should derive preview from nightly versions when nightly dist-tag is missing', () => {
      const mockWithNightliesButNoTag = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=nightly') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([
            '0.6.0',
            '0.6.1',
            '0.8.0-nightly.20250916.abcdef',
          ]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithNightliesButNoTag);

      const result = getVersion({ type: 'preview' });
      expect(result.releaseVersion).toBe('0.8.0-preview.0');
      expect(result.npmTag).toBe('preview');
      expect(result.previousReleaseTag).toBe('v0.6.1');
    });

    it('should reject an invalid stable version derived from preview', () => {
      const mockWithInvalidPreview = (command) => {
        if (command.includes('npm view') && command.includes('--tag=preview'))
          return 'invalid-preview.0';
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithInvalidPreview);

      expect(() => getVersion({ type: 'stable' })).toThrow(
        'Invalid derived from preview dist-tag: invalid',
      );
    });

    it('should reject an invalid preview version derived from nightly', () => {
      const mockWithInvalidNightly = (command) => {
        if (command.includes('npm view') && command.includes('--tag=nightly'))
          return 'invalid-nightly.20250916.abcdef';
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithInvalidNightly);

      expect(() => getVersion({ type: 'preview' })).toThrow(
        'Invalid derived from nightly dist-tag: invalid-preview.0',
      );
    });

    it('should reject a stable release derived below the published latest version', () => {
      const mockWithOlderPreviewVersions = (command) => {
        if (
          command.includes('npm view') &&
          command.includes('--tag=preview') &&
          !command.includes('versions --json')
        ) {
          throw new Error('npm error code E404');
        }
        if (command.includes('npm view') && command.includes('--tag=latest'))
          return '0.9.0';
        if (command.includes('npm view') && command.includes('versions --json'))
          return JSON.stringify([
            '0.7.0-preview.0',
            '0.7.0-preview.1',
            '0.9.0',
          ]);

        return mockExecSync(command);
      };
      vi.mocked(execSync).mockImplementation(mockWithOlderPreviewVersions);

      expect(() => getVersion({ type: 'stable' })).toThrow(
        'Derived stable version 0.7.0 is lower than published latest 0.9.0',
      );
    });
  });

  it('runCli default dispatch prints the version JSON and exits 0', () => {
    // The prepare job consumes this path (VERSION_JSON=$(node
    // scripts/get-release-version.js ...)); pin it through runCli, the
    // wrapper prepare actually invokes, so a dropped args pass-through or
    // a flipped exit code fails here instead of at the next release. The
    // override makes the printed version depend on args reaching
    // getVersion.
    vi.mocked(execSync).mockImplementation(mockExecSync);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli({ type: 'stable', stable_version_override: '9.9.9' })).toBe(
      0,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
      releaseTag: 'v9.9.9',
      releaseVersion: '9.9.9',
      npmTag: 'latest',
      previousReleaseTag: 'v0.6.1',
    });
  });
});

describe('assertVersionUnreleased', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const notFoundAnywhere = (command) => {
    if (command.includes('npm view')) throw new Error('npm error code E404');
    if (command.includes('git ls-remote')) {
      // --exit-code exits 2 when no ref matches.
      throw Object.assign(new Error('no match'), { status: 2 });
    }
    if (command.includes('gh release view')) {
      throw new Error('release not found');
    }
    return '';
  };

  // The push-time refusal must tell the operator where the version was
  // found and that re-running cannot fix a partial publish.
  const refusalMessage = (foundOn) =>
    `Version 1.2.3 has already shipped; refusing to force-push the release branch over it. Found on: ${foundOn}. If a previous attempt published only part of the release, complete the remaining artifacts manually — re-running this job will keep failing here while the version stays published.`;

  it('pins the full published-package set', () => {
    // The push-time guard derives from this list; the workflow's publish
    // steps hardcode the same set separately, so adding or removing a
    // package must update both this pin and the publish steps in
    // release.yml so every consumer is reviewed together.
    expect(PUBLISHED_PACKAGES).toEqual([
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
    ]);
  });

  it('passes when no package, tag, or release has shipped the version', () => {
    vi.mocked(execSync).mockImplementation(notFoundAnywhere);
    expect(() => assertVersionUnreleased('1.2.3')).not.toThrow();
  });

  it('checks origin for tags, not the stale local checkout', () => {
    const commands = [];
    vi.mocked(execSync).mockImplementation((command) => {
      commands.push(command);
      return notFoundAnywhere(command);
    });
    assertVersionUnreleased('1.2.3');
    expect(commands).toContain(
      'git ls-remote --exit-code origin "refs/tags/v1.2.3"',
    );
    expect(commands.some((c) => c.includes('git tag -l'))).toBe(false);
  });

  it('refuses when ANY published package has shipped the version', () => {
    // Ship the version on one package at a time, middle-list packages
    // included: dropping any of them from PUBLISHED_PACKAGES must fail.
    for (const pkg of PUBLISHED_PACKAGES) {
      vi.mocked(execSync).mockImplementation((command) => {
        if (command === `npm view ${pkg}@1.2.3 version`) {
          return '1.2.3';
        }
        return notFoundAnywhere(command);
      });
      expect(() => assertVersionUnreleased('1.2.3')).toThrow(/already shipped/);
    }
  });

  it('refuses when the tag already exists on origin', () => {
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('git ls-remote')) {
        return '0123456789abcdef\trefs/tags/v1.2.3';
      }
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(
      refusalMessage('origin tag v1.2.3'),
    );
  });

  it('refuses when the GitHub release already exists', () => {
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('gh release view')) return 'v1.2.3';
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(
      refusalMessage('GitHub release v1.2.3'),
    );
  });

  it('names every shipped package after a partial publish', () => {
    // A retry of a partially published release is refused forever; the
    // refusal must name exactly which packages to complete, which needs
    // the strict scan of every package, not a stop at the first hit.
    const shipped = [PUBLISHED_PACKAGES[1], PUBLISHED_PACKAGES[7]];
    const commands = [];
    vi.mocked(execSync).mockImplementation((command) => {
      commands.push(command);
      if (shipped.some((pkg) => command === `npm view ${pkg}@1.2.3 version`)) {
        return '1.2.3';
      }
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(
      refusalMessage(shipped.join(', ')),
    );
    expect(commands.filter((c) => c.startsWith('npm view '))).toHaveLength(
      PUBLISHED_PACKAGES.length,
    );
  });

  it('stops probing once the refusal is decided', () => {
    // A shipped version already decides the refusal; running the remaining
    // probes would let a flaky one replace the refusal's recovery
    // guidance with a probe-failure error.
    const commands = [];
    vi.mocked(execSync).mockImplementation((command) => {
      commands.push(command);
      if (command === `npm view ${PUBLISHED_PACKAGES[0]}@1.2.3 version`) {
        return '1.2.3';
      }
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(/already shipped/);
    expect(commands.some((c) => c.includes('ls-remote'))).toBe(false);
    expect(commands.some((c) => c.includes('gh release view'))).toBe(false);
  });

  it('rejects a missing or non-string version instead of failing open', () => {
    for (const bad of [undefined, '', true]) {
      expect(() => assertVersionUnreleased(bad)).toThrow(/requires a version/);
    }
  });

  it('fails closed when an npm probe errors with anything other than E404', () => {
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('npm view')) {
        throw new Error('npm error code ETIMEDOUT');
      }
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(
      /Failed to verify .* on npm/,
    );
  });

  it('keeps the refusal decisive when a probe fails after a shipped hit', () => {
    // A partial publish retried during a registry disruption: the scan
    // hits on a shipped package, then a later probe errors transiently.
    // The refusal is already decided; throwing there would demote the
    // exit-3 refusal to a probe-failure exit and lose the version_refusal
    // marker the workflow keys on to skip the release-failed notification.
    vi.mocked(execSync).mockImplementation((command) => {
      if (command === `npm view ${PUBLISHED_PACKAGES[0]}@1.2.3 version`) {
        return '1.2.3';
      }
      if (command.includes('npm view')) {
        throw new Error('npm error code ETIMEDOUT');
      }
      return notFoundAnywhere(command);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The runner parses workflow commands from stdout only; ::error:: on
    // stderr would never surface as an annotation in the Actions UI.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli({ 'assert-unreleased': '1.2.3' })).toBe(3);
    expect(logSpy).toHaveBeenCalledWith(
      `::error::${refusalMessage(PUBLISHED_PACKAGES[0])}`,
    );
  });

  it('fails closed when ls-remote errors with anything other than no-match', () => {
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('git ls-remote')) {
        throw Object.assign(new Error('fatal: authentication failed'), {
          status: 128,
        });
      }
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(
      /Failed to verify tag v1\.2\.3 on origin/,
    );
  });

  it('fails closed when gh release view errors with anything other than not-found', () => {
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('gh release view')) {
        throw new Error('gh: To use GitHub CLI in automation, set GH_TOKEN.');
      }
      return notFoundAnywhere(command);
    });
    expect(() => assertVersionUnreleased('1.2.3')).toThrow(
      /Failed to verify release v1\.2\.3 on GitHub/,
    );
  });

  it('CLI dispatch: exits 3 (benign refusal) when the version has shipped', () => {
    // Exit 3 is the marker the release workflow uses to keep this
    // decisive, benign refusal out of the release-failed notification.
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('npm view')) return '1.2.3';
      return notFoundAnywhere(command);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli({ 'assert-unreleased': '1.2.3' })).toBe(3);
    expect(logSpy).toHaveBeenCalledWith(
      `::error::${refusalMessage(PUBLISHED_PACKAGES.join(', '))}`,
    );
  });

  it('CLI dispatch: exits 2 (not the refusal marker) when a probe fails', () => {
    vi.mocked(execSync).mockImplementation((command) => {
      if (command.includes('npm view')) {
        throw new Error('npm error code ETIMEDOUT');
      }
      return notFoundAnywhere(command);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli({ 'assert-unreleased': '1.2.3' })).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('::error::Failed to verify'),
    );
  });

  it('CLI dispatch: exits 2 (not the refusal marker) on a missing version', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli({ 'assert-unreleased': '' })).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(
      '::error::assert-unreleased requires a version, e.g. --assert-unreleased=1.2.3',
    );
  });

  it('CLI dispatch: exits 0 when the version has not shipped', () => {
    vi.mocked(execSync).mockImplementation(notFoundAnywhere);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runCli({ 'assert-unreleased': '1.2.3' })).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
