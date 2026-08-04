/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleReverseAuditRound } from './retirement.js';
import { promptRecordDir, recordPrompt } from './prompt-record.js';

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
   * then `calls` successful reads of the diff, then the final text.
   * `calls: 0` is the whiff shape — prose and nothing else.
   */
  function transcript(
    launchPrompt: string,
    finalText: string,
    calls = 1,
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
      converged: false,
    });
    expect(schedule(2).due).toEqual([13, 14, 15]);
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
    // Move the fence past the transcripts: a new capture rewrote the plan.
    const now = new Date(Date.now() + 60_000);
    utimesSync(plan, now, now);

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

  it('an echoed file line without the finding block is not a yield', () => {
    // The cumulative list rides in the launch prompt, and an auditor
    // explaining "already covered" can quote an entry's **File:** line into
    // its return. A quotation is not a report: a filed finding carries the
    // full block, severity included, and only the pair reads as `yielded`.
    // The echo still ends in a substantive receipt, so the chunk retires.
    const echo =
      'The cumulative list already covers **File:** src/pay.ts:42 — not ' +
      're-reporting it.\n\n' +
      DRY;
    for (const r of [1, 2]) {
      const built = record(r, 13, `chunk 13 round ${r} territory`);
      transcript(built, echo);
    }

    const r3 = schedule(3, [13]);
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
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
