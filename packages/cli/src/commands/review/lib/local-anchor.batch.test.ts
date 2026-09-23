/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The batch mechanics of `hashWorktreeFiles`, against a mocked git layer:
// the E2E suites only ever hash a handful of files, so the 200-file window
// arithmetic and the failed-batch fallback had zero coverage — both were
// measured surviving mutations (an empty batch window, a bypassed fallback).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gitOpt = vi.fn<(...args: string[]) => string | null>();
vi.mock('./git.js', () => ({
  gitOpt: (...args: string[]) => gitOpt(...args),
  // Two consumers, told apart by the command: `hash-object --stdin` for a
  // symlink's link text, `check-attr` for the rendering attributes. Without
  // the second these tests would exercise the unknown-attributes fallback
  // rather than the batching they are about.
  gitWithInput: vi.fn((input: Buffer, args: string[]) =>
    args.includes('check-attr') ? checkAttr(input) : 'link-oid',
  ),
  // `check-attr --stdin -z` goes through the RAW variant: the convenience
  // form's `.trim()` steals the first record's key from a path that begins
  // with whitespace.
  gitWithInputRaw: vi.fn((input: Buffer, args: string[]) =>
    args.includes('check-attr') ? checkAttr(input) : 'link-oid',
  ),
}));

/** `git check-attr --stdin -z`'s echo, for the one attribute these ask for. */
function checkAttr(input: Buffer): string {
  return String(input)
    .split('\0')
    .filter((p) => p !== '')
    .map((p) => `${p}\0diff\0unspecified\0`)
    .join('');
}

import { hashWorktreeFiles, UNHASHABLE } from './local-anchor.js';

let dir: string;
let paths: string[];

beforeEach(() => {
  gitOpt.mockReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'anchor-batch-')));
  paths = [];
  for (let i = 0; i < 201; i++) {
    const p = `f${String(i).padStart(3, '0')}.txt`;
    writeFileSync(join(dir, p), String(i));
    paths.push(p);
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A git stub answering each batch with one fake oid per pathspec. */
function answerBatches(): void {
  gitOpt.mockImplementation((...args: string[]) => {
    // Faithful to real git: no `diff.<driver>.binary` is configured here, so
    // the config probes the driver fold runs answer null (the fixture paths
    // all answer `diff=unspecified`, which is a legal driver NAME too, and is
    // probed like any other candidate).
    if (args.includes('config')) return null;
    const files = args.slice(args.indexOf('--') + 1);
    return files.map((f) => `oid-${f}`).join('\n');
  });
}

describe('hashWorktreeFiles — batching', () => {
  it('windows at 200 pathspecs per ls call and maps every file to its own oid', () => {
    answerBatches();
    const out = hashWorktreeFiles(dir, paths);
    expect(Object.keys(out)).toHaveLength(201);
    for (const p of paths)
      expect(out[p]).toBe(`100644:oid-${p}:diff=unspecified`);
    const batchSizes = gitOpt.mock.calls
      .filter((c) => !c.includes('config')) // the driver probes are not ls calls
      .map((c) => c.slice(c.indexOf('--') + 1).length);
    expect(batchSizes).toEqual([200, 1]);
  });

  it('a failed batch falls back to per-file hashing — one bad file costs itself', () => {
    let batchCalls = 0;
    gitOpt.mockImplementation((...args: string[]) => {
      if (args.includes('config')) return null; // no driver configured
      const files = args.slice(args.indexOf('--') + 1);
      if (files.length > 1) {
        batchCalls++;
        return null; // the whole batch refused, as one unreadable file does
      }
      return files[0] === 'f007.txt' ? null : `oid-${files[0]}`;
    });
    const out = hashWorktreeFiles(dir, paths.slice(0, 10));
    expect(batchCalls).toBe(1);
    expect(out['f007.txt']).toBe(UNHASHABLE);
    expect(out['f003.txt']).toBe('100644:oid-f003.txt:diff=unspecified');
  });

  it('a mismatched batch reply (wrong line count) also takes the fallback', () => {
    gitOpt.mockImplementation((...args: string[]) => {
      if (args.includes('config')) return null; // no driver configured
      const files = args.slice(args.indexOf('--') + 1);
      if (files.length > 1) return 'just-one-line';
      return `oid-${files[0]}`;
    });
    const out = hashWorktreeFiles(dir, paths.slice(0, 3));
    for (const p of paths.slice(0, 3))
      expect(out[p]).toBe(`100644:oid-${p}:diff=unspecified`);
  });
});
