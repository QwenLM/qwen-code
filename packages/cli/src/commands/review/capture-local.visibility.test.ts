/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHostGitConfig } from './lib/test-utils.js';

const stderrLines: string[] = [];
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn((line: string) => {
    stderrLines.push(line);
  }),
  writeStderrLineSafe: vi.fn(),
}));

// The oracle is mocked PER SAMPLE — the real one answers what `ls-files -v`
// says at call time, and a bit set-then-cleared inside the capture window
// cannot be scripted against real git from outside the handler. Everything
// else in the module stays real.
const invisibleScript: Array<string[] | null> = [];
let invisibleCalls = 0;
vi.mock('./lib/local-anchor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/local-anchor.js')>();
  return {
    ...real,
    invisibleTrackedPaths: (repoRoot: string): string[] | null => {
      const scripted = invisibleScript[invisibleCalls];
      invisibleCalls += 1;
      return scripted !== undefined
        ? scripted
        : real.invisibleTrackedPaths(repoRoot);
    },
  };
});

import { captureLocalCommand } from './capture-local.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function capture(): Record<string, unknown> {
  const out = join(repo, 'plan.json');
  (captureLocalCommand.handler as (argv: unknown) => void)({
    out,
    target: 'local',
    untracked: true,
  });
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  stderrLines.length = 0;
  invisibleScript.length = 0;
  invisibleCalls = 0;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-loc-vis-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
  write('.gitignore', '.qwen/\nplan.json\n');
  write('src/a.ts', 'export const v = 0;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

describe('capture-local — visibility oracle rides the sampling discipline', () => {
  it('withholds stop and candidate when only an EARLY sample saw the bit', () => {
    // R15-1: sampled once, after the capture loop, the oracle read clean
    // when a bit set through every diff pass was cleared just before the
    // one query — the diffs were blind to the edit the bit hid, the hashes
    // held still, and the candidate certified bytes no pass ever showed.
    // The oracle now brackets the loop like the diffs and hashes do: a bit
    // visible at ANY sample point withholds. Scripted: sample 0 (before the
    // first capture) sees the bit; every later sample is clean — exactly
    // the shape the single post-loop query certified.
    invisibleScript.push(['src/a.ts'], [], [], []);

    const plan = capture();
    // Four samples, exactly — 0 before the first capture, 1-2 in the loop,
    // 3 after. The scripted mock consumes by CALL ORDER, so without this
    // pin a deleted sample 0 merely shifts the script and the dirty sample
    // still lands somewhere: the sandboxed verifier's mutation matrix
    // proved the guard unpinned (M6 survived) and this line red under it.
    expect(invisibleCalls).toBe(4);
    expect(plan['nothingToReview']).toBeUndefined();
    expect(
      existsSync(join(repo, '.qwen/tmp/qwen-review-local-stop.json')),
    ).toBe(false);
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
    expect(stderrLines.join('\n')).toContain(
      '--assume-unchanged/--skip-worktree',
    );
  });

  it('withholds when any single sample fails to enumerate', () => {
    // A failed enumeration is indistinguishable from a hidden bit — the
    // same fail-closed lean as one unhashable path, at every sample point.
    invisibleScript.push([], null, [], []);

    const plan = capture();
    expect(plan['nothingToReview']).toBeUndefined();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
  });

  it('control: all samples clean still decides the clean tree', () => {
    invisibleScript.push([], [], [], []);

    const plan = capture();
    expect(plan['nothingToReview']).toEqual({ reason: 'clean-tree' });
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
  });
});
