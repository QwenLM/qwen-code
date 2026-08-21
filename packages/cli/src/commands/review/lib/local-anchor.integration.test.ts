/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git check-attr`, over paths that only real git renders faithfully.
// The property under test is byte-fidelity of a NUL-delimited protocol, and a
// mocked wrapper cannot break it the way the real one did.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashWorktreeFiles } from './local-anchor.js';
import { isolateHostGitConfig } from './test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'anchor-attr-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'core.autocrlf', 'false');
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

describe('hashWorktreeFiles — the attributes probe is not buffer-bound', () => {
  it('answers for a path count whose check-attr output passes 1 MB', () => {
    // `check-attr --stdin -z` emits roughly three NUL records per path, so a
    // few thousand files pass `execFileSync`'s 1 MB default and the call
    // throws ENOBUFS. The blanket catch then answers an empty attribute map
    // and every identity becomes UNHASHABLE — which never equals itself, so
    // every path reads as changed on every round. Nothing surfaces: the
    // stateId stays stable, so the anchor still validates and no refusal ever
    // prints, while the whole target is silently re-reviewed for ever and the
    // unchanged-since stop is unreachable.
    const paths: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const rel = `f${i}-${'p'.repeat(60)}.ts`;
      writeFileSync(join(repo, rel), 'export const a = 1;\n');
      paths.push(rel);
    }

    const out = hashWorktreeFiles(repo, paths);

    expect(Object.keys(out)).toHaveLength(paths.length);
    // Attributes reached the identity — an ENOBUFS would have left every one
    // of these UNHASHABLE instead.
    expect(out[paths[0]]).toContain('diff=');
    expect(Object.values(out).some((v) => v === 'unhashable')).toBe(false);
  });
});

describe('hashWorktreeFiles — the attributes probe is byte-faithful', () => {
  it('keeps the record of a path that begins with whitespace', () => {
    // A leading space is legal in a path on Linux and macOS, and
    // `check-attr --stdin -z` echoes the path back as each record's key. Read
    // through a wrapper that trims, the first record's key loses that byte:
    // it no longer matches the path that was asked about, every record shifts
    // onto a phantom key, and the path gets a MALFORMED identity rather than
    // an honest UNHASHABLE.
    //
    // That fails OPEN in one direction. The stolen record is the `diff`
    // attribute, so a `diff=<driver>` path never folds its driver's `binary`
    // setting in — and the config-side binary↔text flip the identity exists
    // to track becomes invisible between rounds.
    const leading = ' leading.ts';
    writeFileSync(join(repo, leading), 'export const a = 1;\n');
    writeFileSync(join(repo, 'plain.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, '.gitattributes'), '" leading.ts" diff=custom\n');

    const out = hashWorktreeFiles(repo, [leading, 'plain.ts']);

    // The whitespace path is answered for, under its own name…
    expect(Object.keys(out)).toContain(leading);
    // …and its record is the one git gave for IT: the driver name survives,
    // which is what the config-side `binary` lookup keys on.
    expect(out[leading]).toContain('diff=custom');
    // The sibling is unaffected either way — it is the control that shows the
    // probe ran at all rather than falling back wholesale.
    expect(out['plain.ts']).toContain('diff=unspecified');
  });
});
