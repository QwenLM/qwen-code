/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git` and a real `git worktree`. The property under test — that the
// probe runs in its OWN disposable worktree and never mutates the shared one
// (#6832) — lives entirely in git's bookkeeping, so a mocked child_process
// would prove nothing. `vitest` itself is stubbed by a fake bin (below): the
// verdict logic is unit-tested in `classifyProbeRun`; what these lock down is
// where the probe runs and what it leaves behind.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testEfficacyCommand } from './test-efficacy.js';

type Handler = (args: {
  report: string;
  worktree: string;
  base: string;
  out: string;
}) => Promise<void>;
const runHandler = testEfficacyCommand.handler as unknown as Handler;

let repo: string;
let outside: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function commitAll(msg: string): string {
  git(repo, 'add', '-A');
  git(
    repo,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '-m',
    msg,
  );
  return git(repo, 'rev-parse', 'HEAD').trim();
}
function write(rel: string, body: string) {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}
/** The staged tree of a worktree — changes iff the working tree was mutated. */
function treeState(wt: string): string {
  return (
    git(wt, 'status', '--porcelain', '-z') + '|' + git(wt, 'rev-parse', 'HEAD')
  );
}

/**
 * A minimal same-repo PR: source `f` changes 1→2, with a reachable test that
 * passes regardless (so a revert probe reads it as inert). Returns the shared
 * worktree and base SHA, with the report already written to `report.json`.
 */
function scaffoldModifiedPr(): { wt: string; base: string } {
  write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
  write('packages/lib/src/f.ts', 'export const f = () => 1;\n');
  const base = commitAll('base');
  write('packages/lib/src/f.ts', 'export const f = () => 2;\n');
  write(
    'packages/lib/src/f.test.ts',
    'import { f } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof f).toBe("function"));\n',
  );
  commitAll('pr');
  const wt = join(repo, 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  writeFileSync(
    join(repo, 'report.json'),
    JSON.stringify({
      files: [
        { path: 'packages/lib/src/f.ts', kind: 'source' },
        { path: 'packages/lib/src/f.test.ts', kind: 'test' },
      ],
    }),
  );
  return { wt, base };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'efficacy-iso-'));
  outside = mkdtempSync(join(tmpdir(), 'efficacy-outside-'));
  git(repo, 'init', '-q', '-b', 'main', '.');

  // A fake `vitest` on the up-tree bin path so `npx vitest` in the probe tree
  // resolves locally — fast, deterministic, no network. It echoes each test
  // file it is handed back as PASSED, so a probe over reverted source reads as
  // `inert` without a real runner. `npx` walks node_modules upward, and the
  // probe tree is a direct child of `repo`, so this bin is what it finds.
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  const bin = join(repo, 'node_modules', '.bin', 'vitest');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const path = require('path');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  numPassedTests: files.length,
  numFailedTests: 0,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: 'passed' }],
  })),
}));
`,
  );
  chmodSync(bin, 0o755);
});

afterEach(() => {
  // The handler removes its own probe tree; force-remove any a failed test left.
  try {
    git(repo, 'worktree', 'remove', '--force', join(repo, 'wt-probe'));
  } catch {
    // not there — the normal case
  }
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('test-efficacy probe isolation (#6832)', () => {
  it('probes in a disposable worktree and never mutates the shared one', async () => {
    const { wt, base } = scaffoldModifiedPr();

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    // The shared worktree the other review agents read is byte-identical: no
    // in-place revert was ever visible in it.
    expect(treeState(wt)).toBe(before);
    expect(readFileSync(join(wt, 'packages/lib/src/f.ts'), 'utf8')).toBe(
      'export const f = () => 2;\n',
    );
    // The probe tree was created and discarded.
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
    // And the probe still produced its verdict from the isolated tree: the test
    // passed with the source reverted, so it is inert.
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.findings.map((f: { file: string }) => f.file)).toContain(
      'packages/lib/src/f.test.ts',
    );
    expect(out.cleanupFailure).toBeUndefined();
  });

  it('a PR-controlled symlink cannot delete outside the tree — by isolation, not the guard', async () => {
    writeFileSync(join(outside, 'victim'), 'must survive');

    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write('packages/lib/src/dir/victim', 'base\n');
    write('packages/lib/src/f.ts', 'export const f = () => 1;\n');
    write(
      'packages/lib/src/f.test.ts',
      'import { f } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof f).toBe("function"));\n',
    );
    const base = commitAll('base');

    // The P0 shape: `dir` becomes a symlink to an outside directory and
    // `dir/victim` is deleted.
    git(repo, 'rm', '-q', '-r', 'packages/lib/src/dir');
    symlinkSync(outside, join(repo, 'packages/lib/src/dir'));
    write('packages/lib/src/f.ts', 'export const f = () => 2;\n');
    commitAll('pr: dir -> outside symlink, delete dir/victim');

    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/dir', kind: 'source' },
          { path: 'packages/lib/src/dir/victim', kind: 'source' },
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    // The outside file is untouched.
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('must survive');
    // And it survived because the probe never restored/deleted in a tree holding
    // the symlink — not because `safeRmWithin` refused. If the guard had been the
    // thing that fired, it would have surfaced as an inconclusive probe.
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    const details = (out.probed as Array<{ detail: string }>).map(
      (p) => p.detail,
    );
    expect(details.join('\n')).not.toMatch(
      /refusing to delete through a symlink/,
    );
    // Shared tree untouched, probe tree discarded.
    expect(treeState(wt)).toBe(before);
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('sweeps a stale REGISTERED probe worktree left by a crashed run', async () => {
    const { wt, base } = scaffoldModifiedPr();
    // A prior probe crashed after `worktree add` but before its cleanup, leaving
    // the probe tree registered. The pre-sweep must unregister and replace it,
    // not fail `add` on the collision.
    git(
      repo,
      'worktree',
      'add',
      '-q',
      '--detach',
      join(repo, 'wt-probe'),
      'HEAD',
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(true);

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    // The probe ran (a real verdict, not a "could not be created" inconclusive)
    // and left the tree cleaned up.
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.findings.map((f: { file: string }) => f.file)).toContain(
      'packages/lib/src/f.test.ts',
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('clears an UNREGISTERED non-empty leftover so the probe is not wedged', async () => {
    const { wt, base } = scaffoldModifiedPr();
    // A partial cleanup left a directory at the probe path that git no longer
    // tracks as a worktree, and it is non-empty. `git worktree remove` cannot
    // clear it ("not a working tree"), and without the rmSync fallback the next
    // `git worktree add` fails "already exists" — wedging every probe as
    // inconclusive until someone clears it by hand.
    mkdirSync(join(repo, 'wt-probe', 'junk'), { recursive: true });
    writeFileSync(join(repo, 'wt-probe', 'junk', 'f'), 'x');

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    const details = (out.probed as Array<{ detail?: string }>).map(
      (p) => p.detail ?? '',
    );
    expect(details.join('\n')).not.toMatch(/could not be created/);
    expect(out.findings.map((f: { file: string }) => f.file)).toContain(
      'packages/lib/src/f.test.ts',
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });
});
