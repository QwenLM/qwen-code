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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

const { buildReviewPrompt, newestArtifactSince, exitCodeFor, runCommand } =
  await import('./run.js');
const { REVIEW_TMP_DIR, REVIEWS_DIR } = await import('./lib/paths.js');

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

  it('returns the newest matching artifact from this run', () => {
    const start = Date.now() - 10_000;
    file('qwen-review-local-composed.json', start + 1_000);
    const newer = file('qwen-review-pr-9-composed.json', start + 5_000);
    file('unrelated.json', start + 9_000);

    expect(
      newestArtifactSince(dir, /^qwen-review-.*composed\.json$/, start),
    ).toBe(newer);
  });

  it('returns null when the directory does not exist', () => {
    expect(
      newestArtifactSince(join(dir, 'absent'), /composed/, Date.now()),
    ).toBeNull();
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

describe('review run (handler)', () => {
  let dir: string;
  let cwd: string;
  let outs: string[];
  let exitCode: number | undefined;
  let processKill: ReturnType<typeof vi.spyOn>;

  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = Object.assign(new EventEmitter(), { resume: () => {} });
    stderr = Object.assign(new EventEmitter(), { resume: () => {} });
    kill = vi.fn();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-handler-'));
    cwd = process.cwd();
    process.chdir(dir);
    outs = [];
    exitCode = process.exitCode as number | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      outs.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    armChild(0, {
      event: 'REQUEST_CHANGES',
      verdictLine: 'Verdict: Request changes',
      baseEvent: 'REQUEST_CHANGES',
      cappedBy: [],
      downgraded: false,
      downgradedFrom: null,
      remediation: [],
    });
    await runHandler();

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(true);
    expect(result.event).toBe('REQUEST_CHANGES');
    expect(result.verdictLine).toBe('Verdict: Request changes');
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

  it('reports a timed-out run as incomplete and kills the process group', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockImplementation(() => child);

    const done = runHandler({ 'timeout-minutes': 1 });
    await vi.advanceTimersByTimeAsync(60_000); // fire the timeout
    child.emit('close', null, 'SIGTERM'); // the kill takes effect
    await done;

    const result = JSON.parse(outs.join(''));
    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.childExitCode).toBeNull();
    expect(result.childSignal).toBe('SIGTERM');
    expect(process.exitCode).toBe(1);
    expect(processKill).toHaveBeenCalledWith(-12345, 'SIGTERM');
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
});
