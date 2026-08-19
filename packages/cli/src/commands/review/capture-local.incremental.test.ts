/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The local review-fix loop, end to end against real git: round 1 captures
// full and writes a content-anchor candidate; the candidate promoted to a
// cache scopes round 2 to what changed since — same model, same HEAD — with
// one import hop of dependents; and every gate (model, HEAD, malformed cache)
// degrades to the FULL capture with the reason said out loud, never to a skip.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateIdOf } from './lib/local-anchor.js';
import { captureLocalCommand } from './capture-local.js';
import { buildChunkAgentPrompt } from './agent-prompt.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import type { IncrementalScope } from './lib/report.js';

// The refusal contract is "every reason is said out loud" and SKILL.md
// branches on specific stderr strings — so stderr is part of the interface
// under test, recorded here rather than left to flow to the real terminal.
const stderrLines: string[] = [];
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn((line: string) => {
    stderrLines.push(line);
  }),
  writeStderrLineSafe: vi.fn(),
}));

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

beforeEach(() => {
  stderrLines.length = 0;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-loc-inc-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

const CHANGED = 'src/changed.ts';
const CALLER = 'src/caller.ts';
const BYSTANDER = 'src/bystander.ts';

/** Commit a baseline, then dirty all three files — round 1's working state. */
function seedDirtyTree(): void {
  // Real repos gitignore `.qwen/` (Step 8 checks exactly that); the fixture
  // must too, or the cache file and the plan output masquerade as untracked
  // review scope.
  write('.gitignore', '.qwen/\nplan.json\n');
  write(CHANGED, 'export const v = 0;\n');
  write(CALLER, "import { v } from './changed.js';\nexport const c = v;\n");
  write(BYSTANDER, 'export const b = 0;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
  write(CHANGED, 'export const v = 1;\n');
  write(CALLER, "import { v } from './changed.js';\nexport const c = v + 1;\n");
  write(BYSTANDER, 'export const b = 1;\n');
}

type Plan = Record<string, unknown> & {
  chunks: Array<{ id: number }>;
  files: Array<{ path: string }>;
  incremental?: { scope?: IncrementalScope };
  cacheCandidatePath: string;
  diffPath: string;
};

function capture(extra: Record<string, unknown> = {}): Plan {
  const out = join(repo, 'plan.json');
  (captureLocalCommand.handler as (argv: unknown) => void)({
    out,
    target: 'local',
    untracked: true,
    ...extra,
  });
  return JSON.parse(readFileSync(out, 'utf8')) as Plan;
}

/** What Step 8 does on a clean high-effort end: candidate + ledger → cache. */
function promoteCandidate(plan: Plan, model: string): string {
  const candidate = JSON.parse(
    readFileSync(plan.cacheCandidatePath, 'utf8'),
  ) as Record<string, unknown>;
  const cachePath = join(repo, '.qwen/review-cache/local.json');
  mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({ ...candidate, lastModelId: model }),
  );
  return cachePath;
}

describe('capture-local — incremental local rounds', () => {
  it('round 1 writes a candidate covering every captured file', () => {
    seedDirtyTree();
    const plan = capture();
    expect(plan.incremental).toBeUndefined();
    const candidate = JSON.parse(
      readFileSync(plan.cacheCandidatePath, 'utf8'),
    ) as { files: Record<string, string>; headSha: string | null };
    expect(Object.keys(candidate.files).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
    expect(candidate.headSha).toBe(git('rev-parse', 'HEAD'));
  });

  it('round 2 scopes to the changed file plus its importer; the bystander is out', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');

    write(CHANGED, 'export const v = 2;\n'); // the fix
    const plan = capture({ cache: cachePath, model: 'model-a' });

    expect(plan.incremental).toBeDefined();
    expect(plan.incremental!.scope!.deltaFiles).toEqual([CHANGED]);
    expect(plan.incremental!.scope!.interaction).toEqual([
      { path: CALLER, importsChanged: [CHANGED] },
    ]);
    expect(plan.incremental!.scope!.contextFileCount).toBe(1);
    expect(plan.files.map((f) => f.path).sort()).toEqual([CALLER, CHANGED]);

    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).toContain('+export const v = 2;');
    expect(diff).toContain('caller.ts');
    expect(diff).not.toContain('bystander');
    // The full capture is preserved beside the scoped one.
    expect(
      readFileSync(plan.incremental!.scope!.fullDiffPath!, 'utf8'),
    ).toContain('bystander');
  });

  it('an attribute flip re-reviews the file — including with NO worktree change', () => {
    // What a round READS is the rendering. `binary` turns a file's section
    // into "Binary files … differ", so a round can end clean having read no
    // content of it; drop the attribute and the same bytes are text nobody
    // has reviewed. Mode and blob cannot see that.
    //
    // The rendering attributes ride each file's IDENTITY now, asked of `git
    // check-attr` rather than re-derived from the attribute sources — so a
    // flip moves that one file and the round stays incremental, instead of
    // refusing the whole anchor. The second half is why it cannot be derived
    // by hand: `.git/info/attributes` is not in the worktree, so nothing
    // about the tree changes at all.
    seedDirtyTree();
    write('.gitattributes', `${CHANGED} binary\n`);
    const cachePath = promoteCandidate(capture(), 'model-a');

    // (a) a tracked attributes file changes.
    write('.gitattributes', '\n');
    const viaWorktree = capture({ cache: cachePath, model: 'model-a' });
    expect(viaWorktree.incremental).toBeDefined();
    expect(viaWorktree.incremental!.scope!.deltaFiles).toContain(CHANGED);

    // (b) the same KIND of flip through `.git/info/attributes`, which is not
    // in the worktree at all — no file identity derived from the tree could
    // ever cover it, and nothing about the tree moves. This is why the
    // attributes are asked of git rather than read from the sources.
    write('.gitattributes', '\n');
    const cache2 = promoteCandidate(capture(), 'model-a');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'info', 'attributes'),
      `${CHANGED} binary\n`,
    );
    const viaInfo = capture({ cache: cache2, model: 'model-a' });
    expect(viaInfo.incremental).toBeDefined();
    expect(viaInfo.incremental!.scope!.deltaFiles).toContain(CHANGED);
  });

  it('a cache from before the rendering attributes re-reviews everything', () => {
    // Identities written by an older CLI carry no attribute component, so
    // every one of them compares unequal and every file re-enters scope. The
    // round still runs — it is a wider scope, not a refusal — and nothing is
    // skipped on a comparison that could not be made.
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      files: Record<string, string>;
      headSha: string | null;
      stateId: string;
    };
    // Strip the attribute half back to the old `<mode>:<blob>` shape.
    for (const [path, id] of Object.entries(cache.files)) {
      const parts = id.split(':');
      cache.files[path] = parts.slice(0, 2).join(':');
    }
    // …and re-stamp `stateId`, or the integrity gate refuses first and this
    // test would pass for the wrong reason.
    cache.stateId = stateIdOf(cache.headSha, cache.files);
    writeFileSync(cachePath, JSON.stringify(cache));
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.scope!.deltaFiles.sort()).toEqual(
      [BYSTANDER, CALLER, CHANGED].sort(),
    );
  });

  it('a pending DELETION lets the loop converge instead of re-arming for ever', () => {
    // `UNHASHABLE` never equals itself, deliberately — state that could not
    // be captured is re-reviewed rather than certified. But the "nothing
    // changed, stop" decision used to key on that same list, which made the
    // stop unreachable for any change set holding a deletion: round N+1
    // re-hashed the section to UNHASHABLE, announced "1 changed file(s)" over
    // a byte-identical diff, and re-armed itself for N+2 until HEAD moved.
    seedDirtyTree();
    rmSync(join(repo, CHANGED));
    const cachePath = promoteCandidate(capture(), 'model-a');

    // Nothing moves between the rounds.
    stderrLines.length = 0;
    const plan = capture({ cache: cachePath, model: 'model-a' });
    // The stop is REACHABLE now: the round says nothing changed, because
    // nothing did.
    expect(stderrLines.join('\n')).toContain('No changes since the last local');
    expect(stderrLines.join('\n')).not.toContain('changed file(s)');
    // The deletion is still not CERTIFIED — the scope keeps the wider list on
    // purpose, so an unreadable path is re-reviewed rather than skipped. Both
    // facts are true at once, and separating them is the fix: the stop reads
    // what MOVED, the scope reads what could not be ruled out.
    expect(plan.incremental!.scope!.deltaFiles).toContain(CHANGED);

    // With something genuinely new beside it, the round runs and the count a
    // human reads names the unreadable path apart from the real change.
    write('src/other.ts', 'export const o = 1;\n');
    stderrLines.length = 0;
    const next = capture({ cache: cachePath, model: 'model-a' });
    expect(next.incremental!.scope!.deltaFiles).toContain('src/other.ts');
    expect(stderrLines.join('\n')).toContain('unreadable path(s)');
  });

  it('an identical state under the same model and HEAD yields 0 chunks and says so', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.scope!.deltaFiles).toEqual([]);
    expect(plan.chunks).toEqual([]);
  });

  it('a different model degrades to the full capture', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-b' });
    expect(plan.incremental).toBeUndefined();
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
  });

  it('a moved HEAD degrades to the full capture', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'user committed the changes');
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeUndefined();
  });

  it('a malformed cache and a missing --model both degrade to the full capture', () => {
    seedDirtyTree();
    const cachePath = join(repo, '.qwen/review-cache/local.json');
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    writeFileSync(cachePath, 'not json');
    expect(
      capture({ cache: cachePath, model: 'm' }).incremental,
    ).toBeUndefined();

    const good = promoteCandidate(capture(), 'model-a');
    expect(capture({ cache: good }).incremental).toBeUndefined();
  });

  it('the block the REAL brief renderer reads — not merely the shape', () => {
    // The finding this pins: the local flow wrote the block flat while both
    // consumers (`incrementalScopeOf` here, `incrementalInteractionPaths` in
    // the roster) key on `incremental.scope`. Every shape assertion above
    // stayed green, the diff WAS sliced, and the round looked incremental
    // everywhere — while no chunk brief carried the frame, so each widened
    // file was re-reviewed from scratch. Only driving the real renderer sees
    // it, so this test does.
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.scope!.deltaFiles).toEqual([CHANGED]);

    const briefs = (plan.chunks as Array<{ id: number }>).map((c) =>
      buildChunkAgentPrompt(plan as never, c.id),
    );
    expect(briefs.length).toBeGreaterThan(0);
    expect(briefs.some((b) => b.includes('INCREMENTAL'))).toBe(true);
    // …and the seam itself: the importer's brief must name what it imports
    // that changed, or the agent has no reason to look at the interaction
    // rather than re-read the file.
    expect(briefs.some((b) => b.includes(CALLER))).toBe(true);
  });

  it('a brand-new untracked file since the last round is delta, not skipped', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    write('src/new-untracked.ts', 'export const n = 1;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.scope!.deltaFiles).toEqual([
      'src/new-untracked.ts',
    ]);
    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).toContain('new-untracked');
    expect(diff).not.toContain('bystander');
  });
});

