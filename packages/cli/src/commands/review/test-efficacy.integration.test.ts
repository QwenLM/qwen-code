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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  appendFileSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runOneMutant,
  runOneHunkProbe,
  splitDiffIntoHunks,
  testEfficacyCommand,
} from './test-efficacy.js';
import {
  isolateHostGitConfig,
  isolateOperatorReviewSettings,
} from './lib/test-utils.js';

type Handler = (args: {
  report: string;
  worktree: string;
  base: string;
  out: string;
  now?: () => number;
}) => Promise<void>;
const runHandler = testEfficacyCommand.handler as unknown as Handler;

let repo: string;
let outside: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
let reviewSettingsIsolation: ReturnType<typeof isolateOperatorReviewSettings>;

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
function scaffoldModifiedPr(
  // The gate tests need the worktree UNDER `.qwen/tmp`, because that is the
  // only place `mountRootFor` answers and so the only place the gates speak.
  // A parameter rather than a fork: the fixture's shape — the report schema,
  // the workspace layout the handler requires, the fake runner's contract —
  // stays in one place when any of them moves.
  wtPath: string = join(repo, 'wt'),
): { wt: string; base: string } {
  write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
  write('packages/lib/src/f.ts', 'export const f = () => 1;\n');
  const base = commitAll('base');
  write('packages/lib/src/f.ts', 'export const f = () => 2;\n');
  write(
    'packages/lib/src/f.test.ts',
    'import { f } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof f).toBe("function"));\n',
  );
  commitAll('pr');
  mkdirSync(dirname(wtPath), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', wtPath, 'HEAD');
  writeFileSync(
    join(repo, 'report.json'),
    JSON.stringify({
      files: [
        { path: 'packages/lib/src/f.ts', kind: 'source' },
        { path: 'packages/lib/src/f.test.ts', kind: 'test' },
      ],
    }),
  );
  return { wt: wtPath, base };
}

function vitestScript(): string {
  return join(repo, 'node_modules', 'vitest', 'vitest.mjs');
}

/**
 * Swap the fake runner for one that reports every test file as FAILED. Used to
 * drive the unmutated baseline red, so the mutant phase must skip wholesale.
 */
function installFailingVitest(): void {
  writeFileSync(
    vitestScript(),
    `#!/usr/bin/env node
import path from 'node:path';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  numPassedTests: 0,
  numFailedTests: files.length,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: 'failed' }],
  })),
}));
`,
  );
}

/**
 * Swap the fake runner for one that reports a file whose path contains "skip"
 * as all-skipped (collected, but no assertion executed) and every other file as
 * PASSED. Drives the per-file baseline gate: an unrelated all-skip file is
 * `inconclusive`, not red, and must not disable the mutant phase.
 */
function installMixedVitest(): void {
  writeFileSync(
    vitestScript(),
    `#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const st = (f) => {
  try {
    if (fs.readFileSync(f, 'utf8').includes('QWEN-REVIEW-POSITIVE-CONTROL')) return 'failed';
  } catch {}
  return f.includes('skip') ? 'skipped' : 'passed';
};
process.stdout.write(JSON.stringify({
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: st(f) }],
  })),
}));
`,
  );
}

beforeEach(() => {
  // The operator's own `review.sandbox` reaches the phase gate here too — see
  // isolateOperatorReviewSettings; 19 of this file's tests report their
  // refusal instead of their measurement without it.
  reviewSettingsIsolation = isolateOperatorReviewSettings();
  repo = mkdtempSync(join(tmpdir(), 'efficacy-iso-'));
  outside = mkdtempSync(join(tmpdir(), 'efficacy-outside-'));
  // Isolate the fixtures from the user's git environment (shared helper —
  // see isolateHostGitConfig for the incident class: a global
  // `diff.external` kills every plain `git diff` in the helpers below,
  // exactly what a polluted persistent CI runner did). The code under test
  // spawns git with the ambient env, so process-level env reaches it too.
  gitIsolation = isolateHostGitConfig();
  git(repo, 'init', '-q', '-b', 'main', '.');
  git(repo, 'config', 'core.autocrlf', 'false');
  const hooksDir = join(repo, '.git-hooks-disabled');
  mkdirSync(hooksDir);
  git(repo, 'config', 'core.hooksPath', hooksDir);
  // Keep the fake vitest out of git: `commitAll` runs `git add -A`, and a
  // committed bin would be checked out into the probe worktree — the stale
  // passing copy, not the file `installFailingVitest` overwrites.
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');

  // Put a fake vitest entry in the repo parent so the probe is independent of
  // npm's platform-specific bin wrappers. It reports every test file as passed.
  const vitestDir = join(repo, 'node_modules', 'vitest');
  mkdirSync(vitestDir, { recursive: true });
  // A package.json with a `bin` entry so the probe resolves the fake through the
  // same `vitest/package.json` + `bin.vitest` path it uses for the real package,
  // not a hard-coded entry the finder and the fake merely agree on by
  // construction.
  writeFileSync(
    join(vitestDir, 'package.json'),
    JSON.stringify({
      name: 'vitest',
      version: '0.0.0',
      bin: { vitest: './vitest.mjs' },
    }),
  );
  const script = join(vitestDir, 'vitest.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'run' || args[1] !== '--reporter=json') {
  process.stderr.write('unexpected vitest argv: ' + JSON.stringify(args));
  process.exit(1);
}
const files = args.slice(2).filter((a) => a.includes('.test.'));
// Like the real runner, the injected positive control FAILS: a fake that
// stayed green under it would (correctly) be ruled a dead harness and every
// survivor scenario in this suite would re-class to inconclusive.
const st = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').includes('QWEN-REVIEW-POSITIVE-CONTROL')
      ? 'failed'
      : 'passed';
  } catch {
    return 'passed';
  }
};
const results = files.map((f) => ({
  name: path.resolve(f),
  assertionResults: [{ status: st(f) }],
}));
const failed = results.filter((r) => r.assertionResults[0].status === 'failed').length;
process.stdout.write(JSON.stringify({
  numPassedTests: results.length - failed,
  numFailedTests: failed,
  testResults: results,
}));
`,
  );
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
  gitIsolation.dispose();
  reviewSettingsIsolation?.dispose();
});

// Skipped on win32, and not for convenience: `mountRootFor` refuses every
// absolute Windows path (a drive letter is a colon, which the `-v` grammar
// cannot spell), so containment is unavailable there BY DESIGN and these gates
// never speak. The assertions would fail for that reason and nothing else —
// first inside the merge queue, where the Windows lane actually runs.
const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

describe('fixture git-config isolation', () => {
  it('spawned git reads the throwaway global config, not the host user config', () => {
    // Tripwire for every leg of the beforeEach isolation. Global leg: if
    // the GIT_CONFIG_GLOBAL / HOME redirect is ever removed, the sentinel
    // below becomes unreadable through a child git and this test goes red
    // — instead of the whole suite going red only on hosts whose real
    // config happens to be hostile (the incident mode: a leaked global
    // diff.external killed the per-hunk tests on a persistent CI runner).
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      '[qwen]\n\tisolation = sentinel\n',
    );
    expect(git(repo, 'config', '--global', 'qwen.isolation').trim()).toBe(
      'sentinel',
    );
    expect(process.env['GIT_CONFIG_GLOBAL']).toBe(
      join(gitIsolation.home, '.gitconfig'),
    );
    // System leg: the sentinel resolves through the global redirect, which
    // OUTRANKS system config — so the global check above stays green even
    // with the NOSYSTEM leg deleted (mutation-tested in review). Pin the
    // env, and prove behaviour: with NOSYSTEM set, a child git must not
    // read a system file even when one is pointed at it.
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    const sysCfg = join(gitIsolation.home, 'system-gitconfig');
    writeFileSync(sysCfg, '[qwen]\n\tsystemleak = yes\n');
    const sys = spawnSync('git', ['config', '--get', 'qwen.systemleak'], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_SYSTEM: sysCfg },
      encoding: 'utf8',
    });
    expect(sys.status).not.toBe(0);
  });
});

describe('the review worktree is the first pointer a probe run trusts', () => {
  itWhereContainmentExists(
    'refuses to create a probe tree through a rewritten gitfile',
    async () => {
      // `worktree add` is the first host-side git write of the probe phase that
      // CHECKS FILES OUT — `discardWorktree` above writes too, but materialises
      // nothing, so no filter runs there — and it resolves the repository
      // through the REVIEW worktree's own gitfile —
      // which lives inside the directory the sandbox mounts read-write, and
      // which the build/test phase already gave the PR's code a chance to
      // rewrite. It checks files out, so it runs whatever filter the pointer
      // leads to, on the host, before any gate inside the restore could fire.
      //
      // The fixture has to sit under `.qwen/tmp`: everywhere else `mountRootFor`
      // answers null and the gate short-circuits, which is how deleting it
      // shipped green.
      const { wt, base } = scaffoldModifiedPr(
        join(repo, '.qwen', 'tmp', 'review-pr-1'),
      );

      // The rewrite reviewed code can make from inside the mount — and a
      // COHERENT one, which is the point: the planted entry answers `rev-parse
      // HEAD` with the real sha, so every read before the write agrees and the
      // run reaches the checkout. An empty directory would fail earlier for a
      // reason that has nothing to do with the gate.
      const realEntry = readFileSync(join(wt, '.git'), 'utf8')
        .trim()
        .replace('gitdir: ', '');
      const planted = join(repo, '.qwen', 'tmp', '.evil-git');
      cpSync(realEntry, planted, { recursive: true });
      writeFileSync(join(planted, 'commondir'), `${join(repo, '.git')}\n`);
      writeFileSync(join(planted, 'gitdir'), `${join(wt, '.git')}\n`);
      writeFileSync(join(wt, '.git'), `gitdir: ${planted}\n`);
      // Coherence check, so a fixture that breaks silently fails HERE and not as
      // a green assertion below.
      expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(
        git(repo, 'rev-parse', 'HEAD').trim(),
      );

      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });

      const out = JSON.parse(
        readFileSync(join(repo, 'out.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(JSON.stringify(out)).toContain('review temp dir');
      // ORDER, which the message alone cannot show: the same detail is
      // serialized whether the gate throws before the spawn or after it, so a
      // refactor that moves `worktree add` above the gate — the very thing the
      // comment beside it warns against — would check files out through the
      // planted pointer, execute its filters on the host, and still produce
      // this string. The tree not existing is what says the spawn never ran.
      expect(existsSync(`${wt}-probe`)).toBe(false);
    },
  );
});

