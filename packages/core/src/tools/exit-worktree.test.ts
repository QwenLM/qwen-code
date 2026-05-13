/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ExitWorktreeTool } from './exit-worktree.js';
import type { Config } from '../config/config.js';

function makeMockConfig(targetDir = '/tmp/mock-repo'): Config {
  return {
    getTargetDir: vi.fn(() => targetDir),
    getSessionId: vi.fn(() => 'mock-session-id'),
  } as unknown as Config;
}

describe('ExitWorktreeTool', () => {
  describe('metadata', () => {
    it('exposes the correct tool name', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(tool.name).toBe('exit_worktree');
      expect(tool.displayName).toBe('ExitWorktree');
    });
  });

  describe('validateToolParams', () => {
    it('requires a non-empty name', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(tool.validateToolParams({ name: '', action: 'keep' })).toMatch(
        /non-empty/i,
      );
    });

    it('requires action to be keep or remove', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(
        tool.validateToolParams({
          name: 'foo',
          action: 'destroy' as 'keep' | 'remove',
        }),
      ).toMatch(/keep.*remove/i);
      expect(
        tool.validateToolParams({ name: 'foo', action: 'keep' }),
      ).toBeNull();
      expect(
        tool.validateToolParams({ name: 'foo', action: 'remove' }),
      ).toBeNull();
    });

    it('rejects slugs that would resolve outside the worktrees dir', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(
        tool.validateToolParams({ name: 'a/b', action: 'remove' }),
      ).not.toBeNull();
      expect(
        tool.validateToolParams({ name: '../etc', action: 'remove' }),
      ).not.toBeNull();
    });

    it('rejects discard_changes when it is not a boolean', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      expect(
        tool.validateToolParams({
          name: 'foo',
          action: 'remove',
          // @ts-expect-error: deliberately wrong type
          discard_changes: 'yes',
        }),
      ).toMatch(/boolean/i);
    });
  });

  describe('default permission', () => {
    it("returns 'ask' when action is 'remove'", async () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const inv = tool.build({ name: 'foo', action: 'remove' });
      expect(await inv.getDefaultPermission()).toBe('ask');
    });

    it("returns 'allow' when action is 'keep'", async () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const inv = tool.build({ name: 'foo', action: 'keep' });
      expect(await inv.getDefaultPermission()).toBe('allow');
    });
  });

  describe('getDescription', () => {
    it('mentions remove vs keep', () => {
      const tool = new ExitWorktreeTool(makeMockConfig());
      const remove = tool.build({ name: 'foo', action: 'remove' });
      expect(remove.getDescription()).toMatch(/remove/i);
      const keep = tool.build({ name: 'foo', action: 'keep' });
      expect(keep.getDescription()).toMatch(/keep/i);
    });
  });
});
