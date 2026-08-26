/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Reproduction for issue #9206 — FAILING on the unfixed tree.
//
// /review: chunk retirement silently does not fire in the reverse-audit loop,
// and cleanup destroys the evidence.
//
// A real round-5 reverse audit (PR #9118, 12 chunks) returned substantive dry
// receipts for four chunks in BOTH rounds 1 and 2; rounds 3, 4 and 5 still
// built auditors for all 12 chunks, no `retirement:` note ever appeared, and
// no diagnostic said which certification condition rejected the receipts. Step 9
// cleanup then deleted the prompt-record directory of the non-converged run,
// making the failure undiagnosable after the fact.
//
// This file pins the two expectations the issue states:
//
//   1. A chunk whose two most recent audits returned substantive dry receipts
//      either RETIRES from round 3 on, or the builder emits a diagnostic naming
//      the certification condition that failed. Silently re-auditing a
//      twice-dry chunk with no word anywhere is the bug. Two receipt shapes a
//      human reader calls "substantive dry" stand in for the destroyed real
//      ones: an English receipt whose separator is a period, and a Chinese
//      receipt whose separator is a full-width comma. Both name what the
//      auditor re-examined; both reproduce the reported symptom end to end on
//      the installed CLI (rounds 3-5 build every chunk, zero notes, zero
//      diagnostics).
//   2. Step 9 cleanup of a NON-CONVERGED run (the loop hit its round cap)
//      must leave the prompt-record directory recoverable, because it is the
//      only place the certification history lives.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));
import {
  writeStdoutLine,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { agentPromptCommand } from './agent-prompt.js';
import {
  findingsPointerOf,
  promptRecordDir,
  readRecordedPrompts,
} from './lib/prompt-record.js';
import {
  DEADLINE_ENV,
  RESERVE_ENV,
  TOOL_CONCURRENCY_ENV,
  readBudgetStop,
  writeRoundCapStop,
} from './lib/deadline.js';
import { runCleanup } from './cleanup.js';
import { tmpFile } from './lib/paths.js';

const PLAN = {
  diffPathAbsolute: '/abs/.qwen/tmp/qwen-review-pr-9206-diff.txt',
  chunks: [
    {
      id: 13,
      startLine: 1,
      endLine: 100,
      lines: 100,
      chars: 4000,
      maxLineChars: 100,
      oversized: false,
      files: [
        { path: 'packages/example/src/part1.ts', newStart: 1, newEnd: 100 },
      ],
    },
    {
      id: 14,
      startLine: 101,
      endLine: 200,
      lines: 100,
      chars: 4000,
      maxLineChars: 100,
      oversized: false,
      files: [
        { path: 'packages/example/src/part2.ts', newStart: 1, newEnd: 100 },
      ],
    },
    {
      id: 15,
      startLine: 201,
      endLine: 300,
      lines: 100,
      chars: 4000,
      maxLineChars: 100,
      oversized: false,
      files: [
        { path: 'packages/example/src/part3.ts', newStart: 1, newEnd: 100 },
      ],
    },
  ],
};

// A substantive dry receipt whose separator is a PERIOD: the phrase, a full
// stop, then the clause naming what was re-examined. A human reader calls this
// a clean all-clear; the classifier's separator class (dash / colon) does not.
const DRY_EN_PERIOD =
  'No new issues were found. Re-walked the retry cap and both changed ' +
  "exports' call sites; every gap I checked was already in the confirmed " +
  'list.';

// A substantive Chinese dry receipt whose separator is a full-width COMMA —
// the most natural zh phrasing. Same shape, same problem.
const DRY_ZH_COMMA =
  '未发现新问题，重新走查了重连状态机与两个已改导出的全部调用点，' +
  '每个疑点都已在确认清单中。';

// The canonical shape the classifier accepts — the wiring control.
const DRY_CANONICAL =
  'No new issues found — re-walked the retry cap and both changed ' +
  "exports' call sites; every gap I checked was already in the confirmed " +
  'list.';

const YIELD =
  'Found one gap the prior rounds missed.\n\n' +
  '- **File:** packages/example/src/part3.ts:12\n' +
  '- **Anchor:** const a = 1\n' +
  '- **Issue:** off-by-one in the retry cap\n' +
  '- **Severity:** Suggestion\n';

describe('issue #9206 — retirement must retire twice-dry chunks, or say why it cannot', () => {
  const dirs: string[] = [];
  let dir: string;
  let plan: string;
  let findings: string;
  let seq = 0;
  const SAVED: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'issue-9206-'));
    dirs.push(dir);
    plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(PLAN));
    // Backdate the plan so every record and transcript this test writes
    // clears the plan-mtime fence, exactly like the scheduler's own tests.
    const old = new Date(2020, 0, 1);
    utimesSync(plan, old, old);
    findings = join(dir, 'findings.md');
    writeFileSync(findings, '');
    for (const k of [
      'QWEN_CODE_PROJECT_DIR',
      'QWEN_CODE_SESSION_ID',
      // The budget gate reads these three straight from process.env on
      // every round admission (#9259): an ambient deadline inherited from
      // a concurrent review makes round admission environment-dependent
      // and fails this suite for reasons that have nothing to do with it.
      DEADLINE_ENV,
      RESERVE_ENV,
      TOOL_CONCURRENCY_ENV,
    ]) {
      SAVED[k] = process.env[k];
    }
    process.env['QWEN_CODE_PROJECT_DIR'] = dir;
    process.env['QWEN_CODE_SESSION_ID'] = 'S1';
    delete process.env[DEADLINE_ENV];
    delete process.env[RESERVE_ENV];
    delete process.env[TOOL_CONCURRENCY_ENV];
    mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
  });

  afterEach(() => {
    process.exitCode = undefined;
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Run one --all-chunks round through the real handler. */
  function runRound(round: number): string {
    (writeStdoutLine as unknown as Mock).mockClear();
    (writeStderrLine as unknown as Mock).mockClear();
    // The Safe writer carries the certification diagnostics (#9259) —
    // leaving it out of the round's text makes every `chunk N —` failure
    // line invisible to the assertions below.
    (writeStderrLineSafe as unknown as Mock).mockClear();
    (agentPromptCommand.handler as (a: unknown) => void)({
      plan,
      role: 'reverse-audit',
      findings,
      'all-chunks': true,
      round,
    });
    const out = (writeStdoutLine as unknown as Mock).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    const err = (writeStderrLine as unknown as Mock).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    const safe = (writeStderrLineSafe as unknown as Mock).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    return `${out}\n${err}\n${safe}`;
  }

  /** The recorded launch prompt for one (round, chunk). */
  function recordOf(round: number, chunk: number): string {
    // The exported production reader owns record naming and encoding — a
    // hand-rolled scan here drifts from it silently (the sibling harness
    // in agent-prompt.test.ts calls it for exactly this purpose).
    for (const [key, prompt] of readRecordedPrompts(plan)) {
      if (key.startsWith(`reverse-audit--chunk-${chunk}--round-${round}--`)) {
        return prompt;
      }
    }
    throw new Error(`no record for chunk ${chunk} round ${round}`);
  }

  /**
   * Write a harness-shaped transcript: the recorded prompt delivered VERBATIM
   * (with the block separator above it, as the orchestrator pastes it), one
   * successful read of the baked diff window, then the final text. This
   * satisfies pairing, the tool-call bar and the territory bar — whatever
   * fails afterwards fails in the receipt classification the issue suspects.
   */
  function auditorTranscript(
    launchPrompt: string,
    finalText: string,
    chunk: number,
  ): void {
    const id = `aud-${++seq}`;
    const base = { agentId: id, agentName: 'reverse-audit', sessionId: 'S1' };
    const c = PLAN.chunks.find((x) => x.id === chunk);
    const lines = [
      JSON.stringify({
        ...base,
        type: 'user',
        message: {
          role: 'user',
          parts: [
            { text: `───── auditor — chunk ${chunk} ─────\n\n${launchPrompt}` },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: `${id}-c1`,
                name: 'read_file',
                args: {
                  file_path: PLAN.diffPathAbsolute,
                  offset: (c as { startLine: number }).startLine - 1,
                  limit: (c as { lines: number }).lines,
                },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: `${id}-c1`,
                name: 'read_file',
                response: { output: 'diff bytes' },
              },
            },
          ],
        },
      }),
    ];
    // A compliant auditor reads the cumulative findings list its prompt
    // points at — the comparison against known findings IS the audit's
    // method, and the dry bar (#9091) refuses a receipt from an auditor
    // that skipped the read.
    const pointer = findingsPointerOf(launchPrompt);
    if (pointer !== null) {
      lines.push(
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: `${id}-c2`,
                  name: 'read_file',
                  args: { file_path: pointer },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          ...base,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: `${id}-c2`,
                  name: 'read_file',
                  response: { output: 'findings list' },
                },
              },
            ],
          },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'model', parts: [{ text: finalText }] },
      }),
    );
    writeFileSync(
      join(dir, 'subagents', 'S1', `agent-${id}.jsonl`),
      lines.join('\n') + '\n',
    );
  }

  /**
   * Chunk 15's finding, fresh each round (#9259): a fixed `**File:**` line
   * lands on the baked findings list from round 3 on, the return's only
   * FILE_LINE_RE match reads as a quotation of the list, and the "yields
   * every round" control classifies `unknown` instead — emitting the very
   * diagnostic noise this suite exists to catch. Varying the line number
   * keeps every round's finding off the list the round was launched with.
   */
  function yieldFor(round: number): string {
    return YIELD.replace('part3.ts:12', `part3.ts:${round}2`);
  }

  /** Rounds 1-2 with the given receipt for the two cold chunks; 15 yields. */
  function twiceDry(receipt: string): void {
    for (const round of [1, 2]) {
      runRound(round);
      auditorTranscript(recordOf(round, 13), receipt, 13);
      auditorTranscript(recordOf(round, 14), receipt, 14);
      auditorTranscript(recordOf(round, 15), yieldFor(round), 15);
      // The loop found something every round — grow the list like the real
      // run, so a later round's list holds exactly the earlier rounds'
      // findings and no more.
      appendFileSync(findings, yieldFor(round));
    }
  }

  /**
   * Whether a round's output says something about chunk `id` — a
   * retirement note naming it, or a certification-failure diagnostic
   * naming it and the fallen bar. One predicate at describe scope
   * (#9272): the two tests below assert on the same oracle, and a
   * production-wording change must not pay a double edit (a stale inline
   * copy reads green while asserting the old wording).
   */
  function mentionsChunk(out: string, id: number): boolean {
    return (
      new RegExp(`chunk ${id} — retired`).test(out) ||
      new RegExp(
        `chunk ${id}[^\\n]*(?:certif|receipt|territory|transcript)`,
        'i',
      ).test(out) ||
      new RegExp(
        `(?:certif|receipt|territory|transcript)[^\\n]*chunk ${id}\\b`,
        'i',
      ).test(out)
    );
  }

  it('wiring control: the canonical receipt retires its chunk at round 3', () => {
    twiceDry(DRY_CANONICAL);
    const out = runRound(3);
    expect(out).toContain('1 auditors required this round');
    expect(out).toContain('retirement:');
    expect(out).toContain('chunk 13 — retired: dry in rounds 1 and 2');
    expect(out).toContain('chunk 14 — retired: dry in rounds 1 and 2');
  });

  it.each([
    ['an English receipt separated by a period', DRY_EN_PERIOD],
    ['a Chinese receipt separated by a full-width comma', DRY_ZH_COMMA],
  ])(
    'twice-dry chunks with %s retire at round 3 — or the builder says why certification failed',
    (_label, receipt) => {
      twiceDry(receipt);
      const r3 = runRound(3);

      // The reported symptom: rounds 3-5 each built auditors for EVERY chunk,
      // no retirement note ever appeared, and nothing anywhere said which
      // certification condition rejected the receipts. Either outcome the
      // issue expects must show up in the builder's output — PER CHUNK
      // (#9259): a pair-wide existential match lets one chunk's retirement
      // cover the other's silent re-audit, the asymmetric shape real runs
      // show (#9206 hit 4 of 12 chunks, not all).
      for (const id of [13, 14]) {
        // A twice-dry chunk may stay under audit, but never silently: the
        // round-3 output must carry EITHER a retirement note naming it OR a
        // certification-failure diagnostic. Today it carries neither.
        expect(mentionsChunk(r3, id)).toBe(true);
      }
    },
  );

  it('the silence is not one round: across rounds 3-5 the twice-dry chunks are retired or diagnosed at least once', () => {
    twiceDry(DRY_EN_PERIOD);
    const mentioned = new Set<number>();
    for (const round of [3, 4, 5]) {
      const out = runRound(round);
      // Today every one of these reads `3 auditors required this round`.
      for (const id of [13, 14]) {
        if (mentionsChunk(out, id)) mentioned.add(id);
      }
      // The hot control stays honest (#9259): chunk 15's finding is fresh
      // each round, so it classifies yielded and never produces the
      // certifiable-but-never-retiring diagnostic this suite exists to
      // catch — a `chunk 15 —` failure line here is the harness misreading
      // its own control, not production speaking.
      expect(out).not.toContain('chunk 15 —');
      // Answer whatever chunks the round actually built, so the next round's
      // schedule reads a complete history — the loop shape of the real run.
      for (const m of out.matchAll(/— chunk (\d+)(?: \(cold check\))? ─/g)) {
        const chunkId = Number(m[1]);
        auditorTranscript(
          recordOf(round, chunkId),
          chunkId <= 14 ? DRY_EN_PERIOD : yieldFor(round),
          chunkId,
        );
      }
      // Grow the list with this round's finding, like the real loop.
      appendFileSync(findings, yieldFor(round));
    }
    // Observed today (and on the installed CLI end to end): rounds 3, 4 and 5
    // each built every chunk (`3 auditors required this round` three times)
    // and never said a word about the twice-dry ones. Per chunk (#9259): one
    // chunk's word must not cover the other's silence.
    expect([...mentioned].sort()).toEqual([13, 14]);
  });
});

