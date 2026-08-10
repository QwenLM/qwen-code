/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkflowArgs,
  emitWorkflowCommand,
  type WorkflowArgsFile,
} from './emit-workflow.js';
import { buildLaunch } from './agent-prompt.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import type { PlanReport } from './lib/report.js';

/**
 * A small local review: uncommitted changes, no PR, no worktree, under both
 * Step 3A thresholds (srcDiffLines <= 500, diffLines <= 3200).
 */
function localPlan(over: Record<string, unknown> = {}): PlanReport {
  return {
    diffPathAbsolute: '/abs/.qwen/tmp/qwen-review-local-diff.txt',
    diffLines: 240,
    diffChars: 8000,
    srcDiffLines: 180,
    testDiffLines: 60,
    docsDiffLines: 0,
    generatedDiffLines: 0,
    untrackedFiles: [],
    effort: 'high',
    chunks: [
      {
        id: 1,
        startLine: 1,
        endLine: 240,
        lines: 240,
        chars: 8000,
        maxLineChars: 120,
        oversized: false,
        files: [{ path: 'src/a.ts', newStart: 1, newEnd: 200 }],
      },
    ],
    files: [
      {
        path: 'src/a.ts',
        kind: 'source',
        heavy: false,
        addedLines: 150,
        removedLines: 30,
        fileLines: 400,
      },
    ],
    budget: { toolCalls: 40 },
    ...over,
  } as unknown as PlanReport;
}

describe('emit-workflow — the roster it hands the script', () => {
  let dir: string;
  let planPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    planPath = join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify(localPlan()), 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The whole point of routing through `requiredAgents` is that the fan-out and
  // the gate that checks it read one list. A roster this command shortened
  // would be a dimension nobody reviewed, reported as a complete review.
  it('emits exactly the agents the plan requires, under the keys coverage looks up', () => {
    const plan = localPlan();
    const payload = buildWorkflowArgs(plan, planPath);
    const expected = requiredAgents(plan as unknown as RosterPlan).map(
      (r) => r.key,
    );
    expect(payload.agents.map((a) => a.key)).toEqual(expected);
    expect(payload.agents.length).toBeGreaterThan(1);
  });

  // Byte-parity with the hand-launched path is structural — both go through
  // `buildLaunch` — and this pins it so a future refactor that gives this
  // command its own builder fails here rather than in a review whose delivery
  // check reads "the prompt was rewritten".
  it('emits the same prompt the hand-launched roster would', () => {
    const plan = localPlan();
    const payload = buildWorkflowArgs(plan, planPath);
    for (const req of requiredAgents(plan as unknown as RosterPlan)) {
      const { key, prompt } = buildLaunch(
        plan,
        planPath,
        { role: req.role as never, file: req.file },
        undefined,
      );
      const emitted = payload.agents.find((a) => a.key === key);
      expect(emitted?.prompt).toBe(prompt);
    }
  });

  // The launch prompt points at a brief on disk rather than carrying it. An
  // agent whose prompt named no brief would review with no dimension, no
  // severity definitions and no project rules.
  it('points every agent at its brief file', () => {
    const payload = buildWorkflowArgs(localPlan(), planPath);
    for (const a of payload.agents) {
      expect(a.prompt).toContain('read_file');
      expect(a.prompt.length).toBeGreaterThan(80);
    }
  });

  it('carries the effort the plan recorded, not a caller argument', () => {
    // A medium plan drops the three adversarial personas. The roster reads
    // `plan.effort`, so this command cannot be asked for a different set.
    const high = buildWorkflowArgs(localPlan(), planPath);
    const medium = buildWorkflowArgs(localPlan({ effort: 'medium' }), planPath);
    expect(high.agents.length).toBeGreaterThan(medium.agents.length);
    expect(medium.agents.map((a) => a.key)).not.toContain('6a');
  });

  it('reports the review mode it built for', () => {
    expect(buildWorkflowArgs(localPlan(), planPath).mode).toBe('local');
  });
});

describe('emit-workflow — what it refuses', () => {
  const planPath = '/tmp/plan.json';

  // A territory fan-out's chunk agents carry a per-chunk contract this script
  // does not express. Emitting a 3A-shaped fan-out for one would launch the
  // wrong agents over the right diff and look complete doing it.
  it('refuses a territory fan-out rather than emitting a 3A roster for it', () => {
    const big = localPlan({ srcDiffLines: 2000, diffLines: 6000 });
    expect(() => buildWorkflowArgs(big, planPath)).toThrow(
      /territory fan-out \(Step 3B\)/,
    );
  });

  // Every review agent is pinned to the PR worktree today. A workflow dispatch
  // has no equivalent yet, so its agents would read the user's main checkout —
  // producing findings that look plausible and describe the wrong tree.
  it('refuses a worktree review, naming the missing capability', () => {
    const wt = localPlan({ worktreePath: '.qwen/tmp/review-pr-42' });
    expect(() => buildWorkflowArgs(wt, planPath)).toThrow(
      /cannot yet be pinned to it/,
    );
  });

  it('refuses a plan it cannot read, naming the path', () => {
    expect(() =>
      (emitWorkflowCommand.handler as (a: unknown) => void)({
        plan: '/nope/plan.json',
        out: '/tmp/out',
      }),
    ).toThrow(/cannot read the plan \/nope\/plan\.json/);
  });

  // A rules path that does not resolve would silently review without the
  // project rules the run was told to enforce — the same refusal
  // `agent-prompt` makes.
  it('refuses a rules path it cannot read rather than reviewing without rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({
          plan,
          rules: join(dir, 'missing-rules.md'),
          out: join(dir, 'out'),
        }),
      ).toThrow(/cannot read the rules/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('emit-workflow — what it writes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a script and an args file the run can be pointed at', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const out = join(dir, 'out');
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan, out });

    const script = readFileSync(join(out, 'script.js'), 'utf8');
    expect(script).toContain('export const meta');
    expect(script).toContain('parallel(');

    const args = JSON.parse(
      readFileSync(join(out, 'args.json'), 'utf8'),
    ) as WorkflowArgsFile;
    expect(args.version).toBe(1);
    expect(args.plan).toBe(plan);
    expect(args.agents.length).toBeGreaterThan(1);
    // The prompts live in the args file, so nothing asks a caller to carry
    // them — which is the property the whole command exists for.
    for (const a of args.agents) {
      expect(typeof a.prompt).toBe('string');
      expect(a.prompt.length).toBeGreaterThan(80);
    }
  });
});
