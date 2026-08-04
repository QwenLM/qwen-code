/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeLedger,
  renderLedger,
  costLedgerCommand,
} from './cost-ledger.js';

const SESSION = 'S-ledger';

function event(
  timestamp: string,
  usage: {
    input?: number;
    cached?: number;
    output?: number;
    thoughts?: number;
  },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    usageMetadata: {
      promptTokenCount: usage.input ?? 0,
      cachedContentTokenCount: usage.cached ?? 0,
      candidatesTokenCount: usage.output ?? 0,
      thoughtsTokenCount: usage.thoughts ?? 0,
      // The records' own contract: total = prompt + candidates. Thinking is a
      // subset of candidates, not a sibling — never add it here.
      totalTokenCount: (usage.input ?? 0) + (usage.output ?? 0),
    },
    ...extra,
  });
}

function userRecord(text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-08-03T10:06:00Z',
    message: { role: 'user', parts: [{ text }] },
  });
}

describe('cost-ledger — the spend, from the records already on disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture(): {
    plan: string;
    env: NodeJS.ProcessEnv;
    project: string;
  } {
    const project = mkdtempSync(join(tmpdir(), 'ledger-'));
    dirs.push(project);
    mkdirSync(join(project, 'chats'), { recursive: true });
    mkdirSync(join(project, 'subagents', SESSION), { recursive: true });
    // Recording on, no above-floor records yet. Tests that need calls
    // overwrite this; tests for a missing chat file remove it.
    writeFileSync(join(project, 'chats', `${SESSION}.jsonl`), '');
    const plan = join(project, 'plan.json');
    // A real plan, shape-wise: the ledger validates it before trusting its
    // mtime as the billing floor.
    writeFileSync(
      plan,
      JSON.stringify({
        diffPathAbsolute: join(project, 'diff.txt'),
        chunks: [{ id: 1, startLine: 1, endLine: 10 }],
      }),
    );
    // The review "started" at 10:00; the plan's mtime is the billing floor.
    const start = new Date('2026-08-03T10:00:00Z');
    utimesSync(plan, start, start);
    return {
      plan,
      project,
      env: {
        QWEN_CODE_PROJECT_DIR: project,
        QWEN_CODE_SESSION_ID: SESSION,
      } as NodeJS.ProcessEnv,
    };
  }

  function chatFile(project: string): string {
    return join(project, 'chats', `${SESSION}.jsonl`);
  }

  it('aggregates the main loop and each agent, newest records only', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      [
        // Before the plan: the session's earlier, unrelated conversation.
        event('2026-08-03T09:00:00Z', { input: 500_000, output: 9_000 }),
        event('2026-08-03T10:01:00Z', {
          input: 100_000,
          cached: 90_000,
          output: 1_000,
          thoughts: 200,
        }),
        event('2026-08-03T10:05:00Z', {
          input: 110_000,
          cached: 105_000,
          output: 2_000,
        }),
        // Non-assistant and usage-less lines are not model calls.
        JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:02:00Z' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:03:00Z',
        }),
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-general-purpose-a1.jsonl'),
      [
        userRecord('You are review agent `2` — Agent 2: Security.'),
        event('2026-08-03T10:06:30Z', {
          input: 33_000,
          output: 400,
          thoughts: 100,
        }),
        event('2026-08-03T10:08:00Z', {
          input: 40_000,
          cached: 33_000,
          output: 600,
        }),
      ].join('\n'),
    );

    const ledger = computeLedger(plan, env);

    expect(ledger.totals.calls).toBe(4);
    expect(ledger.totals.inputTokens).toBe(283_000);
    expect(ledger.totals.cachedTokens).toBe(228_000);
    expect(ledger.totals.outputTokens).toBe(4_000);
    expect(ledger.totals.thoughtsTokens).toBe(300);
    // 10:01:00 → 10:08:00.
    expect(ledger.totals.wallSeconds).toBe(420);

    expect(ledger.main?.calls).toBe(2);
    expect(ledger.main?.inputTokens).toBe(210_000);

    expect(ledger.agents).toHaveLength(1);
    expect(ledger.agents[0].label).toBe('agent 2');
    expect(ledger.agents[0].inputTokens).toBe(73_000);

    // The block is archived verbatim, so pin the per-stream values too — not
    // just the totals line.
    const text = renderLedger(ledger);
    expect(text).toContain('main loop: 2 calls · 210k in · 3k out');
    expect(text).toContain('agent 2: 2 calls · 73k in · 1k out');
  });

  it('renders a one-line summary a reader can act on', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      event('2026-08-03T10:01:00Z', {
        input: 1_200_000,
        cached: 600_000,
        output: 10_000,
        thoughts: 5_000,
      }),
    );
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('1 model call');
    expect(text).toContain('1.2M input (50% cached)');
    // Thinking is a subset of output: the total reports output once, with the
    // thinking inside it — never output + thinking.
    expect(text).toContain('10k output (5k thinking)');
    expect(text).toContain('main loop: 1 call · 1.2M in · 10k out');
  });

  it('reports an empty review as zeros, not a crash', () => {
    const { plan, env } = fixture();
    const ledger = computeLedger(plan, env);
    expect(ledger.totals.calls).toBe(0);
    expect(ledger.main).toBeNull();
    expect(ledger.agents).toEqual([]);
    expect(renderLedger(ledger)).toContain('0 model calls');
    expect(renderLedger(ledger)).toContain('0 input (0% cached)');
  });

  it('throws TranscriptsUnavailable through to the caller when the env is bare', () => {
    const { plan } = fixture();
    expect(() => computeLedger(plan, {} as NodeJS.ProcessEnv)).toThrow(
      /QWEN_CODE_PROJECT_DIR/,
    );
  });

  it('names a missing plan as the plan, not the usage records', () => {
    const { env } = fixture();
    expect(() => computeLedger('/nonexistent/plan.json', env)).toThrow(
      /could not read the plan report/,
    );
  });

  it('rejects an existing file that is not the plan report', () => {
    const { env, project } = fixture();
    // The mtime alone defines the billing window; a wrong-but-existing file
    // (the findings JSON, the report) must say so, not silently move the
    // floor.
    const notPlan = join(project, 'findings.json');
    writeFileSync(notPlan, '{}');
    expect(() => computeLedger(notPlan, env)).toThrow(
      /not a review plan report/,
    );
    writeFileSync(notPlan, 'not json at all');
    expect(() => computeLedger(notPlan, env)).toThrow(
      /not a review plan report/,
    );
  });

  it('refuses to render agents-only totals when the chat transcript is missing', () => {
    const { plan, env, project } = fixture();
    // Agents ran and left records; the chat file never existed (chat
    // recording off). The plan proves the main loop made calls, so the
    // agents-only sum is not the review's cost — say the ledger is
    // unavailable instead of printing it as the total.
    rmSync(chatFile(project));
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-1.jsonl'),
      [
        userRecord('You are review agent `1` — dimension 1.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    expect(() => computeLedger(plan, env)).toThrow(
      /could not read the chat transcript/,
    );
  });

  it('surfaces a fault reading the chat file, not a zero ledger', () => {
    const { plan, env, project } = fixture();
    rmSync(chatFile(project), { recursive: true, force: true });
    mkdirSync(chatFile(project)); // EISDIR where the file should be
    expect(() => computeLedger(plan, env)).toThrow(
      /could not read the chat transcript/,
    );
  });

  it('surfaces an unreadable subagent directory instead of main-loop-only totals', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      [event('2026-08-03T10:01:00Z', { input: 1_000, output: 100 })].join('\n'),
    );
    rmSync(join(project, 'subagents', SESSION), {
      recursive: true,
      force: true,
    });
    // ENOTDIR where the directory should be: not ENOENT, so not "no agents".
    writeFileSync(join(project, 'subagents', SESSION), 'in the way');
    expect(() => computeLedger(plan, env)).toThrow(
      /could not list the subagent transcripts/,
    );
  });

  it('orders mixed-precision timestamps by time, not by string', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      [
        // Lexically "…:00.500Z" < "…:00Z" ('.' < 'Z'), but it is the later
        // instant. String comparison would swap first and last.
        event('2026-08-03T10:01:00Z', { input: 1_000, output: 100 }),
        event('2026-08-03T10:01:00.500Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.main?.firstAt).toBe('2026-08-03T10:01:00Z');
    expect(ledger.main?.lastAt).toBe('2026-08-03T10:01:00.500Z');
  });

  it('rounds 999.5k up to 1.0M, not 1000k', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      event('2026-08-03T10:01:00Z', { input: 999_500, output: 100 }),
    );
    expect(renderLedger(computeLedger(plan, env))).toContain('1.0M input');
  });

  it('renders billions with a B tier, not 1500.0M', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      event('2026-08-03T10:01:00Z', { input: 1_500_000_000, output: 100 }),
    );
    expect(renderLedger(computeLedger(plan, env))).toContain('1.5B input');
  });

  it('recovers usage records glued onto one line by an interrupted append', () => {
    const { plan, env, project } = fixture();
    const a = event('2026-08-03T10:01:00Z', { input: 1_000, output: 100 });
    const b = event('2026-08-03T10:02:00Z', { input: 2_000, output: 200 });
    // No newline between them: the documented corruption shape of these
    // incrementally flushed files. A bare JSON.parse drops both records.
    writeFileSync(chatFile(project), `${a}${b}\n`);
    const ledger = computeLedger(plan, env);
    expect(ledger.totals.calls).toBe(2);
    expect(ledger.totals.inputTokens).toBe(3_000);
  });

  it('skips null-shaped lines instead of losing the whole ledger', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      [
        // JSON.parse('null') succeeds, so the parse guard alone would not
        // catch it; "usageMetadata": null passes an === undefined guard.
        'null',
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:01:00Z',
          usageMetadata: null,
        }),
        event('2026-08-03T10:02:00Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.totals.calls).toBe(1);
    expect(ledger.totals.inputTokens).toBe(1_000);
  });

  it('labels a chunk agent from its identity line, not as "agent chunk …"', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-chunk-c3.jsonl'),
      [
        userRecord(
          'You are review agent `chunk 3 of 5` — the territory agent for ' +
            'lines 1-100 of the diff.',
        ),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents[0].label).toBe('chunk 3');
  });

  it('falls back to the chunk label when the prompt names no role', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-general-purpose-b7.jsonl'),
      [
        userRecord('Task: reviewing chunk 3 of 5 for this PR.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents[0].label).toBe('chunk 3');
  });

  it('falls back to the file id when the prompt names neither role nor chunk', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-general-purpose-z0.jsonl'),
      [
        userRecord('Do something useful.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents[0].label).toBe('general-purpose-z0');
  });

  it('orders agents by input, biggest first, regardless of file order', () => {
    const { plan, env, project } = fixture();
    // Small written first: the order must come from the sort, not readdir.
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-small.jsonl'),
      [
        userRecord('You are review agent `small` — dimension.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-big.jsonl'),
      [
        userRecord('You are review agent `big` — dimension.'),
        event('2026-08-03T10:06:30Z', { input: 900_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents.map((a) => a.label)).toEqual([
      'agent big',
      'agent small',
    ]);
  });

  it('folds a relaunched agent into one (×N) row', () => {
    const { plan, env, project } = fixture();
    for (const [file, input] of [
      ['agent-general-purpose-a1.jsonl', 10_000],
      ['agent-general-purpose-d9.jsonl', 12_000],
    ] as const) {
      writeFileSync(
        join(project, 'subagents', SESSION, file),
        [
          userRecord('You are review agent `2` — Agent 2: Security.'),
          event('2026-08-03T10:06:30Z', { input, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    // The doubled run reads as one marked row, not two rows named alike.
    expect(text).toContain('agent 2 (×2)');
    expect(text).toContain('22k in');
    expect(text).toContain('agent runs: 2');
  });

  it('ranks a folded (×N) row by its combined total, not its first member', () => {
    const { plan, env, project } = fixture();
    // Two relaunches at 5.0M each must outrank a solo 6.0M agent once
    // folded, or the doubled run this ledger exists to surface is truncated
    // away by the half that sorted lower.
    for (const file of ['agent-role-p1.jsonl', 'agent-role-p2.jsonl']) {
      writeFileSync(
        join(project, 'subagents', SESSION, file),
        [
          userRecord('You are review agent `2` — Agent 2: Security.'),
          event('2026-08-03T10:06:30Z', { input: 5_000_000, output: 100 }),
        ].join('\n'),
      );
    }
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-solo.jsonl'),
      [
        userRecord('You are review agent `3` — Agent 3: Tests.'),
        event('2026-08-03T10:06:30Z', { input: 6_000_000, output: 100 }),
      ].join('\n'),
    );
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agent 2 (×2): 2 calls · 10.0M in · 200 out');
    expect(text.indexOf('agent 2 (×2)')).toBeLessThan(
      text.indexOf('agent 3: 1 call'),
    );
  });

  it('truncates the agent block past eight rows', () => {
    const { plan, env, project } = fixture();
    for (let i = 1; i <= 9; i++) {
      writeFileSync(
        join(project, 'subagents', SESSION, `agent-role-${i}.jsonl`),
        [
          userRecord(`You are review agent \`${i}\` — dimension ${i}.`),
          event('2026-08-03T10:06:30Z', { input: 10_000 + i, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agent runs: 9');
    expect(text).toContain('…and 1 more agent');
  });
});

describe('cost-ledger command boundary — informational, never a failure', () => {
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(env: NodeJS.ProcessEnv): void {
    for (const k of ['QWEN_CODE_PROJECT_DIR', 'QWEN_CODE_SESSION_ID']) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture(): { plan: string; project: string } {
    const project = mkdtempSync(join(tmpdir(), 'ledger-cmd-'));
    dirs.push(project);
    mkdirSync(join(project, 'chats'), { recursive: true });
    writeFileSync(join(project, 'chats', `${SESSION}.jsonl`), '');
    const plan = join(project, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        diffPathAbsolute: join(project, 'diff.txt'),
        chunks: [{ id: 1, startLine: 1, endLine: 10 }],
      }),
    );
    return { plan, project };
  }

  /** Drive the real yargs handler, as `qwen review cost-ledger` does. */
  function run(args: Record<string, unknown>): {
    stdout: string;
    stderr: string;
  } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdout.push(chunk.toString());
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderr.push(chunk.toString());
        return true;
      });
    try {
      (costLedgerCommand.handler as (a: unknown) => void)(args);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    return { stdout: stdout.join(''), stderr: stderr.join('') };
  }

  it('exits 0 with a reason when the ledger cannot be computed', () => {
    const { plan } = fixture();
    setEnv({} as NodeJS.ProcessEnv);
    const { stderr } = run({ plan });
    expect(stderr).toContain('cost-ledger unavailable');
    expect(stderr).toContain('QWEN_CODE_PROJECT_DIR');
  });

  it('exits 0 and names the plan when the plan is missing', () => {
    setEnv({
      QWEN_CODE_PROJECT_DIR: '/tmp',
      QWEN_CODE_SESSION_ID: SESSION,
    } as NodeJS.ProcessEnv);
    const { stderr } = run({ plan: '/nonexistent/plan.json' });
    expect(stderr).toContain('cost-ledger unavailable');
    expect(stderr).toContain('could not read the plan report');
  });

  it('exits 0 and names a missing chat transcript instead of printing agents-only totals', () => {
    const { plan, project } = fixture();
    rmSync(join(project, 'chats', `${SESSION}.jsonl`));
    setEnv({
      QWEN_CODE_PROJECT_DIR: project,
      QWEN_CODE_SESSION_ID: SESSION,
    } as NodeJS.ProcessEnv);
    const { stdout, stderr } = run({ plan });
    expect(stderr).toContain('cost-ledger unavailable');
    expect(stderr).toContain('could not read the chat transcript');
    expect(stdout).not.toContain('Cost ledger:');
  });

  it('writes --out into a directory it creates', () => {
    const { plan, project } = fixture();
    setEnv({
      QWEN_CODE_PROJECT_DIR: project,
      QWEN_CODE_SESSION_ID: SESSION,
    } as NodeJS.ProcessEnv);
    const out = join(project, 'archive', 'nested', 'ledger.json');
    const { stdout } = run({ plan, out });
    expect(stdout).toContain('Cost ledger:');
    const written = JSON.parse(readFileSync(out, 'utf8')) as {
      totals: { calls: number };
    };
    expect(written.totals.calls).toBe(0);
  });

  it('degrades a failed --out write to a warning and still exits 0', () => {
    const { plan, project } = fixture();
    setEnv({
      QWEN_CODE_PROJECT_DIR: project,
      QWEN_CODE_SESSION_ID: SESSION,
    } as NodeJS.ProcessEnv);
    const blocked = join(project, 'blocked');
    writeFileSync(blocked, 'a file where the archive directory would go');
    const { stdout, stderr } = run({ plan, out: join(blocked, 'ledger.json') });
    expect(stderr).toContain('could not write');
    expect(stdout).toContain('Cost ledger:');
    expect(existsSync(join(blocked, 'ledger.json'))).toBe(false);
  });
});
