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
import { promptRecordDir, briefPath } from './lib/prompt-record.js';

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
  writeFileSync(
    join(recordDir, 'run-sessions.json'),
    JSON.stringify([
      { sessionId: 'S0', atMs: Date.now() },
      { sessionId: 'S1', atMs: Date.now() },
    ]),
  );
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
  const base = { agentId: id, agentName: 'general-purpose' };
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
