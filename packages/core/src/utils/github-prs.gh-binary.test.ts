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

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

import { existsSync } from 'node:fs';
import { resolveGhBinary } from './github-prs.js';

const mockExistsSync = vi.mocked(existsSync);
const CWD = '/nonexistent';

describe('resolveGhBinary fallback candidates', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockDebugLogger.debug.mockReset();
  });

  it('selects the first installed package-manager binary', () => {
    // A launchd-shaped daemon's PATH carries none of these; the fallback is
    // the only way its gh legs (PR binding, panels) keep working.
    mockExistsSync.mockImplementation(
      (candidate) => candidate === '/opt/homebrew/bin/gh',
    );
    expect(
      resolveGhBinary({ PATH: '/nonexistent', HOME: '/nonexistent' }, CWD),
    ).toBe('/opt/homebrew/bin/gh');
    // Which binary ran is otherwise unobservable.
    expect(mockDebugLogger.debug).toHaveBeenCalledWith(
      'gh not on PATH; using fallback binary',
      { binary: '/opt/homebrew/bin/gh' },
    );
  });

  it('prefers the per-user install over a package-manager candidate', () => {
    // A host can carry both a system gh and a newer official-installer gh;
    // the docstring's "per-user install leads" contract must decide.
    const home = '/Users/alice';
    mockExistsSync.mockImplementation(
      (candidate) =>
        candidate === `${home}/.local/bin/gh` ||
        candidate === '/usr/local/bin/gh',
    );
    expect(resolveGhBinary({ PATH: '/nonexistent', HOME: home }, CWD)).toBe(
      `${home}/.local/bin/gh`,
    );
  });

  it('never returns a relative per-user candidate for an empty HOME', () => {
    mockExistsSync.mockImplementation(
      (candidate) => candidate === '.local/bin/gh',
    );
    expect(resolveGhBinary({ PATH: '/nonexistent', HOME: '' }, CWD)).toBe('gh');
    expect(mockDebugLogger.debug).not.toHaveBeenCalled();
  });

  it('keeps the bare name when no candidate exists', () => {
    expect(
      resolveGhBinary({ PATH: '/nonexistent', HOME: '/nonexistent' }, CWD),
    ).toBe('gh');
    expect(mockDebugLogger.debug).not.toHaveBeenCalled();
  });

  it('logs nothing when PATH resolves gh', () => {
    mockExistsSync.mockImplementation(
      (candidate) => candidate === `${CWD}/bin/gh`,
    );
    expect(resolveGhBinary({ PATH: 'bin', HOME: '/nonexistent' }, CWD)).toBe(
      'gh',
    );
    expect(mockDebugLogger.debug).not.toHaveBeenCalled();
  });
});
