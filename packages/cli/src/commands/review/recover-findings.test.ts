/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The recovery command against the shapes real interrupted runs leave: a
// certified agent in the dead session, an uncertified one, a transcript that
// verbatim-matches two records (the injectivity refusal), and the findings
// lists earlier rounds wrote. Fixtures are files in a real temp dir — the
// same discipline as check-coverage.test.ts, whose pairing this reuses.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import type { Argv } from 'yargs';
import { recoverFindings, recoverFindingsCommand } from './recover-findings.js';
import {
  promptRecordDir,
  briefPath,
  findingsFilePath,
} from './lib/prompt-record.js';
import { appendRunSession, recordResume } from './lib/run-ledger.js';

let dir: string;
let ENV: NodeJS.ProcessEnv;
let plan: string;
let DIFF: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'recover-')));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
  mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
  plan = join(dir, 'plan.json');
  DIFF = join(dir, 'diff.txt');
  writeFileSync(
    plan,
    JSON.stringify({ diffPathAbsolute: DIFF, diffLines: 10, chunks: [] }),
  );
  const old = new Date(2020, 0, 1);
  utimesSync(plan, old, old);
  const recordDir = promptRecordDir(plan);
  mkdirSync(recordDir, { recursive: true });
  // Written by the real writers: the entries carry the plan mtime they are
  // keyed on, and reading prior evidence at all requires this session's own
  // recorded resume. The current attempt is stamped last, since each
  // attempt's window closes when the next one opened.
  const now = Date.now();
  appendRunSession(plan, { QWEN_CODE_SESSION_ID: 'S0' }, now);
  appendRunSession(plan, { QWEN_CODE_SESSION_ID: 'S1' }, now + 1500);
  recordResume(plan, ENV, now + 1500);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A CLI-built prompt record plus its brief, under `key`. */
function built(key: string): string {
  const recordDir = promptRecordDir(plan);
  const brief = briefPath(plan, key);
  writeFileSync(brief, `The ${key} brief.`);
  const prompt = `You are ${key}.\nread_file(file_path="${brief}")`;
  writeFileSync(join(recordDir, `${encodeURIComponent(key)}.txt`), prompt);
  return prompt;
}

/** A harness transcript in `session`, launched with `launch`. */
function transcript(
  session: string,
  id: string,
  launch: string,
  opts: { opens?: string[]; finalText?: string } = {},
): void {
  const base = {
    agentId: id,
    agentName: 'general-purpose',
    sessionId: session,
  };
  const lines = [
    JSON.stringify({
      ...base,
      type: 'user',
      message: { role: 'user', parts: [{ text: launch }] },
    }),
  ];
  for (const path of opts.opens ?? []) {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: { file_path: path } } },
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
                response: { output: 'bytes' },
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
      message: {
        role: 'model',
        parts: [{ text: opts.finalText ?? 'Findings: none.' }],
      },
    }),
  );
  writeFileSync(
    join(dir, 'subagents', session, `agent-${id}.jsonl`),
    lines.join('\n') + '\n',
  );
}

const out = () => join(dir, 'recovered.md');

