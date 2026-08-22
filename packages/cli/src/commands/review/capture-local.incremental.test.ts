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
  // The identity is the RUNTIME's, not a flag: `capture-local` reads
  // `QWEN_CODE_MODEL_IDENTITY` the way the child shell publishes it. Tests
  // name a model the same way they always did; the harness puts it where the
  // command actually looks.
  const { model, ...argv } = extra as { model?: string };
  const prev = process.env['QWEN_CODE_MODEL_IDENTITY'];
  if (model !== undefined) process.env['QWEN_CODE_MODEL_IDENTITY'] = model;
  try {
    (captureLocalCommand.handler as (argv: unknown) => void)({
      out,
      target: 'local',
      untracked: true,
      ...argv,
    });
  } finally {
    if (prev === undefined) delete process.env['QWEN_CODE_MODEL_IDENTITY'];
    else process.env['QWEN_CODE_MODEL_IDENTITY'] = prev;
  }
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
    // The round says what is true, and the two halves match: no CONTENT
    // moved, and the unhashable path is still in scope. The bare
    // "nothing to re-review" sentence must NOT appear — SKILL.md stops the
    // orchestrator on exactly that string, so printing it beside a plan that
    // carries chunks stops the round over live scope.
    expect(stderrLines.join('\n')).toContain('No content changes since');
    expect(stderrLines.join('\n')).toContain('could not be hashed');
    expect(stderrLines.join('\n')).toContain('Their sections are in scope');
    expect(stderrLines.join('\n')).not.toContain('nothing to re-review');
    expect(stderrLines.join('\n')).not.toContain('changed file(s)');
    expect((plan.chunks as unknown[]).length).toBeGreaterThan(0);
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

  it('a config-side diff driver moves the identity, like the attribute does', () => {
    // `check-attr` answers attribute VALUES, and `diff=<driver>` is only a
    // NAME: the behaviour lives in git config. `diff.<driver>.binary` flips a
    // section between readable hunks and "Binary files … differ" while the
    // attribute value, the mode and the blob all stand still — so the
    // identity compared equal and the newly-readable section was sliced out,
    // the loop certifying content the previous round had only seen as a
    // marker.
    seedDirtyTree();
    write('.gitattributes', `${CHANGED} diff=mydrv\n`);
    git('config', 'diff.mydrv.binary', 'true');
    const cachePath = promoteCandidate(capture(), 'model-a');

    // Only the CONFIG changes: no file in the tree moves, and `check-attr`'s
    // answer is identical before and after.
    git('config', 'diff.mydrv.binary', 'false');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.scope!.deltaFiles).toContain(CHANGED);
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

describe('capture-local — round-2 regressions from the stop work', () => {
  it('does not call a tracked, unmodified FILE review a clean-tree stop', () => {
    // An empty diff is not a decided round for a file target: SKILL.md's
    // no-diff branch owes it a whole-file review. Marked decided, the round
    // turned from "Review did not complete" — which it was before the stop
    // existed — into a PASSING gate over a file nobody read.
    seedDirtyTree();
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'all committed');

    const plan = capture({ file: CHANGED });
    expect(plan.chunks.length).toBe(0);
    expect(plan['nothingToReview']).toBeUndefined();
  });

  it('does not tell a FILE review of an unchanged file that the tree is clean', () => {
    // The field gate excludes file reviews; the prose channel beside it did
    // not, so stderr still said "the working tree is clean … do not run the
    // review agents" over a capture that was pathspec-scoped — 0 chunks says
    // nothing about the tree (the bystanders here are dirty), and an
    // orchestrator that stops on prose left the user-named file unread. The
    // no-diff branch owes this shape a whole-file review.
    seedDirtyTree();
    git('add', CHANGED);
    git('commit', '-q', '--no-verify', '-m', 'commit only the reviewed file');

    stderrLines.length = 0;
    const plan = capture({ file: CHANGED });
    expect(plan['nothingToReview']).toBeUndefined();
    const err = stderrLines.join('\n');
    expect(err).not.toContain('the working tree is clean');
    expect(err).toContain('whole-file review');
  });

  it('stamps the stop sidecar with the run that asked for it', () => {
    // The sidecar decides `completed` and can carry a REQUEST_CHANGES event,
    // while its NAME is the flattened target token — which is not injective,
    // so a concurrent review whose path flattens alike writes the same file
    // and its blocker count would decide the other run's exit code. The epoch
    // fence separates EARLIER runs, not concurrent ones; only a nonce does.
    seedDirtyTree();
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'all committed');
    const prev = process.env['QWEN_REVIEW_RUN_ID'];
    process.env['QWEN_REVIEW_RUN_ID'] = 'run-abc';
    try {
      capture();
    } finally {
      if (prev === undefined) delete process.env['QWEN_REVIEW_RUN_ID'];
      else process.env['QWEN_REVIEW_RUN_ID'] = prev;
    }
    const sidecar = JSON.parse(
      readFileSync(join(repo, '.qwen/tmp/qwen-review-local-stop.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sidecar['runId']).toBe('run-abc');
  });
});

describe('capture-local — round-5 sibling gaps', () => {
  it('does not stop a FILE review whose anchored change was discarded', () => {
    // `scope-emptied` lacked the exclusion both sibling stops carry, so the
    // same tree decided differently depending on whether a cache existed:
    // with one it completed as a decided round, without one it routed to the
    // whole-file review SKILL.md owes a file target.
    seedDirtyTree();
    write('src/foo.ts', 'export const real = 1;\n');
    const first = capture({ file: 'src/foo.ts', model: 'model-a' });
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    writeFileSync(
      first['cachePath'] as string,
      readFileSync(first.cacheCandidatePath, 'utf8'),
    );
    // Discard the reviewed change entirely; HEAD does not move. The file was
    // untracked, so discarding it removes it — the anchored path vanishes and
    // the slice keeps nothing.
    rmSync(join(repo, 'src/foo.ts'));

    const second = capture({
      file: 'src/foo.ts',
      cache: join(repo, '.qwen/review-cache'),
      model: 'model-a',
    });
    expect(second['nothingToReview']).toBeUndefined();
  });
});

describe('capture-local — the cache namespace discriminates the subject', () => {
  it('gives a file review its own key, so colliding targets keep separate ledgers', () => {
    // The anchor gate's `source` check is the second layer, not the first: it
    // can only refuse a cache the round already opened, which leaves the
    // LEDGER — read and written by the orchestrator, not the gate — sharing
    // one file. `safeTarget` is not injective, so `src/foo.ts` and
    // `src_foo.ts` flattened to one key and erased each other's findings.
    seedDirtyTree();
    write('src_foo.ts', 'export const collide = 1;\n');
    write('src/foo.ts', 'export const real = 1;\n');

    const a = capture({ file: 'src/foo.ts', model: 'model-a' });
    const b = capture({ file: 'src_foo.ts', model: 'model-a' });
    expect(a['target']).toBe(b['target']); // the token still collides…
    expect(a['cachePath']).not.toBe(b['cachePath']); // …the cache key does not
  });

  it('keeps a root file named `local` out of the whole-tree cache', () => {
    // The token space reserves nothing: `safeTarget('local') === 'local'`, so
    // a root file by that name produced the whole-tree key byte for byte and
    // the two rounds served each other their ledgers.
    seedDirtyTree();
    write('local', 'not the whole tree\n');

    const wholeTree = capture({ model: 'model-a' });
    const rootFile = capture({ file: 'local', model: 'model-a' });
    expect(rootFile['target']).toBe(wholeTree['target']);
    expect(rootFile['cachePath']).not.toBe(wholeTree['cachePath']);
  });
});

describe('capture-local — the decided stops are machine-readable', () => {
  it('marks the unchanged-since-last-round stop in the plan', () => {
    // `compose-review` runs only in Step 6, and this stop fires in Step 1, so
    // no composed verdict exists — and `qwen review run` polls for exactly
    // that, reporting "Review did not complete" over a round whose own output
    // was decided. The signal is a field the CLI wrote, not a sentence the
    // model chose off stderr.
    seedDirtyTree();
    const cachePath = promoteCandidate(
      capture({ model: 'model-a' }),
      'model-a',
    );
    const second = capture({ cache: cachePath, model: 'model-a' });
    expect(second.chunks.length).toBe(0);
    expect(second['nothingToReview']).toEqual({
      reason: 'unchanged-since-last-round',
    });
  });

  it('does NOT mark a capture that SKIPPED files — it read nothing, twice over', () => {
    // The safety half. An empty diff beside a non-empty skip list is not a
    // clean tree: that round could not read what it skipped, owes a "Not
    // reviewed" section, and must never reach the parent as complete —
    // exactly the failure this command exists to end, arriving through the
    // front door.
    seedDirtyTree();
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'all committed');
    // A symlink to a DIRECTORY is skipped, not reviewed.
    mkdirSync(join(repo, 'somedir'), { recursive: true });
    symlinkSync(join(repo, 'somedir'), join(repo, 'dirlink'));

    const plan = capture();
    expect((plan['skippedFiles'] as unknown[]).length).toBeGreaterThan(0);
    expect(plan['nothingToReview']).toBeUndefined();
  });

  it('marks the scope-emptied round, which neither other stop reaches', () => {
    // The third decided shape. A cached path that VANISHED — the change
    // discarded with `git checkout --` — is a change by design, so the
    // unchanged-since stop cannot fire; and the clean-tree stop is gated on
    // `!incremental`. The slice keeps nothing, so the plan carried
    // `chunks: []` with an `incremental` block and no field at all: neither
    // SKILL stop fired, `agent-prompt --roster` threw on the first
    // diff-reading role, and the parent reported "Review did not complete".
    seedDirtyTree();
    const cachePath = promoteCandidate(
      capture({ model: 'model-a' }),
      'model-a',
    );
    // Discard every reviewed change; HEAD does not move.
    git('checkout', '--', '.');

    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.chunks.length).toBe(0);
    expect(plan['incremental']).toBeDefined();
    expect(plan['nothingToReview']).toEqual({ reason: 'scope-emptied' });
  });

  it('publishes the stop at a name the PARENT can predict, with blocker state', () => {
    // `--out` is the orchestrator's to choose — it must be, because the
    // CLI-derived target token does not exist yet at Step 1 — so a parent
    // polling the plan by name found nothing for every file review and
    // reported "Review did not complete" over a decided round. The sidecar is
    // named from the same target the parent derives.
    //
    // It carries the ledger's open blocker count too. A decided stop is not
    // automatically a clean one: the common shape is a user who committed
    // without fixing a Critical, and reported with no verdict at all
    // `--fail-on request-changes` returned 0 over a blocker the round itself
    // was calling standing.
    seedDirtyTree();
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'all committed');
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    writeFileSync(
      join(repo, '.qwen/review-cache/local.json'),
      JSON.stringify({
        findings: [
          { id: 'R1-1', severity: 'Critical', status: 'open' },
          { id: 'R1-2', severity: 'Critical', status: 'fixed' },
          { id: 'R1-3', severity: 'Suggestion', status: 'open' },
        ],
      }),
    );

    // Deliberately NOT the name a parent could guess.
    const out = join(repo, 'somewhere-else.json');
    (captureLocalCommand.handler as (argv: unknown) => void)({
      out,
      target: 'local',
      untracked: true,
    });

    const sidecar = JSON.parse(
      readFileSync(join(repo, '.qwen/tmp/qwen-review-local-stop.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sidecar['reason']).toBe('clean-tree');
    // Only the OPEN Criticals count: a fixed one is gone and a Suggestion
    // blocks nothing.
    expect(sidecar['openBlockers']).toBe(1);
  });

  it('marks a genuinely clean tree', () => {
    // `seedDirtyTree` commits a base and then dirties it; committing that
    // work leaves the tree clean, which is the shape this stop is about.
    seedDirtyTree();
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'all committed');

    const plan = capture();
    expect(plan.chunks.length).toBe(0);
    expect(plan['nothingToReview']).toEqual({ reason: 'clean-tree' });
  });
});

describe('capture-local — --cache takes the DIRECTORY', () => {
  it('resolves the cache from the target IT derived, not one the caller guessed', () => {
    // The name is `<target>.json`, and `target` is derived inside this
    // command — so a caller running BEFORE it has to predict, and predicting
    // is wrong for any non-canonical spelling. Through a symlinked
    // directory, the typed path flattens to `srclink_foo.ts` while the
    // command canonicalises to `src_foo.ts`: the prediction misses, the
    // cache is never passed, and the round silently loses both incremental
    // scoping and the findings ledger.
    seedDirtyTree();
    write('src/foo.ts', 'export const real = 1;\n');
    symlinkSync(join(repo, 'src'), join(repo, 'srclink'));

    // Round 1 through the SYMLINKED spelling.
    const first = capture({ file: 'srclink/foo.ts', model: 'model-a' });
    expect(first['target']).toBe('src_foo.ts');
    const cacheDir = join(repo, '.qwen/review-cache');
    mkdirSync(cacheDir, { recursive: true });
    // Written where the CAPTURE says this target's cache lives — the same
    // field the orchestrator reads. A file review's cache is namespaced by
    // source path, so a hand-spelled `<token>.json` is not it.
    writeFileSync(
      first['cachePath'] as string,
      readFileSync(first.cacheCandidatePath, 'utf8'),
    );

    // Round 2 hands over the DIRECTORY and never names the file.
    write('src/foo.ts', 'export const real = 2;\n');
    const second = capture({
      file: 'srclink/foo.ts',
      cache: cacheDir,
      model: 'model-a',
    });
    expect(second.incremental?.scope?.deltaFiles).toEqual(['src/foo.ts']);
  });

  it('reads a directory holding no cache for this target as no anchor', () => {
    seedDirtyTree();
    const cacheDir = join(repo, '.qwen/review-cache');
    mkdirSync(cacheDir, { recursive: true });
    expect(capture({ cache: cacheDir, model: 'model-a' }).incremental).toBe(
      undefined,
    );
  });
});

describe('capture-local — the cache key is the SOURCE path, not the token', () => {
  it('refuses a cache whose flattened token collides with another file', () => {
    // `safeTarget` is not injective: `src/foo.ts` and `src_foo.ts` both
    // flatten to `src_foo.ts`, and this PR keys the cache by that token. The
    // token gate alone passed each file the other's cache — scoping against a
    // state describing a different file, and erasing that file's anchor and
    // open findings on promotion.
    seedDirtyTree();
    write('src_foo.ts', 'export const collide = 1;\n');
    write('src/foo.ts', 'export const real = 1;\n');

    const first = capture({ file: 'src/foo.ts', model: 'model-a' });
    expect(first['target']).toBe('src_foo.ts');
    const candidate = JSON.parse(
      readFileSync(first.cacheCandidatePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(candidate['source']).toBe('src/foo.ts');
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    const cachePath = join(repo, '.qwen/review-cache/src_foo.ts.json');
    writeFileSync(cachePath, JSON.stringify(candidate));

    // The OTHER file, whose token is the same one.
    const other = capture({
      file: 'src_foo.ts',
      cache: cachePath,
      model: 'model-a',
    });
    expect(other['target']).toBe('src_foo.ts');
    expect(other.incremental).toBeUndefined();
    // …and SAID, like every sibling gate's reason: a refactor relocating the
    // check into the reader (fail-quiet null) would surface "the cache is
    // missing or unreadable" — a false diagnosis for exactly this collision.
    expect(stderrLines.join('\n')).toContain('belongs to source path');

    // …and the file the cache actually belongs to still scopes.
    write('src/foo.ts', 'export const real = 2;\n');
    const same = capture({
      file: 'src/foo.ts',
      cache: cachePath,
      model: 'model-a',
    });
    expect(same.incremental).toBeDefined();
  });

  it('derives the source even when an explicit --target rides along on --file', () => {
    // The pre-fix `--target` describe documented this combination, and a
    // caller following it left `sourcePath` undefined: the cache fell out of
    // the digest namespace, the candidate recorded no `source`, and the
    // gate's source clause degraded to `undefined === undefined` and passed —
    // so the TOKEN-colliding pair below (which the target gate cannot tell
    // apart) shared one cache, and the second file erased the first's anchor
    // on promotion. The derivation wins now for EVERY `--file` capture: the
    // parent (`qwen review run`) pins its artifact names to it anyway.
    seedDirtyTree();
    write('src/a.ts', 'export const a = 1;\n');
    write('src_a.ts', 'export const collide = 1;\n');

    const first = capture({ file: 'src/a.ts', target: 't', model: 'model-a' });
    expect(first['target']).toBe('src_a.ts');
    const candidate = JSON.parse(
      readFileSync(first.cacheCandidatePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(candidate['source']).toBe('src/a.ts');
    const cachePath = join(repo, first['cachePath'] as string);
    expect(cachePath).toContain('file-src_a.ts-');
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(candidate));

    // The token-colliding OTHER file under the same explicit token must not
    // inherit it: the derived tokens agree, so the source gate is the only
    // layer that can tell the two subjects apart.
    write('src_a.ts', 'export const collide = 2;\n');
    stderrLines.length = 0;
    const second = capture({
      file: 'src_a.ts',
      target: 't',
      cache: cachePath,
      model: 'model-a',
    });
    expect(second.incremental).toBeUndefined();
    expect(stderrLines.join('\n')).toContain('belongs to source path');
  });

  it('a hostile source path reaches stderr escaped, never raw', () => {
    // Mirrors the hostile-lastModelId pin: the refusal interpolates the
    // cache's recorded source through `display()`, so a crafted value cannot
    // forge warning lines or emit terminal escapes.
    seedDirtyTree();
    write('src_foo.ts', 'export const collide = 1;\n');
    const cachePath = promoteCandidate(
      capture({ file: 'src_foo.ts', model: 'model-a' }),
      'model-a',
    );
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<
      string,
      unknown
    >;
    cache['source'] = 'evil\nWARNING: forged line \u001b[31m';
    writeFileSync(cachePath, JSON.stringify(cache));
    stderrLines.length = 0;
    write('src/foo.ts', 'export const real = 1;\n');
    capture({ file: 'src/foo.ts', cache: cachePath, model: 'model-a' });
    const err = stderrLines.join('|');
    expect(err).not.toContain('\u001b'); // no raw ESC byte at the terminal
    expect(err).toContain('\\n'); // the newline arrives as an escape, quoted
  });
});

describe('capture-local — the local same-model gate', () => {
  const A = 'qwen3-max@aaaaaaaa';
  const B = 'qwen3-max@bbbbbbbb';

  it('records the PROVIDER-QUALIFIED identity in the candidate itself', () => {
    // Step 8 used to merge `lastModelId: "{{model}}"` in afterwards, and
    // `{{model}}` interpolates the BARE model id. The capture records what
    // the runtime published instead, so the token that gets compared is the
    // one that distinguishes two providers exposing one model name.
    seedDirtyTree();
    const plan = capture({ model: A });
    const candidate = JSON.parse(
      readFileSync(plan.cacheCandidatePath, 'utf8'),
    ) as { lastModelId?: string };
    expect(candidate.lastModelId).toBe(A);
  });

  it('refuses an anchor another PROVIDER certified under the same name', () => {
    // The failure the bare comparison allowed: two provider configurations
    // exposing `qwen3-max` compared equal, so provider B honoured provider
    // A's anchor and scoped — and then certified — over code only A read.
    seedDirtyTree();
    const round1 = capture({ model: A });
    const candidate = JSON.parse(
      readFileSync(round1.cacheCandidatePath, 'utf8'),
    ) as Record<string, unknown>;
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    const cachePath = join(repo, '.qwen/review-cache/local.json');
    // Promoted verbatim — the candidate already carries who certified it.
    writeFileSync(cachePath, JSON.stringify(candidate));

    write(CHANGED, 'export const v = 2;\n');
    const other = capture({ cache: cachePath, model: B });
    expect(other.incremental).toBeUndefined();

    // …and the same provider still scopes.
    const same = capture({ cache: cachePath, model: A });
    expect(same.incremental?.scope?.deltaFiles).toEqual([CHANGED]);
  });

  it('names the fallback when the CACHED identity is empty too', () => {
    // `roundModelIdFrom` records `''` when the runtime published nothing —
    // reachable in normal operation, not an error state. The refusal must
    // print the fallback on the cached side as well; a blank certifier name
    // ("reviewed by , not …") reads as a recorded-but-different identity
    // when both sides are unrecorded.
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), '');
    write(CHANGED, 'export const v = 2;\n');
    capture({ cache: cachePath, model: 'model-b' });
    expect(stderrLines.join('\n')).toContain(
      'reviewed by an unrecorded model, not model-b',
    );
  });

  it('treats a runtime that published NO identity as a mismatch', () => {
    // An unverifiable contract is a failed one: empty never matches, so the
    // round degrades to the full capture rather than honouring an anchor it
    // cannot attribute.
    seedDirtyTree();
    const cachePath = promoteCandidate(capture({ model: A }), A);
    write(CHANGED, 'export const v = 2;\n');
    expect(
      capture({ cache: cachePath, model: '' }).incremental,
    ).toBeUndefined();
  });
});

describe('capture-local — a staged move across rounds', () => {
  it('keeps the rename section when only its deleted SOURCE is in scope', () => {
    // The capture's pinned flags include `--find-renames`, so a staged move
    // comes back as ONE section labelled with the NEW path — a comment here
    // once claimed otherwise on the strength of a measurement that did not
    // hold. `changedSince` reports the deleted SOURCE (its recorded identity
    // is UNHASHABLE, which never equals itself), so on the round after the
    // move the keep-set holds the source and no section is labelled with it.
    // Matching the new side alone cut the whole section: a zero-byte slice, a
    // plan with no chunks, `deltaFiles` naming a path no section carries, and
    // the "their sections are in scope" line printed over it. The stop
    // sentence cannot fire either, and the candidate re-records the same
    // state — so the cycle repeats until HEAD moves.
    seedDirtyTree();
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'round 1 work');
    git('mv', CHANGED, 'src/moved.ts');

    const round1 = capture();
    expect(round1.files.map((f) => f.path)).toContain('src/moved.ts');
    const cache = promoteCandidate(round1, 'model-a');

    // Round 2: nothing moved since round 1.
    const round2 = capture({ cache, model: 'model-a' });
    const scope = round2.incremental?.scope;
    expect(scope).toBeDefined();
    // The source is what changed since the anchor…
    expect(scope!.deltaFiles).toContain(CHANGED);
    // …and the section it names is PUBLISHED, not sliced away.
    const sliced = readFileSync(join(repo, round2.diffPath), 'utf8');
    expect(sliced).toContain(`rename from ${CHANGED}`);
    expect(sliced).toContain('rename to src/moved.ts');
    expect(round2.chunks.length).toBeGreaterThan(0);
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

    stderrLines.length = 0;
    writeFileSync(cachePath, 'not json');
    capture({ cache: cachePath, model: 'model-a' });
    expect(stderrLines.join('\n')).toContain(
      'the cache is missing or unreadable',
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
