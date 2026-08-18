/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `review run` is a contract around the headless review: build the right
// /review invocation, republish the verdict compose-review wrote (never the
// model's prose), and map outcomes onto exit codes a CI gate can trust. The
// child CLI itself is tested elsewhere; these tests pin the contract — prompt
// assembly, artifact discovery (this run's verdict, not a stale one), the
// completed/failed/blocking exit split, and the spawn wiring.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock },
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
  };
});

const {
  buildReviewPrompt,
  newestArtifactSince,
  exitCodeFor,
  killProcessGroup,
  runCommand,
  classifyRunTarget,
  composedPatternFor,
  reportPatternFor,
} = await import('./run.js');
const { REVIEW_TMP_DIR, REVIEWS_DIR } = await import('./lib/paths.js');
// The real cleanup, not a mock: the regression test below must prove the parent
// captures the verdict before Step 9's actual sweep deletes it.
const { runCleanup } = await import('./cleanup.js');

describe('buildReviewPrompt', () => {
  it('reviews the local tree when no target is given', () => {
    expect(buildReviewPrompt({})).toBe('/review');
  });

  it('threads target, effort, and --comment through verbatim', () => {
    expect(
      buildReviewPrompt({ target: '7724', effort: 'high', comment: true }),
    ).toBe('/review 7724 --effort high --comment');
  });

  it('omits what was not asked for', () => {
    expect(buildReviewPrompt({ effort: 'medium' })).toBe(
      '/review --effort medium',
    );
  });

  it('rejects a target that would re-tokenize into extra args', () => {
    // `123 --comment` would split into a target plus a flag the child
    // honours, silently authorising a post the run never asked for.
    expect(() => buildReviewPrompt({ target: '123 --comment' })).toThrow(
      /Invalid review target/,
    );
    expect(() => buildReviewPrompt({ target: '--comment' })).toThrow(
      /Invalid review target/,
    );
  });

  it('rejects a separators-only or empty target', () => {
    // `/` names no file: it survives basename extraction as the empty
    // string, pinning the unmatchable `qwen-review--composed.json` — a whole
    // child review burned before the parent reports "no composed verdict".
    for (const target of ['/', '//', '\\']) {
      expect(() => buildReviewPrompt({ target })).toThrow(
        /Invalid review target/,
      );
    }
    // An empty target is a target the caller named and got wrong (an unset
    // `"$TARGET"`); read as "no target given" it silently becomes a full
    // local review at the 120-minute default, not an error.
    for (const target of ['', '   ']) {
      expect(() => buildReviewPrompt({ target })).toThrow(
        /Invalid review target/,
      );
    }
  });

  it('keeps accepting separator-bearing paths — the guard is not over-broad', () => {
    // The rejection cases alone leave over-rejection mutants green: dropping
    // the `$` from `/^[\\/]+$/` kills every absolute path, dropping the `^`
    // kills every tab-completed trailing slash. Both shapes are valid
    // targets and reach the child unchanged.
    expect(buildReviewPrompt({ target: '/repo/src/foo.ts' })).toBe(
      '/review /repo/src/foo.ts',
    );
    expect(buildReviewPrompt({ target: 'src/' })).toBe('/review src/');
  });

  it('rejects a target carrying quote characters', () => {
    // tokenizeArgs strips quotes, so `src/it's-a-file.ts` would re-tokenize
    // to `src/its-a-file.ts` — silently re-targeting a file never named.
    expect(() => buildReviewPrompt({ target: "src/it's-a-file.ts" })).toThrow(
      /Invalid review target/,
    );
    expect(() => buildReviewPrompt({ target: 'src/"quoted".ts' })).toThrow(
      /Invalid review target/,
    );
  });
});

