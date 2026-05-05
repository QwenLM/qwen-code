/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const execSyncMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

global.fetch = fetchMock;

const modulePath = '../../packages/sdk-python/scripts/get-release-version.js';

async function loadGetVersion() {
  const mod = await import(`${modulePath}?t=${Date.now()}-${Math.random()}`);
  return mod.getVersion;
}

function makeResponse({ status = 200, json = {}, statusText = 'OK' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText,
    json: async () => json,
  };
}

function makeExecError(message, { stderr = '', stdout = '', status } = {}) {
  const error = new Error(message);
  if (stderr) {
    error.stderr = Buffer.from(stderr);
  }
  if (stdout) {
    error.stdout = Buffer.from(stdout);
  }
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function makeTimeoutError(command) {
  const error = new Error(`Command failed: ${command}\nSIGTERM`);
  // Real Node.js execSync timeout shape (verified on Node 20+):
  // killed=undefined, signal='SIGTERM', code='ETIMEDOUT'
  error.code = 'ETIMEDOUT';
  error.signal = 'SIGTERM';
  error.status = null;
  return error;
}

function makeExecSyncMock({
  tags = {},
  tagError = null,
  releases = {},
  gitHash = 'abc1234',
} = {}) {
  return (command) => {
    if (command === 'git rev-parse --short HEAD') {
      return Buffer.from(gitHash);
    }

    const tagMatch = command.match(/^git tag -l '(.+)'$/);
    if (tagMatch) {
      if (tagError) {
        throw tagError;
      }
      return Buffer.from(tags[tagMatch[1]] ?? '');
    }

    const releaseMatch = command.match(
      /^gh release view "(.+)" --json tagName --jq \.tagName$/,
    );
    if (releaseMatch) {
      const releaseName = releaseMatch[1];
      const outcome = releases[releaseName];
      if (outcome instanceof Error) {
        throw outcome;
      }
      if (typeof outcome === 'string') {
        return Buffer.from(outcome);
      }
      throw makeExecError('release not found', { status: 1 });
    }

    throw new Error(`Unexpected execSync command: ${command}`);
  };
}

describe('python sdk get-release-version', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T03:15:16.000Z'));
    readFileSyncMock.mockReturnValue('version = "0.1.0"\n');
    fetchMock.mockResolvedValue(
      makeResponse({
        json: { releases: {} },
      }),
    );
    execSyncMock.mockImplementation(makeExecSyncMock());
  });

  it('returns empty previousReleaseTag for preview and nightly releases', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
            '0.1.1.dev20260429010101': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-preview.0': 'sdk-python-v0.1.1-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseTag: 'v0.1.1-preview.1',
      previousReleaseTag: '',
    });

    await expect(getVersion({ type: 'nightly' })).resolves.toMatchObject({
      releaseTag: 'v0.1.1-nightly.20260430031516.abc1234',
      releaseVersion: '0.1.1-nightly.20260430031516.abc1234',
      packageVersion: '0.1.1.dev20260430031516',
      publishChannel: 'nightly',
      previousReleaseTag: '',
    });
  });

  it('fails when an explicit override conflicts with existing PyPI version', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.1rc0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-preview.0': 'sdk-python-v0.1.1-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'preview',
        preview_version_override: 'v0.1.1-preview.0',
      }),
    ).rejects.toThrow(
      'Requested preview release 0.1.1-preview.0 already exists on PyPI, GitHub releases.',
    );
  });

  it('fails when an explicit preview override only conflicts with PyPI state', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.1rc0': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'preview',
        preview_version_override: 'v0.1.1-preview.0',
      }),
    ).rejects.toThrow(
      'Requested preview release 0.1.1-preview.0 already exists on PyPI.',
    );
  });

  it('fails when an explicit override conflicts with an existing git tag', async () => {
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tags: {
          'sdk-python-v0.1.1-preview.0': 'sdk-python-v0.1.1-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'preview',
        preview_version_override: 'v0.1.1-preview.0',
      }),
    ).rejects.toThrow(
      'Requested preview release 0.1.1-preview.0 already exists on git tags.',
    );
  });

  it('fails when an explicit override conflicts with an existing GitHub release', async () => {
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-preview.0': 'sdk-python-v0.1.1-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'preview',
        preview_version_override: 'v0.1.1-preview.0',
      }),
    ).rejects.toThrow(
      'Requested preview release 0.1.1-preview.0 already exists on GitHub releases.',
    );
  });

  it('fails closed when git tag conflict checks error', async () => {
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tagError: new Error('git tag failed'),
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).rejects.toThrow(
      'Failed to check git tags for conflicts: git tag failed',
    );
  });

  it('fails if GitHub release lookup errors for reasons other than not found', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
          },
        },
      }),
    );
    const authError = new Error('HTTP 403 rate limited');
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-preview.0': authError,
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).rejects.toThrow(
      'Failed to check GitHub releases for conflicts: HTTP 403 rate limited',
    );
  });

  it('fails closed when unrelated lowercase not-found errors occur', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-preview.0': makeExecError('host not found'),
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).rejects.toThrow(
      'Failed to check GitHub releases for conflicts: host not found',
    );
  });

  it('reuses a PyPI version when GitHub release finalization needs to resume', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseTag: 'v0.1.1-preview.0',
      packageVersion: '0.1.1rc0',
      resumeExistingRelease: true,
    });
  });

  it('reuses a stable release when only post-release recovery steps remain', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.0': 'sdk-python-v0.1.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.1.0',
      packageVersion: '0.1.0',
      resumeExistingRelease: true,
    });
  });

  it('returns a manual stable override on the happy path', async () => {
    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'stable',
        stable_version_override: 'v0.2.0',
      }),
    ).resolves.toMatchObject({
      releaseVersion: '0.2.0',
      packageVersion: '0.2.0',
      publishChannel: 'latest',
    });
  });

  it('fails when an explicit stable override conflicts with a completed release', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.0': 'sdk-python-v0.1.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'stable',
        stable_version_override: 'v0.1.0',
      }),
    ).rejects.toThrow(
      'Requested stable release 0.1.0 already exists on PyPI, GitHub releases.',
    );
  });

  it('fails when the latest preview base is not newer than the latest stable', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.2.0': [{}],
            '0.1.1rc1': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).rejects.toThrow(
      'Latest preview base 0.1.1 is not newer than latest stable 0.2.0.',
    );
  });

  it('uses the latest nightly base for stable releases when no preview exists', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.2.0.dev20260429010101': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.2.0',
      releaseVersion: '0.2.0',
      packageVersion: '0.2.0',
      previousReleaseTag: 'v0.1.0',
      publishChannel: 'latest',
    });
  });

  it('prefers nightly base over preview when nightly is higher for stable releases', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
            '0.2.0.dev20260429010101': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.2.0',
      releaseVersion: '0.2.0',
      packageVersion: '0.2.0',
      previousReleaseTag: 'v0.1.0',
      publishChannel: 'latest',
    });
  });

  it('fails instead of patch-bumping a stable release derived from preview when its tag already exists', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tags: {
          'sdk-python-v0.1.1': 'sdk-python-v0.1.1',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).rejects.toThrow(
      'Stable release 0.1.1 derived from the latest preview already exists.',
    );
  });

  it('fails instead of patch-bumping a stable release derived from nightly when its tag already exists', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.2.0.dev20260429010101': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tags: {
          'sdk-python-v0.2.0': 'sdk-python-v0.2.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).rejects.toThrow(
      'Stable release 0.2.0 derived from the latest nightly already exists.',
    );
  });

  it('fails instead of patch-bumping the current stable version when its tag already exists', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.0.9': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tags: {
          'sdk-python-v0.1.0': 'sdk-python-v0.1.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).rejects.toThrow(
      'Stable release 0.1.0 already exists. Provide stable_version_override to release a different stable version.',
    );
  });

  it('returns the previous stable tag for stable releases', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.1.1',
      previousReleaseTag: 'v0.1.0',
    });
  });

  it('maps preview versions to PEP 440 package versions', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'preview',
        preview_version_override: 'v0.1.1-preview.2',
      }),
    ).resolves.toMatchObject({
      releaseVersion: '0.1.1-preview.2',
      packageVersion: '0.1.1rc2',
    });
  });

  it('continues the highest prerelease base for preview releases', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.2.0rc0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.2.0-preview.0': 'sdk-python-v0.2.0-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseVersion: '0.2.0-preview.1',
      packageVersion: '0.2.0rc1',
    });
  });

  it('continues the highest nightly-only prerelease base for preview releases', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.2.0.dev20260429010101': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.2.0-preview.0': 'sdk-python-v0.2.0-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseVersion: '0.2.0-preview.1',
      packageVersion: '0.2.0rc1',
    });
  });

  it('keeps bumping preview slots until it finds an unused iteration', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
            '0.1.1rc1': [{}],
            '0.1.1rc2': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-preview.0': 'sdk-python-v0.1.1-preview.0',
          'sdk-python-v0.1.1-preview.1': 'sdk-python-v0.1.1-preview.1',
          'sdk-python-v0.1.1-preview.2': 'sdk-python-v0.1.1-preview.2',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseVersion: '0.1.1-preview.3',
      packageVersion: '0.1.1rc3',
      resumeExistingRelease: false,
    });
  });

  it('throws on nightly conflicts instead of silently changing the timestamped version', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.1.dev20260430031516': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.1-nightly.20260430031516.abc1234':
            'sdk-python-v0.1.1-nightly.20260430031516.abc1234',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'nightly' })).rejects.toThrow(
      'Nightly version conflict for 0.1.1.dev20260430031516',
    );
  });

  it('throws when PyPI metadata fetch is not ok', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        status: 503,
        statusText: 'Service Unavailable',
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).rejects.toThrow(
      'Failed to fetch PyPI metadata: 503 Service Unavailable',
    );
  });

  it('treats a PyPI 404 as a first-release scenario', async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 404 }));

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.1.0',
      releaseVersion: '0.1.0',
      packageVersion: '0.1.0',
      previousReleaseTag: '',
      publishChannel: 'latest',
    });
  });

  it('ignores fully yanked PyPI versions', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{ yanked: true }],
            '0.0.9': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.1.0',
      releaseVersion: '0.1.0',
      packageVersion: '0.1.0',
      previousReleaseTag: 'v0.0.9',
    });
  });

  it('detects yanked versions as conflicts on PyPI', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{ yanked: true }],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    // 0.1.0 is yanked so base-version computation ignores it and derives 0.1.0
    // from pyproject.toml, but conflict detection sees it on PyPI. Since it has
    // no GitHub release, the script resumes the existing release.
    await expect(getVersion({ type: 'stable' })).resolves.toMatchObject({
      releaseTag: 'v0.1.0',
      packageVersion: '0.1.0',
      resumeExistingRelease: true,
    });
  });

  it('rejects stable_version_override that is older than latest stable', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.5.0': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'stable',
        stable_version_override: 'v0.1.0',
      }),
    ).rejects.toThrow(
      'stable_version_override 0.1.0 is older than latest stable 0.5.0',
    );
  });

  it('allows stable_version_override equal to latest stable', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.5.0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.5.0': 'sdk-python-v0.5.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    // Equal version already exists, so the override conflict check fires
    await expect(
      getVersion({
        type: 'stable',
        stable_version_override: 'v0.5.0',
      }),
    ).rejects.toThrow(
      'Requested stable release 0.5.0 already exists on PyPI, GitHub releases.',
    );
  });

  it('uses pyproject.toml version for first preview release when PyPI has no versions', async () => {
    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseTag: 'v0.1.0-preview.0',
      releaseVersion: '0.1.0-preview.0',
      packageVersion: '0.1.0rc0',
    });
  });

  it('uses pyproject.toml version for first nightly release when PyPI has no versions', async () => {
    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'nightly' })).resolves.toMatchObject({
      releaseTag: 'v0.1.0-nightly.20260430031516.abc1234',
      releaseVersion: '0.1.0-nightly.20260430031516.abc1234',
      packageVersion: '0.1.0.dev20260430031516',
    });
  });

  it('continues the prerelease base when it equals the stable baseline', async () => {
    readFileSyncMock.mockReturnValue('version = "0.2.0"\n');
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.2.0rc0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.2.0-preview.0': 'sdk-python-v0.2.0-preview.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseVersion: '0.2.0-preview.1',
      packageVersion: '0.2.0rc1',
    });
  });

  it('emits a warning when skipping a preview slot due to an orphan git tag', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tags: {
          'sdk-python-v0.1.1-preview.0': 'sdk-python-v0.1.1-preview.0',
        },
      }),
    );

    const consoleSpy = vi.spyOn(console, 'error');
    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseVersion: '0.1.1-preview.1',
      packageVersion: '0.1.1rc1',
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('::warning::Orphan git tag'),
    );
    consoleSpy.mockRestore();
  });

  it('excludes current release from previousReleaseTag on resume', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.2.0': [{}],
            '0.2.0rc0': [{}],
          },
        },
      }),
    );
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.2.0': 'sdk-python-v0.2.0',
        },
      }),
    );

    const getVersion = await loadGetVersion();

    const result = await getVersion({ type: 'stable' });
    expect(result).toMatchObject({
      releaseTag: 'v0.2.0',
      previousReleaseTag: 'v0.1.0',
      resumeExistingRelease: true,
    });
  });

  it('throws a timeout error when gh release view times out', async () => {
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        releases: {
          'sdk-python-v0.1.0-preview.0': makeTimeoutError(
            'gh release view "sdk-python-v0.1.0-preview.0"',
          ),
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).rejects.toThrow(
      'gh release view timed out after 30s checking "sdk-python-v0.1.0-preview.0" — GitHub API may be unavailable',
    );
  });

  it('throws a timeout error when git tag -l times out', async () => {
    execSyncMock.mockImplementation(
      makeExecSyncMock({
        tagError: makeTimeoutError('git tag -l'),
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).rejects.toThrow(
      'git tag -l timed out after 10s — local git may be unresponsive',
    );
  });

  it('throws a timeout error when git rev-parse times out', async () => {
    execSyncMock.mockImplementation((command) => {
      if (command === 'git rev-parse --short HEAD') {
        throw makeTimeoutError('git rev-parse --short HEAD');
      }
      return makeExecSyncMock()(command);
    });

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'nightly' })).rejects.toThrow(
      'git rev-parse timed out after 10s — local git may be unresponsive',
    );
  });
});
