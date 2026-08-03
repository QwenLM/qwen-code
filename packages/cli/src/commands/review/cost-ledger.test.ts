/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLedger, renderLedger } from './cost-ledger.js';

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
      totalTokenCount:
        (usage.input ?? 0) + (usage.output ?? 0) + (usage.thoughts ?? 0),
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
    expect(text).toContain('15k output (5k thinking)');
    expect(text).toContain('main loop: 1 calls');
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
});
