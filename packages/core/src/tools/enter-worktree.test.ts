/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { EnterWorktreeTool } from './enter-worktree.js';
import { ExitWorktreeTool } from './exit-worktree.js';
import type { Config } from '../config/config.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';

function makeMockConfig(targetDir = '/tmp/mock-repo'): Config {
  return {
    getTargetDir: vi.fn(() => targetDir),
  } as unknown as Config;
}

describe('GitWorktreeService.validateUserWorktreeSlug', () => {
  it('accepts simple slugs', () => {
    expect(
      GitWorktreeService.validateUserWorktreeSlug('my-feature'),
    ).toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('foo123')).toBeNull();
    expect(
      GitWorktreeService.validateUserWorktreeSlug('foo.bar_baz-1'),
    ).toBeNull();
  });

  it('rejects empty', () => {
    expect(GitWorktreeService.validateUserWorktreeSlug('')).toMatch(
      /non-empty/i,
    );
  });

  it('rejects path-traversal patterns', () => {
    expect(
      GitWorktreeService.validateUserWorktreeSlug('../etc/passwd'),
    ).not.toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('a/b')).not.toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('foo..bar')).toMatch(
      /must not.*\.\./i,
    );
    expect(GitWorktreeService.validateUserWorktreeSlug('.hidden')).toMatch(
      /must not start/i,
    );
    expect(GitWorktreeService.validateUserWorktreeSlug('-leadingdash')).toMatch(
      /must not start/i,
    );
  });

  it('rejects disallowed characters', () => {
    expect(GitWorktreeService.validateUserWorktreeSlug('a b')).not.toBeNull();
    expect(GitWorktreeService.validateUserWorktreeSlug('a@b')).not.toBeNull();
  });

  it('rejects strings longer than 64 chars', () => {
    expect(GitWorktreeService.validateUserWorktreeSlug('a'.repeat(65))).toMatch(
      /64/,
    );
    expect(
      GitWorktreeService.validateUserWorktreeSlug('a'.repeat(64)),
    ).toBeNull();
  });
});

describe('GitWorktreeService.generateAutoSlug', () => {
  it('produces a slug matching the {adj}-{noun}-{4hex} pattern', () => {
    for (let i = 0; i < 10; i++) {
      const slug = GitWorktreeService.generateAutoSlug();
      expect(slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      expect(GitWorktreeService.validateUserWorktreeSlug(slug)).toBeNull();
    }
  });
});

describe('GitWorktreeService.getUserWorktreesDir / getUserWorktreePath', () => {
  it('uses .qwen/worktrees under the project root', () => {
    // Use the cwd (which exists) so simple-git's existence check passes.
    const root = process.cwd();
    const service = new GitWorktreeService(root);
    // Build expected paths via path.join so the separator matches the
    // platform — the implementation uses path.join, so on Windows the
    // separator is `\`, not `/`.
    expect(service.getUserWorktreesDir()).toBe(
      path.join(root, '.qwen', 'worktrees'),
    );
    expect(service.getUserWorktreePath('feat-x')).toBe(
      path.join(root, '.qwen', 'worktrees', 'feat-x'),
    );
  });
});

describe('EnterWorktreeTool metadata', () => {
  it('exposes the correct tool name and display name', () => {
    const tool = new EnterWorktreeTool(makeMockConfig());
    expect(tool.name).toBe('enter_worktree');
    expect(tool.displayName).toBe('EnterWorktree');
  });

  it('rejects an explicitly invalid name during validation', () => {
    const tool = new EnterWorktreeTool(makeMockConfig());
    const error = tool.validateToolParams({ name: '../../etc' });
    expect(error).not.toBeNull();
  });

  it('accepts an undefined name', () => {
    const tool = new EnterWorktreeTool(makeMockConfig());
    expect(tool.validateToolParams({})).toBeNull();
  });

  it('accepts an empty-string name (treated as auto-generate)', () => {
    // Some models pass `{ name: '' }` when the schema marks `name` as
    // optional. Validation should not reject this — `execute` falls back
    // to an auto-generated slug.
    const tool = new EnterWorktreeTool(makeMockConfig());
    expect(tool.validateToolParams({ name: '' })).toBeNull();
  });
});

describe('ExitWorktreeTool metadata and validation', () => {
  it('exposes the correct tool name', () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    expect(tool.name).toBe('exit_worktree');
    expect(tool.displayName).toBe('ExitWorktree');
  });

  it('requires action to be keep or remove', () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    expect(
      tool.validateToolParams({
        name: 'foo',
        action: 'destroy' as 'keep' | 'remove',
      }),
    ).not.toBeNull();
    expect(tool.validateToolParams({ name: 'foo', action: 'keep' })).toBeNull();
    expect(
      tool.validateToolParams({ name: 'foo', action: 'remove' }),
    ).toBeNull();
  });

  it('rejects invalid name slugs', () => {
    const tool = new ExitWorktreeTool(makeMockConfig());
    expect(
      tool.validateToolParams({ name: 'a/b', action: 'remove' }),
    ).not.toBeNull();
  });
});
