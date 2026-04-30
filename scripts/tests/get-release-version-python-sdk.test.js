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

function makeExecSyncMock({
  tags = {},
  releases = {},
  gitHash = 'abc1234',
} = {}) {
  return (command) => {
    if (command === 'git rev-parse --short HEAD') {
      return Buffer.from(gitHash);
    }

    const tagMatch = command.match(/^git tag -l '(.+)'$/);
    if (tagMatch) {
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
      const error = new Error('release not found');
      error.status = 1;
      throw error;
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

  it('returns same-channel previous release tags for preview and nightly', async () => {
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

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'preview' })).resolves.toMatchObject({
      releaseTag: 'v0.1.1-preview.1',
      previousReleaseTag: '',
    });

    await expect(getVersion({ type: 'nightly' })).resolves.toMatchObject({
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

    const getVersion = await loadGetVersion();

    await expect(
      getVersion({
        type: 'preview',
        preview_version_override: 'v0.1.1-preview.0',
      }),
    ).rejects.toThrow(
      'Requested preview release 0.1.1-preview.0 already exists.',
    );
  });

  it('fails if GitHub release lookup errors for reasons other than not found', async () => {
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

  it('fails instead of patch-bumping a stable release derived from preview', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        json: {
          releases: {
            '0.1.0': [{}],
            '0.1.1rc0': [{}],
            '0.1.1': [{}],
          },
        },
      }),
    );

    const getVersion = await loadGetVersion();

    await expect(getVersion({ type: 'stable' })).rejects.toThrow(
      'Stable release 0.1.1 derived from the latest preview already exists.',
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
});
