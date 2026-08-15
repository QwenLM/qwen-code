/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ghMock, ghWithInputMock, getPlatformReaderMock } = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghWithInputMock: vi.fn(),
  getPlatformReaderMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    gh: ghMock,
    ghWithInput: ghWithInputMock,
    setGhHost: vi.fn(),
    currentUser: vi.fn(() => 'someone-else'),
  };
});

// Steer detection to Aone so the refusal guard fires regardless of cwd.
vi.mock('./lib/platform/registry.js', () => ({
  getPlatformReader: getPlatformReaderMock,
}));

import { runSubmit } from './submit.js';

const BASE = {
  pr: 1,
  repo: 'maxcompute/odps_src',
  review: '.qwen/tmp/review.json',
  userAuthorized: true,
  dryRun: false,
};

describe('submit refuses an Aone target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws the read-only refusal before any gh call', () => {
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    expect(() =>
      runSubmit(BASE, 'unknown', { attribution: true, defaultComment: false }),
    ).toThrow(/posting review comments to Aone Code is not supported/);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a padded Aone --host still refuses (detection trims)', () => {
    getPlatformReaderMock.mockImplementation(({ host }: { host?: string }) => ({
      kind: host?.trim() === 'gitlab.alibaba-inc.com' ? 'aone' : 'github',
    }));
    expect(() =>
      runSubmit({ ...BASE, host: ' gitlab.alibaba-inc.com ' }, 'unknown', {
        attribution: true,
        defaultComment: false,
      }),
    ).toThrow(/posting review comments to Aone Code is not supported/);
  });
});
