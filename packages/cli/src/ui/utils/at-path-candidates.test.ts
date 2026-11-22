/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getAtPathCandidates } from './at-path-candidates.js';

describe('getAtPathCandidates', () => {
  it('returns only the input path on POSIX platforms', () => {
    expect(getAtPathCandidates('my\\ file.txt', 'linux')).toEqual([
      'my\\ file.txt',
    ]);
    expect(getAtPathCandidates('doc\\ \\(1\\).md', 'darwin')).toEqual([
      'doc\\ \\(1\\).md',
    ]);
  });

  it('returns literal then unescaped candidates on win32 for escaped paths', () => {
    expect(getAtPathCandidates('测试\\ 文档.md', 'win32')).toEqual([
      '测试\\ 文档.md',
      '测试 文档.md',
    ]);
    expect(getAtPathCandidates('设计稿\\ \\(终版\\).md', 'win32')).toEqual([
      '设计稿\\ \\(终版\\).md',
      '设计稿 (终版).md',
    ]);
    expect(
      getAtPathCandidates('C:\\Users\\demo\\my\\ file.txt', 'win32'),
    ).toEqual([
      'C:\\Users\\demo\\my\\ file.txt',
      'C:\\Users\\demo\\my file.txt',
    ]);
  });

  it('preserves leading drive-root, UNC, and drive-relative separators on win32', () => {
    expect(getAtPathCandidates('C:\\(v2)\\file.txt', 'win32')).toEqual([
      'C:\\(v2)\\file.txt',
    ]);
    expect(getAtPathCandidates('C:\\(v2\\)\\my\\ file.txt', 'win32')).toEqual([
      'C:\\(v2\\)\\my\\ file.txt',
      'C:\\(v2)\\my file.txt',
    ]);
    expect(
      getAtPathCandidates('\\\\server\\#share\\my\\ file.txt', 'win32'),
    ).toEqual([
      '\\\\server\\#share\\my\\ file.txt',
      '\\\\server\\#share\\my file.txt',
    ]);
    expect(getAtPathCandidates('\\#v2\\my\\ file.txt', 'win32')).toEqual([
      '\\#v2\\my\\ file.txt',
      '\\#v2\\my file.txt',
    ]);
  });

  it('returns a single candidate on win32 when nothing is escaped', () => {
    expect(getAtPathCandidates('README.md', 'win32')).toEqual(['README.md']);
    expect(getAtPathCandidates('src\\app\\index.ts', 'win32')).toEqual([
      'src\\app\\index.ts',
    ]);
  });
});
