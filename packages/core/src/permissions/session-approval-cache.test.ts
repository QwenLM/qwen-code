/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionApprovalCache } from './session-approval-cache.js';
import type { PermissionCheckContext } from './types.js';

describe('SessionApprovalCache', () => {
  let cache: SessionApprovalCache;

  beforeEach(() => {
    cache = new SessionApprovalCache();
  });

  describe('file operations', () => {
    const writeCtx: PermissionCheckContext = {
      toolName: 'write_file',
      filePath: '/home/user/project/src/index.ts',
    };

    it('returns false for unapproved context', () => {
      expect(cache.isApproved(writeCtx)).toBe(false);
    });

    it('returns true after approval', () => {
      cache.approve(writeCtx);
      expect(cache.isApproved(writeCtx)).toBe(true);
    });

    it('distinguishes between different files', () => {
      cache.approve(writeCtx);
      const differentFile: PermissionCheckContext = {
        toolName: 'write_file',
        filePath: '/home/user/project/src/other.ts',
      };
      expect(cache.isApproved(differentFile)).toBe(false);
    });

    it('distinguishes between different tools on same file', () => {
      cache.approve(writeCtx);
      const editCtx: PermissionCheckContext = {
        toolName: 'edit',
        filePath: '/home/user/project/src/index.ts',
      };
      expect(cache.isApproved(editCtx)).toBe(false);
    });
  });

  describe('shell commands', () => {
    it('caches safe shell commands', () => {
      const safeCtx: PermissionCheckContext = {
        toolName: 'run_shell_command',
        command: 'git status',
      };
      cache.approve(safeCtx);
      expect(cache.isApproved(safeCtx)).toBe(true);
    });

    it('does not cache dangerous commands (rm)', () => {
      const dangerousCtx: PermissionCheckContext = {
        toolName: 'run_shell_command',
        command: 'rm -rf /tmp/test',
      };
      cache.approve(dangerousCtx);
      expect(cache.isApproved(dangerousCtx)).toBe(false);
    });

    it('does not cache dangerous commands (curl POST)', () => {
      const dangerousCtx: PermissionCheckContext = {
        toolName: 'run_shell_command',
        command: 'curl -X POST http://example.com/api',
      };
      cache.approve(dangerousCtx);
      expect(cache.isApproved(dangerousCtx)).toBe(false);
    });

    it('does not cache commands with redirects', () => {
      const dangerousCtx: PermissionCheckContext = {
        toolName: 'run_shell_command',
        command: 'echo "evil" > /etc/passwd',
      };
      cache.approve(dangerousCtx);
      expect(cache.isApproved(dangerousCtx)).toBe(false);
    });

    it('distinguishes between different commands', () => {
      const ctx1: PermissionCheckContext = {
        toolName: 'run_shell_command',
        command: 'git status',
      };
      const ctx2: PermissionCheckContext = {
        toolName: 'run_shell_command',
        command: 'git log',
      };
      cache.approve(ctx1);
      expect(cache.isApproved(ctx2)).toBe(false);
    });
  });

  describe('web operations', () => {
    it('caches web_fetch by domain', () => {
      const ctx: PermissionCheckContext = {
        toolName: 'web_fetch',
        domain: 'example.com',
      };
      cache.approve(ctx);
      expect(cache.isApproved(ctx)).toBe(true);
    });

    it('distinguishes between different domains', () => {
      const ctx1: PermissionCheckContext = {
        toolName: 'web_fetch',
        domain: 'example.com',
      };
      const ctx2: PermissionCheckContext = {
        toolName: 'web_fetch',
        domain: 'evil.com',
      };
      cache.approve(ctx1);
      expect(cache.isApproved(ctx2)).toBe(false);
    });
  });

  describe('tool-level fallback', () => {
    it('caches tool-level when no specific key available', () => {
      const ctx: PermissionCheckContext = {
        toolName: 'some_custom_tool',
      };
      cache.approve(ctx);
      expect(cache.isApproved(ctx)).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all approvals', () => {
      const ctx: PermissionCheckContext = {
        toolName: 'write_file',
        filePath: '/home/user/project/src/index.ts',
      };
      cache.approve(ctx);
      expect(cache.isApproved(ctx)).toBe(true);

      cache.clear();
      expect(cache.isApproved(ctx)).toBe(false);
    });
  });

  describe('size', () => {
    it('tracks number of approvals', () => {
      expect(cache.size).toBe(0);

      cache.approve({ toolName: 'tool1' });
      expect(cache.size).toBe(1);

      cache.approve({ toolName: 'tool2' });
      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe('max cache size', () => {
    it('evicts old entries when cache is full', () => {
      // Fill cache to MAX_CACHE_SIZE (500)
      for (let i = 0; i < 500; i++) {
        cache.approve({ toolName: `tool_${i}` });
      }
      expect(cache.size).toBe(500);

      // Add one more — should trigger eviction
      cache.approve({ toolName: 'tool_500' });
      // After eviction of 10% (50 entries), size should be 451
      expect(cache.size).toBe(451);
    });
  });
});
