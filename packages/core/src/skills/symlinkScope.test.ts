/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { validateSymlinkTarget } from './symlinkScope.js';

vi.mock('fs/promises');

describe('validateSymlinkTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a target that resolves to a directory', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/some/where/foo');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkTarget('/base/skills/link');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe('/some/where/foo');
    }
  });

  it('accepts a target that resolves outside the skills directory', async () => {
    // Cross-directory symlinks are the supported user workflow: a
    // separate skills repo on disk, with subsets symlinked into
    // `~/.qwen/skills/`. The helper must not reject these.
    vi.mocked(fs.realpath).mockResolvedValue(
      '/Users/me/projects/skills-repo/skills/auto-pr',
    );
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => true,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkTarget(
      '/Users/me/.qwen/skills/auto-pr',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when realpath fails (broken symlink)', async () => {
    vi.mocked(fs.realpath).mockRejectedValue(new Error('ENOENT'));

    const result = await validateSymlinkTarget('/base/skills/dangling');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });

  it('rejects when target exists but is a file, not a directory', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/file');
    vi.mocked(fs.stat).mockResolvedValue({
      isDirectory: () => false,
    } as Awaited<ReturnType<typeof fs.stat>>);

    const result = await validateSymlinkTarget('/base/skills/link');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-directory');
    }
  });

  it('rejects when stat fails after realpath succeeds (race / permission)', async () => {
    vi.mocked(fs.realpath).mockResolvedValue('/base/skills/foo');
    vi.mocked(fs.stat).mockRejectedValue(new Error('EACCES'));

    const result = await validateSymlinkTarget('/base/skills/link');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid');
    }
  });
});