describe('issue #9206 — Step 9 cleanup must not destroy a non-converged run’s certification history', () => {
  let dir: string;
  let savedCwd: string;

  beforeEach(() => {
    (writeStdoutLine as unknown as Mock).mockClear();
    (writeStderrLine as unknown as Mock).mockClear();
    dir = mkdtempSync(join(tmpdir(), 'issue-9206-cleanup-'));
    savedCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a previous run\u2019s marked stop survives a retry at the same plan path (#9206)', () => {
    // Run A stops without converging (cap marker written) and is killed
    // before Step 9; the CI retry re-captures the plan at the SAME path,
    // so the plan's fresh mtime fences run A's marker out of the
    // verdict-oriented reader. Retention must not key on that fence — the
    // marker is exactly the evidence it exists to keep — or the sweep
    // deletes run A's history with no Kept line: the evidence loss this
    // issue reports, recurring for the killed-run shape.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    const planPath = join(dir, tmpFile('pr-9206', 'fetch.json'));
    writeFileSync(planPath, JSON.stringify({ prNumber: '9206' }));
    const recordDir = promptRecordDir(planPath);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'reverse-audit--chunk-1--round-1--abc123.txt'),
      'a recorded launch prompt — the certification history',
    );
    writeRoundCapStop(planPath, 5, 6);
    // The retry's fresh capture dates the plan AFTER run A's marker.
    const fresh = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(planPath, fresh, fresh);
    expect(readBudgetStop(planPath)).toBeNull(); // fenced out — verdict side

    runCleanup('pr-9206');

    expect(existsSync(recordDir)).toBe(true);
  });

  it('a killed run\u2019s marker-LESS record directory survives too (#9206)', () => {
    // A loop killed mid-round stops without converging and leaves NO
    // marker — only refusals (round cap, budget) write one. Its records
    // predate the retry's plan capture and are the only certification
    // history of the killed run; the sweep must keep them on that signal
    // alone.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    const planPath = join(dir, tmpFile('pr-9206', 'fetch.json'));
    writeFileSync(planPath, JSON.stringify({ prNumber: '9206' }));
    const recordDir = promptRecordDir(planPath);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'reverse-audit--chunk-1--round-1--abc123.txt'),
      'a recorded launch prompt — the certification history',
    );
    // The retry's fresh capture dates the plan after run A's records.
    const fresh = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(planPath, fresh, fresh);

    runCleanup('pr-9206');

    expect(existsSync(recordDir)).toBe(true);
  });

  it('a marker-less kept directory survives a SECOND cleanup once its plan is swept (#9213)', () => {
    // The first cleanup keeps the killed run's record directory but sweeps
    // the plan file beside it (retention only preserves the -prompts
    // entry). A second cleanup before the evidence is examined then finds
    // no marker and an unstatable plan — runEpochMs reads -Infinity, the
    // mtime comparison computes false — and silently deletes the directory
    // the first cleanup explicitly kept. A record directory whose plan is
    // gone is itself the retained shape: keep it.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    const planPath = join(dir, tmpFile('pr-9206', 'fetch.json'));
    const recordDir = promptRecordDir(planPath);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'reverse-audit--chunk-1--round-1--abc123.txt'),
      'a recorded launch prompt — the certification history',
    );
    writeFileSync(planPath, JSON.stringify({ prNumber: '9206' }));
    const fresh = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(planPath, fresh, fresh);

    runCleanup('pr-9206');
    expect(existsSync(recordDir)).toBe(true);
    expect(existsSync(planPath)).toBe(false);

    (writeStdoutLine as unknown as Mock).mockClear();
    runCleanup('pr-9206');

    expect(existsSync(recordDir)).toBe(true);
    const out = (writeStdoutLine as unknown as Mock).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(out).toContain('Kept');
  });

  it('one unstatable record entry does not veto the previous-run evidence (#9213)', () => {
    // Retention is existential — ANY file older than the plan — but the
    // scan wrapped every stat in ONE try/catch, so a single broken entry
    // (a vanished file, a planted broken symlink) aborted the walk and
    // swept the older evidence beside it. `a-broken-symlink` sorts before
    // the record, so the old code hit the throw first.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    const planPath = join(dir, tmpFile('pr-9206', 'fetch.json'));
    const recordDir = promptRecordDir(planPath);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'reverse-audit--chunk-1--round-1--abc123.txt'),
      'a recorded launch prompt — the certification history',
    );
    symlinkSync(
      join(dir, 'does-not-exist'),
      join(recordDir, 'a-broken-symlink'),
    );
    writeFileSync(planPath, JSON.stringify({ prNumber: '9206' }));
    const fresh = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(planPath, fresh, fresh);

    runCleanup('pr-9206');

    expect(existsSync(recordDir)).toBe(true);
  });

  it('records NEWER than the plan are this run\u2019s — a single run still sweeps (#9213)', () => {
    // The negative direction of the mtime signal: only records OLDER than
    // the plan are a previous run's. A converged single run writes its
    // records after the capture and leaves no marker — its history earned
    // nothing, and the sweep takes it. Pinning the comparison keeps a
    // `<` \u2192 `!==` mutant (retain a converged run's own records forever,
    // under a false Kept claim) from shipping green.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    const planPath = join(dir, tmpFile('pr-9206', 'fetch.json'));
    writeFileSync(planPath, JSON.stringify({ prNumber: '9206' }));
    const recordDir = promptRecordDir(planPath);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'reverse-audit--chunk-1--round-1--abc123.txt'),
      'this run\u2019s own record',
    );

    runCleanup('pr-9206');

    expect(existsSync(recordDir)).toBe(false);
  });

  it('a non-converged run (round cap hit) keeps its prompt-record directory', () => {
    // The real run's shape: the loop never converged and hit the 5-round cap,
    // so the builder wrote its round-cap stop marker INSIDE the record dir.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    const planPath = join(dir, tmpFile('pr-9206', 'fetch.json'));
    writeFileSync(planPath, JSON.stringify({ prNumber: '9206' }));
    const recordDir = promptRecordDir(planPath);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'reverse-audit--chunk-1--round-1--abc123.txt'),
      'a recorded launch prompt — the certification history',
    );
    writeRoundCapStop(planPath, 5, 6);
    expect(readBudgetStop(planPath)?.cause).toBe('round-cap');

    runCleanup('pr-9206');

    // Expected (issue #9206): a non-converged run keeps the record directory
    // (or a copy beside the saved report) so the no-retirement loop can be
    // diagnosed. Observed: cleanup deletes it unconditionally — the same
    // `Removed temp file: …-fetch-prompts` that destroyed the PR #9118
    // evidence.
    expect(existsSync(recordDir)).toBe(true);
  });
});
