/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as fs from 'node:fs';
import type * as path from 'node:path';
import { checkWritePermissionForPath } from './filesystem.js';
import type { PathPermissionContext } from '../tool-checkers/checker-reasons.js';

const fixture = vi.hoisted(() => ({
  directories: new Set<string>(),
  realPaths: new Map<string, string>(),
}));

// 公共测试初始化会预先加载路径工具，需要清除缓存以应用 Windows 模拟。
vi.hoisted(() => vi.resetModules());

// 在任意测试宿主上执行真实的 Windows 路径分支，不依赖本机盘符和目录。
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return { ...actual.win32, default: actual.win32 };
});
vi.mock('../../utils/platform.js', () => ({ getPlatform: () => 'windows' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const statSync = (value: string) => {
    if (fixture.directories.has(value.replace(/\\$/, ''))) {
      return { isDirectory: () => true, isSymbolicLink: () => false };
    }
    throw Object.assign(new Error('Fixture path does not exist'), {
      code: 'ENOENT',
    });
  };
  const overrides = {
    statSync,
    lstatSync: statSync,
    realpathSync: (value: string) => fixture.realPaths.get(value) ?? value,
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const cwd = 'C:\\workspace';
const context: PathPermissionContext = {
  rules: { allow: {}, deny: {}, ask: {} },
  additionalDirectories: [],
};

function suggestedDirectories(input: string): readonly string[] {
  const result = checkWritePermissionForPath(input, context, cwd);
  expect(result.kind).toBe('ask');
  if (result.kind !== 'ask') throw new Error('Expected a permission request');
  return (result.suggestions ?? []).flatMap((update) =>
    update.type === 'addDirectories' ? update.directories : [],
  );
}

describe('Windows write permission directory suggestions', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { get: () => 'win32' } }),
    );
    fixture.directories.clear();
    fixture.directories.add(cwd);
    fixture.directories.add('D:\\output');
    fixture.realPaths.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['D:\\output\\result.txt', '/d/output/result.txt'])(
    'returns a native containing directory for %s',
    (input) => {
      expect(suggestedDirectories(input)).toEqual(['D:\\output']);
    },
  );

  it('authorizes an existing target directory rather than its parent', () => {
    expect(suggestedDirectories('/d/output')).toEqual(['D:\\output']);
  });

  it('resolves a relative write target against the session working directory', () => {
    expect(suggestedDirectories('..\\outside\\result.txt')).toEqual([
      'C:\\outside',
    ]);
  });

  it('keeps both the native directory and its resolved symlink target', () => {
    fixture.realPaths.set('D:\\output', 'E:\\shared');
    expect(suggestedDirectories('/d/output/result.txt')).toEqual(
      expect.arrayContaining(['D:\\output', 'E:\\shared']),
    );
  });
});