describe('capture-local — identity soundness and refusal contract', () => {
  it.skipIf(process.platform === 'win32')(
    'an exec-bit flip alone is a change — bytes equal, mode not',
    () => {
      seedDirtyTree();
      const cachePath = promoteCandidate(capture(), 'model-a');
      execFileSync('chmod', ['+x', join(repo, CHANGED)]);
      const plan = capture({ cache: cachePath, model: 'model-a' });
      expect(plan.incremental!.scope!.deltaFiles).toEqual([CHANGED]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a retargeted symlink whose new target holds equal bytes is a change',
    () => {
      seedDirtyTree();
      write('src/t1.txt', 'same\n');
      write('src/t2.txt', 'same\n');
      execFileSync('ln', ['-s', 't1.txt', join(repo, 'src/link')]);
      const cachePath = promoteCandidate(capture(), 'model-a');
      rmSync(join(repo, 'src/link'));
      execFileSync('ln', ['-s', 't2.txt', join(repo, 'src/link')]);
      const plan = capture({ cache: cachePath, model: 'model-a' });
      expect(plan.incremental!.scope!.deltaFiles).toContain('src/link');
    },
  );

  it('a file named __proto__ is tracked like any other', () => {
    seedDirtyTree();
    write('__proto__', 'p1\n');
    const round1 = capture();
    const candidate = JSON.parse(
      readFileSync(round1.cacheCandidatePath, 'utf8'),
    ) as { files: Record<string, string> };
    expect(Object.keys(candidate.files)).toContain('__proto__');
    const cachePath = promoteCandidate(round1, 'model-a');
    write('__proto__', 'p2\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.scope!.deltaFiles).toEqual(['__proto__']);
  });

  it('an untracked file DELETED since the cached round re-opens its importer', () => {
    seedDirtyTree();
    write('src/n.ts', 'export const n = 1;\n');
    write('src/c.ts', "import { n } from './n.js';\nexport const c2 = n;\n");
    const cachePath = promoteCandidate(capture(), 'model-a');
    rmSync(join(repo, 'src/n.ts'));
    const plan = capture({ cache: cachePath, model: 'model-a' });
    // n.ts has no diff section left, but its disappearance is a change: the
    // importer re-enters through the widening, and the round must NOT stop
    // as "no changes".
    expect(plan.incremental!.scope!.deltaFiles).toEqual([]);
    expect(plan.incremental!.scope!.interaction.map((e) => e.path)).toContain(
      'src/c.ts',
    );
    expect(stderrLines.join('\n')).not.toContain('No changes since the last');
  });

  it('a skipped (oversized) file refuses the incremental path out loud', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    writeFileSync(join(repo, 'huge.bin'), Buffer.alloc(1_100_000, 7));
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeUndefined();
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
    const err = stderrLines.join('\n');
    expect(err).toContain('SKIPPED');
    expect(err).not.toContain('No changes since the last');
  });

  it('target and stateId integrity gates refuse, full plan preserved, reason out loud', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(cachePath, JSON.stringify({ ...cache, target: 'other.ts' }));
    let plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeUndefined();
    expect(stderrLines.join('\n')).toContain('belongs to target');

    stderrLines.length = 0;
    const files = { ...(cache['files'] as Record<string, string>) };
    const k = Object.keys(files)[0];
    files[k] = '100644:0000000000000000000000000000000000000000';
    writeFileSync(cachePath, JSON.stringify({ ...cache, files }));
    plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeUndefined();
    expect(plan.files.length).toBe(3);
    expect(stderrLines.join('\n')).toContain('stateId does not match');
  });

  it('refusal reasons for model/HEAD/malformed gates reach stderr verbatim', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    capture({ cache: cachePath, model: 'model-b' });
    expect(stderrLines.join('\n')).toContain(
      'was reviewed by model-a, not model-b',
    );

    stderrLines.length = 0;
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'move head');
    write(CHANGED, 'export const v = 5;\n');
    capture({ cache: cachePath, model: 'model-a' });
    expect(stderrLines.join('\n')).toContain(
      'HEAD moved since the last local round',
    );
  });

  it('the no-change stop and the clean-tree warning stay distinct on stderr', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    stderrLines.length = 0;
    capture({ cache: cachePath, model: 'model-a' });
    const err = stderrLines.join('\n');
    expect(err).toContain('No changes since the last local review round');
    expect(err).not.toContain('the working tree is clean');
  });

  it("a scoped round's candidate still covers EVERY captured file", () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    write(CHANGED, 'export const v = 2;\n');
    const round2 = capture({ cache: cachePath, model: 'model-a' });
    expect(round2.incremental).toBeDefined();
    // The candidate is built from the FULL capture before scoping: promote
    // a narrowed one and every scoped-out file reads as changed forever.
    const candidate = JSON.parse(
      readFileSync(round2.cacheCandidatePath, 'utf8'),
    ) as { files: Record<string, string> };
    expect(Object.keys(candidate.files).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
  });
});