describe('recover-findings', () => {
  it("recovers a certified prior-session agent's final text, sectioned by key", () => {
    const prompt = built('1a');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, '1a')],
      finalText: 'Critical: the lock is dropped before the write.',
    });

    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual(['1a']);
    expect(r.missingKeys).toEqual([]);
    expect(r.priorSessions).toBe(1);
    const md = readFileSync(out(), 'utf8');
    expect(md).toContain('## 1a');
    expect(md).toContain('Critical: the lock is dropped before the write.');
  });

  it('refuses the transcript that matches two records — injectivity', () => {
    // One "agent" launched with both prompts concatenated verbatim-contains
    // both records; crediting either would let one agent take a stack.
    const p1 = built('1a');
    const p2 = built('2');
    transcript('S0', 'a0', `${p1}\n${p2}`, {
      opens: [briefPath(plan, '1a'), briefPath(plan, '2')],
      finalText: 'Covered both.',
    });

    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual([]);
    expect(r.missingKeys).toEqual(['1a', '2']);
    expect(readFileSync(out(), 'utf8')).not.toContain('Covered both.');
  });

  it('does not recover an agent that opened neither brief nor diff', () => {
    const prompt = built('1a');
    transcript('S0', 'a0', prompt, {
      opens: [],
      finalText: 'Confident prose, no evidence.',
    });

    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual([]);
    expect(r.missingKeys).toEqual(['1a']);
  });

  it('prefers the newest certified transcript for a key — the relaunch', () => {
    const prompt = built('1a');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, '1a')],
      finalText: 'First attempt.',
    });
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, 'subagents', 'S0', 'agent-a0.jsonl'), past, past);
    transcript('S0', 'a0b', prompt, {
      opens: [briefPath(plan, '1a')],
      finalText: 'Relaunched result.',
    });

    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual(['1a']);
    expect(readFileSync(out(), 'utf8')).toContain('Relaunched result.');
    expect(readFileSync(out(), 'utf8')).not.toContain('First attempt.');
  });

  it('enumerates the findings lists with their rounds, in-dir only', () => {
    const recordDir = promptRecordDir(plan);
    const key = 'reverse-audit--round-2--abc123def456';
    writeFileSync(
      join(recordDir, `${encodeURIComponent(key)}.findings.md`),
      '- R1-1 …',
    );
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.findingsFiles).toEqual([
      {
        key,
        path: join(recordDir, `${encodeURIComponent(key)}.findings.md`),
        round: 2,
      },
    ]);
  });

  it('reports the latest certified reverse-audit round', () => {
    for (const round of [1, 2]) {
      const key = `reverse-audit--round-${round}--abc123def456`;
      const prompt = built(key);
      transcript('S0', `ra${round}`, prompt, {
        opens: [briefPath(plan, key)],
        finalText: `Round ${round}: no new issues after a full territory walk.`,
      });
    }
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.latestReverseAuditRound).toBe(2);
  });

  it('recovers with the NEW session dir absent — the pre-launch state', () => {
    // A resumed run calls this before launching any agent, so the current
    // session's transcript dir does not exist yet. That must not read as an
    // infrastructure failure.
    const prompt = built('1a');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, '1a')],
      finalText: 'Recovered before any new launch.',
    });
    const freshEnv = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S9' };
    appendRunSession(plan, freshEnv, Date.now() + 1500);
    recordResume(plan, freshEnv, Date.now() + 1500);
    const r = recoverFindings({ plan, out: out() }, freshEnv);
    expect(r.recoveredKeys).toEqual(['1a']);
    expect(readFileSync(out(), 'utf8')).toContain(
      'Recovered before any new launch.',
    );
  });

  it('refuses an --out that would overwrite the plan', () => {
    expect(() => recoverFindings({ plan, out: plan }, ENV)).toThrow(
      /must not overwrite the plan/,
    );
  });

  it('the CLI option contract: yargs-parsed flags drive the pure function', () => {
    const prompt = built('1a');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, '1a')],
      finalText: 'Recovered through the parsed flags.',
    });
    const parsed = (recoverFindingsCommand.builder as (y: Argv) => Argv)(
      yargs([]),
    ).parseSync(['--plan', plan, '--out', out()]) as unknown as Parameters<
      typeof recoverFindings
    >[0];

    const r = recoverFindings(parsed, ENV);
    expect(r.recoveredKeys).toEqual(['1a']);
    expect(readFileSync(out(), 'utf8')).toContain(
      'Recovered through the parsed flags.',
    );
  });
});

