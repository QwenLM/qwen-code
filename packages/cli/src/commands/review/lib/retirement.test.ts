/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { scheduleReverseAuditRound } from './retirement.js';
import { appendRunSession, recordResume } from './run-ledger.js';
import {
  findingsPointerOf,
  briefPath,
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
  ): string {
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
    const file = join(dir, 'subagents', 'S1', `agent-${id}.jsonl`);
    writeFileSync(file, lines.join('\n') + '\n');
    return file;
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

  it('one dry launch narrows a non-delta chunk that YIELDED the launch before (#10136 R1-4)', () => {
    // The distinguishing fixture: chunk 14's convergence pair yielded (round
    // 2) and round 3 returned a substantive dry receipt. Round 3 was built
    // after the pair's findings merged — the loop merges before every round
    // build — so its single dry receipt prices the non-delta chunk out of
    // the wave. Ordinary retirement needs two dry audits after the yield and
    // keeps it hot; delta chunk 13 with the same history stays hot — the
    // narrowing never touches a delta territory.
    for (const c of [13, 14]) {
      transcript(record(1, c, `chunk ${c} round 1 territory walk`, 'b1'), DRY);
      transcript(
        record(2, c, `chunk ${c} round 2 territory walk`, 'b1'),
        YIELD,
      );
      transcript(record(3, c, `chunk ${c} round 3 territory walk`, 'b2'), DRY);
    }

    const r4 = scheduleReverseAuditRound(plan, [13, 14], 4, process.env, diff, {
      deltaChunkIds: new Set([13]),
    });
    expect(r4.due).toEqual([13]);
    expect(r4.narrowed).toEqual([{ chunkId: 14, dryRound: 3 }]);
    expect(r4.coldChecks).toEqual([]);
    // Without the narrowing context the same history keeps BOTH hot — the
    // one-launch bar is the posture's alone.
    const plain = scheduleReverseAuditRound(
      plan,
      [13, 14],
      4,
      process.env,
      diff,
    );
    expect(plain.due).toEqual([13, 14]);
    expect(plain.narrowed).toEqual([]);
  });

  it('the convergence pair is ONE launch — its dry member never narrows beside a non-dry partner (#10136 R20-3 round 24)', () => {
    // Rounds 1 and 2 are built together against one findings list, so round
    // 2's dry receipt was built before round 1's findings entered it —
    // whatever that list's bytes or rendering say. Each member here ran on
    // a DIFFERENT digest (tags cleared between the two builds): the shape
    // the list-reading arms used to rule fresh on, until a misreading of the
    // list granted the narrowing. Chunk 14's partner yielded, chunk 15's
    // never certified; chunk 13's whole pair is dry and narrows.
    transcript(record(1, 13, 'chunk 13 round 1 territory walk', 'a1'), DRY);
    transcript(record(2, 13, 'chunk 13 round 2 territory walk', 'a2'), DRY);
    transcript(record(1, 14, 'chunk 14 round 1 territory walk', 'a1'), YIELD);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk', 'a2'), DRY);
    record(1, 15, 'chunk 15 round 1 territory walk', 'a1'); // no transcript
    transcript(record(2, 15, 'chunk 15 round 2 territory walk', 'a2'), DRY);

    const r3 = scheduleReverseAuditRound(
      plan,
      [13, 14, 15],
      3,
      process.env,
      diff,
      { deltaChunkIds: new Set([99]) },
    );
    expect(r3.due).toEqual([14, 15]);
    expect(r3.narrowed).toEqual([{ chunkId: 13, dryRound: 2 }]);
    expect(r3.converged).toBe(false);
  });

  it('a dry launch built on an unmerged round’s very list bytes does not narrow (#10136)', () => {
    // Order is the bar, and the loop merges before every build — but a later
    // launch whose findings digest is also an earlier non-dry round's says
    // that merge never ran. Chunk 14's pair yielded in round 2 under digest
    // feed01 and round 3 was built on feed01 again; chunk 15's round 2 never
    // certified, same bytes. Chunk 13 is the control: the same history under
    // a list the merge changed.
    for (const c of [13, 14, 15]) {
      transcript(
        record(1, c, `chunk ${c} round 1 territory walk`, 'feed00'),
        DRY,
      );
    }
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk', 'feed01'),
      YIELD,
    );
    transcript(record(3, 13, 'chunk 13 round 3 territory walk', 'feed02'), DRY);
    transcript(
      record(2, 14, 'chunk 14 round 2 territory walk', 'feed01'),
      YIELD,
    );
    transcript(record(3, 14, 'chunk 14 round 3 territory walk', 'feed01'), DRY);
    record(2, 15, 'chunk 15 round 2 territory walk', 'feed01'); // no transcript
    transcript(record(3, 15, 'chunk 15 round 3 territory walk', 'feed01'), DRY);

    const r4 = scheduleReverseAuditRound(
      plan,
      [13, 14, 15],
      4,
      process.env,
      diff,
      { deltaChunkIds: new Set([99]) },
    );
    expect(r4.due).toEqual([14, 15]);
    expect(r4.narrowed).toEqual([{ chunkId: 13, dryRound: 3 }]);
    expect(r4.converged).toBe(false);
  });

  it('a PARTIAL merge — one sibling merged, one return dropped — still refuses the narrowing (#10136 R26-1)', () => {
    // `unmerged`'s byte comparison detects a TOTAL merge skip; a partial
    // one always changes the bytes, so the tripwire stays false. The
    // witness reads the list the dry launch was built from: chunk 14's
    // round-2 yield filed `**File:** src/pay.ts:42`, the round-3 launch's
    // list carries chunk 13's filing but NOT that line, so the merge
    // between them dropped chunk 14's return — and the narrowing is
    // refused. Refusal only, never a grant: a misread keeps the chunk hot.
    const YIELD_PAY =
      'Found one gap the prior rounds missed.\n\n' +
      '- **File:** src/pay.ts:42\n' +
      '- **Anchor:** const a = 1\n' +
      '- **Issue:** double charge\n' +
      '- **Severity:** Critical\n';
    transcript(record(1, 13, 'chunk 13 round 1 territory walk', 'feed00'), DRY);
    transcript(record(1, 14, 'chunk 14 round 1 territory walk', 'feed00'), DRY);
    transcript(
      record(2, 13, 'chunk 13 round 2 territory walk', 'feed01'),
      YIELD,
    );
    transcript(
      record(2, 14, 'chunk 14 round 2 territory walk', 'feed01'),
      YIELD_PAY,
    );
    // The list round 3 was built from: chunk 13's filing merged, chunk
    // 14's dropped — the partial merge.
    writeFindingsFile(plan, 'reverse-audit--round-3--feed02', YIELD);
    transcript(record(3, 13, 'chunk 13 round 3 territory walk', 'feed02'), DRY);
    transcript(record(3, 14, 'chunk 14 round 3 territory walk', 'feed02'), DRY);

    const r4 = scheduleReverseAuditRound(plan, [13, 14], 4, process.env, diff, {
      deltaChunkIds: new Set([13]),
    });
    expect(r4.narrowed).toEqual([]);
    expect(r4.due).toEqual([13, 14]);
    expect(r4.converged).toBe(false);
    // The control from the witness: the same history with the round-3 list
    // carrying BOTH filings narrows chunk 14 exactly as before — the
    // witness refuses only on evidence of the drop.
    writeFindingsFile(
      plan,
      'reverse-audit--round-3--feed02',
      `${YIELD}${YIELD_PAY}`,
    );
    const r4b = scheduleReverseAuditRound(
      plan,
      [13, 14],
      4,
      process.env,
      diff,
      { deltaChunkIds: new Set([13]) },
    );
    expect(r4b.due).toEqual([13]);
    expect(r4b.narrowed).toEqual([{ chunkId: 14, dryRound: 3 }]);
  });

  it('a non-delta chunk with NO audit history stays in the wave (#10136)', () => {
    // The `latest !== undefined` arm alone keeps such a chunk hot: no
    // receipt at all is not a dry receipt. Chunk 17 has no record in
    // rounds 1-2; it is due at round 3, not narrowed, beside a narrowed
    // sibling that holds its single dry receipt.
    transcript(record(1, 14, 'chunk 14 round 1 territory walk', 'd1'), DRY);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk', 'd2'), DRY);
    const r3 = scheduleReverseAuditRound(plan, [14, 17], 3, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r3.due).toEqual([17]);
    expect(r3.narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
    expect(r3.converged).toBe(false);
  });

  it('the list-bytes tripwire reads only rounds not dry in every member (#10136)', () => {
    // A dry round leaves the cumulative list unchanged, so a later launch on
    // the same bytes is the ordinary case, not a skipped merge: chunk 14's
    // round 3 was dry in every member and must not hold its round-4
    // narrowing. Chunk 15's round 3 folded dry beside an uncertified
    // rebuild — a member that may have filed what never merged — and round 4
    // was built on round 3's bytes, so the tripwire holds that chunk.
    transcript(record(1, 14, 'chunk 14 round 1 territory walk', 'a0'), DRY);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk', 'a0'), YIELD);
    transcript(record(3, 14, 'chunk 14 round 3 territory walk', 'b0'), DRY);
    transcript(record(4, 14, 'chunk 14 round 4 territory walk', 'b0'), DRY);
    transcript(record(1, 15, 'chunk 15 round 1 territory walk', 'a0'), DRY);
    transcript(record(2, 15, 'chunk 15 round 2 territory walk', 'a0'), YIELD);
    transcript(record(3, 15, 'chunk 15 round 3 territory walk a', 'b0'), DRY);
    record(3, 15, 'chunk 15 round 3 territory walk b', 'b1'); // no transcript
    transcript(record(4, 15, 'chunk 15 round 4 territory walk', 'b0'), DRY);

    const r5 = scheduleReverseAuditRound(plan, [14, 15], 5, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r5.narrowed).toEqual([{ chunkId: 14, dryRound: 4 }]);
  });

  it('a launch that matched several records is an uncertified member — a dry relaunch beside it does not narrow (#10136)', () => {
    // One agent handed two chunks' round-3 blocks certifies neither, then
    // chunk 14's block is relaunched alone and returns dry. The ambiguous
    // launch filed no yield — one would decide the round on its own — but
    // certified nothing either, so the round is not dry in every member.
    transcript(record(1, 14, 'chunk 14 round 1 territory walk', 'c1'), DRY);
    transcript(record(2, 14, 'chunk 14 round 2 territory walk', 'c1'), DRY);
    const r14 = record(3, 14, 'chunk 14 round 3 territory walk', 'c3');
    const r15 = record(3, 15, 'chunk 15 round 3 territory walk', 'c3');
    transcript(`${r14}\n${r15}`, WHIFF);
    transcript(r14, DRY);

    const r4 = scheduleReverseAuditRound(plan, [14], 4, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r4.narrowed).toEqual([]);
  });

  describe('a launch whose record was lost (#10136 R25-1)', () => {
    /**
     * A record whose prompt points its agent at the brief filed under its own
     * key — a line every production launch block carries. Its block line
     * names the list it was built on, as a production block's findings
     * pointer does.
     */
    function launched(round: number, chunk: number, digest = 'abc123'): string {
      const key = `reverse-audit--chunk-${chunk}--round-${round}--${digest}`;
      return record(
        round,
        chunk,
        `chunk ${chunk} round ${round} territory walk on list ${digest}\n` +
          `read_file(file_path="${briefPath(plan, key)}")`,
        digest,
      );
    }
    const narrow = (round: number) =>
      scheduleReverseAuditRound(plan, [14], round, process.env, diff, {
        deltaChunkIds: new Set([99]),
      });
    /**
     * Whether this filesystem keeps a file's birth time across an in-place
     * rewrite — what the clock reads through a reprint. Where it does not
     * (no birth time, or one that follows the change time), the module dates
     * a record from its last write, and the reprint test does not apply.
     */
    const keepsBirthTime = (() => {
      const probe = mkdtempSync(join(tmpdir(), 'retirement-btime-'));
      try {
        const file = join(probe, 'record.txt');
        writeFileSync(file, 'a');
        const born = statSync(file).birthtimeMs;
        const until = Date.now() + 200;
        let st = statSync(file);
        while (st.mtimeMs === born && Date.now() < until) {
          writeFileSync(file, 'a');
          st = statSync(file);
        }
        return born > 0 && st.mtimeMs > born && st.birthtimeMs === born;
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    })();
    /** Record in a transcript that its agent opened `path` right after its launch. */
    function openBrief(file: string, path: string): void {
      const [first, ...rest] = readFileSync(file, 'utf8').trimEnd().split('\n');
      const { agentId, agentName, sessionId } = JSON.parse(first) as {
        agentId: string;
        agentName: string;
        sessionId: string;
      };
      const base = { agentId, agentName, sessionId };
      const opened = [
        {
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: { name: 'read_file', args: { file_path: path } },
              },
            ],
          },
        },
        {
          ...base,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { output: 'a brief' },
                },
              },
            ],
          },
        },
      ].map((l) => JSON.stringify(l));
      writeFileSync(file, [first, ...opened, ...rest].join('\n') + '\n');
    }

    it('still ran: its yield counts, so a stale dry pair cannot price the chunk out', () => {
      // A record's write and its read are both best-effort, and a fail-open
      // build prints every chunk whatever the schedule said. Chunk 14's pair
      // was dry; round 3 ran anyway and yielded, and its record is gone.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14), YIELD);
      rmSync(recordFile(3, 14, 'abc123'));

      const r4 = narrow(4);
      expect(r4.due).toEqual([14]);
      expect(r4.narrowed).toEqual([]);
      expect(r4.converged).toBe(false);
      // Hot, not a cold check: the ordinary rule reads the lost round too,
      // and as the yield it filed, which explains its own heat.
      expect(r4.coldChecks).toEqual([]);
      expect(r4.diagnostics).toEqual([]);
    });

    it('a lost launch that filed nothing is uncertified, and the diagnostics say why', () => {
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14), WHIFF);
      rmSync(recordFile(3, 14, 'abc123'));

      const r4 = narrow(4);
      expect(r4.due).toEqual([14]);
      expect(r4.narrowed).toEqual([]);
      expect(r4.diagnostics).toEqual([
        'chunk 14 — round 3: launch not paired with the record of its block',
      ]);
    });

    it('a pair member whose record was lost is still a member of the pair', () => {
      transcript(launched(1, 14), YIELD);
      rmSync(recordFile(1, 14, 'abc123'));
      transcript(launched(2, 14), DRY);

      expect(narrow(3).narrowed).toEqual([]);
    });

    it('an earlier launch whose record was lost does not hold a later dry launch — the order stands', () => {
      transcript(launched(1, 14), YIELD);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14, 'c3'), YIELD);
      rmSync(recordFile(3, 14, 'c3'));
      transcript(launched(4, 14, 'c4'), DRY);

      expect(narrow(5).narrowed).toEqual([{ chunkId: 14, dryRound: 4 }]);
    });

    it("a lost launch's findings digest still trips the list-bytes check", () => {
      transcript(launched(1, 14), YIELD);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14, 'd3'), YIELD);
      rmSync(recordFile(3, 14, 'd3'));
      transcript(launched(4, 14, 'd3'), DRY);

      expect(narrow(5).narrowed).toEqual([]);
    });

    it('a lost launch of the round being built is not history', () => {
      // A transcript of the round now being (re)built names that round; like
      // a record of it, it is not evidence about the territory yet.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14, 'f3'), YIELD);
      rmSync(recordFile(3, 14, 'f3'));

      expect(narrow(3).narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
    });

    it('a launch that paired with one record still names the round whose record it lost', () => {
      // One agent handed chunks 13 and 14's round-3 blocks; chunk 14's record
      // is gone, so the launch pairs with chunk 13's alone — and still names
      // chunk 14's key through its brief.
      for (const c of [13, 14]) {
        transcript(launched(1, c), DRY);
        transcript(launched(2, c), DRY);
      }
      const both = `${launched(3, 13)}\n${launched(3, 14)}`;
      transcript(both, YIELD);
      rmSync(recordFile(3, 14, 'abc123'));

      expect(narrow(4).narrowed).toEqual([]);
    });

    it('a launch naming two blocks certifies neither, even when one record survived', () => {
      // The shortcut the pairing walk refuses — one agent handed several
      // blocks — must not turn back into a certificate because one of the
      // records is gone: the launch still names both keys.
      for (const c of [13, 14]) {
        transcript(launched(1, c), DRY);
        transcript(launched(2, c), DRY);
      }
      const both = `${launched(3, 13)}\n${launched(3, 14)}`;
      transcript(both, DRY);
      rmSync(recordFile(3, 14, 'abc123'));

      const r4 = scheduleReverseAuditRound(
        plan,
        [13, 14],
        4,
        process.env,
        diff,
        { deltaChunkIds: new Set([99]) },
      );
      expect(r4.narrowed).toEqual([]);
      expect(r4.due).toEqual([13, 14]);
      expect(r4.diagnostics).toEqual([
        'chunk 13 — round 3: launch named several blocks',
        'chunk 14 — round 3: launch not paired with the record of its block',
      ]);
    });

    it('a delivery the orchestrator altered is a member too, beside the record that survived', () => {
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const prompt = launched(3, 14);
      // Altered mid-line, so the launch no longer delivers the record's
      // lines — the brief line it carries survives.
      transcript(
        prompt.replace(
          'round 3 territory walk',
          'round 3 (retyped) territory walk',
        ),
        YIELD,
      );
      transcript(prompt, DRY);

      expect(narrow(4).narrowed).toEqual([]);
    });

    it('a cold check whose record was lost keeps a retired chunk hot — no narrowing needed', () => {
      // The ordinary rule reads the same history. A retired chunk's round-4
      // cold check yielded and lost its record; reading the record set as
      // the rounds that ran skipped the chunk at round 5 and converged.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(4, 14), YIELD);
      rmSync(recordFile(4, 14, 'abc123'));

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([14]);
      expect(r5.skipped).toEqual([]);
      expect(r5.converged).toBe(false);
    });

    it('a lost launch that yielded outranks the dry sibling of its round', () => {
      // Round 4's cold check was built twice: the d1 build returned dry, the
      // d2 rebuild yielded and lost its record. Read as `unknown`, the yield
      // folded into the dry receipt beside it and the chunk retired over it.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(4, 14, 'd1'), DRY);
      transcript(launched(4, 14, 'd2'), YIELD);
      rmSync(recordFile(4, 14, 'd2'));

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([14]);
      expect(r5.converged).toBe(false);
    });

    it("a dead attempt's late transcript names a fenced record, not a lost one", () => {
      // The retry re-captured the plan and the dead attempt's round-3 agent
      // finished after that: its record is older than the plan, fenced out
      // as the dead attempt's, and its transcript must not read as a launch
      // of this attempt whose record went missing.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14, 'dead01'), YIELD);
      const dead = new Date(2019, 0, 1);
      utimesSync(recordFile(3, 14, 'dead01'), dead, dead);

      expect(narrow(4).narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
    });

    it('a launch naming a second block still proves heat: its yield outranks a dry relaunch of its record', () => {
      // Chunk 13's round-4 cold check went out in a block shared with chunk
      // 14, whose record is gone, and yielded; chunk 13's block was then
      // relaunched alone and returned dry. The shared launch certifies
      // nothing, but its yield still joins chunk 13's round.
      for (const c of [13, 14]) {
        transcript(launched(1, c), DRY);
        transcript(launched(2, c), DRY);
      }
      const shared = `${launched(4, 13)}\n${launched(4, 14)}`;
      transcript(shared, YIELD);
      rmSync(recordFile(4, 14, 'abc123'));
      transcript(launched(4, 13), DRY);

      const r5 = scheduleReverseAuditRound(plan, [13], 5, process.env, diff);
      expect(r5.due).toEqual([13]);
      expect(r5.converged).toBe(false);
    });

    it('a launch that matched several records still proves heat: its yield outranks a dry relaunch of its record', () => {
      // Chunks 14 and 15's round-4 cold checks went out to one agent, which
      // pairs with both records and yielded; chunk 14's block was then
      // relaunched alone and returned dry.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const r14 = record(4, 14, 'chunk 14 round 4 territory walk');
      const r15 = record(4, 15, 'chunk 15 round 4 territory walk');
      transcript(`${r14}\n${r15}`, YIELD);
      transcript(r14, DRY);

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([14]);
      expect(r5.converged).toBe(false);
    });

    it("a launch that names another block's brief but not its own certifies nothing", () => {
      // The launch delivered chunk 14's round-3 record — one written without
      // a brief line, so its own key goes unnamed — and points at chunk 13's
      // brief besides. Pairing with one record is not enough: every key the
      // launch names must be one it paired with.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const sibling = briefPath(
        plan,
        'reverse-audit--chunk-13--round-3--abc123',
      );
      transcript(
        `${record(3, 14, 'chunk 14 round 3 territory walk')}\n` +
          `read_file(file_path="${sibling}")`,
        DRY,
      );

      expect(narrow(4).narrowed).toEqual([]);
    });

    it("a launch that merely mentions another round's brief still proves heat for its own record", () => {
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const first = briefPath(plan, 'reverse-audit--chunk-14--round-1--abc123');
      transcript(
        `${launched(4, 14, 'e4')}\nsee read_file(file_path="${first}")`,
        YIELD,
      );
      transcript(launched(4, 14, 'e4'), DRY);

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([14]);
      expect(r5.converged).toBe(false);
    });

    it("a lost launch's quotation guard never follows a pointer its delivery carries", () => {
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(4, 14, 'd1'), DRY);
      // A list the delivered text points at, carrying the very entry the
      // lost launch filed: read, it turned the filing into a quotation.
      const planted = writeFindingsFile(
        plan,
        'reverse-audit--round-4--feed99',
        YIELD,
      );
      transcript(
        `read_file(file_path="${planted ?? ''}")\n${launched(4, 14, 'd2')}`,
        YIELD,
      );
      rmSync(recordFile(4, 14, 'd2'));

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([14]);
    });

    it("a lost launch's quotation guard reads the list the CLI filed under its round and digest", () => {
      // Round 4's d2 rebuild went out on a list already carrying the entry
      // its lost launch returned: the return quotes that list and files
      // nothing, so the round folds dry on its d1 receipt and the retired
      // chunk skips round 5.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(4, 14, 'd1'), DRY);
      writeFindingsFile(plan, 'reverse-audit--round-4--d2', YIELD);
      transcript(launched(4, 14, 'd2'), YIELD);
      rmSync(recordFile(4, 14, 'd2'));

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([]);
    });

    it('a brief path the delivery re-wrapped at one of its spaces still names its key', () => {
      plan = join(dir, 'with space.json');
      writeFileSync(plan, '{}');
      const old = new Date(2020, 0, 1);
      utimesSync(plan, old, old);
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(launched(3, 14).replace('with space', 'with\nspace'), YIELD);
      rmSync(recordFile(3, 14, 'abc123'));

      expect(narrow(4).narrowed).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'a plan spelled through a symlinked directory names the same blocks',
      () => {
        // The round builds spelled the plan through a link to its directory,
        // and this schedule spells it through the real one. Chunk 14's
        // round-3 record is lost; chunk 15's delivery dropped its brief line
        // beside a dry relaunch; chunk 16's agent opened the brief its retyped
        // delivery no longer named. Each still names its block.
        const real = join(dir, 'real');
        mkdirSync(real);
        symlinkSync(real, join(dir, 'link'));
        plan = join(dir, 'link', 'plan.json');
        writeFileSync(plan, '{}');
        const old = new Date(2020, 0, 1);
        utimesSync(plan, old, old);
        for (const c of [14, 15, 16]) {
          transcript(launched(1, c), DRY);
          transcript(launched(2, c), DRY);
        }
        transcript(launched(3, 14), YIELD);
        rmSync(recordFile(3, 14, 'abc123'));
        const fifteen = launched(3, 15);
        transcript(
          fifteen
            .split('\n')
            .filter((l) => !l.includes('.brief.md'))
            .join('\n'),
          YIELD,
        );
        transcript(fifteen, DRY);
        const brief = briefPath(
          plan,
          'reverse-audit--chunk-16--round-3--abc123',
        );
        transcript('chunk 16, round 3, retyped', YIELD, 1, brief);
        transcript(launched(3, 16), DRY);
        plan = join(real, 'plan.json');

        const r4 = scheduleReverseAuditRound(
          plan,
          [14, 15, 16],
          4,
          process.env,
          diff,
          { deltaChunkIds: new Set([99]) },
        );
        expect(r4.narrowed).toEqual([]);
        expect(r4.due).toEqual([14, 15, 16]);
      },
    );

    it('a plan spelled in another letter case names the same blocks', () => {
      // Round 3 was built with the plan's name in another case — the same
      // record dir on a case-insensitive filesystem — so every brief path it
      // printed spells that dir differently. Chunk 14's round-3 record is
      // lost; chunk 15's delivery dropped its brief line beside a dry
      // relaunch; chunk 16's agent opened the brief its retyped delivery no
      // longer named. Each still names its block.
      const brief = (c: number) =>
        briefPath(
          join(dir, 'PLAN.json'),
          `reverse-audit--chunk-${c}--round-3--abc123`,
        );
      const body = (c: number) =>
        `chunk ${c} round 3 territory walk on list abc123\n` +
        `read_file(file_path="${brief(c)}")`;
      for (const c of [14, 15, 16]) {
        transcript(launched(1, c), DRY);
        transcript(launched(2, c), DRY);
      }
      transcript(`reverse-audit ${body(14)}`, YIELD);
      const fifteen = record(3, 15, body(15));
      transcript(
        fifteen
          .split('\n')
          .filter((l) => !l.includes('.brief.md'))
          .join('\n'),
        YIELD,
      );
      transcript(fifteen, DRY);
      transcript('chunk 16, round 3, retyped', YIELD, 1, brief(16));
      transcript(record(3, 16, body(16)), DRY);

      const r4 = scheduleReverseAuditRound(
        plan,
        [14, 15, 16],
        4,
        process.env,
        diff,
        { deltaChunkIds: new Set([99]) },
      );
      expect(r4.narrowed).toEqual([]);
      expect(r4.due).toEqual([14, 15, 16]);
    });

    it("a brief path that never spells this plan's record dir names nothing here", () => {
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      transcript(
        'reverse-audit chunk 14 round 2 territory walk, elsewhere\n' +
          'read_file(file_path="/elsewhere/prompts/reverse-audit--chunk-14--round-2--abc123.brief.md")',
        YIELD,
      );

      expect(narrow(3).narrowed).toEqual([{ chunkId: 14, dryRound: 2 }]);
    });

    it('a delivery that lost its brief line is still a member, beside the record that survived', () => {
      // The brief line was dropped on the way, so the launch names no key and
      // pairs with nothing; the block was relaunched verbatim and came back
      // dry. Every other line of the block arrived.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const prompt = launched(3, 14);
      transcript(
        prompt
          .split('\n')
          .filter((l) => !l.includes('.brief.md'))
          .join('\n'),
        YIELD,
      );
      transcript(prompt, DRY);

      expect(narrow(4).narrowed).toEqual([]);
    });

    it('a launch handed a second block whose brief line was lost certifies neither', () => {
      // One agent took chunks 13 and 14's round-3 blocks, and chunk 14's brief
      // line was dropped on the way: the launch pairs with chunk 13's record
      // alone and names only its key, yet it delivered the rest of chunk
      // 14's block.
      for (const c of [13, 14]) {
        transcript(launched(1, c), DRY);
        transcript(launched(2, c), DRY);
      }
      const second = launched(3, 14)
        .split('\n')
        .filter((l) => !l.includes('.brief.md'))
        .join('\n');
      transcript(`${launched(3, 13)}\n${second}`, DRY);

      const r4 = scheduleReverseAuditRound(
        plan,
        [13, 14],
        4,
        process.env,
        diff,
        { deltaChunkIds: new Set([99]) },
      );
      expect(r4.narrowed).toEqual([]);
      expect(r4.due).toEqual([13, 14]);
    });

    it('a block launched again inside a later wave holds the narrowing, its record lost or not', () => {
      // Round 3 was built after the pair merged. Then round-2 blocks went out
      // again inside round 3's wave and yielded — chunk 14's pairing with its
      // own round-2 record, chunk 15's naming a record that is gone — while
      // round 3's blocks came back dry. Those yields were written after round
      // 3 was built, so its list cannot hold them. Chunk 17's round 3 was
      // rebuilt a day after its stale yield returned, and its first build
      // still predates that yield. Chunk 16 is the control.
      const stamp = (file: string, day: number) =>
        utimesSync(file, new Date(2021, 0, day), new Date(2021, 0, day));
      const agents = join(dir, 'subagents', 'S1');
      for (const c of [14, 15, 16, 17]) {
        transcript(launched(1, c, 'd1'), DRY);
        transcript(launched(2, c, 'd1'), DRY);
        stamp(recordFile(1, c, 'd1'), 1);
        stamp(recordFile(2, c, 'd1'), 1);
      }
      for (const f of readdirSync(agents)) stamp(join(agents, f), 2);
      for (const c of [14, 15, 16, 17]) {
        transcript(launched(3, c, 'd3'), DRY);
        stamp(recordFile(3, c, 'd3'), 3);
      }
      transcript(launched(2, 14, 'd1'), YIELD);
      transcript(launched(2, 15, 'd1'), YIELD);
      rmSync(recordFile(2, 15, 'd1'));
      stamp(transcript(launched(2, 17, 'd1'), YIELD), 4);
      transcript(launched(3, 17, 'd3b'), DRY);
      stamp(recordFile(3, 17, 'd3b'), 5);

      const r4 = scheduleReverseAuditRound(
        plan,
        [14, 15, 16, 17],
        4,
        process.env,
        diff,
        { deltaChunkIds: new Set([99]) },
      );
      expect(r4.narrowed).toEqual([{ chunkId: 16, dryRound: 3 }]);
      expect(r4.due).toEqual([14, 15, 17]);
    });

    it('a shared block launched again inside a later wave holds the narrowing even when it filed nothing', () => {
      // Chunks 13 and 14's round-2 blocks went out again together inside
      // round 3's wave and came back bare: the launch certifies neither
      // record, and it returned after round 3 was built.
      const stamp = (file: string, day: number) =>
        utimesSync(file, new Date(2021, 0, day), new Date(2021, 0, day));
      for (const c of [13, 14]) {
        stamp(transcript(launched(1, c, 'd1'), DRY), 2);
        stamp(transcript(launched(2, c, 'd1'), DRY), 2);
        stamp(recordFile(1, c, 'd1'), 1);
        stamp(recordFile(2, c, 'd1'), 1);
      }
      for (const c of [13, 14]) {
        transcript(launched(3, c, 'd3'), DRY);
        stamp(recordFile(3, c, 'd3'), 3);
      }
      transcript(`${launched(2, 13, 'd1')}\n${launched(2, 14, 'd1')}`, WHIFF);

      const r4 = scheduleReverseAuditRound(
        plan,
        [13, 14],
        4,
        process.env,
        diff,
        { deltaChunkIds: new Set([99]) },
      );
      expect(r4.narrowed).toEqual([]);
      expect(r4.due).toEqual([13, 14]);
    });

    it.skipIf(!keepsBirthTime)(
      "a reprint of the dry launch's block keeps the clock of its first build",
      () => {
        // Round 3's block was built, a round-2 block then went out again
        // inside its wave and yielded, and round 3's block was repaired —
        // reprinted under the same key — before its launch returned dry. The
        // reprint rewrites the record, not the build the dry launch was made
        // from. Days count from now, so every stamp falls after the births.
        const now = Date.now();
        const day = (n: number) => new Date(now + n * 86_400_000);
        transcript(launched(1, 14, 'd1'), DRY);
        transcript(launched(2, 14, 'd1'), DRY);
        launched(3, 14, 'd3');
        utimesSync(transcript(launched(2, 14, 'd1'), YIELD), day(1), day(1));
        const dry = transcript(launched(3, 14, 'd3'), DRY);
        utimesSync(recordFile(3, 14, 'd3'), day(2), day(2));
        utimesSync(dry, day(3), day(3));

        expect(narrow(4).narrowed).toEqual([]);
      },
    );

    it("a record a dead attempt left under the same key dates from this attempt's rewrite", () => {
      // A CI retry re-captured the plan after the dead attempt wrote these
      // records and rebuilt them unchanged, so their birth predates the plan
      // and their build is this attempt's write. The pair's yield returned
      // before round 3 was rebuilt — the ordinary merge order. Days count
      // from now, so the plan postdates every birth.
      const now = Date.now();
      const at = (day: number) => new Date(now + day * 86_400_000);
      const stamp = (file: string, day: number) =>
        utimesSync(file, at(day), at(day));
      const pair = [
        transcript(launched(1, 14), YIELD),
        transcript(launched(2, 14), DRY),
      ];
      const third = transcript(launched(3, 14, 'd3'), DRY);
      stamp(plan, 1);
      stamp(recordFile(1, 14, 'abc123'), 2);
      stamp(recordFile(2, 14, 'abc123'), 2);
      for (const file of pair) stamp(file, 3);
      stamp(recordFile(3, 14, 'd3'), 4);
      stamp(third, 5);

      expect(narrow(4).narrowed).toEqual([{ chunkId: 14, dryRound: 3 }]);
    });

    for (const { how, spoil } of [
      { how: 'was lost', spoil: (file: string) => rmSync(file) },
      {
        how: 'was left empty by a partial write',
        spoil: (file: string) => writeFileSync(file, ''),
      },
      {
        how: 'was cut off inside its brief line',
        spoil: (file: string) => {
          const text = readFileSync(file, 'utf8');
          writeFileSync(file, text.slice(0, text.indexOf('.brief.md') - 4));
        },
      },
    ]) {
      it(`a carried block whose record ${how} is named by the brief its agent opened`, () => {
        // One agent took chunk 13's round-3 block and, beside it, chunk 14's —
        // whose brief line was dropped and whose record cannot pair. The launch
        // pairs with chunk 13's record alone and walked the diff; its agent also
        // opened chunk 14's brief, so it certifies neither block.
        for (const c of [13, 14]) {
          transcript(launched(1, c), DRY);
          transcript(launched(2, c), DRY);
        }
        const carried = launched(3, 14)
          .split('\n')
          .filter((l) => !l.includes('.brief.md'))
          .join('\n');
        spoil(recordFile(3, 14, 'abc123'));
        openBrief(
          transcript(`${launched(3, 13)}\n${carried}`, DRY),
          briefPath(plan, 'reverse-audit--chunk-14--round-3--abc123'),
        );

        const r4 = scheduleReverseAuditRound(
          plan,
          [13, 14],
          4,
          process.env,
          diff,
          { deltaChunkIds: new Set([99]) },
        );
        expect(r4.narrowed).toEqual([]);
        expect(r4.due).toEqual([13, 14]);
      });
    }

    it("an agent that paired with its record and opened a sibling's brief still certifies its own", () => {
      // Opening a brief is not running its block: the launch delivered chunk
      // 14's round-3 block, and its agent also read chunk 13's brief — a block
      // with its own record and its own dry launch.
      for (const c of [13, 14]) {
        transcript(launched(1, c), DRY);
        transcript(launched(2, c), DRY);
      }
      transcript(launched(3, 13), DRY);
      openBrief(
        transcript(launched(3, 14), DRY),
        briefPath(plan, 'reverse-audit--chunk-13--round-3--abc123'),
      );

      const r4 = scheduleReverseAuditRound(
        plan,
        [13, 14],
        4,
        process.env,
        diff,
        { deltaChunkIds: new Set([99]) },
      );
      expect(r4.narrowed).toEqual([
        { chunkId: 13, dryRound: 3 },
        { chunkId: 14, dryRound: 3 },
      ]);
    });

    it('a cold check whose brief path was re-spelled keeps a retired chunk hot', () => {
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const prompt = launched(4, 14);
      const brief = briefPath(plan, 'reverse-audit--chunk-14--round-4--abc123');
      transcript(prompt.replace(brief, basename(brief)), YIELD);
      transcript(prompt, DRY);

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([14]);
      expect(r5.converged).toBe(false);
    });

    it('an agent that opened its brief names its block, whatever its delivery lost', () => {
      // The delivery lost everything that spells the role — the brief line
      // included — and retyped the block's own line; the agent opened the
      // brief anyway, and the harness recorded it.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      const brief = briefPath(plan, 'reverse-audit--chunk-14--round-3--abc123');
      transcript('chunk 14, round 3, retyped', YIELD, 1, brief);
      transcript(launched(3, 14), DRY);

      expect(narrow(4).narrowed).toEqual([]);
    });

    it("a launch that paired with its record is not read against a rebuild's record differing in the brief line alone", () => {
      // A rules-corrected rebuild on an empty list keeps every launch line
      // but the brief path, which the digest keys. Each honest launch pairs
      // with its own record and certifies it; read against the other record
      // too, each would name two blocks and the cold check would certify
      // nothing.
      transcript(launched(1, 14), DRY);
      transcript(launched(2, 14), DRY);
      for (const digest of ['aa0001', 'aa0002']) {
        const key = `reverse-audit--chunk-14--round-4--${digest}`;
        const body =
          'chunk 14 round 4 territory walk\n' +
          `read_file(file_path="${briefPath(plan, key)}")`;
        transcript(record(4, 14, body, digest), DRY);
      }

      const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff);
      expect(r5.due).toEqual([]);
    });
  });

  it('a dry relaunch beside its own round’s uncertified return does not narrow (#10136 R20-2)', () => {
    // The witness shape. One round-1 record, two transcripts — the mandated
    // relaunch: the first return files a finding the quotation guard
    // refuses (so it classifies `unknown` while the orchestrator merges the
    // finding anyway), the second is a substantive dry receipt built
    // against the SAME list. `mergeOutcomes` folds `['unknown', 'dry']` to
    // `'dry'`, and the narrowing used to read only round-level folds, so
    // nothing looked at the sibling and the chunk was priced out of the
    // wave over a live finding.
    const L1 =
      '- **File:** src/pay.ts:42 — the double charge — [unverified]\n' +
      '- **Severity:** Suggestion\n';
    const QUOTED_FILING =
      'Already covered by the confirmed list, not re-reporting:\n\n' +
      '- **File:** src/pay.ts:42 — the double charge\n' +
      '- **Severity:** Suggestion\n';
    const f1 = writeFindingsFile(plan, 'reverse-audit--round-1--d1', L1);
    const built = record(
      1,
      14,
      'chunk 14 round 1 territory walk\n' +
        `read_file(file_path="${f1 ?? ''}")`,
      'd1',
    );
    transcript(built, QUOTED_FILING);
    transcript(built, DRY);

    const r3 = scheduleReverseAuditRound(plan, [14], 3, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r3.due).toEqual([14]);
    expect(r3.narrowed).toEqual([]);
    expect(r3.converged).toBe(false);
  });

  it('a dry receipt beside its round’s uncertified rebuild does not narrow (#10136 R20-2)', () => {
    // The other shape the module's docblock names: a same-round REBUILD is
    // a second record, under a corrected list — so the two members carry
    // different digests and the same entries, tag state apart. The rebuild
    // never returned, and a record no transcript certifies is an
    // uncertified member of the round, not an absent one.
    const L1 =
      '- **File:** src/pay.ts:42 — the double charge — [unverified]\n' +
      '- **Severity:** Suggestion\n';
    const L2 =
      '- **File:** src/pay.ts:42 — the double charge\n' +
      '- **Severity:** Suggestion\n';
    const f1 = writeFindingsFile(plan, 'reverse-audit--round-1--d1', L1);
    const f2 = writeFindingsFile(plan, 'reverse-audit--round-1--d2', L2);
    transcript(
      record(
        1,
        14,
        'chunk 14 round 1 territory walk a\n' +
          `read_file(file_path="${f1 ?? ''}")`,
        'd1',
      ),
      DRY,
    );
    record(
      1,
      14,
      'chunk 14 round 1 territory walk b\n' +
        `read_file(file_path="${f2 ?? ''}")`,
      'd2',
    );

    const r3 = scheduleReverseAuditRound(plan, [14], 3, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r3.due).toEqual([14]);
    expect(r3.narrowed).toEqual([]);
    expect(r3.converged).toBe(false);
  });

  it('an uncertified sibling blocks whatever list it was built against (#10136 R20-2)', () => {
    // The launch bar asks NO question about the two members' lists, and
    // this is the case that says why. A finding an auditor files is merged before
    // the NEXT round begins, so a filing by any member of THIS round
    // post-dates every list this round was built against — the newer of
    // the two included. Within one launch "the dry member saw a different
    // list" means nothing, and reading it as freshness priced the chunk out
    // of the wave over a live finding.
    const L1 =
      '- **File:** src/pay.ts:42 — the double charge — [unverified]\n' +
      '- **Severity:** Suggestion\n';
    // A genuinely NEWER list: another chunk's finding merged between the
    // round's two builds, so the two members' digests differ.
    const L2 =
      '- **File:** src/pay.ts:42 — the double charge\n' +
      '- **Severity:** Suggestion\n' +
      '- **File:** src/other.ts:7 — an unrelated finding\n' +
      '- **Severity:** Suggestion\n';
    const f1 = writeFindingsFile(plan, 'reverse-audit--round-1--d1', L1);
    const f2 = writeFindingsFile(plan, 'reverse-audit--round-1--d2', L2);
    // The certified member is the one built against the NEWER list.
    transcript(
      record(
        1,
        14,
        'chunk 14 round 1 territory walk b\n' +
          `read_file(file_path="${f2 ?? ''}")`,
        'd2',
      ),
      DRY,
    );
    // The sibling: an earlier build of the same round, never returned.
    record(
      1,
      14,
      'chunk 14 round 1 territory walk a\n' +
        `read_file(file_path="${f1 ?? ''}")`,
      'd1',
    );

    const r3 = scheduleReverseAuditRound(plan, [14], 3, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r3.due).toEqual([14]);
    expect(r3.narrowed).toEqual([]);
    expect(r3.converged).toBe(false);
  });

  it('an uncertified sibling with no readable list blocks too (#10136 R20-2)', () => {
    // The prompt-fallback sibling: its record points at no findings file,
    // so nothing about it can be compared even in principle. Same ruling —
    // the bar is the launch, not the lists.
    const L1 =
      '- **File:** src/pay.ts:42 — the double charge — [unverified]\n' +
      '- **Severity:** Suggestion\n';
    const f1 = writeFindingsFile(plan, 'reverse-audit--round-1--d1', L1);
    transcript(
      record(
        1,
        14,
        'chunk 14 round 1 territory walk a\n' +
          `read_file(file_path="${f1 ?? ''}")`,
        'd1',
      ),
      DRY,
    );
    record(1, 14, 'chunk 14 round 1 territory walk b', 'd2');

    const r3 = scheduleReverseAuditRound(plan, [14], 3, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r3.due).toEqual([14]);
    expect(r3.narrowed).toEqual([]);
    expect(r3.converged).toBe(false);
  });

  it('a lone dry round still narrows — the launch bar rules on siblings only (#10136 R20-2)', () => {
    // The control: one record, one transcript, one substantive dry receipt.
    // No sibling, nothing stale, and the non-delta chunk leaves the wave on
    // its single dry audit exactly as the posture intends.
    const L1 =
      '- **File:** src/pay.ts:42 — the double charge\n' +
      '- **Severity:** Suggestion\n';
    const f1 = writeFindingsFile(plan, 'reverse-audit--round-1--d1', L1);
    transcript(
      record(
        1,
        14,
        'chunk 14 round 1 territory walk\n' +
          `read_file(file_path="${f1 ?? ''}")`,
        'd1',
      ),
      DRY,
    );

    const r3 = scheduleReverseAuditRound(plan, [14], 3, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r3.due).toEqual([]);
    expect(r3.narrowed).toEqual([{ chunkId: 14, dryRound: 1 }]);
    expect(r3.converged).toBe(true);
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

  /**
   * A transcript (a dry receipt by default), written into the named session's
   * dir and stamped with `stamp` (the session, unless a test wants none).
   */
  function transcriptIn(
    session: string,
    launchPrompt: string,
    finalText: string = DRY,
    stamp: string = session,
  ): void {
    const id = `aud-${++seq}`;
    const base = {
      agentId: id,
      agentName: 'general-purpose',
      sessionId: stamp,
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
        message: { role: 'model', parts: [{ text: finalText }] },
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

  it('a yield from the interrupted attempt holds the narrowing — only recovery could have merged it (#10136)', () => {
    // The live orchestrator merges the returns it receives; a resumed one
    // receives the prior attempt's only through `recover-findings`, whose bar
    // is stricter than the yield scan's. So a yield filed in another session
    // is not proven merged into the list the resumed session's dry launch was
    // built on. Chunk 13 is the control: its yield and its dry round ran in
    // the same attempt.
    ledger('S0', 'S1');
    for (const c of [13, 14]) {
      transcriptIn('S0', record(1, c, `chunk ${c} round 1 territory walk`));
      transcriptIn('S0', record(2, c, `chunk ${c} round 2 territory walk`));
      transcriptIn(
        'S0',
        record(3, c, `chunk ${c} round 3 territory walk`, 'ab03'),
        YIELD,
      );
    }
    transcriptIn(
      'S0',
      record(4, 13, 'chunk 13 round 4 territory walk', 'ab04'),
    );
    transcriptIn(
      'S1',
      record(4, 14, 'chunk 14 round 4 territory walk', 'ab04'),
    );

    const r5 = scheduleReverseAuditRound(plan, [13, 14], 5, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r5.narrowed).toEqual([{ chunkId: 13, dryRound: 4 }]);
    expect(r5.due).toEqual([14]);
  });

  it('one stamped session must cover every dry receipt of the launch and every return that was not dry (#10136)', () => {
    // Chunk 13 is the control: the whole account ran in S0. Chunk 14's latest
    // launch holds dry receipts from S0 AND a rebuild in S1 — a union of the
    // two would let S0's yield pass though the S1 member was built on a list
    // only recovery could have fed. Chunk 15's non-dry return is a bare
    // receipt, not a yield: an `unknown` may carry a filing the quotation
    // guard refused, and across a resume it merges only if recovery carried
    // it. Chunk 16's transcripts carry no session stamp at all, so nothing
    // shows the live merge covered them.
    ledger('S0', 'S1');
    for (const c of [13, 14, 15, 16]) {
      const stamp = c === 16 ? '' : 'S0';
      transcriptIn(
        'S0',
        record(1, c, `chunk ${c} round 1 territory walk`),
        DRY,
        stamp,
      );
      transcriptIn(
        'S0',
        record(2, c, `chunk ${c} round 2 territory walk`),
        DRY,
        stamp,
      );
      transcriptIn(
        'S0',
        record(3, c, `chunk ${c} round 3 territory walk`, 'ab03'),
        c === 15 ? WHIFF : YIELD,
        stamp,
      );
    }
    transcriptIn(
      'S0',
      record(4, 13, 'chunk 13 round 4 territory walk', 'ab04'),
    );
    transcriptIn(
      'S0',
      record(4, 14, 'chunk 14 round 4 territory walk a', 'ab04'),
    );
    transcriptIn(
      'S1',
      record(4, 14, 'chunk 14 round 4 territory walk b', 'ab14'),
    );
    transcriptIn(
      'S1',
      record(4, 15, 'chunk 15 round 4 territory walk', 'ab04'),
    );
    transcriptIn(
      'S1',
      record(4, 16, 'chunk 16 round 4 territory walk', 'ab04'),
      DRY,
      '',
    );

    const r5 = scheduleReverseAuditRound(
      plan,
      [13, 14, 15, 16],
      5,
      process.env,
      diff,
      { deltaChunkIds: new Set([99]) },
    );
    expect(r5.narrowed).toEqual([{ chunkId: 13, dryRound: 4 }]);
  });

  it('a launch that matched several records still holds the narrowing across a resume (#10136)', () => {
    // One S0 agent handed two chunks' round-3 blocks certifies neither, and
    // recovery refuses it the same way, so whatever it filed never reaches
    // a resumed run's list. Its return is bare — a yield would hold the
    // chunk as heat on its own — and its session rides as a return that was
    // not dry.
    ledger('S0', 'S1');
    for (const c of [14, 15]) {
      transcriptIn('S0', record(1, c, `chunk ${c} round 1 territory walk`));
      transcriptIn('S0', record(2, c, `chunk ${c} round 2 territory walk`));
    }
    const both =
      record(3, 14, 'chunk 14 round 3 territory walk', 'ab03') +
      '\n' +
      record(3, 15, 'chunk 15 round 3 territory walk', 'ab03');
    transcriptIn('S0', both, WHIFF);
    transcriptIn(
      'S1',
      record(4, 14, 'chunk 14 round 4 territory walk', 'ab04'),
    );

    const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r5.narrowed).toEqual([]);
  });

  it("a lost record's launch keeps its session — a resumed dry launch cannot pass it (#10136 R25-1)", () => {
    // Chunk 14's round-3 yield ran in S0 and its record is gone; S1 resumed
    // and ran round 4 dry. The lost launch still names its round through its
    // brief, and it carries S0 into the resume rule.
    ledger('S0', 'S1');
    const key = (r: number, digest: string) =>
      `reverse-audit--chunk-14--round-${r}--${digest}`;
    const launched = (r: number, digest = 'abc123') =>
      record(
        r,
        14,
        `chunk 14 round ${r} territory walk\n` +
          `read_file(file_path="${briefPath(plan, key(r, digest))}")`,
        digest,
      );
    transcriptIn('S0', launched(1));
    transcriptIn('S0', launched(2));
    transcriptIn('S0', launched(3, 'e3'), YIELD);
    rmSync(
      join(promptRecordDir(plan), `${encodeURIComponent(key(3, 'e3'))}.txt`),
    );
    transcriptIn('S1', launched(4, 'e4'));

    const r5 = scheduleReverseAuditRound(plan, [14], 5, process.env, diff, {
      deltaChunkIds: new Set([99]),
    });
    expect(r5.narrowed).toEqual([]);
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