describe('newestArtifactSince', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-artifacts-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, mtimeMs: number): string {
    const path = join(dir, name);
    writeFileSync(path, '{}', 'utf8');
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
  }

  it('ignores artifacts older than the run', () => {
    // A stale composed JSON is the LAST review's verdict — republishing it
    // would report an outcome this run never produced.
    const start = Date.now();
    file('qwen-review-local-composed.json', start - 60_000);

    expect(
      newestArtifactSince(dir, /^qwen-review-.*composed\.json$/, start),
    ).toBeNull();
  });

  it('returns the newest matching artifact from this run, mtime attached', () => {
    const start = Date.now() - 10_000;
    file('qwen-review-local-composed.json', start + 1_000);
    const newer = file('qwen-review-pr-9-composed.json', start + 5_000);
    file('unrelated.json', start + 9_000);

    const best = newestArtifactSince(
      dir,
      /^qwen-review-.*composed\.json$/,
      start,
    );
    expect(best?.path).toBe(newer);
    // The mtime rides along so the capture poll never re-stats the path —
    // a second stat races the child's Step 9 sweep.
    expect(Math.abs((best?.mtime ?? 0) - (start + 5_000))).toBeLessThan(1_000);
  });

  it('returns null when the directory does not exist', () => {
    expect(
      newestArtifactSince(join(dir, 'absent'), /composed/, Date.now()),
    ).toBeNull();
  });
});

describe('target-pinned artifact patterns', () => {
  it('classifies exactly as the child parser does — no second classifier', () => {
    // The child names its artifacts after parse-args' verdict; a narrower
    // local regex pinned patterns the child never writes and reported a
    // completed (and posted) review as "no verdict was produced".
    expect(classifyRunTarget('9014')).toEqual({ kind: 'pr', number: '9014' });
    expect(classifyRunTarget('https://github.com/o/r/pull/9014')).toEqual({
      kind: 'pr',
      number: '9014',
    });
    // GitHub's Files-changed tab hands out /pull/<n>/files URLs:
    expect(classifyRunTarget('https://github.com/o/r/pull/9014/files')).toEqual(
      { kind: 'pr', number: '9014' },
    );
    // The parser normalizes pure integers via Number(), and the child writes
    // `pr-42-…`, so the pin must be '42', never '0042':
    expect(classifyRunTarget('0042')).toEqual({ kind: 'pr', number: '42' });
    // The scheme and path are case-insensitive to the parser:
    expect(classifyRunTarget('HTTPS://github.com/o/r/PULL/9014')).toEqual({
      kind: 'pr',
      number: '9014',
    });
    // A path that merely contains /pull/<n> is a FILE target to the parser,
    // and the file identity is the basename (the skill's `{target}` token):
    expect(classifyRunTarget('docs/pull/42')).toEqual({
      kind: 'file',
      base: '42',
    });
    expect(classifyRunTarget('src/foo.ts')).toEqual({
      kind: 'file',
      base: 'foo.ts',
    });
    // A tab-completed trailing separator must not produce an empty basename
    // (an empty base pins `qwen-review--composed.json`, which no child
    // artifact can carry — every such run would report "no verdict").
    expect(classifyRunTarget('src/')).toEqual({ kind: 'file', base: 'src' });
    expect(classifyRunTarget(undefined)).toEqual({ kind: 'local' });
  });

  it('pins each target class to its exact composed filename', () => {
    // Two concurrent `review run`s share `.qwen/tmp`; the generic
    // newest-composed scan republished the OTHER run's verdict on two of
    // three live parallel reviews. Exact names, not shape heuristics.
    const pr = composedPatternFor({ kind: 'pr', number: '9014' });
    expect(pr.test('qwen-review-pr-9014-composed.json')).toBe(true);
    expect(pr.test('qwen-review-pr-9013-composed.json')).toBe(false);
    expect(pr.test('qwen-review-local-composed.json')).toBe(false);

    const local = composedPatternFor({ kind: 'local' });
    expect(local.test('qwen-review-local-composed.json')).toBe(true);
    expect(local.test('qwen-review-pr-9013-composed.json')).toBe(false);
    // A concurrent FILE run's artifact is not the local run's either:
    expect(local.test('qwen-review-b.ts-composed.json')).toBe(false);

    const file = composedPatternFor({ kind: 'file', base: 'b.ts' });
    expect(file.test('qwen-review-b.ts-composed.json')).toBe(true);
    expect(file.test('qwen-review-local-composed.json')).toBe(false);
    // The dot is a literal, not a wildcard:
    expect(file.test('qwen-review-bxts-composed.json')).toBe(false);
  });

  it('a pr-<digits>-named FILE target is not confused with a PR run', () => {
    // A name-shape pin broke both directions here: the `(?!pr-\d+-)`
    // lookahead rejected this file run's OWN artifact, and the PR branch's
    // `.*` wildcard claimed it for `review run 42`.
    const file = composedPatternFor({ kind: 'file', base: 'pr-42-notes.ts' });
    expect(file.test('qwen-review-pr-42-notes.ts-composed.json')).toBe(true);

    const pr = composedPatternFor({ kind: 'pr', number: '42' });
    expect(pr.test('qwen-review-pr-42-notes.ts-composed.json')).toBe(false);
    expect(pr.test('qwen-review-pr-42-composed.json')).toBe(true);
  });

  it('pins the saved report as far as its naming allows', () => {
    const pr = reportPatternFor({ kind: 'pr', number: '9014' });
    expect(pr.test('2026-08-13-071500-pr-9014.md')).toBe(true);
    expect(pr.test('2026-08-13-162336-pr-9013.md')).toBe(false);
    const local = reportPatternFor({ kind: 'local' });
    expect(local.test('review.md')).toBe(true);
    expect(local.test('2026-08-13-1622-pr-9045.md')).toBe(false);

    // File reports carry the filename in the report stem's trailing slot.
    const file = reportPatternFor({ kind: 'file', base: 'foo.ts' });
    expect(file.test('2026-08-13-101010-foo.ts.md')).toBe(true);
    expect(file.test('2026-08-13-101010-bar.ts.md')).toBe(false);
    // A file literally named `pr-1234.md` claims its OWN report — the shape
    // the local branch's PR exclusion would self-reject (`.md` not doubled).
    const prNamed = reportPatternFor({ kind: 'file', base: 'pr-1234.md' });
    expect(prNamed.test('2026-08-13-101010-pr-1234.md')).toBe(true);
  });
});

