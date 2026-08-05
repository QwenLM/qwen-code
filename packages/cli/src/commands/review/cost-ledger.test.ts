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
      // This helper models ONE usage convention: total = prompt + candidates,
      // with thinking a subset of candidates. The disjoint convention
      // (thoughts a sibling of candidates, total = prompt + candidates +
      // thoughts) is real too — the both-conventions derivation test writes
      // those records raw, where the two formulas actually diverge.
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
    // overwrite this; tests for a missing chat file remove it; tests for
    // the empty-window refusal use it as-is.
    writeFileSync(join(project, 'chats', `${SESSION}.jsonl`), '');
    const plan = join(project, 'plan.json');
    // A real plan, shape-wise: the ledger validates it before trusting its
    // mtime as the billing floor.
    writeFileSync(
      plan,
      JSON.stringify({
        diffPathAbsolute: join(project, 'diff.txt'),
        diffLines: 10,
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

  /**
   * One real main-loop call. Agents-only records with no above-floor
   * main-loop call are refused as an unreadable chat transcript, so every
   * agent-focused fixture writes the main call its agents' launch implies.
   */
  function writeMainCall(project: string): void {
    writeFileSync(
      chatFile(project),
      event('2026-08-03T10:01:00Z', { input: 500, output: 50 }),
    );
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
        // Nor is a non-assistant record CARRYING usage — a `}{`-glued
        // corruption fragment can leave a stray usageMetadata attached to
        // the wrong half. The type filter, not the usage check, excludes it.
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-03T10:04:00Z',
          usageMetadata: {
            promptTokenCount: 7_777,
            candidatesTokenCount: 7,
            totalTokenCount: 7_784,
          },
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
    // just the totals line — and the seconds→minutes wall conversion, whose
    // only other non-zero fixture asserts the raw field.
    const text = renderLedger(ledger);
    expect(text).toContain('7 min wall');
    expect(text).toContain('main loop: 2 calls · 210k in · 3k out');
    expect(text).toContain('agent 2: 2 calls · 73k in · 1k out');
  });

  it('derives output as total − prompt under both usage conventions', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      [
        // The disjoint convention: thoughts a sibling of candidates, so
        // total = prompt + candidates + thoughts. Output must be
        // total − prompt = 500 — bare candidates would drop the thinking.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:01:00Z',
          usageMetadata: {
            promptTokenCount: 1_000,
            candidatesTokenCount: 400,
            thoughtsTokenCount: 100,
            totalTokenCount: 1_500,
          },
        }),
        // No total reported at all: candidates is the only number there is,
        // and the subset convention keeps it correct.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:02:00Z',
          usageMetadata: {
            promptTokenCount: 1_000,
            candidatesTokenCount: 400,
          },
        }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    // 500 (total − prompt) + 400 (candidates fallback).
    expect(ledger.main?.outputTokens).toBe(900);
    expect(ledger.main?.thoughtsTokens).toBe(100);
  });

  it('coerces broken provider counts instead of corrupting totals', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      [
        event('2026-08-03T10:01:00Z', {
          input: 1_000,
          cached: 500,
          output: 100,
        }),
        // A broken OpenAI-compat proxy: the agent path records provider
        // usage uncoerced, so negative counts reach the ledger. Summed, they
        // would render >100% cached shares and negative rows in the archive.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:02:00Z',
          usageMetadata: {
            promptTokenCount: -5_000,
            cachedContentTokenCount: -4_000,
            candidatesTokenCount: -1_000,
            totalTokenCount: -6_000,
          },
        }),
        // Positive but INVERTED: cached above prompt passes the ≥ 0 check
        // and would render a 500% share. It is clamped to its own prompt,
        // so the rendered share and the archived JSON both stay ≤ 100%.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:03:00Z',
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 5_000,
            candidatesTokenCount: 50,
            totalTokenCount: 150,
          },
        }),
        // Mixed-sign: prompt negative, total positive. Deriving output as
        // total − coerced-prompt would bill the call's whole total as
        // output; it falls back to candidates instead.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:04:00Z',
          usageMetadata: {
            promptTokenCount: -5_000,
            candidatesTokenCount: 100,
            totalTokenCount: 6_000,
          },
        }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.totals.calls).toBe(4);
    // 1_000 + 0 + 100 + 0.
    expect(ledger.totals.inputTokens).toBe(1_100);
    // 500 + 0 + min(5_000, 100) + 0.
    expect(ledger.totals.cachedTokens).toBe(600);
    // 100 + 0 + (150 − 100) + 100 (candidates fallback).
    expect(ledger.totals.outputTokens).toBe(250);
    // The clamp keeps the archived share sane: 600 / 1_100 → 55%, never
    // the 500% the raw counts would render.
    expect(renderLedger(ledger)).toContain('(55% cached)');
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

  it('refuses an empty window even when no agents ran', () => {
    const { plan, env } = fixture();
    // The recorder pre-creates the chat file and degrades permanently on a
    // failed first append, while a live review always holds at least one
    // above-floor main-loop record — the plan itself is a main-loop write.
    // A zero window is therefore the degraded-recorder fact, with or
    // without agents — never a cheaper "empty review".
    expect(() => computeLedger(plan, env)).toThrow(
      /no main-loop usage records at or after the plan/,
    );
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
    // Each validated field independently: a fixture per condition, each
    // satisfying the other, so relaxing either one alone turns a test red.
    writeFileSync(notPlan, JSON.stringify({ chunks: [{ id: 1 }] }));
    expect(() => computeLedger(notPlan, env)).toThrow(
      /not a review plan report/,
    );
    writeFileSync(notPlan, JSON.stringify({ diffLines: 42 }));
    expect(() => computeLedger(notPlan, env)).toThrow(
      /not a review plan report/,
    );
  });

  it('accepts a degraded diff-less plan — its mtime is still the floor', () => {
    const { plan, env, project } = fixture();
    // fetch-pr writes diffPathAbsolute: null with chunks: [] on two real
    // paths (unresolvable merge base, the tiling fallback). That file IS the
    // Step 1 plan report, and the ledger needs only its mtime.
    writeFileSync(
      plan,
      JSON.stringify({ diffPathAbsolute: null, diffLines: 0, chunks: [] }),
    );
    const start = new Date('2026-08-03T10:00:00Z');
    utimesSync(plan, start, start);
    writeMainCall(project);
    expect(computeLedger(plan, env).totals.calls).toBe(1);
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

  it('refuses agents-only totals when the chat file exists but is empty', () => {
    const { plan, env, project } = fixture();
    // The recorder pre-creates the chat file; a failed first append degrades
    // it permanently, leaving the file present with zero records while
    // agents run. That must not slip past the missing-file refusal and
    // present agents-only totals as the review's whole cost.
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
    // Same refusal when every main-loop record predates the plan: an
    // above-floor agent with no above-floor main call is the same state.
    writeFileSync(
      chatFile(project),
      event('2026-08-03T09:00:00Z', { input: 1_000, output: 100 }),
    );
    expect(() => computeLedger(plan, env)).toThrow(
      /no main-loop usage records at or after the plan/,
    );
  });

  it('loses only the unreadable agent transcript, not the whole ledger', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // EISDIR on read: a listed transcript that cannot be opened. One corrupt
    // agent record must cost that agent's row, never the ledger.
    mkdirSync(join(project, 'subagents', SESSION, 'agent-bad.jsonl'));
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-ok.jsonl'),
      [
        userRecord('You are review agent `ok` — dimension.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents).toHaveLength(1);
    expect(ledger.agents[0].label).toBe('agent ok');
    expect(ledger.agents[0].inputTokens).toBe(1_000);
  });

  it('ignores the harness sidecar files beside the transcripts', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-1.jsonl'),
      [
        userRecord('You are review agent `1` — dimension 1.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    // The harness writes siblings per agent (agent-transcript.ts): a
    // `.meta.json` that carries an `agentId`, and a transient
    // `.jsonl.stream`. Both readers of this dir share one filter
    // (listAgentTranscriptFiles); admitted here, the meta's `agentId` would
    // surface as a phantom row and break (×N) folding.
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-1.meta.json'),
      JSON.stringify({
        agentId: 'role-1',
        agentType: 'general-purpose',
        description: 'dimension 1',
        parentSessionId: SESSION,
        parentAgentId: null,
        createdAt: '2026-08-03T10:06:00.000Z',
        status: 'completed',
      }),
    );
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-1.jsonl.stream'),
      'streaming text, not jsonl records',
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents).toHaveLength(1);
    expect(ledger.agents[0].id).toBe('role-1');
    expect(renderLedger(ledger)).not.toContain('(×2)');
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

  it('rounds fractional tiers to the nearest unit, not down', () => {
    const { plan, env, project } = fixture();
    writeFileSync(
      chatFile(project),
      event('2026-08-03T10:01:00Z', {
        input: 45_600,
        cached: 5_700,
        output: 100,
      }),
    );
    // 45_600 → "46k" (the docstring's own example, not "45k"), and
    // 5_700 / 45_600 = 12.5% → "13% cached".
    expect(renderLedger(computeLedger(plan, env))).toContain(
      '46k input (13% cached)',
    );
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
        // Arrays are objects to typeof: without its own guard this would
        // count as a phantom zero-token call.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:01:30Z',
          usageMetadata: [],
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
    writeMainCall(project);
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

  it('labels a free-text chunk mention by the file id, not the quoted chunk', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // No identity line at the head: an older harness, or an agent this
    // review never launched. Its free text names a chunk, but parsing free
    // text for labels folds it into the real chunk-3 agent's row as a
    // phantom (×2) relaunch. The file's own id is the one label it owns.
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-general-purpose-b7.jsonl'),
      [
        userRecord('Task: reviewing chunk 3 of 5 for this PR.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents[0].label).toBe('general-purpose-b7');
  });

  it('falls back to the file id when the prompt names neither role nor chunk', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
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

  it('distinguishes parallel invariant agents by full path, not basename', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // Step 3B launches invariant-a once PER heavy file, and a monorepo
    // routinely holds same-basename files in different packages. Folding by
    // bare role — or by basename — renders one (×2) row, the marker
    // reserved for relaunches, and erases the per-file breakdown the
    // distinguisher exists to keep.
    for (const [file, owned] of [
      ['agent-invariant-x1.jsonl', 'packages/cli/src/config/storage.ts'],
      ['agent-invariant-x2.jsonl', 'packages/core/src/config/storage.ts'],
    ] as const) {
      writeFileSync(
        join(project, 'subagents', SESSION, file),
        [
          userRecord(
            'You are review agent `invariant-a` — the hot-path audit.' +
              ` Your file: \`${owned}\`.`,
          ),
          event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain(
      'agent invariant-a (packages/cli/src/config/storage.ts):',
    );
    expect(text).toContain(
      'agent invariant-a (packages/core/src/config/storage.ts):',
    );
    expect(text).not.toContain('(×2)');
  });

  it('labels a fork agent from its launch prompt, not the bootstrap before it', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-fork-f1.jsonl'),
      [
        // A fork's first record is the inherited conversation — an
        // agent_bootstrap system record that quotes another agent's identity
        // line and can outgrow any fixed head slice. The launch prompt is the
        // first USER record, after it.
        JSON.stringify({
          type: 'system',
          subtype: 'agent_bootstrap',
          timestamp: '2026-08-03T10:05:00Z',
          systemPayload: {
            kind: 'fork',
            history: [
              {
                text:
                  'Earlier turn: You are review agent `chunk 1 of 5` — ' +
                  `the territory agent. ${'x'.repeat(70_000)}`,
              },
            ],
          },
        }),
        userRecord('You are review agent `verify` — the reverse audit.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents[0].label).toBe('agent verify');
  });

  it('orders agents by input, biggest first, regardless of file order', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // The small agent gets the lexically EARLIER name and is written FIRST:
    // a write-order filesystem and a lexical readdir both list [small, big],
    // so only the sort can produce [big, small].
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-a.jsonl'),
      [
        userRecord('You are review agent `small` — dimension.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-z.jsonl'),
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

  it('skips agent files whose mtime predates the plan without opening them', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // An earlier review in the same session: the dir is session-scoped and
    // never pruned, so its files are still listed — the mtime pre-filter is
    // what keeps them out.
    const stale = join(project, 'subagents', SESSION, 'agent-role-old.jsonl');
    writeFileSync(
      stale,
      [
        userRecord('You are review agent `old` — an earlier review.'),
        event('2026-08-03T10:06:30Z', { input: 9_000, output: 900 }),
      ].join('\n'),
    );
    const before = new Date('2026-08-03T09:30:00Z');
    utimesSync(stale, before, before);
    const ledger = computeLedger(plan, env);
    expect(ledger.agents).toEqual([]);
    expect(ledger.totals.inputTokens).toBe(500);
  });

  it('floors agent events by timestamp even when the file itself is fresh', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // A first-review agent still appending when the second review's plan
    // lands: the file's mtime crosses the new floor (the pre-filter keeps
    // it), so the event-level floor is the only thing keeping the earlier
    // review's spend out of this ledger.
    const straddling = join(
      project,
      'subagents',
      SESSION,
      'agent-role-first.jsonl',
    );
    writeFileSync(
      straddling,
      [
        userRecord('You are review agent `first` — the earlier review.'),
        event('2026-08-03T09:00:00Z', { input: 9_000, output: 900 }),
      ].join('\n'),
    );
    const after = new Date('2026-08-03T10:30:00Z');
    utimesSync(straddling, after, after);
    const ledger = computeLedger(plan, env);
    expect(ledger.agents).toEqual([]);
    expect(ledger.totals.inputTokens).toBe(500);
  });

  it('skips an agent killed before its first response, with no phantom row', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // Only the launch prompt, no usage event: the harness wrote the record,
    // the agent never got a model response.
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-dead.jsonl'),
      userRecord('You are review agent `dead` — killed at launch.'),
    );
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-live.jsonl'),
      [
        userRecord('You are review agent `live` — dimension.'),
        event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
      ].join('\n'),
    );
    const ledger = computeLedger(plan, env);
    expect(ledger.agents).toHaveLength(1);
    expect(ledger.agents[0].label).toBe('agent live');
    // The phantom must not inflate the run count the fold math feeds on.
    expect(renderLedger(ledger)).toContain('agent runs: 1');
  });

  it('folds a relaunched agent into one (×N) row', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
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
    writeMainCall(project);
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

  it('truncates the agent block past eight rows, keeping the biggest', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
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
    // Membership, not just the footnote: the cut keeps the top spenders and
    // truncates the smallest — never the other way around.
    expect(text).toContain('agent 9:');
    expect(text).not.toContain('agent 1:');
    expect(text).toContain('…and 1 more agent · 10k in combined');
  });

  it('renders exactly eight agent rows with no truncation footnote', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // The common full-roster shape (5 chunk + 3 dimension agents) lands
    // exactly on the cut: no "…and 0 more agents" nonsense line.
    for (let i = 1; i <= 8; i++) {
      writeFileSync(
        join(project, 'subagents', SESSION, `agent-role-${i}.jsonl`),
        [
          userRecord(`You are review agent \`${i}\` — dimension ${i}.`),
          event('2026-08-03T10:06:30Z', { input: 10_000 + i, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agent runs: 8');
    expect(text).toContain('agent 8:');
    expect(text).not.toContain('…and');
  });

  it('counts folded runs below the cut as agents, not rows', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // Eight solo rows big enough to keep the folded pair below the cut: the
    // footnote must count its RUNS (2), not its rows (1) — a repair-round
    // doubling hidden under the cut is exactly what the ledger exists to
    // surface.
    for (let i = 1; i <= 8; i++) {
      writeFileSync(
        join(project, 'subagents', SESSION, `agent-role-${i}.jsonl`),
        [
          userRecord(`You are review agent \`${i}\` — dimension ${i}.`),
          event('2026-08-03T10:06:30Z', { input: 100_000 + i, output: 100 }),
        ].join('\n'),
      );
    }
    for (const file of ['agent-role-d1.jsonl', 'agent-role-d2.jsonl']) {
      writeFileSync(
        join(project, 'subagents', SESSION, file),
        [
          userRecord('You are review agent `dup` — relaunched dimension.'),
          event('2026-08-03T10:06:30Z', { input: 1_000, output: 100 }),
        ].join('\n'),
      );
    }
    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agent runs: 10');
    expect(text).toContain('…and 2 more agents · 2k in combined');
  });
  it('keeps a reverse-audit chunk auditor apart from the territory finder', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-t3.jsonl'),
      [
        userRecord(
          'You are review agent `chunk 3 of 5` — the territory agent.\n' +
            'read_file(file_path="/abs/diff.txt", offset=100, limit=50)',
        ),
        event('2026-08-03T10:07:00Z', { input: 40_000, output: 500 }),
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-ra3.jsonl'),
      [
        userRecord(
          'You are review agent `chunk 3 of 5` — the territory agent.\n' +
            'read_file(file_path="/p/plan-prompts/reverse-audit--chunk-3--round-2--ab12cd.brief.md")',
        ),
        event('2026-08-03T10:08:00Z', { input: 30_000, output: 400 }),
      ].join('\n'),
    );

    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('chunk 3:');
    expect(text).toContain('audit chunk 3 (round 2):');
    expect(text).not.toContain('(×2)');
  });

  it('labels an auditor from its own brief line, not a quoted audit path', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    // From round 2 on, an auditor's launch carries the folded findings ABOVE
    // its own brief line, and those findings quote earlier rounds' brief
    // paths — bare and in read_file shape alike. The label must come from
    // the agent's OWN brief line, the last brief-shaped read_file in the
    // launch: the folds always sit above it.
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-ra4.jsonl'),
      [
        userRecord(
          'You are review agent `chunk 5 of 5` — the territory agent.\n' +
            '\n' +
            '## Already confirmed — do not re-report these\n' +
            '\n' +
            '- misattributed spend: reverse-audit--chunk-3--round-1--ab12cd.brief.md\n' +
            '- quoted launch block:\n' +
            '  read_file(file_path="/p/plan-prompts/reverse-audit--chunk-3--round-1--ab12cd.brief.md")\n' +
            '\n' +
            '**Your brief is a file. Read it first.**\n' +
            '\n' +
            'read_file(file_path="/p/plan-prompts/reverse-audit--chunk-5--round-2--ef56ab.brief.md")',
        ),
        event('2026-08-03T10:08:00Z', { input: 30_000, output: 400 }),
      ].join('\n'),
    );

    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('audit chunk 5 (round 2):');
    expect(text).not.toContain('audit chunk 3');
  });

  it('separates rounds by label while shards of one round still fold', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    const put = (file: string, identity: string, input: number) =>
      writeFileSync(
        join(project, 'subagents', SESSION, file),
        [
          userRecord(identity),
          event('2026-08-03T10:07:00Z', { input, output: 100 }),
        ].join('\n'),
      );
    put(
      'agent-ra1.jsonl',
      'You are review agent `reverse-audit` — Reverse audit (round 1).',
      20_000,
    );
    put(
      'agent-ra2.jsonl',
      'You are review agent `reverse-audit` — Reverse audit (round 2).',
      21_000,
    );
    put(
      'agent-v1.jsonl',
      'You are review agent `verify` — Verification (round 2).',
      9_000,
    );
    put(
      'agent-v2.jsonl',
      'You are review agent `verify` — Verification (round 2).',
      8_000,
    );

    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agent reverse-audit (round 1):');
    expect(text).toContain('agent reverse-audit (round 2):');
    expect(text).toContain('agent verify (round 2) (×2):');
  });

  it('reads the round from the identity line, never from folded findings', () => {
    const { plan, env, project } = fixture();
    writeMainCall(project);
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-v0.jsonl'),
      [
        userRecord(
          'You are review agent `verify` — Verification.\n' +
            '- quoted ledger row: agent verify (round 4): 1 call · 7k in · 80 out\n',
        ),
        event('2026-08-03T10:07:00Z', { input: 7_000, output: 80 }),
      ].join('\n'),
    );

    const text = renderLedger(computeLedger(plan, env));
    expect(text).toContain('agent verify:');
    expect(text).not.toContain('agent verify (round 4)');
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
    process.exitCode = undefined;
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
        diffLines: 10,
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
    // The describe's whole contract, asserted on every path: the ledger is
    // informational, and a review must never fail on its own accounting —
    // "exits 0" in each title is this line, not a hope.
    expect(process.exitCode ?? 0).toBe(0);
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
    // The path, contiguous with OUR message: the relayed line is all a
    // maintainer gets in headless CI, and the errno text happening to carry
    // the path must not stand in for the message naming it.
    expect(stderr).toContain(
      'could not read the plan report /nonexistent/plan.json',
    );
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
    // Contiguous, so the errno text carrying the path cannot mask a message
    // that stopped naming it.
    expect(stderr).toContain(
      `could not read the chat transcript ${join(project, 'chats', `${SESSION}.jsonl`)}`,
    );
    expect(stdout).not.toContain('Cost ledger:');
  });

  it('exits 0 when the terminal writes throw — the reader went away', () => {
    const { plan, project } = fixture();
    const start = new Date('2026-08-03T10:00:00Z');
    utimesSync(plan, start, start);
    setEnv({
      QWEN_CODE_PROJECT_DIR: project,
      QWEN_CODE_SESSION_ID: SESSION,
    } as NodeJS.ProcessEnv);
    // A pipe whose reader left (`qwen … | head`): the write throws. All
    // three terminal writes — the unavailable warning, the could-not-write
    // warning, and the ledger block — must absorb it; the review must never
    // fail on its own accounting, including the accounting of a reader that
    // left.
    const pipeGone = (): boolean => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    const runWithBrokenPipes = (args: Record<string, unknown>): void => {
      const outSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(pipeGone);
      const errSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(pipeGone);
      try {
        (costLedgerCommand.handler as (a: unknown) => void)(args);
      } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
      }
      expect(process.exitCode ?? 0).toBe(0);
    };
    // The unavailable-warning arm: no above-floor records.
    runWithBrokenPipes({ plan });
    // The ledger-block arm: a real spend.
    writeFileSync(
      join(project, 'chats', `${SESSION}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-03T10:01:00Z',
        usageMetadata: {
          promptTokenCount: 1_000,
          candidatesTokenCount: 100,
          totalTokenCount: 1_100,
        },
      }),
    );
    runWithBrokenPipes({ plan });
  });

  it('writes --out into a directory it creates, with every stream kept', () => {
    const { plan, project } = fixture();
    // A real spend, so the archive contract is observable: SKILL.md promises
    // the --out JSON keeps every stream — totals alone cannot answer the
    // "which agent doubled" question the archive exists for.
    const start = new Date('2026-08-03T10:00:00Z');
    utimesSync(plan, start, start);
    writeFileSync(
      join(project, 'chats', `${SESSION}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-03T10:01:00Z',
        usageMetadata: {
          promptTokenCount: 1_000,
          candidatesTokenCount: 100,
          totalTokenCount: 1_100,
        },
      }),
    );
    mkdirSync(join(project, 'subagents', SESSION), { recursive: true });
    writeFileSync(
      join(project, 'subagents', SESSION, 'agent-role-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-03T10:06:00Z',
          message: {
            role: 'user',
            parts: [{ text: 'You are review agent `1` — dimension 1.' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-08-03T10:06:30Z',
          usageMetadata: {
            promptTokenCount: 2_000,
            candidatesTokenCount: 200,
            totalTokenCount: 2_200,
          },
        }),
      ].join('\n'),
    );
    setEnv({
      QWEN_CODE_PROJECT_DIR: project,
      QWEN_CODE_SESSION_ID: SESSION,
    } as NodeJS.ProcessEnv);
    const out = join(project, 'archive', 'nested', 'ledger.json');
    const { stdout } = run({ plan, out });
    expect(stdout).toContain('Cost ledger:');
    const written = JSON.parse(readFileSync(out, 'utf8')) as {
      totals: { calls: number };
      main: { id: string } | null;
      agents: Array<{ id: string; label: string; inputTokens: number }>;
    };
    expect(written.totals.calls).toBe(2);
    expect(written.main?.id).toBe('main');
    expect(written.agents).toHaveLength(1);
    expect(written.agents[0]).toMatchObject({
      id: 'role-1',
      label: 'agent 1',
      inputTokens: 2_000,
    });
  });

  it('degrades a failed --out write to a warning and still exits 0', () => {
    const { plan, project } = fixture();
    const start = new Date('2026-08-03T10:00:00Z');
    utimesSync(plan, start, start);
    writeFileSync(
      join(project, 'chats', `${SESSION}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-03T10:01:00Z',
        usageMetadata: {
          promptTokenCount: 1_000,
          candidatesTokenCount: 100,
          totalTokenCount: 1_100,
        },
      }),
    );
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
