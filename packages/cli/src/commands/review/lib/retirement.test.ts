/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleReverseAuditRound } from './retirement.js';
import { appendRunSession, recordResume } from './run-ledger.js';
import {
  findingsPointerOf,
  promptRecordDir,
  recordPrompt,
  writeFindingsFile,
} from './prompt-record.js';
import { REVERSE_AUDIT_EXAMPLE_RECEIPT } from './agent-briefs.js';

// Direct unit coverage for the scheduler's own rules — the classifier's
// thresholds, the outcome merge, the injective guard and the parity rules —
// driving `scheduleReverseAuditRound` over synthetic histories instead of
// the full command handler. The handler tests exercise the same module end
// to end; this file is where a guard wired in the wrong direction fails
// loudly at the level it lives at.

const DRY =
  'No new issues found — re-walked the whole territory, the retry cap and ' +
  "both changed exports' call sites; every gap I checked was already in " +
  'the confirmed list.';
const WHIFF = 'No issues found.';
const YIELD =
  'Found one gap the prior rounds missed.\n\n' +
  '- **File:** packages/cli/src/commands/review/x.test.ts:12\n' +
  '- **Anchor:** const a = 1\n' +
  '- **Issue:** off-by-one in the retry cap\n' +
  '- **Severity:** Suggestion\n';

