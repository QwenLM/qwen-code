/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveExcludePatterns,
  isAgentsMdExcluded,
  filterExcludedMemoryPaths,
  type TypedMemoryPaths,
} from './memoryDiscovery.js';

describe('resolveExcludePatterns', () => {
  it('should normalize backslashes to forward slashes', () => {
    const result = resolveExcludePatterns(['C:\\Users\\test\\AGENTS.md']);
    expect(result).toContain('C:/Users/test/AGENTS.md');
  });

  it('should filter out empty patterns', () => {
    const result = resolveExcludePatterns(['', '**/AGENTS.md']);
    expect(result).not.toContain('');
    expect(result).toContain('**/AGENTS.md');
  });

  it('should pass through relative glob patterns unchanged', () => {
    const result = resolveExcludePatterns(['**/AGENTS.md', '**/*.md']);
    expect(result).toEqual(['**/AGENTS.md', '**/*.md']);
  });

  it('should handle patterns with nonexistent absolute directories gracefully', () => {
    const result = resolveExcludePatterns([
      '/nonexistent-dir-zzz/path/AGENTS.md',
    ]);
    expect(result).toContain('/nonexistent-dir-zzz/path/AGENTS.md');
  });

  it('should not duplicate patterns when realpath matches original', () => {
    // Use a known real path that won't have a symlink
    const result = resolveExcludePatterns(['/usr/bin/AGENTS.md']);
    // Should contain the original (no duplicate since realpath of /usr matches)
    expect(result.filter((p) => p === '/usr/bin/AGENTS.md').length).toBe(1);
  });

  it('should handle glob characters in path correctly', () => {
    const result = resolveExcludePatterns(['/some/path/**/AGENTS.md']);
    expect(result).toContain('/some/path/**/AGENTS.md');
  });
});

describe('isAgentsMdExcluded', () => {
  it('should return false for empty patterns', () => {
    expect(isAgentsMdExcluded('/app/AGENTS.md', [])).toBe(false);
  });

  it('should match exact absolute paths', () => {
    expect(isAgentsMdExcluded('/app/AGENTS.md', ['/app/AGENTS.md'])).toBe(true);
  });

  it('should match double-star glob patterns', () => {
    expect(isAgentsMdExcluded('/app/src/AGENTS.md', ['**/AGENTS.md'])).toBe(
      true,
    );
  });

  it('should not match non-matching paths', () => {
    expect(isAgentsMdExcluded('/app/README.md', ['**/AGENTS.md'])).toBe(false);
  });

  it('should match dot-prefixed directories with dot: true', () => {
    expect(
      isAgentsMdExcluded('/app/.hidden/AGENTS.md', ['**/.hidden/AGENTS.md']),
    ).toBe(true);
  });

  it('should match dot-prefixed directories with double-star', () => {
    expect(isAgentsMdExcluded('/app/.hidden/AGENTS.md', ['**/AGENTS.md'])).toBe(
      true,
    );
  });

  it('should match single-star directory wildcards', () => {
    expect(
      isAgentsMdExcluded('/app/packages/sub/AGENTS.md', [
        '/app/packages/*/AGENTS.md',
      ]),
    ).toBe(true);
  });

  it('should not match deeper nesting with single-star', () => {
    expect(
      isAgentsMdExcluded('/app/packages/deep/sub/AGENTS.md', [
        '/app/packages/*/AGENTS.md',
      ]),
    ).toBe(false);
  });

  it('should normalize backslashes before matching', () => {
    expect(isAgentsMdExcluded('C:\\app\\AGENTS.md', ['C:/app/AGENTS.md'])).toBe(
      true,
    );
  });

  it('should match local memory files', () => {
    expect(
      isAgentsMdExcluded('/app/AGENTS.local.md', ['**/AGENTS.local.md']),
    ).toBe(true);
  });
});

import { CONFIG_DIR } from './paths.js';

describe('filterExcludedMemoryPaths', () => {
  const basePaths: TypedMemoryPaths = {
    global: [`/home/user/${CONFIG_DIR}/AGENTS.md`],
    plugin: ['/ext/myext/AGENTS.md'],
    project: [
      '/app/AGENTS.md',
      '/app/packages/sub1/AGENTS.md',
      '/app/packages/sub2/AGENTS.md',
    ],
    local: ['/app/AGENTS.local.md'],
  };

  it('should return paths unchanged when no exclude patterns', () => {
    const result = filterExcludedMemoryPaths(basePaths, []);
    expect(result).toBe(basePaths);
  });

  it('should return paths unchanged when exclude patterns is empty array', () => {
    const result = filterExcludedMemoryPaths(basePaths, []);
    expect(result).toBe(basePaths);
  });

  it('should never filter global paths even with broad patterns', () => {
    const result = filterExcludedMemoryPaths(basePaths, ['**/*.md']);
    expect(result.global).toEqual(basePaths.global);
  });

  it('should never filter plugin paths even with broad patterns', () => {
    const result = filterExcludedMemoryPaths(basePaths, ['**/*.md']);
    expect(result.plugin).toEqual(basePaths.plugin);
  });

  it('should filter matching project paths by exact path', () => {
    const result = filterExcludedMemoryPaths(basePaths, [
      '/app/packages/sub1/AGENTS.md',
    ]);
    expect(result.project).toEqual([
      '/app/AGENTS.md',
      '/app/packages/sub2/AGENTS.md',
    ]);
  });

  it('should filter matching local paths', () => {
    const result = filterExcludedMemoryPaths(basePaths, ['**/AGENTS.local.md']);
    expect(result.local).toEqual([]);
  });

  it('should filter project paths with glob patterns', () => {
    const result = filterExcludedMemoryPaths(basePaths, [
      '/app/packages/*/AGENTS.md',
    ]);
    expect(result.project).toEqual(['/app/AGENTS.md']);
  });

  it('should handle multiple exclude patterns', () => {
    const result = filterExcludedMemoryPaths(basePaths, [
      '/app/AGENTS.md',
      '/app/packages/sub1/AGENTS.md',
    ]);
    expect(result.project).toEqual(['/app/packages/sub2/AGENTS.md']);
  });

  it('should filter all project/local with broad wildcard but preserve global/plugin', () => {
    const result = filterExcludedMemoryPaths(basePaths, ['**/*.md']);
    expect(result.global).toEqual(basePaths.global);
    expect(result.plugin).toEqual(basePaths.plugin);
    expect(result.project).toEqual([]);
    expect(result.local).toEqual([]);
  });
});