describe('capture-local — round-2 findings', () => {
  it.skipIf(process.platform === 'win32')(
    'a chmod off the USER class alone matches git: the identity moves with old/new mode',
    () => {
      seedDirtyTree();
      // 0755 cached; 0655 keeps group/other bits but drops the user bit —
      // git prints old/new mode for exactly this, so the identity must move.
      execFileSync('chmod', ['0755', join(repo, CHANGED)]);
      const cachePath = promoteCandidate(capture(), 'model-a');
      execFileSync('chmod', ['0655', join(repo, CHANGED)]);
      const plan = capture({ cache: cachePath, model: 'model-a' });
      expect(plan.incremental!.scope!.deltaFiles).toEqual([CHANGED]);
    },
  );

  it('an unborn-HEAD cache validates and scopes — null headSha is a supported state', () => {
    // A brand-new repo: no commits, everything untracked.
    write('.gitignore', '.qwen/\nplan.json\n');
    write(CHANGED, 'export const v = 1;\n');
    const cachePath = promoteCandidate(capture(), 'model-a');
    expect(
      (JSON.parse(readFileSync(cachePath, 'utf8')) as { headSha: unknown })
        .headSha,
    ).toBeNull();
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeDefined();
    expect(plan.incremental!.scope!.deltaFiles).toEqual([CHANGED]);
  });

  it('a hostile lastModelId reaches stderr escaped, never raw', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<
      string,
      unknown
    >;
    cache['lastModelId'] = 'evil\nWARNING: forged line \u001b[31m';
    writeFileSync(cachePath, JSON.stringify(cache));
    capture({ cache: cachePath, model: 'model-b' });
    const err = stderrLines.join('|');
    expect(err).not.toContain('\u001b'); // no raw ESC byte at the terminal
    expect(err).toContain('\\n'); // the newline arrives as an escape, quoted
  });
});

