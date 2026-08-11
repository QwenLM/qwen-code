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
import {
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
    // launch prompt marks the quotation; the honest receipt underneath
    // still retires the chunk.
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
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
  });

  it('quoting a WHOLE entry from the findings FILE is not a yield (post-#8597 shape)', () => {
    // Since #8597 the cumulative list rides a digest-named `.findings.md`
    // file the launch prompt points at, not the prompt itself. The echo
    // guard must read the list back from that file: quoting the whole entry
    // the auditor was told not to re-report is still not a yield.
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
    expect(r3.due).toEqual([]);
    expect(r3.skipped.map((s) => s.chunkId)).toEqual([13]);
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