describe('exitCodeFor', () => {
  it('splits completed / no-verdict / blocking into 0 / 1 / 3', () => {
    expect(exitCodeFor(true, 'APPROVE', 'none')).toBe(0);
    expect(exitCodeFor(true, 'REQUEST_CHANGES', 'none')).toBe(0);
    expect(exitCodeFor(false, null, 'none')).toBe(1);
    expect(exitCodeFor(true, 'REQUEST_CHANGES', 'request-changes')).toBe(3);
    expect(exitCodeFor(true, 'COMMENT', 'request-changes')).toBe(0);
    // An incomplete run is 1 even under --fail-on: "the tool broke" must never
    // read as "the review blocked".
    expect(exitCodeFor(false, 'REQUEST_CHANGES', 'request-changes')).toBe(1);
  });
});

describe('killProcessGroup', () => {
  let processKill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    execFileSyncMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kills the POSIX process group with a negative pid', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    killProcessGroup(12345, 'SIGTERM');
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('kills the process tree via taskkill on Windows', () => {
    // A negative pid is not a process group on win32; the group kill must fall
    // back to a tree kill or the timeout/cancel termination silently no-ops.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    killProcessGroup(12345, 'SIGTERM');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '12345', '/T', '/F'],
      { stdio: 'ignore' },
    );
    expect(processKill).not.toHaveBeenCalled();
  });
});

