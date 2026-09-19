/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveProjectRelativePath,
  resolveSymlinkAwareRelativePaths,
} from './projectPath.js';

describe('resolveProjectRelativePath', () => {
  it('returns a forward-slash relative path for an absolute input', () => {
    const result = resolveProjectRelativePath(
      '/project/src/foo.ts',
      '/project',
    );
    expect(result).toBe('src/foo.ts');
  });

  it('returns null for paths outside the project root', () => {
    expect(resolveProjectRelativePath('/other/foo.ts', '/project')).toBeNull();
  });

  it('resolves relative paths against projectRoot', () => {
    const result = resolveProjectRelativePath('src/foo.ts', '/project');
    expect(result).toBe('src/foo.ts');
  });

  it('rejects the exact `..` relative path', () => {
    expect(resolveProjectRelativePath('/', '/project')).toBeNull();
  });
});

describe('resolveSymlinkAwareRelativePaths', () => {
  it.each([
    ['/tmp/project/src/foo.ts', '/private/tmp/project'],
    ['/private/tmp/project/src/foo.ts', '/tmp/project'],
  ])('resolves aliases for file %s and root %s', async (file, root) => {
    const realpath = vi
      .fn()
      .mockResolvedValueOnce('/private/tmp/project/src/foo.ts')
      .mockResolvedValueOnce('/private/tmp/project');
    expect(
      await resolveSymlinkAwareRelativePaths(file, root, realpath),
    ).toEqual(['src/foo.ts']);
  });

  it('rejects paths outside the canonical project root', async () => {
    const realpath = vi
      .fn()
      .mockResolvedValueOnce('/private/tmp/other/foo.ts')
      .mockResolvedValueOnce('/private/tmp/project');
    expect(
      await resolveSymlinkAwareRelativePaths(
        '/tmp/other/foo.ts',
        '/private/tmp/project',
        realpath,
      ),
    ).toEqual([]);
  });

  it('returns the original relative path when realpath is not provided', async () => {
    const result = await resolveSymlinkAwareRelativePaths(
      '/project/src/foo.ts',
      '/project',
    );
    expect(result).toEqual(['src/foo.ts']);
  });

  it('returns both original and realpath-resolved paths when they differ', async () => {
    const mockRealpath = vi
      .fn()
      .mockResolvedValueOnce('/project/lib/foo.ts') // realpath(file)
      .mockResolvedValueOnce('/project'); // realpath(projectRoot)
    const result = await resolveSymlinkAwareRelativePaths(
      '/project/src/foo.ts',
      '/project',
      mockRealpath,
    );
    expect(result).toEqual(['src/foo.ts', 'lib/foo.ts']);
  });

  it('returns only the original path when realpath equals the input', async () => {
    const mockRealpath = vi.fn().mockResolvedValue('/project/src/foo.ts');
    const result = await resolveSymlinkAwareRelativePaths(
      '/project/src/foo.ts',
      '/project',
      mockRealpath,
    );
    expect(result).toEqual(['src/foo.ts']);
  });

  it('returns empty array when original path is outside project root', async () => {
    const result = await resolveSymlinkAwareRelativePaths(
      '/other/foo.ts',
      '/project',
    );
    expect(result).toEqual([]);
  });

  it('falls back to original path when realpath fails', async () => {
    const mockRealpath = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const result = await resolveSymlinkAwareRelativePaths(
      '/project/src/foo.ts',
      '/project',
      mockRealpath,
    );
    expect(result).toEqual(['src/foo.ts']);
  });

  it('filters out realpath result when it is also outside project root', async () => {
    const mockRealpath = vi
      .fn()
      .mockResolvedValueOnce('/other/foo.ts') // realpath(file)
      .mockResolvedValueOnce('/project'); // realpath(projectRoot)
    const result = await resolveSymlinkAwareRelativePaths(
      '/project/src/foo.ts',
      '/project',
      mockRealpath,
    );
    // realpath resolved to outside project root, so only original is returned
    expect(result).toEqual(['src/foo.ts']);
  });

  it('handles symlinked directories correctly', async () => {
    // Simulate /project/symlink-to-src → /project/src
    const mockRealpath = vi
      .fn()
      .mockResolvedValueOnce('/project/src/nested/foo.ts') // realpath(file)
      .mockResolvedValueOnce('/project'); // realpath(projectRoot)
    const result = await resolveSymlinkAwareRelativePaths(
      '/project/symlink-to-src/nested/foo.ts',
      '/project',
      mockRealpath,
    );
    expect(result).toEqual([
      'symlink-to-src/nested/foo.ts',
      'src/nested/foo.ts',
    ]);
  });

  it('works with relative input paths', async () => {
    const mockRealpath = vi
      .fn()
      .mockResolvedValueOnce('/project/lib/foo.ts') // realpath(file)
      .mockResolvedValueOnce('/project'); // realpath(projectRoot)
    const result = await resolveSymlinkAwareRelativePaths(
      'src/foo.ts',
      '/project',
      mockRealpath,
    );
    expect(result).toEqual(['src/foo.ts', 'lib/foo.ts']);
  });
});