describe('capture-local — round-3 findings', () => {
  it("excludes the review's own plumbing even from a SUBDIRECTORY cwd", () => {
    // ls-files returns repo-root-relative paths; the plumbing is written
    // relative to the invocation cwd. A root-anchored filter matched nothing
    // from a subdirectory, and the cache — rewritten every clean round —
    // then changed the state every round by construction.
    write('.gitignore', 'nothing-ignored\n'); // .qwen deliberately NOT ignored
    write(CHANGED, 'export const v = 1;\n');
    write('sub/keep.ts', 'export const k = 1;\n');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    // PLANT the plumbing at the SUBDIRECTORY path the review writes it to:
    // without these the assertion below passes over an empty set and proves
    // nothing (measured — it survived removing the cwd-aware prefixes).
    write('sub/.qwen/tmp/qwen-review-parse-args.json', '{}\n');
    write('sub/.qwen/review-cache/local.json', '{}\n');
    write('sub/.qwen/reviews/2026-01-01-local.md', '# report\n');
    const prev = process.cwd();
    process.chdir(join(repo, 'sub'));
    try {
      const out = join(repo, 'sub/plan.json');
      (captureLocalCommand.handler as (argv: unknown) => void)({
        out,
        target: 'local',
        untracked: true,
      });
      const plan = JSON.parse(readFileSync(out, 'utf8')) as Plan;
      const paths = plan.files.map((f) => f.path);
      expect(paths.some((p) => p.includes('.qwen/'))).toBe(false);
      expect(paths).toContain('sub/keep.ts');
    } finally {
      process.chdir(prev);
    }
  });

  it('excludes .qwen/review-cache and .qwen/reviews, not just .qwen/tmp', () => {
    write('.gitignore', 'nothing-ignored\n');
    write(CHANGED, 'export const v = 1;\n');
    write('.qwen/review-cache/local.json', '{}\n');
    write('.qwen/reviews/2026-01-01-local.md', '# report\n');
    const out = join(repo, 'plan.json');
    (captureLocalCommand.handler as (argv: unknown) => void)({
      out,
      target: 'local',
      untracked: true,
    });
    const plan = JSON.parse(readFileSync(out, 'utf8')) as Plan;
    expect(
      plan.files.map((f) => f.path).some((p) => p.startsWith('.qwen/')),
    ).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'a symlink retargeted to non-UTF-8 bytes is a change — the raw-bytes identity',
    () => {
      seedDirtyTree();
      // Two targets that differ only in invalid-UTF-8 bytes: a lossy decode
      // collapses both to U+FFFD and the identity would hold still.
      const linkPath = join(repo, 'src/link');
      // Buffer targets: `execFileSync`/`ln` re-encode a JS string as UTF-8
      // and never put the invalid bytes on disk — the shape this fix exists
      // for would go untested.
      symlinkSync(Buffer.from([0xff, 0x2e, 0x74]), linkPath);
      const cachePath = promoteCandidate(capture(), 'model-a');
      rmSync(linkPath);
      symlinkSync(Buffer.from([0xfe, 0x2e, 0x74]), linkPath);
      const plan = capture({ cache: cachePath, model: 'model-a' });
      expect(plan.incremental!.scope!.deltaFiles).toContain('src/link');
    },
  );

  it('a null→string HEAD transition refuses like any other moved HEAD', () => {
    // Unborn HEAD at round 1 (cache records null), first commit before
    // round 2: the same worktree bytes now describe a different change.
    write('.gitignore', '.qwen/\nplan.json\n');
    write(CHANGED, 'export const v = 1;\n');
    const cachePath = promoteCandidate(capture(), 'model-a');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'first commit');
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeUndefined();
    expect(stderrLines.join('\n')).toContain('HEAD moved');
  });
});