describe('scheduleReverseAuditRound — the scheduler on its own', () => {
  let dir: string;
  let plan: string;
  let diff: string;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retirement-'));
    plan = join(dir, 'plan.json');
    writeFileSync(plan, '{}');
    // Backdate the plan so every transcript this test writes counts as
    // newer — the same mtime fence the scheduler applies against a previous
    // review's agents in the same session.
    const old = new Date(2020, 0, 1);
    utimesSync(plan, old, old);
    diff = join(dir, 'diff.txt');
    process.env['QWEN_CODE_PROJECT_DIR'] = dir;
    process.env['QWEN_CODE_SESSION_ID'] = 'S1';
    mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_PROJECT_DIR'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Record a built (chunk, round) prompt the way the builder does. The role
   * id is stapled onto the body because the real builder always emits it —
   * the identity line and the brief path both carry `reverse-audit` — and
   * the scheduler's cheap transcript pre-filter keys on it: a synthetic
   * launch without it is dropped before the pairing walk.
   */
  function record(
    round: number,
    chunk: number,
    body: string,
    digest = 'abc123',
  ): string {
    const prompt = `reverse-audit ${body}`;
    recordPrompt(
      plan,
      `reverse-audit--chunk-${chunk}--round-${round}--${digest}`,
      prompt,
    );
    return prompt;
  }

  /** Where `record` put a key's file — for tests that backdate one. */
  function recordFile(round: number, chunk: number, digest: string): string {
    return join(
      promptRecordDir(plan),
      `${encodeURIComponent(`reverse-audit--chunk-${chunk}--round-${round}--${digest}`)}.txt`,
    );
  }

  /**
   * Write a transcript the way the harness writes one: launch prompt first,
   * then `calls` successful reads of `filePath` (the diff unless told
   * otherwise), then the final text. `calls: 0` is the whiff shape — prose
   * and nothing else.
   */
  function transcript(
    launchPrompt: string,
    finalText: string,
    calls = 1,
    filePath: string = diff,
    offset = 0,
    limit = 100,
  ): void {
    const id = `aud-${++seq}`;
    const base = {
      agentId: id,
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    const lines = [
      JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', parts: [{ text: launchPrompt }] },
      }),
    ];
    for (let i = 0; i < calls; i++) {
      lines.push(
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { file_path: filePath, offset, limit },
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
                  name: 'read_file',
                  response: { output: 'diff bytes' },
                },
              },
            ],
          },
        }),
      );
    }
    // A compliant auditor reads the cumulative findings list its prompt
    // points at — the comparison against known findings IS the audit's
    // method, and the scheduler now refuses receipts from an auditor that
    // skipped it. Modeled by default, like the brief-opens elsewhere; a test
    // that wants a skipping auditor writes its own transcript.
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
                  name: 'read_file',
                  response: { output: 'the cumulative list' },
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

  function schedule(round: number, chunks = [13, 14, 15]) {
    return scheduleReverseAuditRound(plan, chunks, round, process.env, diff);
  }

  /** Two dry rounds answered honestly, one transcript per record. */
  function dryTwice(chunks: number[]): void {
    for (const r of [1, 2]) {
      for (const c of chunks) {
        transcript(record(r, c, `chunk ${c} round ${r} territory walk`), DRY);
      }
    }
  }

  it('rounds 1 and 2 fan out to every chunk, reading no history', () => {
    expect(schedule(1)).toEqual({
      due: [13, 14, 15],
      coldChecks: [],
      skipped: [],
      narrowed: [],
      converged: false,
      // No history yet — nothing is certifiable, so nothing is diagnosed.
      diagnostics: [],
    });
    expect(schedule(2).due).toEqual([13, 14, 15]);
  });

  it('posture narrowing drops a dry non-delta chunk, keeps yields and unknowns (#10104)', () => {
    // Delta territory: 13. 14 and 15 are interaction-only chunks.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), YIELD);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY);
    transcript(record(1, 14, 'chunk 14 round 1 territory walk'), DRY);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk'), DRY);
    transcript(record(1, 15, 'chunk 15 round 1 territory walk'), DRY);
    transcript(record(2, 15, 'chunk 15 round 2 territory walk'), YIELD);
    record(1, 16, 'chunk 16 round 1 territory walk'); // no transcript: unknown
    record(2, 16, 'chunk 16 round 2 territory walk');

    const r3 = scheduleReverseAuditRound(
      plan,
      [13, 14, 15, 16],
      3,
      process.env,
      diff,
      { deltaChunkIds: new Set([13]) },
    );
    // 13 is delta and keeps the ordinary rules (yield+dry: hot). 14 is
    // non-delta with a dry latest audit: narrowed out, no cold check. 15
    // yielded last wave: due. 16 never certified anything: fails toward
    // auditing, due.
    expect(r3.due).toEqual([13, 15, 16]);
    expect(r3.narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
    expect(r3.coldChecks).toEqual([]);
    expect(r3.converged).toBe(false);
  });

  it('a retired DELTA chunk still cold-checks; a narrowed one never does', () => {
    dryTwice([13, 14]);
    const narrowing = { deltaChunkIds: new Set([13]) };
    const r3 = scheduleReverseAuditRound(
      plan,
      [13, 14],
      3,
      process.env,
      diff,
      narrowing,
    );
    expect(r3.due).toEqual([]);
    expect(r3.skipped).toEqual([
      { chunkId: 13, dryRounds: [1, 2], nextColdCheck: 4 },
    ]);
    expect(r3.narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
    // Every chunk left the wave — the audit has converged, and the narrowed
    // chunk's exit is the posture's own ruling, disclosed, not a gap.
    expect(r3.converged).toBe(true);

    const r4 = scheduleReverseAuditRound(
      plan,
      [13, 14],
      4,
      process.env,
      diff,
      narrowing,
    );
    // The even round: the retired delta chunk takes its cold check; the
    // narrowed chunk stays out.
    expect(r4.due).toEqual([13]);
    expect(r4.coldChecks).toEqual([13]);
    expect(r4.narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
  });

  it('without a narrowing context the schedule is what it always was', () => {
    dryTwice([13, 14, 15]);
    const r3 = schedule(3);
    expect(r3.due).toEqual([]);
    expect(r3.narrowed).toEqual([]);
    expect(r3.skipped).toHaveLength(3);
  });

  it('a disclosure cannot BE the receipt — but cannot BLOCK a real one either', () => {
    // Two directions, one rule: the receipt is judged with its
    // `Budget gap:` lines stripped. A return whose only substance is its
    // disclosures must not retire the chunk still owing the work (the
    // admission doubling as the receipt). And a receipt substantive
    // without them — a proven territory walk that found nothing new —
    // must still retire, or a reverse auditor whose ceiling is routinely
    // met (its brief orders the whole findings list read) makes
    // convergence impossible and runs every budgeted loop to the round
    // cap. The gap is coverage's to report and Step 3D's to rule on.
    const ONLY_GAPS =
      'No new issues found —\n' +
      'Budget gap: the reconnect state machine walk\n' +
      'Budget gap: the two remaining changed-export call-site traces';
    const DRY_WITH_GAP =
      DRY + '\nBudget gap: second-order callers outside this chunk';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY_WITH_GAP);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY_WITH_GAP);
    transcript(record(1, 14, 'chunk 14 round 1 territory walk'), ONLY_GAPS);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk'), ONLY_GAPS);
    record(1, 15, 'chunk 15 round 1 territory walk');
    record(2, 15, 'chunk 15 round 2 territory walk');

    const r3 = schedule(3);
    // 13 retires on its substantive-without-gaps receipts; 14's
    // gaps-as-receipt returns keep it due.
    expect(r3.due).toEqual([14, 15]);
    expect(r3.skipped).toEqual([
      { chunkId: 13, dryRounds: [1, 2], nextColdCheck: 4 },
    ]);
    expect(r3.converged).toBe(false);
  });

  it('an inline disclosure cannot lend the receipt its substance', () => {
    // A one-line return puts the disclosure AFTER the receipt separator,
    // where the line-based strip cannot see it — and the clause capture
    // would absorb the gap text and pass the substance check on it. The
    // clause is cut at the inline marker first: with nothing before the
    // disclosure, the receipt is bare and the chunk stays due. A zh
    // disclosure counts the same — the receipt regex accepts zh receipts,
    // so the guard must too.
    const INLINE = 'No new issues found — Budget gap: the remaining traces';
    const INLINE_ZH = '未发现新问题——预算缺口：其余调用点追踪';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), INLINE);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), INLINE);
    transcript(record(1, 14, 'chunk 14 round 1 territory walk'), INLINE_ZH);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk'), INLINE_ZH);
    record(1, 15, 'chunk 15 round 1 territory walk');
    record(2, 15, 'chunk 15 round 2 territory walk');

    const r3 = schedule(3);
    expect(r3.due).toEqual([13, 14, 15]);
    expect(r3.skipped).toEqual([]);
  });

  it('a chunk twice dry retires on the odd round and cold-checks on the even one', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY);
    // 14 and 15 stay hot: records with no transcript certify nothing.
    record(1, 14, 'chunk 14 round 1 territory walk');
    record(2, 14, 'chunk 14 round 2 territory walk');
    record(1, 15, 'chunk 15 round 1 territory walk');
    record(2, 15, 'chunk 15 round 2 territory walk');

    const r3 = schedule(3);
    expect(r3.due).toEqual([14, 15]);
    expect(r3.coldChecks).toEqual([]);
    expect(r3.converged).toBe(false);
    expect(r3.skipped).toEqual([
      { chunkId: 13, dryRounds: [1, 2], nextColdCheck: 4 },
    ]);

    const r4 = schedule(4);
    expect(r4.due).toEqual([13, 14, 15]);
    expect(r4.coldChecks).toEqual([13]);
    expect(r4.skipped).toEqual([]);
  });

  it('a bare receipt is not dry — the substance floor rejects it', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    // The stock sixteen-character sentence, with the tool calls to look
    // believable: the floor still reads it as `unknown`, not `dry`.
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), WHIFF);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('a return that never opened the diff is not dry, however substantive it sounds', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY, 0);

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('successful calls that never touched the diff are not dry — the two guards are independent', () => {
    // Every other transcript here reads the diff, so `successfulToolCalls`
    // and `diffToolCalls` move in lockstep and the classifier's two guards
    // are exercised only together. An auditor that reads only its own brief
    // clears the first guard but not the second: the receipt must still
    // read `unknown`, so the chunk stays under audit.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      DRY,
      1,
      join(dir, 'brief.md'),
    );

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('a finding outranks a dry receipt — yielded history keeps the chunk hot', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), YIELD);

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('one launch matching several records certifies none — the guard is records per transcript', () => {
    // The shortcut's real shape is ONE agent handed the whole round's
    // blocks. Its single transcript verbatim-contains every record, so it
    // is each record's unique match — counting transcripts per record
    // would credit every chunk the same receipt and retire the round
    // whole. Matching several records, it must certify none.
    const r1 = [13, 14].map((c) => record(1, c, `chunk ${c} round 1 walk`));
    const r2 = [13, 14].map((c) => record(2, c, `chunk ${c} round 2 walk`));
    transcript(r1.join('\n\n'), DRY);
    transcript(r2.join('\n\n'), DRY);

    const r3 = schedule(3, [13, 14]);
    expect(r3.due).toEqual([13, 14]);
    expect(r3.skipped).toEqual([]);
    expect(r3.converged).toBe(false);
  });

  it('several honest transcripts for ONE record all certify it — the relaunch merge', () => {
    // SKILL mandates relaunching a whiffing auditor once within the round,
    // with the same block verbatim: two transcripts, one record. Both must
    // count — the whiff reads `unknown`, the substantive receipt `dry`,
    // and the merge takes the dry.
    const p1 = record(1, 13, 'chunk 13 round 1 territory walk');
    transcript(p1, WHIFF, 0);
    transcript(p1, DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a yield in ANY matching transcript outranks the merge', () => {
    const p1 = record(1, 13, 'chunk 13 round 1 territory walk');
    transcript(p1, YIELD);
    transcript(p1, DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY);

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('staggered certificates share one parity — both cold-check on the even round', () => {
    // 13 earns its certificate off rounds 1,2; 14 a round later, off 2,3.
    // Per-chunk parity anchors would cold-check them on opposite rounds
    // forever; one global parity lines them up.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY);
    transcript(record(1, 14, 'chunk 14 round 1 territory walk'), YIELD);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk'), DRY);
    transcript(record(3, 14, 'chunk 14 round 3 territory walk'), DRY);

    // Round 3: 13 retired (odd round → skipped); 14's certificate only
    // completes once its round-2 and round-3 audits are both in history.
    expect(schedule(3, [13, 14]).due).toEqual([14]);
    // Round 4: both retired, both cold-checked together.
    const r4 = schedule(4, [13, 14]);
    expect(r4.due).toEqual([13, 14]);
    expect(r4.coldChecks).toEqual([13, 14]);
  });

  it('all retired and none due is convergence', () => {
    dryTwice([13, 14]);
    const r3 = schedule(3, [13, 14]);
    expect(r3.due).toEqual([]);
    expect(r3.coldChecks).toEqual([]);
    expect(r3.converged).toBe(true);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13, 14]);
  });

  it('a yielding cold check puts the chunk back on the every-round schedule', () => {
    dryTwice([13]);
    // Round 3 skipped; round 4 is the cold check — and it yields.
    transcript(record(4, 13, 'chunk 13 round 4 territory walk'), YIELD);

    const r5 = schedule(5, [13]);
    expect(r5.due).toEqual([13]);
    expect(r5.coldChecks).toEqual([]);
    expect(r5.converged).toBe(false);
  });

  it('the records of the round being built are not history', () => {
    dryTwice([13]);
    // A rebuild of round 3 (a repaired delivery) writes a round-3 record
    // before the schedule is asked; it must not count as evidence.
    record(3, 13, 'chunk 13 round 3 territory walk');
    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
  });

  it('transcripts older than the plan do not count', () => {
    const p1 = record(1, 13, 'chunk 13 round 1 territory walk');
    const p2 = record(2, 13, 'chunk 13 round 2 territory walk');
    transcript(p1, DRY);
    transcript(p2, DRY);
    // Age every transcript this test wrote to a fixed past (a previous
    // review in the same session), then move the fence past it. The
    // records keep their real mtimes and stay fresh, so only the
    // transcripts age out — unfenced, they would verbatim-match the
    // records and retire the chunk. Advancing the plan to a FUTURE
    // instant instead would fence the records out too, and `due` would
    // pass with zero records regardless of transcripts.
    const old = new Date(2021, 0, 1);
    for (const name of readdirSync(join(dir, 'subagents', 'S1'))) {
      utimesSync(join(dir, 'subagents', 'S1', name), old, old);
    }
    const fence = new Date(2022, 0, 1);
    utimesSync(plan, fence, fence);

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it("records older than the plan are a dead attempt's — the retry still retires", () => {
    // The CI retry re-runs the review at the SAME plan path and nothing
    // clears the record dir. The dead attempt's findings list is a prefix of
    // the retry's, so the retry's honest launch verbatim-contains BOTH
    // records for a (chunk, round) — unfenced, the injectivity guard counts
    // two records for one transcript and certifies neither, and the retry
    // never retires a chunk. Fenced by file mtime against the plan — the
    // same fence the transcripts and the budget files take — the dead
    // records read as absent and the honest pair certifies.
    const fresh: string[] = [];
    for (const r of [1, 2]) {
      record(r, 13, `chunk 13 round ${r} territory walk`, 'dead01');
      fresh.push(
        record(
          r,
          13,
          `chunk 13 round ${r} territory walk\nwith the retry's grown findings list`,
        ),
      );
    }
    transcript(fresh[0], DRY);
    transcript(fresh[1], DRY);
    // Both attempts' records fresh: ambiguous, so nothing certifies — the
    // exact shape the probe measured (`two attempts, twice dry → due: [13]`).
    expect(schedule(3, [13]).due).toEqual([13]);

    // Backdate the dead attempt's records past the plan's mtime: fenced out,
    // the retry's own pair is each transcript's unique match, and it retires.
    const dead = new Date(2019, 0, 1);
    utimesSync(recordFile(1, 13, 'dead01'), dead, dead);
    utimesSync(recordFile(2, 13, 'dead01'), dead, dead);
    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('an honest short English receipt is dry — structure, not a length floor', () => {
    // 78 characters, the probe that stayed hot under the old 120-char floor:
    // the phrase, the dash, and a clause naming what was re-walked.
    const receipt =
      'No issues found — re-walked the retry cap and both changed ' +
      "exports' call sites.";
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a receipt whose phrase is bolded is dry — emphasis is not a sentence break', () => {
    // Auditors bold the phrase in the same **File:** / **Severity:** idiom
    // the pipeline writes in; the old separator class refused the closing
    // marks, so the most idiomatic shape never retired — on the unfixed
    // class this receipt reads `unknown` and the chunk stays due.
    const receipt =
      '**No issues found** — re-walked the retry cap and both changed ' +
      "exports' call sites.";
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a bolded Chinese phrase is dry, exactly like the English one', () => {
    const receipt =
      '**未发现新问题** —— 重新走查了重连状态机与两个已改导出的全部调用点,' +
      '每个疑点都已在确认清单中。';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a parenthesised scope between phrase and separator is dry', () => {
    // The filler admits parentheses beside words: a scope label is not a
    // sentence break, and the clause after the separator still names the
    // territory.
    const receipt =
      'No new issues found (chunk 13) — re-walked the retry cap and both ' +
      "changed exports' call sites.";
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a Chinese receipt with a named territory is dry', () => {
    // The other probe: auditors narrate in the review's output language, and
    // the old English-only phrase left a zh receipt `unknown` at any length.
    const receipt =
      '未发现新问题——重新走查了重连状态机与两个已改导出的全部调用点,' +
      '每个疑点都已在确认清单中。';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('the bare zh stock sentence is not dry, exactly like the English one', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      '未发现问题。',
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('a receipt whose clause names nothing is not dry', () => {
    // The structure is phrase, separator, then a clause that NAMES what was
    // examined — "all good." clears a separator but names no territory.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      'No new issues found — all good.',
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('a launch without the builder’s role marker certifies nothing', () => {
    // The real builder never emits a reverse-audit launch without the role
    // id in it, and the scheduler drops marker-less transcripts before the
    // pairing walk. A hand-built record whose body lacks it can only lose
    // matches — and a lost match fails toward auditing.
    for (const r of [1, 2]) {
      const bare = `chunk 13 round ${r} bare body`;
      recordPrompt(plan, `reverse-audit--chunk-13--round-${r}--abc123`, bare);
      transcript(bare, DRY);
    }

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('an echoed file line is not a yield — and its prose lead is not the form (#9213)', () => {
    // The cumulative list rides in the launch prompt, and an auditor
    // explaining "already covered" can quote an entry's **File:** line
    // into its return. A quotation is not a report: a filed finding
    // carries the full block, severity included, and only the pair reads
    // as `yielded`. The echo's leading prose is not the receipt FORM
    // either — an admission riding that same line-before-the-receipt
    // shape retired a chunk on the probe (#9213) — so the return reads
    // `unknown`, DIAGNOSED: a yield suppresses its diagnostic, and this
    // one names the bar, proving the echo reached the form, not the
    // filing check.
    const echo =
      'The cumulative list already covers **File:** src/pay.ts:42 — not ' +
      're-reporting it.\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const built = record(r, 13, `chunk 13 round ${r} territory`);
      transcript(built, echo);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not matched; round 2: receipt not matched',
    ]);
  });

  it.each([
    [
      'a passive no+noun admission (no regressions were verified)',
      'No issues found — re-walked the reconnect path; no regressions ' +
        'were verified.',
      'receipt clause contradicts the phrase',
    ],
    [
      'the incapacity compound 未来得及',
      '未发现问题——走查了解析器，未来得及检查生成的文件。',
      'receipt clause contradicts the phrase',
    ],
    [
      'a limiter before the walk verb (没有回归，只走查了X)',
      '未发现问题——没有回归，只走查了解析器与调用点。',
      'receipt clause contradicts the phrase',
    ],
    [
      'an un-examined admission (unexamined)',
      'No issues found — re-walked the scheduler; the fallback path ' +
        'went unexamined.',
      'receipt clause contradicts the phrase',
    ],
    [
      'a no+verb admission (no verification)',
      'No issues found — I did no verification of the parser or its callers.',
      'receipt clause contradicts the phrase',
    ],
    [
      'a strip-dead noun in the passive seat (no issues were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a strip-dead noun with an adverb between (no issues at all were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues at all were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a strip-dead noun, findings (no findings were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no findings were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a strip-dead noun, gaps (no gaps are verified outstanding)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no gaps are verified outstanding.',
      'receipt clause restates the all-clear',
    ],
    [
      'a strip-dead noun in a filler-seat clause (there were no issues verified)',
      'No issues found — there were no issues verified this round across ' +
        'the reconnect state machine and its call sites.',
      'receipt clause restates the all-clear',
    ],
    [
      'a passive head with a non-walk participle (no issues were checked)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were checked.',
      'receipt clause restates the all-clear',
    ],
    [
      'a get-passive head with a non-walk participle (no issues got checked)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues got checked.',
      'receipt clause restates the all-clear',
    ],
    [
      'a passive head with a non-walk participle (no issues were confirmed)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were confirmed.',
      'receipt clause restates the all-clear',
    ],
    [
      'a hyphenated walk verb in the passive seat (no issues were re-verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were re-verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a passive seat across a no-break space (no issues NBSP were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues\u00A0were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a passive seat across an ideographic space (no issues U+3000 were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues\u3000were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a passive seat across a parenthetical (no issues, however, were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues, however, were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a passive seat across parens (no issues (all 12) were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues (all 12) were verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a prefixed one-token participle in the passive seat (no issues were reverified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were reverified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a prefixed one-token participle in the passive seat (no issues were retraced)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were retraced.',
      'receipt clause restates the all-clear',
    ],
    [
      'a blanket-found pardon with an admission spliced after (nothing was verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues were found because nothing was verified.',
      'receipt clause restates the all-clear',
    ],
    [
      'a headless reduced passive (no issues checked)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues checked.',
      'receipt clause restates the all-clear',
    ],
    [
      'a dash-split passive (no issues — were verified)',
      'No issues found — re-walked the reconnect state machine and its ' +
        'call sites; no issues — were verified across every call site.',
      'receipt clause restates the all-clear',
    ],
  ])(
    'an admission stays marked, however the absence-of-problems phrasing tempts an exception: %s (#9272)',
    (_label, leaked, failure) => {
      // The fleet-family fixtures restate the receipt's core in the
      // clause — the passive/reduced/spliced family three shipped guard
      // shapes failed to close — and fall to the restatement bar by FORM
      // (`receipt clause restates the all-clear`), no lookahead, no
      // enumeration. The marker fixtures carry no core, so the bare
      // marker list itself contradicts them (`…contradicts the phrase`).
      // The expected bar rides with each tuple.
      transcript(record(1, 13, 'chunk 13 round 1 territory walk'), leaked);
      transcript(record(2, 13, 'chunk 13 round 2 territory walk'), leaked);

      const r3 = schedule(3, [13]);
      expect(r3.due).toEqual([13]);
      expect(r3.skipped).toEqual([]);
      expect(r3.diagnostics).toEqual([
        `chunk 13 — round 1: ${failure}; round 2: ${failure}`,
      ]);
    },
  );

  it('an honest absence-of-problems receipt stays under audit — the accepted residue (#9272)', () => {
    // `verified no regressions` is honest audit prose, and it reads
    // `unknown` anyway: the exception that would spare it licenses
    // admissions no regex enumeration closes (executed, two rounds
    // running). The chunk simply stays under audit — the failure
    // direction this module declares.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No issues found — verified no regressions in the reconnect path ' +
          'and re-walked its call sites.',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause contradicts the phrase; round 2: receipt clause contradicts the phrase',
    ]);
  });

  it('an echo in a walk verb\u2019s object seat restates the all-clear — the form refuses it (#9272)', () => {
    // The object-seat restatement reads as the all-clear the walk
    // produced — and it is refused anyway: no regex tells `verified no
    // issues in X` from an admission wearing the same words, so the form
    // forbids the restatement outright (the brief now mandates the
    // clause never restates the all-clear). Fails toward audit — the
    // declared direction — and stays out of the enumeration trap the
    // last three guard shapes fell into (#9272 rounds 4-6).
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No issues found — re-walked the scheduler and verified no ' +
          'issues in it or its callers.',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause restates the all-clear; round 2: receipt clause restates the all-clear',
    ]);
  });

  it('a lead filler carrying walk vocabulary still retires — the lead never restates (#9272)', () => {
    // `No issues found after verification — …` puts the walk in the
    // receipt's own filler: the lead strip removes the phrase core, the
    // residue carries no marker, and the clause narrates without
    // restating — the honest shape the form keeps retiring.
    const receipt =
      'No issues found after verification — re-walked the parser and both ' +
      'of its call sites.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
  });

  it('a Chinese receipt separated by a full-width colon is dry', () => {
    // U+FF1A is the standard zh separator; the receipt's separator class
    // admits a colon in either width. Probed on the unfixed class: the
    // byte-identical receipt with an ASCII colon retired while this one
    // read `unknown` and re-audited every round.
    const receipt =
      '未发现问题：重新走查了重连状态机与两个已改导出的全部调用点,' +
      '每个疑点都已在确认清单中。';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('an English receipt separated by a period is dry (#9206)', () => {
    // One of the two shapes that never retired on the run the issue
    // reports: the phrase, a full stop, then the clause naming the walk.
    // The clause is the substance; the stop only has to open it.
    const receipt =
      'No new issues were found. Re-walked the retry cap and both changed ' +
      "exports' call sites; every gap I checked was already in the list.";
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
  });

  it('a Chinese receipt separated by a full-width comma is dry (#9206)', () => {
    // The other shape: the most natural zh phrasing, comma-led clause.
    const receipt =
      '未发现新问题，重新走查了重连状态机与两个已改导出的全部调用点，' +
      '每个疑点都已在确认清单中。';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
  });

  it.each([
    [
      'an ASCII comma',
      'No new issues were found, re-walked the retry cap and both changed ' +
        "exports' call sites; every gap I checked was already confirmed.",
    ],
    [
      'an ASCII semicolon',
      'No new issues found; re-walked the retry cap and both changed ' +
        "exports' call sites.",
    ],
    [
      'a full-width period',
      '未发现问题。重新走查了重连状态机与两个已改导出的全部调用点,' +
        '每个疑点都已在确认清单中。',
    ],
    [
      'a full-width semicolon',
      '未发现新问题；重新走查了重连状态机与两个已改导出的全部调用点，' +
        '每个疑点都已在确认清单中。',
    ],
  ])(
    'a receipt separated by %s is dry, like the period and full-width comma (#9206)',
    (_label, receipt) => {
      // The widened class admits six new separators; the suite must pin
      // every one it admits. Dropping any of these four from the class
      // reads such receipts `unknown` again — chunks silently never
      // retire, the exact #9206 failure mode, and no test fails.
      transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
      transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

      const r3 = schedule(3, [13]);
      expect(r3.due).toEqual([]);
      expect(r3.converged).toBe(true);
    },
  );

  it('a hedged receipt is not dry — a clause that CONTRADICTS the phrase proves no walk (#9206)', () => {
    // The widening admitted sentence punctuation; the substance floor
    // measures length and objects, never polarity — so an auditor that
    // admitted it never checked still cleared the floor and retired the
    // chunk. Probed pre-guard: the receipt read `dry` and the chunk
    // retired; under the pre-widening class both reads were `unknown`.
    const hedged =
      'No new issues were found, but I could not open the generated files ' +
      'and did not check them.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), hedged);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), hedged);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('a dash-led hedge is not dry either — the polarity guard covers every separator path (#9206)', () => {
    const hedged =
      'No new issues were found — but the generated files would not open ' +
      'and I did not check them.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), hedged);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), hedged);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('a Chinese hedged receipt is not dry, exactly like the English one (#9206)', () => {
    const hedged = '未发现新问题，但是我未能打开生成的文件，没有检查它们。';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), hedged);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), hedged);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it.each([
    [
      'a trailing though with a listed marker in the clause',
      'No new issues were found. I could not open the generated files, ' +
        'though.',
    ],
    [
      'a hedge led by Yet',
      'No new issues were found. Yet I could not open the generated files ' +
        'and did not check them.',
    ],
    [
      'a hedge led by unfortunately',
      'No new issues were found; unfortunately the generated files would ' +
        'not open and I did not check them.',
    ],
    [
      'a Chinese hedge with 只是 and listed markers (未能/没有)',
      '未发现新问题，只是我未能打开生成的文件，没有检查它们。',
    ],
    [
      'a comma-led incapacity admission carrying listed markers',
      'No new issues were found, I could not open the generated files and ' +
        'did not check them.',
    ],
    [
      'a hedge riding inside the phrase filler',
      'No new issues found but only skimmed. Re-walked the reconnect state ' +
        'machine.',
    ],
  ])('a hedge is refused wherever it sits: %s (#9213)', (_label, hedged) => {
    // The polarity guard used to enumerate contrast WORDS over unbounded
    // prose: any hedge not on the list (though, Yet, unfortunately, 只是)
    // retired the chunk on the clause that admitted it was not checked,
    // and a hedge inside the phrase's filler (…found but only skimmed.)
    // never reached the clause-only test at all. The contrast list is
    // gone now (#9259): the marker test runs over the match's own prefix
    // plus the clause, so the hedge's POSITION no longer matters — a
    // listed marker in any seat refuses, and every miss fails toward
    // RETIREMENT, the direction this module declares impossible.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), hedged);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), hedged);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it.each([
    [
      'an incapacity admission carrying a listed marker (unable)',
      'No issues found — I was unable to open the generated files.',
    ],
    [
      'an omission admission carrying a listed marker (failed)',
      'No issues found — I failed to check them.',
    ],
    [
      'an omission admission carrying a listed marker (skipped)',
      'No issues found — I skipped the generated files.',
    ],
    [
      'an omission admission carrying a listed marker (unchecked)',
      'No issues found — left them unchecked.',
    ],
    [
      'a Chinese bare-不 incapacity admission',
      '未发现问题——打不开生成的文件。',
    ],
    ['a Chinese omission verb (跳过)', '未发现问题——跳过了生成的文件。'],
    [
      'a marker riding inside a phrase echo the strip removes',
      'No issues found — no issues, left them unchecked.',
    ],
    [
      'a clause whose substance is only echoed phrases',
      'No issues found — no issues found, no issues found, no issues ' +
        'found.',
    ],
    [
      'a hedge BEFORE the phrase on the same line',
      'I could not check everything, but no new issues — re-walked the ' +
        "retry cap and both changed exports' call sites.",
    ],
    [
      'a filler hedge the lead marker test catches (dash path)',
      'No issues found though only skimmed — re-walked the retry cap and ' +
        "both changed exports' call sites.",
    ],
    [
      'a filler hedge the lead marker test catches (anchored path)',
      'No new issues found though only skimmed. Re-walked the retry cap ' +
        "and both changed exports' call sites.",
    ],
  ])('an executed leak family is refused: %s (#9213)', (_label, leaked) => {
    // The six leak families executed against the real scheduler (#9213
    // on #9206): incapacity/omission admissions the marker list names,
    // zh bare-不 and 跳过, a marker lost to the saturation strip, phrase
    // echoes lending the floor their substance, a hedge BEFORE the
    // phrase the guard never saw, and filler hedges the lead marker
    // test catches on both separator paths (#9259 — the labels used to
    // cite the removed contrast list). Every one read dry twice
    // and retired the chunk — the direction this module declares
    // impossible.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), leaked);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), leaked);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it.each([
    [
      // The residue names a walk (`re-walking`) so the refusal comes ONLY
      // from the marker surviving the strip: under the greedy filler-tail
      // strip the marker is swallowed, the walk gate and floor pass, and
      // this case reads dry — the mutation this fixture pins (#9259).
      'a listed marker the phrase-strip used to swallow (skipped)',
      'No issues found — no issues found but I skipped the generated ' +
        'files after re-walking the parser.',
    ],
    [
      'an admission on the line BEFORE the receipt (en)',
      'I did not check the generated files.\n' +
        'No issues found — re-walked the retry cap and both changed ' +
        "exports' call sites.",
    ],
    [
      'an admission on the line BEFORE the receipt (zh)',
      '没有检查生成的文件。\n未发现问题——重新走查了重连状态机。',
    ],
    [
      'a self-admission the quoted-span exemption used to blank',
      'No issues found — I "could not open" the generated files.',
    ],
    [
      'a synonym the marker list does not name (overlooked)',
      'No issues found — overlooked the generated files.',
    ],
    [
      'a synonym the marker list does not name (without checking)',
      'No issues found — without checking the generated files.',
    ],
    [
      'a zh synonym the marker list does not name (忽略)',
      '未发现问题——忽略了生成的文件。',
    ],
    [
      'a minus-led hedge before the phrase',
      'Minus the generated files, no issues found — re-walked the retry cap.',
    ],
  ])('a hedge the form closes is refused: %s (#9213)', (_label, leaked) => {
    // The four entrance families executed at the round-4 commit (#9213 on
    // #9206): the greedy phrase strip swallowing its OWN listed marker,
    // an admission outside the receipt line, a quoted self-admission, and
    // synonym vocabulary no marker list closes. The form closes the class
    // where the list cannot: the receipt stands ALONE or reads `unknown`,
    // and the clause names a WALK or reads `unknown` — every miss fails
    // toward audit, the only direction the module header declares.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), leaked);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), leaked);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('prose on EITHER side of the receipt line is refused alike (#9213)', () => {
    // The clause capture used to run to the END of the return: prose
    // AFTER the receipt line contradicted the phrase while identical
    // prose BEFORE it passed — an executed asymmetry under the line-scope
    // claim the comments stated (#9213). The form reads both sides
    // alike: the receipt stands alone, or the return is not the receipt
    // — named for the side it fell at.
    const receiptLine =
      'No new issues found — re-walked the reconnect flow and both ' +
      "changed exports' call sites.";
    const trailing =
      'The list already covered the timer path, so I did not re-report it.';
    transcript(
      record(1, 13, 'chunk 13 round 1 territory walk'),
      receiptLine + '\n' + trailing,
    );
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      receiptLine + '\n' + trailing,
    );
    transcript(
      record(1, 14, 'chunk 14 round 1 territory walk'),
      trailing + '\n' + receiptLine,
    );
    transcript(
      record(2, 14, 'chunk 14 round 2 territory walk'),
      trailing + '\n' + receiptLine,
    );

    const r3 = schedule(3, [13, 14]);
    expect(r3.due).toEqual([13, 14]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not alone; round 2: receipt not alone',
      'chunk 14 — round 1: receipt not matched; round 2: receipt not matched',
    ]);
  });

  it('a clause that names no walk is not dry — the walk gate (#9213)', () => {
    // A clause can clear the substance floor on length and still name no
    // WALK — a conclusion, not a walk — and the unbounded hedge class
    // (`overlooked`, `missed`, 忽略…) rides exactly such clauses. The
    // gate's misses fail toward audit: a walk verb the vocabulary does
    // not name reads `unknown`, never `dry`.
    const noWalk = 'No issues found — the territory is clean.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), noWalk);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), noWalk);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('layer receipts above the receipt do not break the form (#9213)', () => {
    // A modeled-system diff receipts each walked layer on its own line
    // ABOVE the no-issues line; the form strips those with audit-layers'
    // own matcher, so the receipt still stands alone and retires.
    const ret =
      'Layer walked: token-layer — comment tokens and globs examined.\n' +
      'Layer walked: state-propagation — unset and alias paths examined.\n' +
      'No issues found — re-walked the guard state model and both ' +
      "changed exports' call sites.";
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), ret);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), ret);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a layer label fused onto the receipt line certifies nothing (#9213)', () => {
    // The line-anchored strip only sees OWN-line labels, so a fused one
    // rode the clause: the label's own "walked" passed the walk test and
    // its length the substance floor, certifying a receipt the identical
    // two-line form (above) refuses. The clause is cut at the inline
    // marker, exactly as at an inline `Budget gap:`.
    const fused = 'No issues found — Layer walked: lexing';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), fused);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), fused);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
    // The cut leaves an empty clause, and an empty clause names no walk.
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause names no walk; ' +
        'round 2: receipt clause names no walk',
    ]);
  });

  it('a quoted layer line is never stripped — fence and blockquote stay, and fail the form (#9259)', () => {
    // The strip is fence- and blockquote-aware: a QUOTED `Layer walked:`
    // line is prose the return carries, not a receipt the form strips, so
    // the return refuses — the safe direction. A plain line filter would
    // strip these too and let the non-receipt certify; that regression is
    // what these two shapes pin. Chunk 13 fences the layer line above the
    // receipt (no receipt at the anchor); chunk 14 blockquotes it below
    // (prose after the receipt's line).
    const fenced =
      '```\nLayer walked: lexing\n```\n' +
      'No issues found — re-walked the parser and the retry cap call sites.';
    const blockquoted =
      'No issues found — re-walked the parser and the retry cap call sites.\n' +
      '> Layer walked: lexing';
    for (const r of [1, 2]) {
      transcript(record(r, 13, `chunk 13 round ${r} territory walk`), fenced);
      transcript(
        record(r, 14, `chunk 14 round ${r} territory walk`),
        blockquoted,
      );
    }

    const r3 = schedule(3, [13, 14]);
    expect(r3.due).toEqual([13, 14]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not matched; round 2: receipt not matched',
      'chunk 14 — round 1: receipt not alone; round 2: receipt not alone',
    ]);
  });

  it('a receipt split across two lines is not dry — the matcher is line-bound (#9213)', () => {
    // Every whitespace element in the matcher used to be `\s`, which
    // matches `\n`: the matcher itself spanned lines and pulled the
    // clause in from a LATER line, so the receipt-is-its-line form
    // refused nothing. Each shape below reads `unknown` — the dangling
    // separator leaves prose after the receipt's (empty) line, and a
    // break before the separator is no receipt at all.
    const shapes: Array<[string, string]> = [
      // Dangling em dash at the end of line 1.
      [
        'No issues found —\nre-walked the parser and the retry cap call sites',
        'receipt not alone',
      ],
      // Break before the separator.
      [
        'No issues found\n— re-walked the parser and the retry cap call sites',
        'receipt not matched',
      ],
      // Blank line after the dangling separator.
      [
        'No issues found —\n\nre-walked the parser and the retry cap call sites',
        'receipt not alone',
      ],
      // ASCII hyphen dangling — "stands alone" asks for a space, not `\n`.
      [
        'No issues found -\nre-walked the parser and the retry cap call sites',
        'receipt not matched',
      ],
    ];
    shapes.forEach(([ret], i) => {
      const chunk = 13 + i;
      transcript(
        record(1, chunk, `chunk ${chunk} round 1 territory walk`),
        ret,
      );
      transcript(
        record(2, chunk, `chunk ${chunk} round 2 territory walk`),
        ret,
      );
    });

    const r3 = schedule(
      3,
      shapes.map((_, i) => 13 + i),
    );
    expect(r3.due).toEqual([13, 14, 15, 16]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual(
      shapes.map(
        ([, failure], i) =>
          `chunk ${13 + i} — round 1: ${failure}; round 2: ${failure}`,
      ),
    );
  });

  it('an innocuous "but" does not block retirement — only a hedge does (#9213)', () => {
    // The clause-contrast refusal used to reject ANY occurrence of a
    // contrast word, so the commonest honest connective — "already in the
    // list, still re-verified, BUT I checked again" — regressed from dry
    // to unknown and blocked retirement on exactly the budgeted runs the
    // optimization exists for. A contrast word without a negation or
    // incapacity marker in its scope contradicts nothing.
    const receipt =
      'No new issues were found — re-walked the retry cap and both changed ' +
      "exports' call sites; the list already covered them, but I " +
      're-verified the readers.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('an innocuous 不过 does not block the Chinese receipt either (#9213)', () => {
    const receipt =
      '未发现新问题——重新走查了重连状态机与两个已改导出的全部调用点，' +
      '清单已覆盖它们，不过我又核对了一遍。';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a nested phrase occurrence inside the clause does not truncate it (#9213)', () => {
    // The clause naming the walk naturally repeats the brief's saturated
    // vocabulary plus a colon or dash (`no gaps:`, `no issues —`); the
    // unanchored matcher tried FIRST found the nested occurrence and
    // refused the truncated clause, defeating the widening's purpose on
    // exactly the receipts it was added to admit. The anchored matcher
    // must take the lead.
    for (const receipt of [
      'No new issues were found. All six layers walked; every gap already ' +
        'on the list.',
      'No new issues were found. Re-walked the scheduler: all of it cold.',
    ]) {
      transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
      transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

      const r3 = schedule(3, [13]);
      expect(r3.due).toEqual([]);
      expect(r3.converged).toBe(true);
    }
  });

  it('a budget-gap line parted by a blank line does not block the receipt (#9213)', () => {
    // Stripping the disclosure line leaves a leading blank when it sat a
    // paragraph above the receipt; the anchored matcher's ^ must not die
    // on strip's own leftover whitespace.
    const receipt =
      'Budget gap: walked the parser only\n\n' +
      'No new issues found. Re-walked the reconnect state machine.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('quoting the stock phrase to NEGATE it is not a receipt (#9206)', () => {
    // A return that names the phrase inside a negation matched mid-text
    // once the stops widened: the quoted phrase opened a clause out of
    // the negation's own tail, and the chunk retired on the sentence
    // that said it was not checked. Sentence-punctuation separators open
    // a clause only when the phrase LEADS the return — a quotation is
    // never the lead.
    const quoted =
      'I cannot write "No new issues were found." I could not open the ' +
      'generated files and did not check them.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), quoted);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), quoted);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('a quoted phrase with a marker-free walk clause is refused ONLY by the anchor (#9259)', () => {
    // The clause after the quoted phrase names a walk and dodges every
    // marker, so no other bar can refuse this return: an unanchored
    // sentence-punctuation separator would open a clause out of the
    // quotation and retire the chunk — the mutation this pins. (The
    // sibling above carries `not` in its clause, so it falls at the
    // polarity bar no matter where the anchor sits.)
    const quoted =
      'I cannot write "No new issues were found." I re-walked the ' +
      'parser and its call sites this round.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), quoted);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), quoted);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not matched; round 2: receipt not matched',
    ]);
  });

  it('a hedged clause carrying a code span is refused by polarity, not saved by the object (#9259)', () => {
    // The object escape hatch lives inside the substance floor, BELOW the
    // polarity bar: a clause that contradicts the phrase is refused
    // whatever it names. Reordering those checks retires this shape with
    // no other red test — the mutation this pins.
    const hedged =
      'No new issues found; I could not open `gen/output.ts` and left ' +
      'it unchecked.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), hedged);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), hedged);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause contradicts the phrase; round 2: receipt clause contradicts the phrase',
    ]);
  });

  it('a transcript that never reads the diff reads "no read of the diff", even with territory baked (#9259)', () => {
    // Crosses the two adjacent bars: the record bakes a diff window (so
    // territory is non-empty) and the transcript's only successful call
    // reads the brief instead. The `diffToolCalls === 0` bar must answer
    // first — swapped, this shape mislabels as a range-overlap mismatch
    // and sends the operator hunting the wrong mismatch.
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} walk — ` +
          `read_file(file_path="${diff}", offset=1000, limit=200)`,
      );
      transcript(built, DRY, 1, join(dir, 'brief.md'), 0, 50);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: no read of the diff; round 2: no read of the diff',
    ]);
  });

  it('a yield suppresses the diagnostic for the chunk it explains (#9259)', () => {
    // The certifiable gate requires the last two outcomes to be free of
    // yields: round 1 reads `unknown`, round 2 yields, and the round-3
    // schedule stays silent — the yield already explains the chunk's
    // heat. Dropping the gate emits the round-1 failure here and no other
    // test notices — the mutation this pins.
    transcript(
      record(1, 13, 'chunk 13 round 1 territory walk'),
      'Walked the territory carefully and studied every edge case in it.',
    );
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), YIELD);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([]);
  });

  it('the bare stock sentence stays unknown through the widened class (#9206)', () => {
    // The widening admits the stop; the substance floor still refuses the
    // clause. `No issues found.` opens an EMPTY clause, and a receipt with
    // nothing after it proves no walk whatever separator let it through.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), WHIFF);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), WHIFF);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('diagnoses a twice-audited chunk no transcript certified (#9206)', () => {
    // The silent half of the reported loop: records on disk, launches that
    // match none of them (an undelivered build, a paraphrase), and rounds
    // that re-audited without a word. The schedule now names the bar.
    record(1, 13, 'chunk 13 round 1 territory walk');
    record(2, 13, 'chunk 13 round 2 territory walk');

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: no matching transcript; round 2: no matching transcript',
    ]);
  });

  it('diagnoses a matched transcript whose receipt fell at a named bar (#9206)', () => {
    // The launch pairs, the agent opened the territory — but the return
    // carries no structural receipt at all. The diagnostic says WHICH bar,
    // so the reader is not left with `unknown` and a destroyed record dir.
    const noReceipt =
      'Walked the territory carefully and studied every edge case in it.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), noReceipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), noReceipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not matched; round 2: receipt not matched',
    ]);
  });

  it('diagnoses per round — a dry round beside a failed one names only the failure (#9206)', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    record(2, 13, 'chunk 13 round 2 territory walk'); // undelivered

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 2: no matching transcript',
    ]);
  });

  it('does not diagnose a yielded chunk — a yield explains its own heat (#9206)', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), YIELD);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([]);
  });

  it('diagnoses a launch that never read the diff (#9206)', () => {
    // A successful call ELSEWHERE (the brief) clears the tool-call bar
    // but not the diff-read bar; the diagnostic must name the second one
    // — a rename or a swap of the two bars would otherwise send the
    // reader hunting the wrong mismatch.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        DRY,
        1,
        join(dir, 'brief.md'),
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: no read of the diff; round 2: no read of the diff',
    ]);
  });

  it('diagnoses a diff read that missed the baked territory (#9206)', () => {
    // The record bakes the chunk's window; the auditor read elsewhere in
    // the file. The territory bar names the miss.
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} walk — ` +
          `read_file(file_path="${diff}", offset=1000, limit=200)`,
      );
      transcript(built, DRY, 1, diff, 0, 50);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: territory read missing; round 2: territory read missing',
    ]);
  });

  it('diagnoses a transcript with no successful tool calls (#9259)', () => {
    // The whiff shape — prose and nothing else — falls at the very first
    // bar, and the diagnostic names it instead of collapsing into a
    // downstream refusal.
    for (const r of [1, 2]) {
      transcript(record(r, 13, `chunk 13 round ${r} territory walk`), DRY, 0);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: no successful tool calls; round 2: no successful tool calls',
    ]);
  });

  it('diagnoses a receipt whose clause names no walk (#9206)', () => {
    // The receipt matches and every tool-call bar clears — but the clause
    // after the separator carries neither a walk verb nor a named object,
    // so the walk gate is the bar that fell, and the diagnostic says so.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No new issues found — all good.',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause names no walk; round 2: receipt clause names no walk',
    ]);
  });

  it('diagnoses a clause that names a walk but stays under the substance floor (#9259)', () => {
    // `walked lexing` clears the walk gate on its verb and then falls at
    // the floor (13 flattened characters, no object) — pinning the
    // floor's own refusal, which the walk-gate fixture above cannot reach.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No issues found — walked lexing',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause too thin; round 2: receipt clause too thin',
    ]);
  });

  it('diagnoses a lead-side hedge as the lead contradicting the phrase (#9259)', () => {
    // The hedge rides the receipt's own filler, before the clause: the
    // lead is the bar that fell, and the name says so — distinct from a
    // clause-side admission.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No issues found but only skimmed. Re-walked the parser.',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt lead contradicts the phrase; round 2: receipt lead contradicts the phrase',
    ]);
  });

  it('diagnoses a clause-side admission as the clause contradicting the phrase (#9259)', () => {
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No issues found — re-walked the parser but skipped the generated files',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause contradicts the phrase; round 2: receipt clause contradicts the phrase',
    ]);
  });

  it('diagnoses an ambiguous launch — one transcript matching several records (#9206)', () => {
    // Two same-round records (a repair rebuild), ONE transcript handed
    // both blocks: it certifies neither, and the diagnostic names the
    // ambiguity instead of leaving an unexplained `unknown`.
    for (const r of [1, 2]) {
      const a = record(r, 13, `chunk 13 round ${r} walk`, 'aaa111');
      const b = record(
        r,
        13,
        `chunk 13 round ${r} rules-corrected rebuild walk`,
        'fff999',
      );
      transcript([a, b].join('\n\n'), DRY);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: launch matched multiple records; round 2: launch matched multiple records',
    ]);
  });

  it("parroting the brief's own example receipt is not dry", () => {
    // Every reverse auditor is handed this exact sentence as the model
    // answer; a clause that echoes it names nothing the agent examined
    // itself, whatever its length.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      `${REVERSE_AUDIT_EXAMPLE_RECEIPT}.`,
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('a case-shifted echo of the example receipt is not dry either (#9213)', () => {
    // The example clause starts lowercase because it continues the model
    // receipt mid-sentence; the widened sentence-punctuation separators
    // let a parroting auditor open it as a NEW sentence — capitalized —
    // and the case-sensitive compare never saw it. No honest clause
    // contains the model clause verbatim in any casing.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      'No issues found. Re-walked the reconnect state machine and the ' +
        "two changed exports' call sites; every gap I checked was " +
        'already in the list',
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it("a doubled stock sentence is not dry — the parrot bar refuses the brief's own example (#9213)", () => {
    // The stock sentence pasted twice: the doubled clause RESTATES the
    // all-clear core twice over, so the restatement bar is the bar that
    // falls (#9272 — an earlier form credited the parrot bar, and before
    // that the substance floor; the form's refusal lands earlier now).
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      'No issues found. Re-walked the reconnect state machine and the ' +
        "two changed exports' call sites; every gap I checked was " +
        'already in the list. No issues found. Re-walked the reconnect ' +
        "state machine and the two changed exports' call sites; every " +
        'gap I checked was already in the list',
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('an echo cannot lend the floor its substance — the restatement bar refuses it first (#9272)', () => {
    // The clause carries a walk verb, but every flat character past it is
    // an echoed all-clear — a restatement, which the form refuses before
    // any floor measurement runs (the strip-measure ordering this test
    // once pinned is unreachable now: no clause with a core in it
    // survives the restatement bar to be measured).
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        'No issues found — re-walked, no issues found, no issues found.',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause restates the all-clear; round 2: receipt clause restates the all-clear',
    ]);
  });

  it('a Chinese clause of four ideographs clears the substance floor (#9259)', () => {
    // The CJK floor branch (>= 4 ideographs) — every prior zh dry fixture
    // used a ~30-char clause that the 20-char branch would have passed
    // anyway, leaving this branch pinned by nothing.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        '未发现问题——走查解析',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
  });

  it('a Chinese clause of three ideographs stays under the floor (#9259)', () => {
    // One ideograph short of the CJK branch and far under 20 flattened
    // characters, with a walk verb carrying it past the walk gate — the
    // floor is the bar that falls.
    for (const r of [1, 2]) {
      transcript(
        record(r, 13, `chunk 13 round ${r} territory walk`),
        '未发现问题——走查了',
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt clause too thin; round 2: receipt clause too thin',
    ]);
  });

  it('a quoted marker inside the clause contradicts the phrase (#9213)', () => {
    // The polarity domain used to exempt quoted spans — and a
    // self-admission wrapped in quotes — `I "could not open" the
    // generated files` — blanked to nothing and retired the chunk
    // (#9213). The exemption is gone: a quoted marker contradicts the phrase exactly
    // as a bare one, and an honest clause quoting a marker-carrying
    // label pays the refusal — the direction every failure here fails.
    const receipt =
      'No issues found — the "could not reproduce" note was already ' +
      "known; re-walked the retry cap and both changed exports' call " +
      'sites.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('a stray backtick is not a named object — only an enclosed span is', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      'No new issues found — all good. `',
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('an enclosed code span still names an object', () => {
    // Short enough that ONLY the span shortcut can clear it.
    const receipt = 'No issues found — `retry-cap`.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('the conjunction "and/or" is not a path', () => {
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk'),
      'No issues found — and/or cases.',
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('a real path still names an object — dotted extension, one slash', () => {
    // Short enough that ONLY the path shortcut can clear it.
    const receipt = 'No issues found — checked src/pay.ts.';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), receipt);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk'), receipt);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('a diff read outside the baked territory is not dry', () => {
    // The record bakes the chunk's read; the transcript's only diff read
    // is elsewhere in the file. The receipt reads `unknown` whatever it
    // says — an auditor that never opened the territory has no claim on
    // it, and no other stage re-asks the question.
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} walk — ` +
          `read_file(file_path="${diff}", offset=1000, limit=200)`,
      );
      transcript(built, DRY, 1, diff, 0, 50);
    }

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('an overlapping read of the baked territory still retires', () => {
    // Overlap is the bar, not containment: the second audit pages the
    // territory, and its half-read still lands inside.
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} walk — ` +
          `read_file(file_path="${diff}", offset=1000, limit=200)`,
      );
      transcript(
        built,
        DRY,
        1,
        diff,
        r === 1 ? 1000 : 1100,
        r === 1 ? 200 : 50,
      );
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('findings prose quoting a read window cannot widen the territory', () => {
    // The record is the FOLDED launch prompt — the cumulative findings
    // list rides inside it, verbatim. Prose quoting ANY `offset=N,
    // limit=M` pair (a read_file call under discussion; this PR's own
    // review threads do) used to inject the range into the territory, and
    // any-overlap-with-any-range passes: an auditor whose only diff read
    // was lines 1-50 retired a chunk whose territory is 1001-1200 the
    // moment a finding quoted `offset=0, limit=50`. Only the read aimed
    // at the diff is territory.
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} walk\n` +
          '## Already confirmed — do not re-report these\n' +
          'the earlier read used read_file(offset=0, limit=50)\n' +
          `read_file(file_path="${diff}", offset=1000, limit=200)`,
      );
      transcript(built, DRY, 1, diff, 0, 50);
    }

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('the real baked read still retires beside noisy findings', () => {
    // The positive control for the bound scan: the same findings noise,
    // and the auditor opens the territory itself.
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} walk\n` +
          '## Already confirmed — do not re-report these\n' +
          'the earlier read used read_file(offset=0, limit=50)\n' +
          `read_file(file_path="${diff}", offset=1000, limit=200)`,
      );
      transcript(built, DRY, 1, diff, 1000, 200);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('quoting a WHOLE cumulative-list entry is not a yield', () => {
    // The cumulative list rides in the launch prompt as full blocks —
    // File AND Severity — and an auditor justifying "already covered"
    // can quote one whole. A file line appearing verbatim in its own
    // launch prompt marks the quotation — the filing check refuses it;
    // the FORM then refuses the return's prose lead (#9213).
    const quoted =
      'The list already carries this entry, so it is not re-reported:\n' +
      '- **File:** src/pay.ts:42\n' +
      '- **Severity:** Suggestion\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} territory\n**File:** src/pay.ts:42`,
      );
      transcript(built, quoted);
    }

    const r3 = schedule(3, [13]);
    // Not a yield — the entry is on the list — but not the receipt FORM
    // either: the quotation's prose leads the return, and prose before
    // the phrase is the executed leak family the form closes (#9213).
    // The diagnostic proves the echo reached the form, not the filing
    // check: a yield suppresses its diagnostic.
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not matched; round 2: receipt not matched',
    ]);
  });

  it('an auditor that SKIPPED the findings read cannot retire the chunk', () => {
    // The comparison against known findings IS the audit's method, and the
    // brief instructs the read. Two dry receipts from auditors that skipped
    // it would retire the chunk on a comparison nobody made. The fixture
    // builder models the compliant read automatically, so this one writes
    // its transcripts by hand, minus the read.
    for (const r of [1, 2]) {
      const findingsFile = writeFindingsFile(
        plan,
        `reverse-audit--round-${r}--skip99`,
        '- **File:** src/pay.ts:42 — the double charge\n' +
          '- **Severity:** Suggestion\n',
      );
      const built = record(
        r,
        13,
        `chunk 13 round ${r} territory\n` +
          `read_file(file_path="${findingsFile}")`,
      );
      const id = `aud-skip-${r}`;
      const base = {
        agentId: id,
        agentName: 'general-purpose',
        sessionId: 'S1',
      };
      writeFileSync(
        join(dir, 'subagents', 'S1', `agent-${id}.jsonl`),
        [
          JSON.stringify({
            ...base,
            type: 'user',
            message: { role: 'user', parts: [{ text: built }] },
          }),
          JSON.stringify({
            ...base,
            type: 'assistant',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'read_file',
                    args: { file_path: diff, offset: 0, limit: 100 },
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
                    name: 'read_file',
                    response: { output: 'diff bytes' },
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            ...base,
            type: 'assistant',
            message: { role: 'model', parts: [{ text: DRY }] },
          }),
        ].join('\n') + '\n',
      );
    }

    const r3 = schedule(3, [13]);
    // The receipts do not classify, both rounds read `unknown`, and the
    // chunk stays hot.
    expect(r3.due).toEqual([13]);
  });

  /** A transcript whose FINAL text is followed by more tool traffic — the
   *  died-mid-flight shape: `returned: false`, narration only. */
  function deadTranscript(launchPrompt: string, narration: string): void {
    const id = `aud-dead-${++seq}`;
    const base = {
      agentId: id,
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    const call = JSON.stringify({
      ...base,
      type: 'assistant',
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'read_file',
              args: { file_path: diff, offset: 0, limit: 100 },
            },
          },
        ],
      },
    });
    const result = JSON.stringify({
      ...base,
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'diff bytes' },
            },
          },
        ],
      },
    });
    writeFileSync(
      join(dir, 'subagents', 'S1', `agent-${id}.jsonl`),
      [
        JSON.stringify({
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: launchPrompt }] },
        }),
        call,
        result,
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: { role: 'model', parts: [{ text: narration }] },
        }),
        // The traffic AFTER the text is what makes it narration: the agent
        // went on working and the process died mid-walk.
        call,
        result,
      ].join('\n') + '\n',
    );
  }

  it('a died-mid-flight narration carrying a receipt shape classifies nothing', () => {
    // `finalText` keeps the last non-empty assistant text, narration
    // included — an auditor that printed a receipt-shaped progress line and
    // was killed mid-walk must not read `dry`. Two such corpses would
    // retire the chunk on an audit that never finished.
    deadTranscript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    deadTranscript(record(2, 13, 'chunk 13 round 2 territory walk'), DRY);

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.converged).toBe(false);
  });

  it('a filed YIELD survives a skipped findings read — the bar gates dry only', () => {
    // The findings-read bar exists so a no-issues receipt cannot certify a
    // comparison nobody made. Applied BEFORE classification it also
    // suppressed filed findings: round 2's yielder skipped the list read,
    // its yield vanished, the compliant dry sibling carried the round, and
    // the chunk retired WITH a live finding on it.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    const findingsFile = writeFindingsFile(
      plan,
      'reverse-audit--round-2--yield7',
      '- **File:** src/pay.ts:42 — the double charge\n' +
        '- **Severity:** Suggestion\n',
    );
    const built = record(
      2,
      13,
      `chunk 13 round 2 territory walk\n` +
        `read_file(file_path="${findingsFile}")`,
    );
    // The yielder, by hand: territory read, NO findings read, a new finding.
    const id = `aud-yielder-${++seq}`;
    const base = {
      agentId: id,
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    writeFileSync(
      join(dir, 'subagents', 'S1', `agent-${id}.jsonl`),
      [
        JSON.stringify({
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: built }] },
        }),
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { file_path: diff, offset: 0, limit: 100 },
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
                  name: 'read_file',
                  response: { output: 'diff bytes' },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: { role: 'model', parts: [{ text: YIELD }] },
        }),
      ].join('\n') + '\n',
    );
    // The compliant dry sibling for the same record (the helper models the
    // findings read automatically).
    transcript(built, DRY);

    const r3 = schedule(3, [13]);
    // yielded outranks dry: round 2 is hot and the chunk stays due.
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });

  it('quoting a WHOLE entry from the findings FILE is not a yield (post-#8597 shape)', () => {
    // Since #8597 the cumulative list rides a digest-named `.findings.md`
    // file the launch prompt points at, not the prompt itself. The echo
    // guard must read the list back from that file: quoting the whole
    // entry the auditor was told not to re-report is not a yield — and
    // the form refuses the return's prose lead, like the prompt twin.
    const quoted =
      'The list already carries this entry, so it is not re-reported:\n' +
      '- **File:** src/pay.ts:42\n' +
      '- **Severity:** Suggestion\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const findingsFile = writeFindingsFile(
        plan,
        `reverse-audit--round-${r}--abc123`,
        '- **File:** src/pay.ts:42 — the double charge\n' +
          '- **Severity:** Suggestion\n',
      );
      const built = record(
        r,
        13,
        `chunk 13 round ${r} territory\n` +
          `read_file(file_path="${findingsFile}")`,
      );
      transcript(built, quoted);
    }

    const r3 = schedule(3, [13]);
    // The echo guard reads the list back from the findings file — the
    // quotation is not a filing — and the form refuses the prose lead
    // exactly like the prompt-side twin (#9213).
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
    expect(r3.diagnostics).toEqual([
      'chunk 13 — round 1: receipt not matched; round 2: receipt not matched',
    ]);
  });

  it('a MISSING findings file fails toward auditing — the quotation reads as a yield', () => {
    // The pointer is there but the list is gone (a cleaned-up record dir):
    // the guard falls back to the prompt, no entry matches, and the quoted
    // block keeps the chunk hot — the module's failure direction.
    const quoted =
      'The list already carries this entry, so it is not re-reported:\n' +
      '- **File:** src/pay.ts:42\n' +
      '- **Severity:** Suggestion\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} territory\n` +
          `read_file(file_path="${join(dir, 'gone.findings.md')}")`,
      );
      transcript(built, quoted);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.converged).toBe(false);
  });

  it('a pointer outside the record dir is not followed — degrades to the prompt', () => {
    // The echo guard reads the pointer the record carries, confined to this
    // plan's record dir. A prompt whose `.findings.md` path escapes it
    // (here: a list sitting outside, with the quoted entry in it) must NOT
    // be read — the guard falls back to the prompt, no entry matches, and
    // the quotation keeps the chunk hot rather than reading an arbitrary path.
    const outside = join(dir, 'outside.findings.md');
    writeFileSync(
      outside,
      '- **File:** src/pay.ts:42 — the double charge\n' +
        '- **Severity:** Suggestion\n',
    );
    const quoted =
      'The list already carries this entry, so it is not re-reported:\n' +
      '- **File:** src/pay.ts:42\n' +
      '- **Severity:** Suggestion\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const built = record(
        r,
        13,
        `chunk 13 round ${r} territory\n` + `read_file(file_path="${outside}")`,
      );
      transcript(built, quoted);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([13]);
    expect(r3.converged).toBe(false);
  });

  it('a missing findings file is not cross-contaminated between chunks of a round', () => {
    // Every chunk of a round points at the SAME (chunk-free) findings file.
    // When it is missing, each record must fall back to its OWN prompt as the
    // echo-guard corpus — not to a sibling chunk's prompt cached under the
    // shared pointer. Here chunk 13's prompt carries a `**File:**` line that
    // chunk 14 quotes; if chunk 14 were handed chunk 13's prompt, the quote
    // would match and chunk 14 would wrongly skip-to-dry.
    const missing = join(promptRecordDir(plan), 'gone.findings.md');
    const quoted =
      'The list already carries this entry, so it is not re-reported:\n' +
      '- **File:** src/pay.ts:42\n' +
      '- **Severity:** Suggestion\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const b13 = record(
        r,
        13,
        `chunk 13 round ${r} territory\n**File:** src/pay.ts:42\n` +
          `read_file(file_path="${missing}")`,
      );
      const b14 = record(
        r,
        14,
        `chunk 14 round ${r} territory\n` + `read_file(file_path="${missing}")`,
      );
      transcript(b13, DRY);
      transcript(b14, quoted);
    }

    const r3 = schedule(3, [13, 14]);
    // Chunk 13 (clean DRY) may retire; chunk 14 must stay hot — its quotation
    // matches nothing in its OWN prompt, so it reads as a yield, not an echo.
    expect(r3.due).toContain(14);
  });

  it('a cold check nobody certified puts the chunk back on the every-round schedule', () => {
    dryTwice([13]);
    // Round 4 is the cold check — built, but the launch left no certified
    // transcript. The round still belongs to the history with an empty
    // outcome set, so the two-most-recent-dry rule breaks and the chunk
    // is hot again — a refactor skipping empty rounds would retire it
    // forever over a cold check that produced no evidence.
    record(4, 13, 'chunk 13 round 4 territory walk');

    const r5 = schedule(5, [13]);
    expect(r5.due).toEqual([13]);
    expect(r5.coldChecks).toEqual([]);
    expect(r5.converged).toBe(false);
  });

  it('a chunk with no audit history stays due when its neighbour retires', () => {
    dryTwice([13]);
    // 16 entered the loop mid-capture (or its records were lost): no
    // history at all. Retirement needs TWO certificates, and nothing is
    // not one — the chunk stays hot while 13 skips.
    const r3 = schedule(3, [13, 16]);
    expect(r3.due).toEqual([16]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
    expect(r3.converged).toBe(false);
  });

  it('two live records for ONE (chunk, round): any yield keeps it hot', () => {
    // A --chunk repair re-records the same (chunk, round) under a new
    // findings digest; both records stay live. The bodies are disjoint so
    // each transcript certifies exactly its own record, and the merge
    // must carry BOTH outcomes — one yield proves the territory hot
    // whichever order the filesystem returns the records in.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk', 'aaa111'),
      YIELD,
    );
    transcript(
      record(2, 13, 'chunk 13 round 2 rules-corrected rebuild walk', 'fff999'),
      DRY,
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('the same-round pair still outranks retirement with the digest order flipped', () => {
    // The twin of the test above with the digests swapped: the two
    // arrangements flip the filesystem's record order, so a
    // last-record-wins overwrite cannot pass both.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk', 'fff999'),
      YIELD,
    );
    transcript(
      record(2, 13, 'chunk 13 round 2 rules-corrected rebuild walk', 'aaa111'),
      DRY,
    );

    expect(schedule(3, [13]).due).toEqual([13]);
  });

  it('an empty chunk list is not convergence', () => {
    // Unreachable through the command (`runAllChunks` refuses a chunkless
    // plan first), but the function is exported and convergence is an exit-5
    // termination rule: it must not be reachable from nothing.
    const r3 = schedule(3, []);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(false);
  });
});

