/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getAtPathCandidates,
  selectAtPathCandidate,
  selectAtPathCandidateSync,
} from './at-path-candidates.js';

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

  it('offers fully unescaped candidates for leading-metacharacter relative paths without dropping rooted candidates or duplicating identical ones', () => {
    expect(getAtPathCandidates('\\#notes.md', 'win32')).toEqual([
      '\\#notes.md',
      '#notes.md',
    ]);
    expect(getAtPathCandidates('\\(v2\\)/a.md', 'win32')).toEqual([
      '\\(v2\\)/a.md',
      '\\(v2)/a.md',
      '(v2)/a.md',
    ]);
    expect(getAtPathCandidates('\\#v2\\my\\ file.txt', 'win32')).toEqual([
      '\\#v2\\my\\ file.txt',
      '\\#v2\\my file.txt',
      '#v2\\my file.txt',
    ]);
    expect(getAtPathCandidates('\\foo\\ bar.txt', 'win32')).toEqual([
      '\\foo\\ bar.txt',
      '\\foo bar.txt',
    ]);
  });

  it('preserves leading drive-root and UNC separators without fully unescaping them on win32', () => {
    expect(getAtPathCandidates('C:\\(v2)\\file.txt', 'win32')).toEqual([
      'C:\\(v2)\\file.txt',
    ]);
    expect(getAtPathCandidates('C:\\#notes.md', 'win32')).toEqual([
      'C:\\#notes.md',
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
    expect(getAtPathCandidates('\\\\#share\\a.txt', 'win32')).toEqual([
      '\\\\#share\\a.txt',
    ]);
  });

  it('preserves interior directory separators before metacharacters ahead of folded siblings and rejects non-escaped folds', () => {
    expect(
      getAtPathCandidates(
        'C:\\Users\\John\\ Doe\\Docs\\(draft\\)\\a.txt',
        'win32',
      ),
    ).toEqual([
      'C:\\Users\\John\\ Doe\\Docs\\(draft\\)\\a.txt',
      'C:\\Users\\John Doe\\Docs\\(draft)\\a.txt',
      'C:\\Users\\John Doe\\Docs(draft)\\a.txt',
    ]);
    expect(
      getAtPathCandidates(
        'C:\\Users\\John\\ Doe\\Docs\\(draft)\\a.txt',
        'win32',
      ),
    ).toEqual([
      'C:\\Users\\John\\ Doe\\Docs\\(draft)\\a.txt',
      'C:\\Users\\John Doe\\Docs\\(draft)\\a.txt',
    ]);
    expect(
      getAtPathCandidates('C:\\Users\\demo\\Docs\\(draft)\\a.txt', 'win32'),
    ).toEqual(['C:\\Users\\demo\\Docs\\(draft)\\a.txt']);
    expect(getAtPathCandidates('Docs\\(draft\\)\\a.txt', 'win32')).toEqual([
      'Docs\\(draft\\)\\a.txt',
      'Docs\\(draft)\\a.txt',
      'Docs(draft)\\a.txt',
    ]);
    expect(getAtPathCandidates('Docs\\(draft)\\a.txt', 'win32')).toEqual([
      'Docs\\(draft)\\a.txt',
    ]);
    expect(getAtPathCandidates('Docs\\(draft)/a.txt', 'win32')).toEqual([
      'Docs\\(draft)/a.txt',
    ]);
    expect(getAtPathCandidates('report\\(1\\)\\', 'win32')).toEqual([
      'report\\(1\\)\\',
      'report(1)\\',
    ]);
    expect(
      getAtPathCandidates('C:\\Users\\demo\\my\\\\ file.txt', 'win32'),
    ).toEqual(['C:\\Users\\demo\\my\\\\ file.txt']);
    expect(getAtPathCandidates('\\\\#notes.md', 'win32')).toEqual([
      '\\\\#notes.md',
    ]);
  });

  it('keeps unescaping valid escaped spaces when later characters include unescaped shell metacharacters', () => {
    expect(getAtPathCandidates('my\\ folder/(', 'win32')).toEqual([
      'my\\ folder/(',
      'my folder/(',
    ]);
    expect(getAtPathCandidates('my\\ folder/notes#', 'win32')).toEqual([
      'my\\ folder/notes#',
      'my folder/notes#',
    ]);
    expect(getAtPathCandidates('my\\ folder/R&', 'win32')).toEqual([
      'my\\ folder/R&',
      'my folder/R&',
    ]);
    expect(
      getAtPathCandidates("C:\\Users\\O'Brien\\my\\ file.txt", 'win32'),
    ).toEqual([
      "C:\\Users\\O'Brien\\my\\ file.txt",
      "C:\\Users\\O'Brien\\my file.txt",
    ]);
    expect(getAtPathCandidates('report\\(1\\)\\ notes#1.md', 'win32')).toEqual([
      'report\\(1\\)\\ notes#1.md',
      'report(1) notes#1.md',
    ]);
  });

  it('handles long consecutive backslash runs in linear time without collapsing even runs', () => {
    const evenRun = `${'\\'.repeat(40000)} `;
    expect(getAtPathCandidates(evenRun, 'win32')).toEqual([evenRun]);

    const oddRun = `${'\\'.repeat(40001)} `;
    expect(getAtPathCandidates(oddRun, 'win32')).toEqual([
      oddRun,
      `${'\\'.repeat(40000)} `,
    ]);
  });

  it('returns a single candidate on win32 when nothing is escaped', () => {
    expect(getAtPathCandidates('README.md', 'win32')).toEqual(['README.md']);
    expect(getAtPathCandidates('src\\app\\index.ts', 'win32')).toEqual([
      'src\\app\\index.ts',
    ]);
  });
});