describe('review run (handler)', () => {
  let dir: string;
  let cwd: string;
  let outs: string[];
  let errs: string[];
  let exitCode: number | undefined;
  let processKill: MockInstance<typeof process.kill>;

  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = Object.assign(new EventEmitter(), { resume: () => {} });
    stderr = Object.assign(new EventEmitter(), { resume: () => {} });
    kill = vi.fn();
  }

  beforeEach(() => {
    // Pin POSIX semantics for the whole suite (restored in afterEach): these
    // tests assert the process-group kill and POSIX paths, so pinning the
    // platform keeps them green on a Windows runner without pretending to cover
    // win32 — that path has its own test in killProcessGroup above.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    dir = mkdtempSync(join(tmpdir(), 'run-handler-'));
    cwd = process.cwd();
    process.chdir(dir);
    outs = [];
    errs = [];
    exitCode = process.exitCode as number | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      outs.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errs.push(String(chunk));
      return true;
    });
    processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockReset();
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function runHandler(over: Record<string, unknown> = {}): Promise<void> {
    return (runCommand.handler as (a: unknown) => Promise<void>)({
      comment: false,
      json: true,
      'fail-on': 'none',
      'timeout-minutes': 120,
      'approval-mode': 'yolo',
      quiet: true,
      ...over,
    });
  }

  /** Child that "completes", writing (or not) a composed verdict first. */
  function armChild(exit: number, composed?: Record<string, unknown>): void {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        if (composed) {
          mkdirSync(REVIEW_TMP_DIR, { recursive: true });
          mkdirSync(REVIEWS_DIR, { recursive: true });
          writeFileSync(
            join(REVIEW_TMP_DIR, 'qwen-review-local-composed.json'),
            JSON.stringify(composed),
            'utf8',
          );
          writeFileSync(join(REVIEWS_DIR, 'review.md'), '# report', 'utf8');
        }
        child.emit('close', exit);
      });
      return child;
    });
  }

  it('republishes the composed verdict and exits 0', async () => {
    // Non-default values for every republished field, so a dropped or
    // hard-coded `composed?.X ?? default` mapping cannot pass.
    armChild(0, {
      event: 'COMMENT',
      verdictLine: 'Verdict: Comment',
      baseEvent: 'REQUEST_CHANGES',
      cappedBy: ['unreviewed-dimension'],
      downgraded: true,
      downgradedFrom: 'Request changes',
      remediation: ['do x'],
    });
    await runHandler();

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(true);
    expect(result.event).toBe('COMMENT');
    expect(result.verdictLine).toBe('Verdict: Comment');
    expect(result.baseEvent).toBe('REQUEST_CHANGES');
    expect(result.cappedBy).toEqual(['unreviewed-dimension']);
    expect(result.downgraded).toBe(true);
    expect(result.downgradedFrom).toBe('Request changes');
    expect(result.remediation).toEqual(['do x']);
    expect(result.reportPath).toContain('review.md');
    expect(process.exitCode).toBe(0);
  });

  it('exits 3 on a blocking verdict only when --fail-on asks for it', async () => {
    armChild(0, {
      event: 'REQUEST_CHANGES',
      verdictLine: 'Verdict: Request changes',
    });
    await runHandler({ 'fail-on': 'request-changes' });

    expect(process.exitCode).toBe(3);
  });

  it('treats a clean child exit without a composed verdict as failure', async () => {
    // The model can wander off and exit 0 without ever reaching Step 7. That is
    // "no verdict", never "approve".
    armChild(0);
    await runHandler();

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(false);
    expect(result.event).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('captures the verdict before Step 9 cleanup sweeps it', async () => {
    // The regression this command shipped with: the child runs the bundled
    // skill through Step 9, whose `cleanup` deletes the composed verdict before
    // the child exits. A parent that reads only after `close` sees nothing and
    // reports a completed review as a failure. The capture poll must snapshot
    // the verdict while the child still runs.
    vi.useFakeTimers();
    let child!: FakeChild;
    spawnMock.mockImplementation(() => {
      // Step 6: compose-review writes the composed verdict.
      mkdirSync(REVIEW_TMP_DIR, { recursive: true });
      writeFileSync(
        join(REVIEW_TMP_DIR, 'qwen-review-local-composed.json'),
        JSON.stringify({ event: 'APPROVE', verdictLine: 'Verdict: Approve' }),
        'utf8',
      );
      child = new FakeChild();
      return child;
    });

    const done = runHandler();
    // The capture poll snapshots the verdict while the child still runs...
    await vi.advanceTimersByTimeAsync(1_000);
    // ...then Step 9 runs the REAL cleanup, which sweeps the verdict...
    runCleanup('local');
    outs.length = 0; // drop cleanup's "Removed temp file" stdout noise
    // ...and only then does the child exit.
    child.emit('close', 0);
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(true);
    expect(result.event).toBe('APPROVE');
    expect(result.composedPath).toContain('qwen-review-local-composed.json');
    expect(process.exitCode).toBe(0);
  });

  it('ignores a concurrent run’s other-PR verdict and captures its own', async () => {
    vi.useFakeTimers();
    let child!: FakeChild;
    spawnMock.mockImplementation(() => {
      // A NEIGHBOUR review composes first — the shape that made two of three
      // live parallel runs republish the wrong PR's verdict.
      mkdirSync(REVIEW_TMP_DIR, { recursive: true });
      writeFileSync(
        join(REVIEW_TMP_DIR, 'qwen-review-pr-9013-composed.json'),
        JSON.stringify({ event: 'APPROVE', verdictLine: 'Verdict: Approve' }),
        'utf8',
      );
      // Strictly NEWER than this run's own verdict, written below: with the
      // neighbour older, an unpinned newest-composed scan would land on the
      // right file anyway and the regression would pass this test.
      utimesSync(
        join(REVIEW_TMP_DIR, 'qwen-review-pr-9013-composed.json'),
        Date.now() / 1000 + 60,
        Date.now() / 1000 + 60,
      );
      // The neighbour's saved report exists too — and is newer than this
      // run's own by the time the scan runs.
      mkdirSync(REVIEWS_DIR, { recursive: true });
      writeFileSync(
        join(REVIEWS_DIR, '2026-08-13-071500-pr-9014.md'),
        '# own report',
        'utf8',
      );
      writeFileSync(
        join(REVIEWS_DIR, '2026-08-13-162336-pr-9013.md'),
        '# neighbour report',
        'utf8',
      );
      // Force the neighbour's report strictly newer, so an unpinned
      // newest-.md scan would deterministically pick the wrong one.
      utimesSync(
        join(REVIEWS_DIR, '2026-08-13-162336-pr-9013.md'),
        Date.now() / 1000 + 60,
        Date.now() / 1000 + 60,
      );
      child = new FakeChild();
      return child;
    });

    const done = runHandler({ target: '9014' });
    await vi.advanceTimersByTimeAsync(1_000);
    // This run's own verdict lands later.
    writeFileSync(
      join(REVIEW_TMP_DIR, 'qwen-review-pr-9014-composed.json'),
      JSON.stringify({
        event: 'COMMENT',
        verdictLine: 'Verdict: Comment',
      }),
      'utf8',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', 0);
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(true);
    expect(result.event).toBe('COMMENT');
    expect(result.composedPath).toContain('qwen-review-pr-9014-composed.json');
    // The report scan is pinned the same way — the neighbour's newer report
    // must not become this run's reportPath.
    expect(result.reportPath).toContain('pr-9014.md');
  });

  it('republishes the newest recompose, not the first snapshot', async () => {
    // A coverage re-check can recompose the verdict minutes after the first
    // write (measured live); the first snapshot would republish a superseded
    // verdict.
    vi.useFakeTimers();
    let child!: FakeChild;
    spawnMock.mockImplementation(() => {
      mkdirSync(REVIEW_TMP_DIR, { recursive: true });
      const path = join(REVIEW_TMP_DIR, 'qwen-review-pr-7-composed.json');
      writeFileSync(
        path,
        JSON.stringify({ event: 'APPROVE', verdictLine: 'Verdict: Approve' }),
        'utf8',
      );
      utimesSync(path, Date.now() / 1000, Date.now() / 1000);
      child = new FakeChild();
      return child;
    });

    const done = runHandler({ target: '7' });
    await vi.advanceTimersByTimeAsync(1_000);
    const path = join(REVIEW_TMP_DIR, 'qwen-review-pr-7-composed.json');
    writeFileSync(
      path,
      JSON.stringify({
        event: 'REQUEST_CHANGES',
        verdictLine: 'Verdict: Request changes',
      }),
      'utf8',
    );
    // A strictly newer mtime, independent of filesystem clock granularity.
    utimesSync(path, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', 0);
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.event).toBe('REQUEST_CHANGES');
  });

  it('names the artifact it waited for when no verdict appears', async () => {
    // The pin is an exact-filename contract with the skill's naming
    // template. When the two drift, Step 9 has already swept `.qwen/tmp` by
    // the time anyone investigates — so the expectation has to be in the
    // failure report itself, in both output modes.
    armChild(0);
    await runHandler({ target: '9014', json: false });

    expect(outs.join('')).toContain(
      'no composed verdict was produced (expected',
    );
    expect(outs.join('')).toContain('qwen-review-pr-9014-composed.json');
    expect(process.exitCode).toBe(1);

    outs.length = 0;
    armChild(0);
    await runHandler({ target: '9014' });

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(false);
    expect(result.expectedComposedName).toBe(
      'qwen-review-pr-9014-composed.json',
    );
  });

  it('closes the child stdin so piped input cannot defeat slash detection', async () => {
    armChild(0, { event: 'APPROVE', verdictLine: 'Verdict: Approve' });
    await runHandler();

    const [, argvUsed, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown[]; detached: boolean },
    ];
    expect(opts.stdio[0]).toBe('ignore');
    expect(opts.detached).toBe(true);
    // --expose-gc must lead the argv: spawning argv[1] directly would drop the
    // flag the memory-pressure monitor's critical tier needs (cli-entry.js
    // passes it for exactly this relaunch path).
    expect(argvUsed[0]).toBe('--expose-gc');
    expect(argvUsed).toContain('--prompt');
    expect(argvUsed).toContain('/review');
  });

  it('passes the approval mode through to the child CLI', async () => {
    armChild(0, { event: 'APPROVE', verdictLine: 'Verdict: Approve' });
    await runHandler({ 'approval-mode': 'default' });

    const [, argvUsed] = spawnMock.mock.calls[0] as [string, string[]];
    const i = argvUsed.indexOf('--approval-mode');
    expect(i).toBeGreaterThan(-1);
    expect(argvUsed[i + 1]).toBe('default');
  });

  describe('child env: QWEN_CODE_CLI version skew', () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env['QWEN_CODE_CLI'];
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env['QWEN_CODE_CLI'];
      } else {
        process.env['QWEN_CODE_CLI'] = saved;
      }
    });

    function childEnvValue(): string | undefined {
      const [, , opts] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      return opts.env['QWEN_CODE_CLI'];
    }

    it('blanks an inherited entry that points at a DIFFERENT build', async () => {
      // The dogfooded failure: a review launched from inside a parent Qwen
      // session ran the parent's install for every skill subcommand.
      process.env['QWEN_CODE_CLI'] = process.execPath; // real file, ≠ argv[1]
      armChild(0, { event: 'COMMENT', verdictLine: 'Verdict: Comment' });
      await runHandler();

      // '' counts as unset in stampCliEntryEnv: the child re-stamps its own.
      expect(childEnvValue()).toBe('');
    });

    it('preserves an inherited entry that IS this build', async () => {
      // The outer-launcher case first-writer-wins exists for: an npm bin shim,
      // cli-entry.js, or the desktop bundle stamping this same install.
      process.env['QWEN_CODE_CLI'] = process.argv[1] as string;
      armChild(0, { event: 'COMMENT', verdictLine: 'Verdict: Comment' });
      await runHandler();

      expect(childEnvValue()).toBe(process.argv[1]);
    });

    it('blanks an inherited entry that does not resolve', async () => {
      process.env['QWEN_CODE_CLI'] = join(dir, 'no-such-qwen');
      armChild(0, { event: 'COMMENT', verdictLine: 'Verdict: Comment' });
      await runHandler();

      expect(childEnvValue()).toBe('');
    });

    it('preserves a sibling entry in the same package root (npm layout)', async () => {
      // cli-entry.js stamps itself but spawns cli.js: different files, same
      // directory. An exact-file comparison would blank this valid stamp.
      const bundle = join(dir, 'cli.js');
      const wrapper = join(dir, 'cli-entry.js');
      writeFileSync(bundle, '');
      writeFileSync(wrapper, '');
      const origArgv1 = process.argv[1];
      process.argv[1] = bundle;
      try {
        process.env['QWEN_CODE_CLI'] = wrapper;
        armChild(0, { event: 'COMMENT', verdictLine: 'Verdict: Comment' });
        await runHandler();

        expect(childEnvValue()).toBe(wrapper);
      } finally {
        process.argv[1] = origArgv1;
      }
    });

    it('preserves an inherited entry that is a symlink to this build', async () => {
      const shim = join(dir, 'qwen-shim');
      symlinkSync(process.argv[1] as string, shim);
      process.env['QWEN_CODE_CLI'] = shim;
      armChild(0, { event: 'COMMENT', verdictLine: 'Verdict: Comment' });
      await runHandler();

      expect(childEnvValue()).toBe(shim);
    });
  });

  it('treats a composed verdict without a string event as no verdict', async () => {
    // readComposed must refuse a file whose `event` is not a string, or a
    // corrupt verdict would read as completed with event null and exit 0.
    armChild(0, { event: 123, verdictLine: 'Verdict: Approve' });
    await runHandler();

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(false);
    expect(result.event).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it('reports a launch failure when the child emits an error', async () => {
    // A missing CLI binary or an OS that cannot fork emits `error`, not
    // `close`; the handler must still settle and report "no verdict".
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    });
    await runHandler();

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(false);
    expect(result.childExitCode).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(errs.join('')).toContain('failed to launch the CLI');
  });

  it('streams child progress to stderr, never stdout, when not quiet', async () => {
    // The contract: stdout carries only the result. If progress leaked to
    // stdout it would interleave with the JSON a CI consumer parses.
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('progress noise'));
        child.emit('close', 0);
      });
      return child;
    });
    await runHandler({ quiet: false });

    expect(errs.join('')).toContain('progress noise');
    expect(outs.join('')).not.toContain('progress noise');
  });

  it('reports a timed-out run as incomplete and kills the process group', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockImplementation(() => child);

    const done = runHandler({ 'timeout-minutes': 1 });
    await vi.advanceTimersByTimeAsync(60_000); // fire the timeout
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    // A child that ignores SIGTERM is escalated to SIGKILL after 10 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    child.emit('close', null, 'SIGTERM'); // the kill takes effect
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.childExitCode).toBeNull();
    expect(result.childSignal).toBe('SIGTERM');
    expect(process.exitCode).toBe(1);
  });

  it('keeps a captured verdict when the timeout fires after compose-review', async () => {
    // The race the contract must survive: compose-review writes the verdict
    // (Step 6) and the capture poll snapshots it, but --timeout-minutes fires
    // before the child exits (Steps 7–9). The flag terminates a run "without a
    // verdict", so a captured verdict still counts as completed — the kill must
    // not flip exit 0 to 1 or suppress the verdict, and `timedOut` alone still
    // records that the timer fired.
    vi.useFakeTimers();
    let child!: FakeChild;
    spawnMock.mockImplementation(() => {
      mkdirSync(REVIEW_TMP_DIR, { recursive: true });
      writeFileSync(
        join(REVIEW_TMP_DIR, 'qwen-review-local-composed.json'),
        JSON.stringify({ event: 'APPROVE', verdictLine: 'Verdict: Approve' }),
        'utf8',
      );
      child = new FakeChild();
      return child;
    });

    const done = runHandler({ 'timeout-minutes': 1 });
    // The capture poll snapshots the verdict while the child still runs...
    await vi.advanceTimersByTimeAsync(1_000);
    // ...then the timeout fires and kills the group before the child exits.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.event).toBe('APPROVE');
    expect(process.exitCode).toBe(0);
  });

  it('forwards a parent signal to the child group and exits 128+signum', async () => {
    // The detached child sits outside the foreground group a terminal's
    // Ctrl+C signals, and a cancelled CI job sends the parent SIGTERM.
    // Without forwarding, the parent dies and the review is reparented to
    // PID 1, burning API calls for the full timeout. Pin the registration
    // and the 128+signum mapping so a refactor cannot silently drop them.
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockImplementation(() => child);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const onSpy = vi.spyOn(process, 'on');

    const done = runHandler({ 'timeout-minutes': 1 });

    // All three signals must be registered.
    const registered = onSpy.mock.calls
      .map(([sig]) => sig)
      .filter((sig) => ['SIGHUP', 'SIGINT', 'SIGTERM'].includes(sig as string));
    expect(registered).toEqual(
      expect.arrayContaining(['SIGHUP', 'SIGINT', 'SIGTERM']),
    );

    const handler = onSpy.mock.calls.find(
      ([sig]) => sig === 'SIGTERM',
    )?.[1] as (signal: NodeJS.Signals) => void;
    handler('SIGHUP');
    handler('SIGINT');
    handler('SIGTERM');

    // The group is killed and each signal maps onto 128+signum.
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(exitSpy).toHaveBeenNthCalledWith(1, 129);
    expect(exitSpy).toHaveBeenNthCalledWith(2, 130);
    expect(exitSpy).toHaveBeenNthCalledWith(3, 143);

    // The handler cleared the timeout timer: crossing it must not fire the
    // timeout path (which would write its own stderr notice).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errs.join('')).not.toContain('timeout after');

    child.emit('close', null, 'SIGTERM');
    await done;
  });

  it('prints the verdict line and report path in human-readable mode', async () => {
    armChild(0, { event: 'APPROVE', verdictLine: 'Verdict: Approve' });
    await runHandler({ json: false });

    const output = outs.join('');
    expect(output).toContain('Verdict: Approve');
    expect(output).toContain('Report: ');
    expect(process.exitCode).toBe(0);
  });

  it('distinguishes a corrupt composed artifact from a missing one', async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        mkdirSync(REVIEW_TMP_DIR, { recursive: true });
        writeFileSync(
          join(REVIEW_TMP_DIR, 'qwen-review-local-composed.json'),
          '{truncated',
          'utf8',
        );
        child.emit('close', 0);
      });
      return child;
    });
    await runHandler({ json: false });

    const output = outs.join('');
    expect(output).toContain('could not be parsed');
    expect(output).not.toContain('no composed verdict was produced');
    expect(process.exitCode).toBe(1);
  });

  it('preserves the exit code when writing the result to stdout throws', async () => {
    // The pipe reader can go away (EPIPE) mid-write. The exit code is the
    // contract a CI gate reads, so it must be set before — and survive — the
    // write, not downgraded to yargs' generic exit 1 by the throw.
    armChild(0, {
      event: 'REQUEST_CHANGES',
      verdictLine: 'Verdict: Request changes',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });

    await runHandler({ 'fail-on': 'request-changes' });

    expect(process.exitCode).toBe(3);
  });

  it('clamps a negative timeout to the 1-minute floor', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockImplementation(() => child);

    const done = runHandler({ 'timeout-minutes': -5 });
    // 59 s is under the 1-minute floor — must not fire.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(processKill).not.toHaveBeenCalled();
    // Crossing the floor fires the timeout.
    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', null, 'SIGTERM');
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.timedOut).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('floors a zero timeout to 1 minute rather than the 120-minute default', async () => {
    // `|| 120` treats 0 as falsy and would silently substitute the default;
    // an explicit 0 must still reach the Math.max(1, …) floor.
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockImplementation(() => child);

    const done = runHandler({ 'timeout-minutes': 0 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(processKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.timedOut).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
