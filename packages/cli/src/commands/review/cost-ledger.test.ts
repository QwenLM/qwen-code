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
    const plan = join(project, 'plan.json');
    writeFileSync(plan, '{}');
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

  it('aggregates the main loop and each agent, newest records only', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'chats', `${SESSION}.jsonl`),
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
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-03T10:06:00Z',
          message: {
            role: 'user',
            parts: [{ text: 'You are review agent `2` — Agent 2: Security.' }],
          },
        }),
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
  });

  it('renders a one-line summary a reader can act on', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'chats', `${SESSION}.jsonl`),
      event('2026-08-03T10:01:00Z', {
        input: 1_200_000,
        cached: 600_000,
        output: 10_000,
        thoughts: 5_000,
      }),
    );
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('1 model calls');
    expect(text).toContain('1.2M input (50% cached)');
    // Thinking is a subset of output: the total reports output once, with the
    // thinking inside it — never output + thinking.
    expect(text).toContain('10k output (5k thinking)');
    expect(text).toContain('main loop: 1 calls');
    expect(text).toContain('10k out');
  });

  it('reports an empty review as zeros, not a crash', () => {
    const { plan, env } = fixture();
    const ledger = computeLedger(plan, env);
    expect(ledger.totals.calls).toBe(0);
    expect(ledger.main).toBeNull();
    expect(ledger.agents).toEqual([]);
    expect(renderLedger(ledger)).toContain('0 model calls');
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

  it('orders mixed-precision timestamps by time, not by string', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'chats', `${SESSION}.jsonl`),
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
      join(project, 'chats', `${SESSION}.jsonl`),
      event('2026-08-03T10:01:00Z', { input: 999_500, output: 100 }),
    );
    expect(renderLedger(computeLedger(plan, env))).toContain('1.0M input');
  });

  it('falls back to the chunk label when the prompt names no role', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-general-purpose-b7.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-03T10:06:00Z',
          message: {
            role: 'user',
            parts: [{ text: 'Task: reviewing chunk 3 of 5 for this PR.' }],
          },
        }),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents[0].label).toBe('chunk 3');
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
          JSON.stringify({
            type: 'user',
            timestamp: '2026-08-03T10:06:00Z',
            message: {
              role: 'user',
              parts: [
                { text: 'You are review agent `2` — Agent 2: Security.' },
              ],
            },
          }),
          event('2026-08-03T10:06:30Z', { input, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    // The doubled run reads as one marked row, not two rows named alike.
    expect(text).toContain('agent 2 (×2)');
    expect(text).toContain('22k in');
    expect(text).toContain('agents: 2');
  });

  it('truncates the agent block past eight rows', () => {
    const { plan, env, project } = fixture();
    for (let i = 1; i <= 9; i++) {
      writeFileSync(
        join(project, 'subagents', SESSION, `agent-role-${i}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-08-03T10:06:00Z',
            message: {
              role: 'user',
              parts: [
                { text: `You are review agent \`${i}\` — dimension ${i}.` },
              ],
            },
          }),
          event('2026-08-03T10:06:30Z', { input: 10_000 + i, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agents: 9');
    expect(text).toContain('…and 1 more agents');
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
    const plan = join(project, 'plan.json');
    writeFileSync(plan, '{}');
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