describe('selectAtPathCandidate and selectAtPathCandidateSync', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), 'qwen-at-candidates-')),
    );
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns single candidates without probing the filesystem', async () => {
    const lstatSpy = vi.spyOn(fsPromises, 'lstat');
    const lstatSyncSpy = vi.spyOn(fs, 'lstatSync');

    expect(await selectAtPathCandidate(['README.md'], ['/ws'])).toBe(
      'README.md',
    );
    expect(selectAtPathCandidateSync(['README.md'], ['/ws'])).toBe('README.md');
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(lstatSyncSpy).not.toHaveBeenCalled();
  });

  it('prefers the first existing candidate and falls back only on ENOENT', async () => {
    const ws = await makeTempDir();
    await fsPromises.writeFile(path.join(ws, 'literal.txt'), 'a');
    await fsPromises.writeFile(path.join(ws, 'fallback.txt'), 'b');

    expect(
      await selectAtPathCandidate(['literal.txt', 'fallback.txt'], [ws]),
    ).toBe('literal.txt');
    expect(
      selectAtPathCandidateSync(['literal.txt', 'fallback.txt'], [ws]),
    ).toBe('literal.txt');

    expect(
      await selectAtPathCandidate(['missing.txt', 'fallback.txt'], [ws]),
    ).toBe('fallback.txt');
    expect(
      selectAtPathCandidateSync(['missing.txt', 'fallback.txt'], [ws]),
    ).toBe('fallback.txt');

    expect(
      await selectAtPathCandidate(['missing-a.txt', 'missing-b.txt'], [ws]),
    ).toBe('missing-a.txt');
    expect(
      selectAtPathCandidateSync(['missing-a.txt', 'missing-b.txt'], [ws]),
    ).toBe('missing-a.txt');
  });

  it('returns the current candidate without falling back on non-ENOENT errors such as EACCES or EPERM', async () => {
    const ws = await makeTempDir();
    const siblingPath = path.join(ws, 'sibling.txt');
    const literalPath = path.join(ws, 'denied.txt');
    await fsPromises.writeFile(siblingPath, 'sibling');

    const eacces = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const origLstat = fsPromises.lstat.bind(fsPromises);
    vi.spyOn(fsPromises, 'lstat').mockImplementation(async (target) => {
      if (String(target) === literalPath) {
        throw eacces;
      }
      return origLstat(target);
    });

    const eperm = Object.assign(new Error('operation not permitted'), {
      code: 'EPERM',
    });
    const origLstatSync = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((target) => {
      if (String(target) === literalPath) {
        throw eperm;
      }
      return origLstatSync(target);
    });

    expect(
      await selectAtPathCandidate(['denied.txt', 'sibling.txt'], [ws]),
    ).toBe('denied.txt');
    expect(selectAtPathCandidateSync(['denied.txt', 'sibling.txt'], [ws])).toBe(
      'denied.txt',
    );

    const nonError: unknown = null;
    vi.spyOn(fsPromises, 'lstat').mockRejectedValueOnce(nonError);
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
      throw nonError;
    });
    expect(
      await selectAtPathCandidate(['denied.txt', 'sibling.txt'], [ws]),
    ).toBe('denied.txt');
    expect(selectAtPathCandidateSync(['denied.txt', 'sibling.txt'], [ws])).toBe(
      'denied.txt',
    );
  });

  it('skips probe targets lexically outside allowedRoots without calling realpathSync', async () => {
    const ws = await makeTempDir();
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, '$RECYCLE.BIN');
    const insideFile = path.join(ws, '$RECYCLE.BIN');
    await fsPromises.writeFile(outsideFile, 'outside');
    await fsPromises.writeFile(insideFile, 'inside');

    const realpathSyncSpy = vi.spyOn(fs, 'realpathSync');
    expect(
      await selectAtPathCandidate(
        [outsideFile, '$RECYCLE.BIN'],
        [ws],
        ['', ws],
      ),
    ).toBe('$RECYCLE.BIN');
    expect(
      selectAtPathCandidateSync([outsideFile, '$RECYCLE.BIN'], [ws], ['', ws]),
    ).toBe('$RECYCLE.BIN');

    expect(
      await selectAtPathCandidate([outsideFile, insideFile], [], [ws]),
    ).toBe(insideFile);
    expect(selectAtPathCandidateSync([outsideFile, insideFile], [], [ws])).toBe(
      insideFile,
    );
    const missingOutside = path.join(outsideDir, 'missing.bin');
    expect(
      await selectAtPathCandidate([missingOutside, insideFile], [], []),
    ).toBe(insideFile);
    expect(realpathSyncSpy).not.toHaveBeenCalled();
  });

  it('probes across multiple workspace directories and deduplicates absolute targets', async () => {
    const ws1 = await makeTempDir();
    const ws2 = await makeTempDir();
    const fileInWs2 = path.join(ws2, 'target.txt');
    await fsPromises.writeFile(fileInWs2, 'ok');

    expect(
      await selectAtPathCandidate(['missing.txt', 'target.txt'], [ws1, ws2]),
    ).toBe('target.txt');
    expect(
      selectAtPathCandidateSync(['missing.txt', 'target.txt'], [ws1, ws2]),
    ).toBe('target.txt');

    const missingAbs = path.join(ws1, 'does-not-exist.txt');
    const lstatSpy = vi.spyOn(fsPromises, 'lstat');
    expect(
      await selectAtPathCandidate([missingAbs, fileInWs2], [ws1, ws2]),
    ).toBe(fileInWs2);
    expect(lstatSpy).toHaveBeenCalledTimes(2);
    expect(selectAtPathCandidateSync([missingAbs, fileInWs2], [])).toBe(
      fileInWs2,
    );
    expect(await selectAtPathCandidate(['missing.txt', 'target.txt'], [])).toBe(
      'missing.txt',
    );
  });
});
