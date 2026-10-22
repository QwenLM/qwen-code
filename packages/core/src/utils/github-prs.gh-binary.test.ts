/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only existence is stubbed: which candidate the resolver picks is decided by
// real files on the host, so the fallback list itself needs a controlled probe.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { resolveGhBinary } from './github-prs.js';

const mockExistsSync = vi.mocked(existsSync);

describe('resolveGhBinary fallback candidates', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  it('selects the first installed package-manager binary', () => {
    // A launchd-shaped daemon's PATH carries none of these; the fallback is
    // the only way its gh legs (PR binding, panels) keep working.
    mockExistsSync.mockImplementation(
      (candidate) => candidate === '/opt/homebrew/bin/gh',
    );
    expect(
      resolveGhBinary({ PATH: '/nonexistent', HOME: '/nonexistent' }),
    ).toBe('/opt/homebrew/bin/gh');
  });

  it('never returns a relative per-user candidate for an empty HOME', () => {
    mockExistsSync.mockImplementation(
      (candidate) => candidate === '.local/bin/gh',
    );
    expect(resolveGhBinary({ PATH: '/nonexistent', HOME: '' })).toBe('gh');
  });

  it('keeps the bare name when no candidate exists', () => {
    expect(
      resolveGhBinary({ PATH: '/nonexistent', HOME: '/nonexistent' }),
    ).toBe('gh');
  });
});