describe('scheduleReverseAuditRound — a resumed run reads the prior attempt', () => {
  let dir: string;
  let plan: string;
  let diff: string;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retirement-resume-'));
    plan = join(dir, 'plan.json');
    writeFileSync(plan, '{}');
    const old = new Date(2020, 0, 1);
    utimesSync(plan, old, old);
    diff = join(dir, 'diff.txt');
    process.env['QWEN_CODE_PROJECT_DIR'] = dir;
    process.env['QWEN_CODE_SESSION_ID'] = 'S1';
    mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
    mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_PROJECT_DIR'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    rmSync(dir, { recursive: true, force: true });
  });

  function record(round: number, chunk: number, body: string): string {
    const prompt = `reverse-audit ${body}`;
    recordPrompt(
      plan,
      `reverse-audit--chunk-${chunk}--round-${round}--abc123`,
      prompt,
    );
    return prompt;
  }

  /** A dry-receipt transcript, written into the named session's dir. */
  function transcriptIn(session: string, launchPrompt: string): void {
    const id = `aud-${++seq}`;
    const base = {
      agentId: id,
      agentName: 'general-purpose',
      sessionId: session,
    };
    const lines = [
      JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', parts: [{ text: launchPrompt }] },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { file_path: diff, offset: 0, limit: 100 },
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
                name: 'read_file',
                response: { output: 'diff bytes' },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'model', parts: [{ text: DRY }] },
      }),
    ];
    const f = join(dir, 'subagents', session, `agent-${id}.jsonl`);
    writeFileSync(f, lines.join('\n') + '\n');
    // Backdated below the ledger fixture's prior-window close: a CI stall
    // after ledger() would otherwise fence these out via the until clamp.
    const past = new Date(Date.now() - 10_000);
    utimesSync(f, past, past);
  }

  function ledger(...ids: string[]): void {
    const d = promptRecordDir(plan);
    mkdirSync(d, { recursive: true });
    // Written by the real writer: it stamps the plan mtime each entry is
    // keyed on, and the resume marker is what authorizes reading prior
    // evidence at all. The current attempt is stamped last, since each
    // attempt's window closes when the next one opened.
    const nowMs = Date.now();
    ids.forEach((id, i) =>
      appendRunSession(
        plan,
        { QWEN_CODE_SESSION_ID: id },
        i === ids.length - 1 ? nowMs + 1500 : nowMs,
      ),
    );
    recordResume(plan, process.env, nowMs + 1500);
  }

  it('reads the prior attempt before this session has launched anything', () => {
    // The scheduler runs BEFORE the first launch of a resumed run, so the
    // harness has not created `subagents/<current>` yet — the exact shape
    // `currentDirOptional` exists for.
    ledger('S0', 'S1');
    for (const r of [1, 2]) {
      transcriptIn('S0', record(r, 13, `chunk 13 round ${r} territory walk`));
    }
    rmSync(join(dir, 'subagents', 'S1'), { recursive: true, force: true });
    const r3 = scheduleReverseAuditRound(plan, [13], 3, process.env, diff);
    expect(r3.due).toEqual([]);
    expect(r3.converged).toBe(true);
  });

  it('retires a chunk on dry receipts the interrupted attempt earned', () => {
    ledger('S0', 'S1');
    for (const r of [1, 2]) {
      transcriptIn('S0', record(r, 13, `chunk 13 round ${r} territory walk`));
    }
    const r3 = scheduleReverseAuditRound(plan, [13], 3, process.env, diff);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
    expect(r3.converged).toBe(true);
  });

  it('keeps every chunk hot when no ledger names the prior session', () => {
    for (const r of [1, 2]) {
      transcriptIn('S0', record(r, 13, `chunk 13 round ${r} territory walk`));
    }
    const r3 = scheduleReverseAuditRound(plan, [13], 3, process.env, diff);
    expect(r3.due).toEqual([13]);
    expect(r3.skipped).toEqual([]);
  });
});