describe('recover-findings — the guarantees, made falsifiable', () => {
  it('refuses a launch that diverged from the recorded prompt', () => {
    // The verbatim-delivery check is the core of the certification; no
    // fixture diverged from it before, so dropping it shipped green.
    const prompt = built('1a');
    transcript('S0', 'a0', prompt.replace('You are', 'You were'), {
      opens: [briefPath(plan, '1a')],
      finalText: 'Rewritten launch, plausible prose.',
    });
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual([]);
    expect(r.missingKeys).toEqual(['1a']);
  });

  it('does not recover an agent whose final text is empty', () => {
    const prompt = built('1a');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, '1a')],
      finalText: '   ',
    });
    expect(recoverFindings({ plan, out: out() }, ENV).recoveredKeys).toEqual(
      [],
    );
  });

  it('vetoes a return that declares a chunk uncoverable', () => {
    const prompt = built('chunk-1');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, 'chunk-1')],
      finalText: 'Uncoverable: chunk 1 — a line exceeds the read limit',
    });
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual([]);
  });

  it('refuses a CHUNK agent that opened its brief but never the diff', () => {
    // Coverage requires `diffToolCalls > 0` of a chunk-assigned record. The
    // recovery bar was `openedBrief || diffToolCalls > 0`, so this agent's
    // plausible prose over zero diff lines was written into the recovery file
    // and its key left `missingKeys` — the resumed run then never relaunches
    // it.
    const prompt = built('chunk-2');
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, 'chunk-2')],
      finalText: 'No issues found in chunk 2.',
    });
    expect(recoverFindings({ plan, out: out() }, ENV).recoveredKeys).toEqual(
      [],
    );
  });

  it('refuses a NON-chunk agent that opened the diff but never its brief', () => {
    // The mirror direction: a reverse-audit brief carries the method and the
    // cumulative findings list, so an auditor that never opened it did not
    // perform the audit however much of the diff it read.
    const prompt = built('reverse-audit');
    transcript('S0', 'a0', prompt, {
      opens: [DIFF],
      finalText: 'Audit complete; nothing further.',
    });
    expect(recoverFindings({ plan, out: out() }, ENV).recoveredKeys).toEqual(
      [],
    );
  });

  it('requires the findings list a verifier was told to read', () => {
    // The floor the compose-time gate applies to the same key. Without it,
    // recovery certifies a verifier that skipped the read and compose then
    // rules the very same key `findings-unread`.
    const key = 'verify';
    const prompt = built(key);
    const findings = findingsFilePath(plan, key);
    writeFileSync(findings, '- **[Critical]** x.ts:1 — y');

    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, key)],
      finalText: 'Verified.',
    });
    expect(recoverFindings({ plan, out: out() }, ENV).recoveredKeys).toEqual(
      [],
    );

    // ...and it recovers once the list was actually opened.
    transcript('S0', 'a1', prompt, {
      opens: [briefPath(plan, key), findings],
      finalText: 'Verified, with the list read.',
    });
    expect(recoverFindings({ plan, out: out() }, ENV).recoveredKeys).toEqual([
      key,
    ]);
  });

  it('does not veto an auditor that QUOTES an uncoverable declaration', () => {
    // The brief instructs verbatim quoting of the evidence, so a certified
    // auditor's text legitimately contains the line. Applied raw, the veto
    // matched the quotation, dropped the round from recovery, and regressed
    // `latestReverseAuditRound` — restarting the audit loop a round early.
    const key = 'reverse-audit--round-2--abc123def456';
    const prompt = built(key);
    transcript('S0', 'a0', prompt, {
      opens: [briefPath(plan, key)],
      finalText:
        'Reviewed the round-1 declarations. One of them reads:\n' +
        'Uncoverable: chunk 1 — a line exceeds the read limit\n' +
        'That declaration is sound.',
    });
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.recoveredKeys).toEqual([key]);
    expect(r.latestReverseAuditRound).toBe(2);
  });

  it('fences findings files by the run epoch', () => {
    // Nothing clears the record dir: a PREVIOUS review of the same PR leaves
    // its rounds' lists behind, and restoring one would hand a resumed run a
    // foreign attempt's state.
    const recordDir = promptRecordDir(plan);
    const key = 'reverse-audit--round-1--abc123def456';
    const stale = join(recordDir, `${encodeURIComponent(key)}.findings.md`);
    writeFileSync(stale, '- from a previous review');
    const old = new Date(2019, 0, 1);
    utimesSync(stale, old, old);
    expect(recoverFindings({ plan, out: out() }, ENV).findingsFiles).toEqual(
      [],
    );
  });

  it('decodes a key whose file name is percent-encoded', () => {
    const recordDir = promptRecordDir(plan);
    const key = 'invariant-a--packages/cli/src/x.ts';
    writeFileSync(
      join(recordDir, `${encodeURIComponent(key)}.findings.md`),
      '- entry',
    );
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.findingsFiles.map((f) => f.key)).toEqual([key]);
  });

  it('reports the budget stop the interrupted attempt left standing', () => {
    writeFileSync(
      join(promptRecordDir(plan), 'budget-stop.json'),
      JSON.stringify({
        cause: 'round-cap',
        cap: 5,
        entry: 'the audit stopped at the round cap',
        entryZh: '审计在轮数上限停止',
        round: 5,
        remainingSeconds: 900,
        reserveSeconds: 1200,
        atMs: Date.now(),
      }),
    );
    const r = recoverFindings({ plan, out: out() }, ENV);
    expect(r.budgetStop?.cause).toBe('round-cap');
  });

  it('counts only CERTIFIED rounds toward latestReverseAuditRound', () => {
    const k1 = 'reverse-audit--round-1--abc123def456';
    const k2 = 'reverse-audit--round-2--abc123def456';
    const p1 = built(k1);
    built(k2); // built, but its agent never opened anything
    transcript('S0', 'ra1', p1, {
      opens: [briefPath(plan, k1)],
      finalText: 'Round 1: no new issues after a full walk.',
    });
    transcript('S0', 'ra2', `You are ${k2}.`, {
      opens: [],
      finalText: 'Round 2: nothing.',
    });
    expect(
      recoverFindings({ plan, out: out() }, ENV).latestReverseAuditRound,
    ).toBe(1);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'discloses an unreadable record dir instead of printing as empty',
    () => {
      // Guarded like every sibling chmod fixture in this suite: as uid 0 the
      // permission bits are bypassed and the directory stays readable, and on
      // Windows chmod on a directory only toggles the read-only attribute —
      // in both cases `recordDirUnreadable` stays null and this fails on a
      // required merge-queue leg for a reason that has nothing to do with the
      // code.
      const recordDir = promptRecordDir(plan);
      chmodSync(recordDir, 0o000);
      try {
        const r = recoverFindings({ plan, out: out() }, ENV);
        expect(r.recordDirUnreadable).not.toBeNull();
      } finally {
        chmodSync(recordDir, 0o755);
      }
    },
  );

  it('exits 1 when the transcript infrastructure is missing entirely', () => {
    const handler = recoverFindingsCommand.handler as (a: unknown) => void;
    const saved = process.exitCode;
    try {
      handler({ plan, out: out() });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
    }
  });
});