describe('the revert phase is reached after the gates refuse', () => {
  itWhereContainmentExists(
    'refuses to revert through a gitfile the probe run rewrote',
    async () => {
      // The route R1-13 names: a restore refusal becomes `inconclusive` without
      // throwing, and the mutation phase's catch continues on purpose so the
      // revert probe still runs — so the revert is reached PRECISELY WHEN the
      // earlier gates fired. Guarding the first two writes and not this one
      // leaves the route open exactly where the others closed it.
      //
      // The rewrite is done by the PR's own suite, which is who does it in
      // production: the fake runner below runs with the probe tree as its cwd.
      const { wt, base } = scaffoldModifiedPr(
        join(repo, '.qwen', 'tmp', 'review-pr-1'),
      );

      // A runner that rewrites its own tree's `.git` the first time it is
      // asked to run anything, then answers normally.
      // A COHERENT planted repository carrying a real smudge filter, so the
      // oracle can be the thing itself — a canary the host writes only if a
      // checkout ran through this pointer — rather than the refusal message,
      // which reads the same whichever side of the write the gate fires on.
      const planted = join(repo, '.qwen', 'tmp', '.evil-git');
      const fakeCommon = join(repo, '.qwen', 'tmp', '.evil-common');
      const canary = join(repo, 'PWNED');
      cpSync(join(repo, '.git'), fakeCommon, { recursive: true });
      rmSync(join(fakeCommon, 'worktrees'), { recursive: true, force: true });
      appendFileSync(
        join(fakeCommon, 'config'),
        `\n[filter "evil"]\n\tsmudge = sh -c "echo PWNED > ${canary}; cat"\n`,
      );
      mkdirSync(join(fakeCommon, 'info'), { recursive: true });
      writeFileSync(join(fakeCommon, 'info', 'attributes'), '* filter=evil\n');
      cpSync(
        readFileSync(join(wt, '.git'), 'utf8').trim().replace('gitdir: ', ''),
        planted,
        { recursive: true },
      );
      writeFileSync(join(planted, 'commondir'), `${fakeCommon}\n`);
      writeFileSync(join(planted, 'gitdir'), `${join(wt, '.git')}\n`);
      writeFileSync(
        vitestScript(),
        `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
try {
  const dotGit = path.join(process.cwd(), '.git');
  if (fs.existsSync(dotGit) && fs.lstatSync(dotGit).isFile()) {
    fs.writeFileSync(dotGit, ${JSON.stringify(`gitdir: ${planted}\n`)});
  }
} catch {}
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

      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });

      const out = readFileSync(join(repo, 'out.json'), 'utf8');
      // The refusal names why...
      expect(out).toContain('review temp dir');
      // ...and nothing checked out through the planted pointer. This is the
      // property; the message above is only its explanation, and it reads the
      // same whether the gate fires before the write or after it.
      expect(existsSync(canary)).toBe(false);
    },
  );
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

  it('probes hunks end-to-end on a diff with NO mutant candidates', async () => {
    // The gating bug this pins: hunk probes once lived inside the mutant
    // branch, so they ran only on a diff that already had a safety-verb
    // candidate — exactly inverting their purpose. This diff changes a return
    // value and a condition. `SAFETY_VERB_RE` matches neither, so there are
    // zero mutants, and before the fix there were zero hunk probes too: the
    // one class of diff per-hunk probing exists for got nothing at all.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    // No safety verb, no `??`, no `+ CONST`, and the condition edit carries no
    // comparison — zero candidates for EVERY operator, which is the premise.
    write(
      'packages/lib/src/f.ts',
      'export function price(n: number) {\n' +
        '  if (valid(n)) return 0;\n' +
        '  return n * 2;\n' +
        '}\n' +
        '\n'.repeat(12) +
        'export function label() {\n' +
        '  return "old";\n' +
        '}\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export function price(n: number) {\n' +
        '  if (!valid(n)) return 0;\n' +
        '  return n * 3;\n' +
        '}\n' +
        '\n'.repeat(12) +
        'export function label() {\n' +
        '  return "new";\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { price } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof price).toBe("function"));\n',
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

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([]);
    // Two well-separated changes, so two hunks — and the fake vitest is green
    // whatever the tree holds, so both changes ship with nothing gating them.
    expect(out.hunks.probed).toHaveLength(2);
    expect(out.hunks.survived).toBe(2);
    expect(
      out.findings.filter((f: { kind: string }) => f.kind === 'hunk-survived'),
    ).toHaveLength(2);
    // The mutation happened only in the disposable tree.
    expect(treeState(wt)).toEqual(before);
  });

  it('scores a hunk inconclusive when its OWN collocated test dropped out of the baseline', async () => {
    // The false survivor this exists to remove. The probe tree resolves
    // `node_modules` by walking up to the repo root, so a probe file that
    // transitively imports a workspace-NESTED dependency collects nothing in the
    // probe tree and is dropped from the green baseline set. Before the fix the
    // hunk probe then ran the OTHER (green) probes, they passed, and the hunk
    // was scored `survived` — a false finding, since the one test that covers
    // the hunk never ran. Here `price.test.ts` (collocated with the changed
    // `price.ts`) collects nothing while an unrelated `other.test.ts` is green.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/price.ts',
      'export function price(n: number) {\n  return n * 2;\n}\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/price.ts',
      'export function price(n: number) {\n  return n * 3;\n}\n',
    );
    write(
      'packages/lib/src/price.test.ts',
      'import { price } from "./price.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof price).toBe("function"));\n',
    );
    write(
      'packages/lib/src/other.test.ts',
      'import { it, expect } from "vitest"; it("t", () => expect(1).toBe(1));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/price.ts', kind: 'source' },
          { path: 'packages/lib/src/price.test.ts', kind: 'test' },
          { path: 'packages/lib/src/other.test.ts', kind: 'test' },
        ],
      }),
    );
    // The baseline drops the collocated test: `price.test.ts` collects nothing
    // (the probe-tree import-error shape); every other file passes.
    // Override the fake PACKAGE entry — post-#8050 the probe resolves the
    // runner through vitest/package.json's bin, so a node_modules/.bin file
    // is dead weight it never reads. price.test.ts collects nothing; every
    // other file passes.
    writeFileSync(
      join(repo, 'node_modules', 'vitest', 'vitest.mjs'),
      `#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const st = (f) => {
  try {
    if (fs.readFileSync(f, 'utf8').includes('QWEN-REVIEW-POSITIVE-CONTROL')) return [{ status: 'failed' }];
  } catch {}
  return path.basename(f) === 'price.test.ts' ? [] : [{ status: 'passed' }];
};
process.stdout.write(JSON.stringify({
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: st(f),
  })),
}));
`,
    );

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    // The hunk in price.ts is NOT scored survived: its collocated test never ran
    // green, so the green run of the other probe proves nothing about it.
    expect(out.hunks.survived).toBe(0);
    expect(out.hunks.inconclusive).toBe(1);
    expect(out.hunks.probed[0].verdict).toBe('inconclusive');
    expect(out.hunks.probed[0].detail).toContain('collocated test');
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'hunk-survived',
      ),
    ).toBe(false);
  });

  it('runs a REPLACEMENT mutant end-to-end and reports the survivor', async () => {
    // The three new operators take the `lines[line-1] = mutated` branch of
    // runOneMutant, and nothing exercised write-file -> run-probe -> classify
    // for it: the unit tests stop at candidate selection, and the other
    // integration fixture was deliberately made operator-free.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export function pick(a?: string) {\n  return a;\n}\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export function pick(a?: string) {\n' +
        '  return a ?? fallback.value;\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { pick } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof pick).toBe("function"));\n',
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

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    const coalesce = out.mutants.probed.find(
      (m: { operator?: string }) => m.operator === 'coalesce',
    );
    expect(coalesce).toBeDefined();
    expect(coalesce.mutated).toBe('  return a;');
    expect(coalesce.verdict).toBe('survived');
    // The wording must match the operator: a replacement CHANGES the line.
    expect(coalesce.detail).toContain('when it changes');
    expect(
      out.findings.some((f: { message: string }) =>
        f.message.includes('?? fallback'),
      ),
    ).toBe(true);
    // The mutation happened only in the disposable tree.
    expect(treeState(wt)).toEqual(before);
  });

  it('runs a deletion mutant end-to-end and reports the survivor', async () => {
    // The dogfood shape at full scale: the PR adds a reset function whose one
    // safety statement (`state.clear()`) nothing gates. The fake vitest is
    // green no matter what, so the baseline run passes, the mutant run passes
    // — a SURVIVOR — and the revert probe still reads the test as inert. Both
    // trees end clean: the mutation happened only in the disposable worktree.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function use(k: string) {\n' +
        '  return state.get(k);\n' +
        '}\n',
    );
    const base = commitAll('base');
    const prSource =
      'export const state = new Map<string, string>();\n' +
      'export function use(k: string) {\n' +
      '  return state.get(k);\n' +
      '}\n' +
      'export function reset() {\n' +
      '  state.clear();\n' +
      '}\n';
    write('packages/lib/src/f.ts', prSource);
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/f.ts',
        line: 6,
        statement: 'state.clear();',
        verdict: 'survived',
        detail: expect.stringContaining('still PASSED'),
      },
    ]);
    expect(out.mutants.survived).toBe(1);
    expect(out.mutants.skippedForBudget).toBe(0);
    // The survivor is a finding the orchestrator files; the register matches
    // the unreachable/inert messages Agent 7's brief already knows how to read.
    const survivor = (
      out.findings as Array<{ kind: string; file: string; message: string }>
    ).find((f) => f.kind === 'mutant-survived');
    expect(survivor?.file).toBe('packages/lib/src/f.ts');
    expect(survivor?.message).toContain('state.clear();');
    // The mutation never touched the shared tree, and the probe tree is gone.
    expect(treeState(wt)).toBe(before);
    expect(readFileSync(join(wt, 'packages/lib/src/f.ts'), 'utf8')).toBe(
      prSource,
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('kills a mutant the suite catches — the A/B control for the survivor test', async () => {
    // Same source, same statement, same line as the survivor test above. The
    // ONLY variable is the fake runner: here it reads the source and fails when
    // `state.clear()` is gone — a genuinely gating test. The mutant must be
    // KILLED (no finding), proving the verdict tracks the test, not the harness.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function use(k: string) {\n' +
        '  return state.get(k);\n' +
        '}\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function use(k: string) {\n' +
        '  return state.get(k);\n' +
        '}\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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
    // The fake runner reads the source: green when `state.clear()` is present,
    // red when it is gone. The baseline passes; the mutant (statement deleted)
    // fails — KILLED.
    writeFileSync(
      vitestScript(),
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const src = fs.readFileSync(path.join(process.cwd(), 'packages/lib/src/f.ts'), 'utf8');
const ctl = files.some((f) => { try { return fs.readFileSync(f, 'utf8').includes('QWEN-REVIEW-POSITIVE-CONTROL'); } catch { return false; } });
const failed = ctl ? 1 : src.includes('state.clear()') ? 0 : 1;
process.stdout.write(JSON.stringify({
  numPassedTests: failed ? 0 : files.length,
  numFailedTests: failed ? files.length : 0,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: failed ? 'failed' : 'passed' }],
  })),
}));
`,
    );

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/f.ts',
        line: 6,
        statement: 'state.clear();',
        verdict: 'killed',
        detail: expect.stringContaining('suite went red'),
      },
    ]);
    expect(out.mutants.killed).toBe(1);
    expect(out.mutants.survived).toBe(0);
    // A killed mutant is the GOOD outcome — no finding.
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'mutant-survived',
      ),
    ).toBe(false);
    expect(treeState(wt)).toBe(before);
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('skips the mutants wholesale when the unmutated baseline is not green', async () => {
    // A mutant is only evidence against a suite that is green WITHOUT it: against
    // a baseline that already fails, every mutant would be "killed" by failures
    // it did not cause. So when no probe file is green in the unmutated run, the whole
    // mutant phase is skipped and the report says so — no probed mutants and no
    // survivor finding, even though the diff adds an ungated safety statement.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    // The test FAILS, so the suite is not cleanly green under a real runner
    // too — not only under the fake one installed below. Whichever runner the
    // probe resolves to, the baseline is red and the mutants must be skipped.
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => { reset(); expect(1).toBe(2); });\n',
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
    // The unmutated suite is NOT green: the fake runner reports a failure.
    installFailingVitest();

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([]);
    expect(out.mutants.skippedForBaseline).toBe(1);
    expect(out.mutants.note).toContain('no probe file was green');
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'mutant-survived',
      ),
    ).toBe(false);
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain(
      '1 mutant(s) skipped: no probe file was green in the unmutated baseline',
    );
    expect(stdout).toContain('mutants not run: no probe file was green');
  });

  it('still probes when an UNRELATED probe file is all-skipped (per-file gate)', async () => {
    // Finding 2's shape: a quarantined suite that is entirely `it.skip`
    // classifies `inconclusive` — not red, not a failure. The old whole-suite
    // gate read that as "not cleanly green" and took the ENTIRE mutant phase
    // down with it, losing the survivor finding below. The gate is per file:
    // the mutant runs against the probe files that ARE green in the baseline,
    // so an unrelated all-skip file no longer disables it.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    // An unrelated suite that collects but runs nothing (all skipped).
    write(
      'packages/lib/src/skipped.test.ts',
      'import { it } from "vitest"; it.skip("quarantined", () => {});\n',
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
          { path: 'packages/lib/src/skipped.test.ts', kind: 'test' },
        ],
      }),
    );
    // Baseline: f.test.ts passes (inert), skipped.test.ts collects but runs
    // nothing (inconclusive). The mutant must still run against the green file.
    installMixedVitest();

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.note).toBeUndefined();
    expect(out.mutants.survived).toBe(1);
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/f.ts',
        line: 3,
        statement: 'state.clear();',
        verdict: 'survived',
        detail: expect.stringContaining('still PASSED'),
      },
    ]);
  });

  it('re-classes every survivor and spends nothing when the positive control fails', async () => {
    // The control's WHOLE point, and the half no other case reaches. This is
    // the same tree as the survivor test above — one uncovered `state.clear()`
    // and an inert probe file — run against a DEAD runner: one that reports
    // `passed` for every file it is handed, including the injected
    // always-failing control. Against that runner the survivor above is not a
    // coverage gap, it is the runner not executing assertions, and reporting
    // it would be the false gap-report this command exists to prevent.
    // Two separated change blocks, so the diff carries a mutant candidate AND
    // a hunk candidate: the filler keeps them more than two context windows
    // apart, and `selectHunkProbes` drops the hunk that already contains a
    // mutant line. Without the second block every hunk counter reads zero and
    // the hunk half of the re-class is asserted against nothing.
    const filler = Array.from(
      { length: 8 },
      (_, i) => `const a${i} = ${i};\n`,
    ).join('');
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        filler +
        'export const KEEP = a0 + a7;\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n' +
        filler +
        'export const KEEP = a0 + a7;\n' +
        'export function extra() {\n' +
        '  return a1 + a2;\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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
    // A runner that reports green unconditionally — it never reads the file,
    // so the injected control is green too. Three real defects share this
    // shape (a runner that executes nothing, a collector that skips the
    // injected test, a reporter that drops failures) and none can kill.
    writeFileSync(
      vitestScript(),
      `#!/usr/bin/env node
import path from 'node:path';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const results = files.map((f) => ({
  name: path.resolve(f),
  assertionResults: [{ status: 'passed' }],
}));
process.stdout.write(JSON.stringify({
  numPassedTests: results.length,
  numFailedTests: 0,
  testResults: results,
}));
`,
    );

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.harnessValidated).toBe(false);
    // Nothing was spent after the control came back green: a mutant run
    // against a runner that cannot kill only manufactures survivors.
    expect(out.mutants.probed).toEqual([]);
    expect(out.hunks.probed).toEqual([]);
    // …and the candidates it declined are counted under their OWN reason.
    // Folding them into `skippedForBudget` would blame a window that never
    // ran out; a bare zero would read as "there was nothing to probe".
    expect(out.mutants.skippedForControl).toBe(1);
    expect(out.mutants.skippedForBudget).toBe(0);
    expect(out.hunks.skippedForControl).toBeGreaterThan(0);
    expect(out.mutants.note).toContain('positive control FAILED');
    // The file-level revert probe's `inert` is the same survivor claim one
    // level up — a dead runner reports every reverted file green too — so it
    // is re-classed with the rest.
    expect(out.probed.map((p: { verdict: string }) => p.verdict)).toEqual([
      'inconclusive',
    ]);
    expect(out.probed[0].detail).toContain('positive control failed');
    // The re-class happens UPSTREAM of findings: nothing a reader acts on may
    // carry a survivor claim this run cannot support.
    expect(out.findings).toEqual([]);
  });

  it('holds a mutant at inconclusive when its OWN test was red in the baseline', async () => {
    // Measured live on PR #8213: six hunks in `bridge.ts` were correctly held
    // at `inconclusive` because `bridge.test.ts` never ran green, while eight
    // mutants in the SAME file were scored `survived` and shipped as findings.
    // A mutant runs against `greenProbes` only, so the red collocated test is
    // excluded from the run, and "every affected test still passed" is then
    // computed over a set that omits the one test most likely to catch the
    // deletion. Two files here: `f.ts` whose own test is red, and `g.ts`
    // whose own test is green — the second is what shows the guard is
    // targeted rather than a blanket refusal.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write('packages/lib/src/f.ts', 'export const a = new Map();\n');
    write('packages/lib/src/g.ts', 'export const b = new Map();\n');
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const a = new Map();\nexport function fReset() {\n  a.clear();\n}\n',
    );
    write(
      'packages/lib/src/g.ts',
      'export const b = new Map();\nexport function gReset() {\n  b.clear();\n}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { fReset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof fReset).toBe("function"));\n',
    );
    write(
      'packages/lib/src/g.test.ts',
      'import { gReset } from "./g.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof gReset).toBe("function"));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/g.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
          { path: 'packages/lib/src/g.test.ts', kind: 'test' },
        ],
      }),
    );
    // `f.test.ts` is red from the start — the baseline shape this is about.
    // Everything else is green, and the injected control still turns the run
    // red, so the harness is validated and survivors would be licensed.
    writeFileSync(
      vitestScript(),
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const st = (f) => {
  try {
    if (fs.readFileSync(f, 'utf8').includes('QWEN-REVIEW-POSITIVE-CONTROL')) return 'failed';
  } catch {}
  return path.basename(f) === 'f.test.ts' ? 'failed' : 'passed';
};
const results = files.map((f) => ({
  name: path.resolve(f),
  assertionResults: [{ status: st(f) }],
}));
const nf = results.filter((r) => r.assertionResults[0].status === 'failed').length;
process.stdout.write(JSON.stringify({
  numPassedTests: results.length - nf,
  numFailedTests: nf,
  testResults: results,
}));
`,
    );
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.harnessValidated).toBe(true);
    const forF = out.mutants.probed.filter((m: { file: string }) =>
      m.file.endsWith('f.ts'),
    );
    expect(forF.length).toBeGreaterThan(0);
    for (const m of forF) {
      expect(m.verdict).toBe('inconclusive');
      expect(m.detail).toContain('f.test.ts');
      expect(m.detail).toContain('did not run green');
      // The clause that actually regressed. The old flat wording satisfied
      // both assertions above, so only this one pins the chain the bug
      // shipped on: baseline classification -> reason tag -> sentence.
      // `f.test.ts` fails an assertion here, so `gated` is the measured state.
      expect(m.detail).toContain('was RED there');
      expect(m.detail).not.toContain('compile or import error');
    }
    // ...and nothing a reader acts on carries a survivor claim for that file.
    expect(
      (out.findings as Array<{ kind: string; file: string }>).filter(
        (f) => f.kind === 'mutant-survived' && f.file.endsWith('f.ts'),
      ),
    ).toEqual([]);
    // The guard is targeted: `g.ts`, whose own test IS green, still gets a
    // real verdict rather than being swept up with it.
    const forG = out.mutants.probed.filter((m: { file: string }) =>
      m.file.endsWith('g.ts'),
    );
    expect(forG.length).toBeGreaterThan(0);
    expect(
      forG.every((m: { verdict: string }) => m.verdict !== 'inconclusive'),
    ).toBe(true);
  });

  // A symlink is the mechanism, and Windows needs a privilege to create one.
  it.skipIf(process.platform === 'win32')(
    'a control that could not be SET UP leaves the window spendable',
    async () => {
      // `null` is not `false`, and this is where the difference is observable.
      // A control that never ran demonstrated nothing about the runner, so the
      // mutants must still spend their window — reporting `false` here would
      // discard the whole phase over an I/O error and stamp every survivor with
      // "an injected always-failing test stayed green" about a run that never
      // happened.
      write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
      write(
        'packages/lib/src/f.ts',
        'export const state = new Map<string, string>();\n',
      );
      const base = commitAll('base');
      write(
        'packages/lib/src/f.ts',
        'export const state = new Map<string, string>();\n' +
          'export function reset() {\n' +
          '  state.clear();\n' +
          '}\n',
      );
      write(
        'packages/lib/src/f.test.ts',
        'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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
      // Green, then it relinks the probe file it just reported on out of the
      // tree — one of the ways the control finds nothing it may set up. It used
      // to DELETE the file, and a delete stopped standing for anything: every
      // run now begins by putting the tree back to its commit, so a deleted
      // probe file comes straight back and the control runs. What this test is
      // about is downstream of WHICH way the control failed — that the mutant
      // window is still spent — and the read-failure path itself is pinned
      // directly in the unit suite. The runner stays honest, so nothing here is
      // a claim about whether it can kill.
      writeFileSync(
        vitestScript(),
        `#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const results = files.map((f) => ({
  name: path.resolve(f),
  assertionResults: [{ status: 'passed' }],
}));
process.stdout.write(JSON.stringify({
  numPassedTests: results.length,
  numFailedTests: 0,
  testResults: results,
}));
for (const f of files) {
  try { fs.unlinkSync(f); fs.symlinkSync(os.tmpdir(), f); } catch {}
}
`,
      );

      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });

      const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
      expect(out.harnessValidated).toBeNull();
      expect(out.mutants.note).toContain('could not be set up');
      expect(out.mutants.note).toContain('NOT validated');
      // The window was NOT discarded — this is the whole difference from `false`.
      expect(out.mutants.probed.length).toBeGreaterThan(0);
      expect(out.mutants.skippedForControl).toBe(0);
      // And the revert phase does not score the relinked probe. It was
      // screened from the index once, before the baseline; the runner replaced
      // it during that run, and collecting it here would score the verdict
      // against whatever the link names. With every probe gone the phase has
      // nothing left it can run — and `vitest run` with an empty file list
      // collects the WHOLE suite, so "nothing to score" must not become "score
      // everything".
      expect(out.probed).toEqual([
        expect.objectContaining({
          file: 'packages/lib/src/f.test.ts',
          verdict: 'inconclusive',
        }),
      ]);
      expect(out.probed[0].detail).toContain('nothing left it could score');
    },
  );

  it('reports mutants skipped for budget when time runs out mid-loop', async () => {
    // Three safety-verb candidates, but the budget expires after one: the
    // counter, the `skippedForBudget` report field, and the stdout line are
    // exercised end-to-end. The injected clock reads a simulated DURATION off
    // the fake runner's suite-run count, not a count of `Date.now()` calls, so
    // the implementation is free to consult the clock as often as it likes.
    // The arithmetic lives at the `now:` argument below and only there — this
    // comment carried a second copy of it, and when the per-run figure changed
    // the copy did not, leaving two disagreeing budgets inside one test.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export let items: string[] = ["a"];\n' +
        'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export let items: string[] = ["a"];\n' +
        'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n' +
        'export function reset() {\n' +
        '  items = [];\n' +
        '  state.clear();\n' +
        '  cache.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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

    // The fake runner appends one line per invocation; the injected clock
    // reads the log, so it moves only when a suite actually runs.
    const runsLog = join(repo, 'runs.log');
    writeFileSync(
      vitestScript(),
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(${JSON.stringify(runsLog)}, 'run\\n');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const status = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').includes('QWEN-REVIEW-POSITIVE-CONTROL') ? 'failed' : 'passed';
  } catch { return 'passed'; }
};
const results = files.map((f) => ({
  name: path.resolve(f),
  assertionResults: [{ status: status(f) }],
}));
const failed = results.filter((r) => r.assertionResults[0].status === 'failed').length;
process.stdout.write(JSON.stringify({
  numPassedTests: results.length - failed,
  numFailedTests: failed,
  testResults: results,
}));
`,
    );
    const suiteRuns = () =>
      existsSync(runsLog)
        ? readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).length
        : 0;
    // The skip must also be DISCLOSED on stdout — a capped run that stays
    // silent lets `survived: 0` read as "every safety statement is covered".
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
        // 60 s per suite run: baseline + POSITIVE CONTROL = 120 s, estimated
        // run 75 s, one mutant fits (→180 s), the remaining 60 s does not.
        now: () => suiteRuns() * 60_000,
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.harnessValidated).toBe(true); // the control spent its run and passed
    expect(out.mutants.probed.length).toBe(1);
    expect(out.mutants.skippedForBudget).toBe(2);
    expect(out.mutants.skippedForBaseline).toBe(0);
    expect(out.mutants.probed.length + out.mutants.skippedForBudget).toBe(3);
    for (const m of out.mutants.probed) {
      expect(m.verdict).toBe('survived');
    }
    expect(stdoutChunks.join('')).toContain(
      '2 mutant(s) skipped: the remaining budget cannot fit another suite run',
    );
  });

  it('reports mutants skipped for cap when candidates exceed MAX_MUTANTS', async () => {
    // Nine safety-verb candidates but MAX_MUTANTS is 8: the counter, the
    // `skippedForCap` report field, and the stdout line are exercised
    // end-to-end, mirroring the budget-skip test above.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    const stmts = Array.from({ length: 9 }, (_, i) => `  state${i}.clear();`);
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        stmts.join('\n') +
        '\n}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { it, expect } from "vitest"; it("t", () => expect(1).toBe(1));\n',
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

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed.length).toBe(8);
    expect(out.mutants.skippedForCap).toBe(1);
    expect(out.mutants.skippedForBaseline).toBe(0);
    expect(out.mutants.probed.length + out.mutants.skippedForCap).toBe(9);
    // Names BOTH caps: this count carries sub-cap drops too, and a message
    // naming only the total sends the reader after candidates that never were.
    expect(stdoutChunks.join('')).toContain(
      '1 mutant(s) skipped: more candidates than the selection caps (8 total, 3 of them replacements)',
    );
  });

  it('marks every candidate inconclusive when the runner dies mid-mutation, and still runs the revert probe', async () => {
    // The mutation-phase catch: a runner killed (or failing to spawn) during a
    // mutant run is not evidence about any statement. Every candidate that
    // never got a verdict — the one being run AND the ones never attempted —
    // must come back `inconclusive` with the reason, the revert probe must
    // still run, and the report must still be written. The fake runner passes
    // the baseline (run 1), floods stdout past spawnSync's 64 MiB maxBuffer on
    // run 2 (the first mutant) so the runner spawn itself errors (ENOBUFS),
    // and passes the revert probe (run 3).
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '  cache.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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
    const callsFile = join(repo, 'calls.txt');
    writeFileSync(
      vitestScript(),
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
let n = 0;
try { n = parseInt(fs.readFileSync(${JSON.stringify(callsFile)}, 'utf8'), 10) || 0; } catch {}
n += 1;
fs.writeFileSync(${JSON.stringify(callsFile)}, String(n));
if (n === 2) {
  const big = Buffer.alloc(8 * 1024 * 1024, 97);
  try { for (let i = 0; i < 10; i++) fs.writeSync(1, big); } catch {}
  process.exit(0);
}
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

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toHaveLength(2);
    for (const m of out.mutants.probed as Array<{
      verdict: string;
      detail: string;
    }>) {
      expect(m.verdict).toBe('inconclusive');
      expect(m.detail).toContain('mutation probe could not run');
    }
    expect(out.mutants.probed[0].detail).toContain('ENOBUFS');
    expect(out.mutants.inconclusive).toBe(2);
    expect(out.mutants.killed).toBe(0);
    expect(out.mutants.survived).toBe(0);
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'mutant-survived',
      ),
    ).toBe(false);
    // The revert probe still ran: a real verdict from run 3, not a propagated
    // mutation failure.
    expect(out.probed).toEqual([
      expect.objectContaining({
        file: 'packages/lib/src/f.test.ts',
        verdict: 'inert',
      }),
    ]);
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('still finds the survivor under hostile user git diff config', async () => {
    // A developer's diff.srcPrefix/dstPrefix reshapes the `+++ b/…` headers
    // parseAddedLines anchors on, diff.external replaces the unified diff with
    // an external command's output (here one that dies outright), and
    // core.quotePath octal-escapes every non-ASCII path — each one alone
    // would turn selection into a silent zero or a selection failure. The
    // invocation pins its own prefixes and disables ext-diff/textconv/quoting,
    // so the survivor must still be found, in a non-ASCII path too.
    git(repo, 'config', 'diff.srcPrefix', 'left/');
    git(repo, 'config', 'diff.dstPrefix', 'right/');
    git(repo, 'config', 'diff.external', 'false');
    git(repo, 'config', 'core.quotePath', 'true');
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/fø.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/fø.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { it, expect } from "vitest"; it("t", () => expect(1).toBe(1));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/fø.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.note).toBeUndefined();
    expect(out.mutants.survived).toBe(1);
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/fø.ts',
        line: 3,
        statement: 'state.clear();',
        verdict: 'survived',
        detail: expect.stringContaining('still PASSED'),
      },
    ]);
  });

  it('discloses the dropped candidates when a file derails the literal scan', async () => {
    // A regex literal holding a backtick flips the whole-file scan into
    // template state through to EOF, so every candidate in the file — here a
    // genuinely ungated `state.clear()` — is dropped as untrustworthy. That
    // zero must be DISCLOSED in `mutants.note`, never silent: a report that
    // says `survived: 0` without it reads as "every safety statement is
    // covered". The revert probe does not depend on selection and still runs.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export const TICK_RE = /`/;\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
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

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([]);
    expect(out.mutants.note).toContain('literal scan derailed');
    expect(out.mutants.note).toContain('packages/lib/src/f.ts');
    expect(stdoutChunks.join('')).toContain('literal scan derailed');
    // The revert probe still produced a real verdict.
    expect(out.probed).toEqual([
      expect.objectContaining({
        file: 'packages/lib/src/f.test.ts',
        verdict: 'inert',
      }),
    ]);
  });

  it('discloses a selection failure and still runs the revert probe', async () => {
    // Mutant selection captures the diff with `git diff <base>`, and a base
    // this repository cannot resolve (a shallow clone's truncated history has
    // exactly this shape) makes that capture throw. The catch is load-bearing:
    // without it the whole command crashes and the revert probe — which does
    // not depend on selection — is lost with it. The failure must be disclosed
    // as the mutants note, never as a crash and never as silent zero mutants.
    const { wt } = scaffoldModifiedPr();

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base: 'no-such-base-rev',
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.note).toContain('mutant selection failed');
    expect(out.mutants.probed).toEqual([]);
    // The revert probe still produced a real verdict from the fake runner.
    expect(out.probed).toEqual([
      expect.objectContaining({
        file: 'packages/lib/src/f.test.ts',
        verdict: 'inert',
      }),
    ]);
  });

  it('never deletes a line that does not hold the selected statement', () => {
    // `runOneMutant`'s mismatch guard, pinned directly: selection and the
    // probe tree both derive from the same commit, so the command cannot reach
    // this branch — but if the guard were dropped, a stale line number would
    // delete the WRONG statement and attribute the run's verdict (here the
    // fake runner's green — `survived`) to a statement that was never removed.
    // Committed, not just written: every run now opens by putting the tree
    // back to its commit, which is the production invariant this fixture has
    // to share — a probe tree is a detached checkout, so a tracked file that
    // disagrees with HEAD is contamination, not a starting condition.
    write('src/x.ts', 'alpha();\nbeta();\n');
    commitAll('mismatched line');
    const before = readFileSync(join(repo, 'src/x.ts'), 'utf8');

    const got = runOneMutant(
      repo,
      { file: 'src/x.ts', line: 1, statement: 'gone.clear();' },
      ['src/x.test.ts'],
    );

    expect(got.verdict).toBe('inconclusive');
    expect(got.detail).toContain('does not match the selected statement');
    expect(readFileSync(join(repo, 'src/x.ts'), 'utf8')).toBe(before);
  });

  it('puts tracked files back before each run — one run cannot decide the next', () => {
    // The probe tree is reused across the baseline, the control, every mutant
    // and every hunk probe, and what runs in it between those phases is the
    // PR's own test suite. Re-linking `node_modules` covers half of what a run
    // can leave behind; TRACKED files are the other half, and the more direct
    // one — a suite that rewrites a probe file AFTER vitest has collected it
    // stays green for the run it was collected in and hands every later run a
    // file of its choosing. The verdict that buys is `killed`: "a test catches
    // this", asserted for statements no test covers.
    write('src/x.ts', 'gone.clear();\n');
    write('src/other.ts', 'export const clean = true;\n');
    // The commit's own ignore rules are the PR's to write, so a plant named to
    // match one of them is hidden from a sweep that honors them. `-fd` honored
    // them; the sweep is `-ffdx` now, sparing only the borrowed farm.
    write('.gitignore', 'node_modules\nplanted-cache/\n');
    commitAll('a second tracked file');
    // Plants ONCE, so the second run's state is the restore's doing and not
    // the runner's. The marker lives OUTSIDE the tree because inside it would
    // be swept with everything else the run left — which is the other half of
    // what this pins: an untracked `vitest.config.ts` is what a suite reaches
    // for when it wants to decide the next run's collection, and no
    // zero-config project commits one.
    const marker = join(mkdtempSync(join(tmpdir(), 'qwen-plant-')), 'once');
    writeFileSync(
      vitestScript(),
      `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync('src/other.ts', 'export const clean = false; // planted\\n');
  fs.writeFileSync('vitest.config.ts', 'export default { test: {} };\\n');
  fs.mkdirSync('planted-cache', { recursive: true });
  fs.writeFileSync('planted-cache/decider.json', '{}\\n');
  fs.writeFileSync(${JSON.stringify(marker)}, '1');
}
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

    runOneMutant(
      repo,
      { file: 'src/x.ts', line: 1, statement: 'gone.clear();' },
      ['src/x.test.ts'],
    );
    // Both plants are real, and they outlive the run that made them.
    expect(readFileSync(join(repo, 'src/other.ts'), 'utf8')).toContain(
      'planted',
    );
    expect(existsSync(join(repo, 'vitest.config.ts'))).toBe(true);
    expect(existsSync(join(repo, 'planted-cache/decider.json'))).toBe(true);
    // ...and `status` cannot see the ignored one, which is the point of it:
    // a sweep that honors the commit's ignore rules never reaches it either.
    expect(
      git(repo, 'status', '--porcelain', '--untracked-files=all'),
    ).not.toContain('planted-cache');

    const second = runOneMutant(
      repo,
      { file: 'src/x.ts', line: 1, statement: 'gone.clear();' },
      ['src/x.test.ts'],
    );

    // ...and the next run opens on neither.
    expect(readFileSync(join(repo, 'src/other.ts'), 'utf8')).toBe(
      'export const clean = true;\n',
    );
    expect(existsSync(join(repo, 'vitest.config.ts'))).toBe(false);
    expect(existsSync(join(repo, 'planted-cache/decider.json'))).toBe(false);
    expect(second.verdict).toBe('survived');
  });

  it('runs tests with dependencies from the source worktree', () => {
    const dependencyRoot = join(repo, 'source-worktree');
    const probeTree = join(repo, 'separate-probe');
    mkdirSync(dependencyRoot);
    mkdirSync(join(probeTree, 'src'), { recursive: true });
    const sourceVitestDir = join(dependencyRoot, 'node_modules', 'vitest');
    const sourceDependencyDir = join(
      dependencyRoot,
      'node_modules',
      'probe-dependency',
    );
    const sourceScopedDependencyDir = join(
      dependencyRoot,
      'node_modules',
      '@probe',
      'scoped-dependency',
    );
    mkdirSync(sourceVitestDir, { recursive: true });
    mkdirSync(sourceDependencyDir);
    mkdirSync(sourceScopedDependencyDir, { recursive: true });
    writeFileSync(
      join(sourceVitestDir, 'package.json'),
      JSON.stringify({ bin: { vitest: './vitest.mjs' } }),
    );
    const sourceBinDir = join(dependencyRoot, 'node_modules', '.bin');
    mkdirSync(sourceBinDir);
    writeFileSync(
      join(dependencyRoot, 'node_modules', '.package-lock.json'),
      '{}\n',
    );
    writeFileSync(
      join(sourceVitestDir, 'vitest.mjs'),
      `import '${pathToFileURL(join(probeTree, 'src/x.test.mjs')).href}';
process.stdout.write(JSON.stringify({
  testResults: [{
    name: ${JSON.stringify(join(probeTree, 'src/x.test.mjs'))},
    assertionResults: [{ status: 'passed' }],
  }],
}));
`,
    );
    writeFileSync(
      join(sourceDependencyDir, 'package.json'),
      JSON.stringify({ type: 'module', exports: './index.mjs' }),
    );
    writeFileSync(
      join(sourceDependencyDir, 'index.mjs'),
      'export default 1;\n',
    );
    writeFileSync(
      join(sourceScopedDependencyDir, 'package.json'),
      JSON.stringify({ type: 'module', exports: './index.mjs' }),
    );
    writeFileSync(
      join(sourceScopedDependencyDir, 'index.mjs'),
      'export default 2;\n',
    );
    const brokenLink = join(dependencyRoot, 'node_modules', 'broken-link');
    if (process.platform !== 'win32') {
      symlinkSync(
        join(dependencyRoot, 'node_modules', 'missing-package'),
        brokenLink,
      );
    }
    writeFileSync(join(sourceBinDir, 'probe-tool'), 'available');
    writeFileSync(join(probeTree, 'src/x.ts'), 'gone.clear();\n');
    writeFileSync(
      join(probeTree, 'src/x.test.mjs'),
      "import fs from 'node:fs'; import value from 'probe-dependency'; import scopedValue from '@probe/scoped-dependency'; if (value !== 1 || scopedValue !== 2 || fs.readFileSync('node_modules/.bin/probe-tool', 'utf8') !== 'available') throw new Error('bad dependency');\n",
    );

    // The probe tree a review builds is a `git worktree add` checkout, and the
    // between-run restore refuses anything else; commit what this fixture has
    // laid out so the restore is a no-op over it.
    execFileSync('git', ['init', '-q', '-b', 'main', '--template=', '.'], {
      cwd: probeTree,
    });
    execFileSync('git', ['add', '-A'], { cwd: probeTree });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t.t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null/no-hooks',
        'commit',
        '-qm',
        'fixture',
        '--no-verify',
        '--allow-empty',
      ],
      { cwd: probeTree },
    );

    const result = runOneMutant(
      probeTree,
      { file: 'src/x.ts', line: 1, statement: 'gone.clear();' },
      ['src/x.test.mjs'],
      undefined,
      Date.now,
      dependencyRoot,
    );

    const probeModules = join(probeTree, 'node_modules');
    expect(statSync(probeModules).isDirectory()).toBe(true);
    expect(lstatSync(probeModules).isSymbolicLink()).toBe(false);
    writeFileSync(join(probeModules, '.vite-probe'), 'local cache');
    expect(
      existsSync(join(dependencyRoot, 'node_modules', '.vite-probe')),
    ).toBe(false);
    if (process.platform !== 'win32') {
      expect(() => lstatSync(join(probeModules, 'broken-link'))).toThrow();
    }

    expect(result.verdict).toBe('survived');
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

describe('per-hunk probes against real git', () => {
  // The risky half is the patch, not the verdict: a single-hunk patch has to be
  // something `git apply --reverse` accepts, and reverse-applying hunk N has to
  // change hunk N's lines and nothing else. A wrong patch here does not fail
  // loudly — it neutralises the wrong change and attributes the run's verdict
  // to code it never touched, which is the exact failure the mutants' own
  // line-mismatch guard exists to prevent.
  //
  // `runProbeSuite` is not the subject. With an empty probe list it collects
  // nothing and the verdict is `inconclusive` by the third-outcome rule, which
  // leaves the patch application and the restore as what these assert.
  const FILE = 'src/x.ts';
  const BEFORE =
    Array.from({ length: 30 }, (_, i) => `line${i + 1};`).join('\n') + '\n';
  let base: string;

  const contents = () => readFileSync(join(repo, FILE), 'utf8');

  const hunkPatches = () => {
    const diff = git(
      repo,
      'diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      'HEAD',
      '--',
      FILE,
    );
    return splitDiffIntoHunks(diff);
  };

  beforeEach(() => {
    write(FILE, BEFORE);
    base = commitAll('base');
    // Two well-separated changes, so they land in two distinct hunks.
    const after = BEFORE.split('\n');
    after[1] = 'line2_CHANGED;';
    after[24] = 'line25_CHANGED;';
    write(FILE, after.join('\n'));
    commitAll('head');
  });

  it('produces two patches git accepts, one per change', () => {
    const hunks = hunkPatches();
    expect(hunks).toHaveLength(2);
    for (const h of hunks) {
      // `--check` applies nothing; it asks git whether the patch is well-formed
      // and would apply. A patch this rejects would be `inconclusive` forever.
      expect(() =>
        execFileSync('git', ['apply', '--reverse', '--check', '-'], {
          cwd: repo,
          input: h.patch,
          encoding: 'utf8',
        }),
      ).not.toThrow();
    }
  });

  it('reverting ONE hunk restores only that change', () => {
    const [first, second] = hunkPatches();

    runOneHunkProbe(
      repo,
      {
        file: FILE,
        index: 0,
        header: first.header,
        startLine: first.startLine,
        patch: first.patch,
      },
      [],
    );
    // Restored afterwards — the probe must leave the tree as it found it.
    expect(contents()).toContain('line2_CHANGED;');

    // Apply by hand to observe the mid-probe state the probe itself hides.
    execFileSync('git', ['apply', '--reverse', '-'], {
      cwd: repo,
      input: second.patch,
      encoding: 'utf8',
    });
    const reverted = contents();
    // The second change is undone…
    expect(reverted).toContain('line25;');
    expect(reverted).not.toContain('line25_CHANGED;');
    // …and the first is untouched. This is what `git checkout base -- <file>`
    // cannot do, and the whole reason the probe is per-hunk.
    expect(reverted).toContain('line2_CHANGED;');
  });

  it('restores a hunk-ADDED file whose parent directory the reverse apply removed', () => {
    // Reviewed live on this PR: reverse-applying a `new file` hunk deletes the
    // directories it emptied, and the old restore threw ENOENT from finally —
    // losing the verdict and marking every remaining hunk inconclusive.
    write('src/newdir/added.ts', 'export const fresh = 1;\n');
    commitAll('adds a file in a new dir');
    const diff = git(
      repo,
      'diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'HEAD~1',
      'HEAD',
      '--',
      'src/newdir/added.ts',
    );
    const [h] = splitDiffIntoHunks(diff);
    const got = runOneHunkProbe(
      repo,
      {
        file: 'src/newdir/added.ts',
        index: 0,
        header: h.header,
        startLine: h.startLine,
        patch: h.patch,
      },
      [],
    );
    expect(got.verdict).toBe('inconclusive'); // no probe files collected — honest
    expect(readFileSync(join(repo, 'src/newdir/added.ts'), 'utf8')).toBe(
      'export const fresh = 1;\n',
    );
  });

  it('restores the file after the run, verdict notwithstanding', () => {
    const [first] = hunkPatches();
    const before = contents();
    const got = runOneHunkProbe(
      repo,
      {
        file: FILE,
        index: 0,
        header: first.header,
        startLine: first.startLine,
        patch: first.patch,
      },
      [],
    );
    expect(contents()).toBe(before);
    // No probe file collected anything, so the honest verdict is the
    // third outcome — never `killed`.
    expect(got.verdict).toBe('inconclusive');
    expect(got.header).toBe(first.header);
    // …and it is inconclusive because nothing was COLLECTED, not because the
    // patch bounced. Without this the assertion above passes just as well on a
    // probe that never applied anything, which is the state it exists to rule
    // out: a silent no-op reads exactly like a clean restore.
    expect(got.detail).toContain('no clean verdict');
    expect(got.detail).not.toContain('could not be reverse-applied');
  });

  it('is inconclusive and leaves the tree ALONE when the patch will not apply', () => {
    const before = contents();
    const got = runOneHunkProbe(
      repo,
      {
        file: FILE,
        index: 0,
        header: '@@ -1,3 +1,3 @@',
        startLine: 1,
        patch:
          'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,3 +1,3 @@\n-nope;\n+also nope;\n context;\n',
      },
      [],
    );
    expect(got.verdict).toBe('inconclusive');
    expect(got.detail).toContain('could not be reverse-applied');
    expect(contents()).toBe(before);
  });

  it('is inconclusive when the probe tree does not hold the file at all', () => {
    const got = runOneHunkProbe(
      repo,
      {
        file: 'src/gone.ts',
        index: 0,
        header: '@@ -1 +1 @@',
        startLine: 1,
        patch: 'x',
      },
      [],
    );
    expect(got.verdict).toBe('inconclusive');
    expect(got.detail).toContain('does not hold');
  });
});
