/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitIgnoreParser } from './gitIgnoreParser.js';

// Exercise a complete production matcher-evaluation window.
const LOOKUP_WINDOW = 10_000;

describe('GitIgnoreParser cache retention', () => {
  let root: string;
  let parser: GitIgnoreParser;

  async function write(relativePath: string, content: string) {
    const file = path.join(root, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-cache-'));
    await write('.gitignore', '*.log\n');
    parser = new GitIgnoreParser(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shares compiled rules between directories with the same ignore chain', async () => {
    for (let i = 0; i < 100; i++) {
      const dir = `scratch-${i}`;
      await fs.mkdir(path.join(root, dir));
      expect(parser.isIgnored(`${dir}/result.log`)).toBe(true);
      expect(parser.isIgnored(`${dir}/result.txt`)).toBe(false);
    }

    // Correct output alone cannot catch the OOM: inspect the references the
    // parser retains, rather than relying on platform-dependent heap sizes.
    expect(new Set(parser['ignorerCache'].values()).size).toBe(1);
  });

  it('bounds directory memos and negative pattern lookups across a large scan', () => {
    for (let i = 0; i < LOOKUP_WINDOW + 5; i++) {
      expect(parser.isIgnored(`scratch-${i}/result.log`)).toBe(true);
    }

    expect(parser['ignorerCache'].size).toBeLessThanOrEqual(LOOKUP_WINDOW);
    expect(parser['cache'].size).toBeLessThanOrEqual(LOOKUP_WINDOW + 1);
    expect(new Set(parser['ignorerCache'].values()).size).toBe(1);
  });

  it('counts ancestor matcher checks on deep cache misses', () => {
    const depth = 25;
    const tail = Array.from({ length: depth }, (_, i) => `level-${i}`).join(
      '/',
    );

    expect(parser.isIgnored(`branch-0/${tail}/first.log`)).toBe(true);
    const chainKey = `\0${root}`;
    const firstMatcher = parser['chainIgnorers'].get(chainKey);
    expect(firstMatcher).toBeDefined();

    // A fresh deep branch is a cache miss. It evaluates every ancestor against
    // the currently applicable matcher, plus the final path. Counting only
    // top-level isIgnored() calls would leave the same matcher alive here.
    const checksPerLookup = depth + 2;
    const lookupsToCrossWindow = Math.ceil(LOOKUP_WINDOW / checksPerLookup) + 2;
    for (let i = 1; i <= lookupsToCrossWindow; i++) {
      expect(parser.isIgnored(`branch-${i}/${tail}/result.log`)).toBe(true);
    }

    expect(parser['chainIgnorers'].get(chainKey)).not.toBe(firstMatcher);
    expect(parser['matcherChecksSinceReset']).toBeLessThan(LOOKUP_WINDOW);
  });

  it('releases matcher result caches even when every directory lookup is a memo hit', () => {
    expect(parser.isIgnored('scratch/first.log')).toBe(true);
    const firstMatcher = parser['ignorerCache'].get(path.join(root, 'scratch'));
    expect(firstMatcher).toBeDefined();

    for (let i = 0; i < LOOKUP_WINDOW; i++) {
      expect(parser.isIgnored(`scratch/result-${i}.log`)).toBe(true);
    }

    expect(parser['ignorerCache'].get(path.join(root, 'scratch'))).not.toBe(
      firstMatcher,
    );
  });

  it('preserves nested rules, exclusions and ignored ancestors across resets', async () => {
    await write('.git/info/exclude', '*.bak\n');
    await write('.gitignore', '*.log\nvendor/\n/root-only.txt\n');
    await write('a/.gitignore', '!keep.log\ncache/\n/anchored.txt\n');
    await write('a/deep/.gitignore', '!kept.bak\n');
    await write('b/.gitignore', '*.txt\n');
    await write('vendor/.gitignore', '!keep.log\n');
    const cases: Array<[string, boolean]> = [
      ['plain.log', true],
      ['plain.txt', false],
      ['root-only.txt', true],
      ['a/root-only.txt', false],
      ['a/keep.log', false],
      ['a/deep/keep.log', false],
      ['b/keep.log', true],
      ['b/plain.txt', true],
      ['a/plain.txt', false],
      ['a/anchored.txt', true],
      ['a/deep/anchored.txt', false],
      ['a/deep/cache/entry.txt', true],
      ['a/deep/cache', false],
      ['a/cache/', true],
      ['a/deep/kept.bak', false],
      ['a/kept.bak', true],
      ['vendor/keep.log', true],
      ['.git/config', true],
    ];

    for (const [file, expected] of cases) {
      expect(parser.isIgnored(file)).toBe(expected);
    }
    const rootPatterns = parser['cache'].get(root);

    for (let i = 0; i < LOOKUP_WINDOW; i++) {
      expect(parser.isIgnored(`scratch/probe-${i}.txt`)).toBe(false);
    }

    // Keep the already-loaded rule snapshot; drop only derived/negative caches.
    expect(parser['cache'].get(root)).toBe(rootPatterns);
    for (const [file, expected] of [...cases].reverse()) {
      expect(parser.isIgnored(file)).toBe(expected);
    }
  });

  it('does not mutate a shared parent matcher when loading a child ignore file', async () => {
    await write('a/.gitignore', '!keep.log\n');
    await write('b/.gitignore', '!keep.log\n');

    expect(parser.isIgnored('other/keep.log')).toBe(true);
    expect(parser.isIgnored('a/keep.log')).toBe(false);
    expect(parser.isIgnored('b/keep.log')).toBe(false);
    expect(parser.isIgnored('other/keep.log')).toBe(true);
    expect(parser.isIgnored('a/lost.log')).toBe(true);
    expect(parser.isIgnored('b/lost.log')).toBe(true);
    expect(parser.isIgnored('keep.log')).toBe(true);
  });
});
