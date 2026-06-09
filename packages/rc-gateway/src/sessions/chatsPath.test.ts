/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeCwd,
  runtimeBaseDir,
  resolveChatsDir,
  isValidSessionId,
  SESSION_FILE_RE,
} from './chatsPath.js';

describe('sanitizeCwd', () => {
  it('replaces every non-alphanumeric char (/, ., _, space) with a dash', () => {
    // These are exactly the cases where cycle-19's `replace(/[/.]/g,'-')`
    // approximation diverges from core's sanitizeCwd.
    expect(sanitizeCwd('/home/my_user/projects/qwen code.v2')).toBe(
      '-home-my-user-projects-qwen-code-v2',
    );
  });

  it('leaves alphanumerics untouched', () => {
    expect(sanitizeCwd('abc123')).toBe('abc123');
  });
});

describe('runtimeBaseDir', () => {
  it('honors QWEN_RUNTIME_DIR first (resolved to absolute)', () => {
    expect(runtimeBaseDir({ QWEN_RUNTIME_DIR: '/rt/dir' })).toBe('/rt/dir');
  });

  it('falls back to QWEN_HOME when QWEN_RUNTIME_DIR is unset', () => {
    expect(runtimeBaseDir({ QWEN_HOME: '/home-dir/.qwen' })).toBe(
      '/home-dir/.qwen',
    );
  });

  it('prefers QWEN_RUNTIME_DIR over QWEN_HOME', () => {
    expect(runtimeBaseDir({ QWEN_RUNTIME_DIR: '/rt', QWEN_HOME: '/qh' })).toBe(
      '/rt',
    );
  });

  it('falls back to ~/.qwen when neither env var is set', () => {
    expect(runtimeBaseDir({})).toBe(join(homedir(), '.qwen'));
  });
});

describe('resolveChatsDir', () => {
  it('builds <base>/projects/<sanitizeCwd>/chats honoring QWEN_RUNTIME_DIR', () => {
    expect(resolveChatsDir('/work/proj', { QWEN_RUNTIME_DIR: '/rt' })).toBe(
      join('/rt', 'projects', '-work-proj', 'chats'),
    );
  });

  it('honors QWEN_HOME when QWEN_RUNTIME_DIR is unset', () => {
    expect(resolveChatsDir('/work/proj', { QWEN_HOME: '/qh/.qwen' })).toBe(
      join('/qh/.qwen', 'projects', '-work-proj', 'chats'),
    );
  });

  it('falls back to ~/.qwen base', () => {
    expect(resolveChatsDir('/work/proj', {})).toBe(
      join(homedir(), '.qwen', 'projects', '-work-proj', 'chats'),
    );
  });
});

describe('isValidSessionId / SESSION_FILE_RE', () => {
  it('accepts a UUID', () => {
    expect(isValidSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('rejects a path-traversal id', () => {
    expect(isValidSessionId('../x')).toBe(false);
  });

  it('rejects a too-short id', () => {
    expect(isValidSessionId('abc')).toBe(false);
  });

  it('rejects ids with a path separator', () => {
    expect(isValidSessionId('a/b')).toBe(false);
  });

  it('SESSION_FILE_RE matches a 32-char hex id', () => {
    expect(SESSION_FILE_RE.test('0123456789abcdef0123456789abcdef')).toBe(true);
  });
});
