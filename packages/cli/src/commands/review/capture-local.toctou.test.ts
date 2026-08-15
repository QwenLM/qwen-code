/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The TOCTOU withhold branch, in isolation: when the re-capture after hashing
// returns different bytes, the candidate must NOT be written and the refusal
// must be said out loud — the one uncertainty in the anchor module that used
// to fail open. The capture layer is mocked with a stateful fake so the two
// captures can disagree deterministically; everything downstream is real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stderrLines: string[] = [];
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn((line: string) => {
    stderrLines.push(line);
  }),
  writeStderrLineSafe: vi.fn(),
}));

const captures: Array<{ diff: Buffer }> = [];
vi.mock('./lib/local-diff.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lib/local-diff.js')>();
  return {
    ...real,
    captureLocalDiff: vi.fn(() => {
      const next = captures.shift();
      if (!next) throw new Error('fixture exhausted');
      return {
        diff: next.diff,
        untracked: [],
        skipped: [],
        unbornHead: false,
        repoRoot: repo,
      };
    }),
  };
});

import { captureLocalCommand } from './capture-local.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

beforeEach(() => {
  stderrLines.length = 0;
  captures.length = 0;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-toctou-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

const DIFF_A = Buffer.from(
  'diff --git a/a.ts b/a.ts\nindex 000..111 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n',
  'utf8',
);

function run(): void {
  (captureLocalCommand.handler as (argv: unknown) => void)({
    out: join(repo, 'plan.json'),
    target: 'local',
    untracked: true,
  });
}

describe('capture-local — TOCTOU candidate withholding', () => {
  it('a tree that moved between capture and hash withholds the candidate, out loud', () => {
    captures.push(
      { diff: DIFF_A },
      { diff: Buffer.from('changed mid-hash\n') },
    );
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(false);
    expect(stderrLines.join('\n')).toContain(
      'working tree changed while the capture was being hashed',
    );
  });

  it('a tree that held still writes the candidate and no warning', () => {
    captures.push({ diff: DIFF_A }, { diff: Buffer.from(DIFF_A) });
    run();
    expect(
      existsSync(
        join(repo, '.qwen/tmp/qwen-review-local-cache-candidate.json'),
      ),
    ).toBe(true);
    expect(stderrLines.join('\n')).not.toContain('candidate is withheld');
  });
});
