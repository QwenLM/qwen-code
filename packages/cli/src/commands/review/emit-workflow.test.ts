/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFanOutRoster,
  emitWorkflowCommand,
  workflowsEnabled,
  EXIT_LEGACY_ORCHESTRATION,
} from './emit-workflow.js';
import { buildLaunch } from './agent-prompt.js';
import { readRecordedPrompts } from './lib/prompt-record.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import { reviewWorkflowScriptPath } from './lib/paths.js';
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

describe('emit-workflow — the roster it bakes into the script', () => {
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

  // Routing through `requiredAgents` is what makes the fan-out and the gate
  // that checks it read one list. A roster this command shortened would be a
  // dimension nobody reviewed, reported as a complete review.
  it('emits exactly the agents the plan requires, under the keys coverage looks up', () => {
    const plan = localPlan();
    const agents = buildFanOutRoster(plan, planPath);
    expect(agents.map((a) => a.key)).toEqual(
      requiredAgents(plan as unknown as RosterPlan).map((r) => r.key),
    );
    expect(agents.length).toBeGreaterThan(1);
  });

  // Byte-parity with the hand-launched path is structural — both go through
  // `buildLaunch` — and this pins it so a future refactor that gives this
  // command its own builder fails here rather than in a review whose delivery
  // check reads "the prompt was rewritten".
  it('emits the same prompt the hand-launched roster would', () => {
    const plan = localPlan();
    const agents = buildFanOutRoster(plan, planPath);
    for (const req of requiredAgents(plan as unknown as RosterPlan)) {
      const { key, prompt } = buildLaunch(
        plan,
        planPath,
        { role: req.role as never, file: req.file },
        undefined,
      );
      expect(agents.find((a) => a.key === key)?.prompt).toBe(prompt);
    }
  });

  // `check-coverage` compares each launch against what the CLI recorded
  // handing out. Without a record, a launched agent reads as one that never
  // ran — the whole roster would come back as unlaunched.
  it('records every prompt it hands out, so the coverage gate can match them', () => {
    const agents = buildFanOutRoster(localPlan(), planPath);
    const recorded = readRecordedPrompts(planPath);
    for (const a of agents) {
      expect(recorded.get(a.key)).toBe(a.prompt);
    }
  });

  it('carries the effort the plan recorded, not a caller argument', () => {
    // A medium plan drops the three adversarial personas. The roster reads
    // `plan.effort`, so this command cannot be asked for a different set.
    const high = buildFanOutRoster(localPlan(), planPath);
    const medium = buildFanOutRoster(localPlan({ effort: 'medium' }), planPath);
    expect(high.length).toBeGreaterThan(medium.length);
    expect(medium.map((a) => a.key)).not.toContain('6a');
  });

  it('builds a diff-only review too, not just a local one', () => {
    // `diff-only` (cross-repo lightweight) has no tree, so its roster drops
    // 1c and 7. It is the second mode this command accepts and was previously
    // never exercised.
    const diffOnly = localPlan({ untrackedFiles: undefined });
    const agents = buildFanOutRoster(diffOnly, planPath);
    expect(agents.map((a) => a.key)).not.toContain('7');
    expect(agents.length).toBeGreaterThan(1);
  });
});

describe('emit-workflow — what it refuses', () => {
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

  // A territory fan-out's chunk agents carry a per-chunk contract this script
  // does not express. Emitting a 3A-shaped fan-out for one would launch the
  // wrong agents over the right diff and look complete doing it.
  it('refuses a territory fan-out rather than emitting a 3A roster for it', () => {
    expect(() =>
      buildFanOutRoster(
        localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
        planPath,
      ),
    ).toThrow(/territory fan-out \(Step 3B\)/);
  });

  // Every review agent is pinned to the PR worktree today. A workflow dispatch
  // has no equivalent yet, so its agents would read the user's main checkout.
  it('refuses a worktree review, naming the missing capability', () => {
    expect(() =>
      buildFanOutRoster(
        localPlan({ worktreePath: '.qwen/tmp/review-pr-42' }),
        planPath,
      ),
    ).toThrow(/cannot yet be pinned to it/);
  });
});

describe('emit-workflow — the workflows gate', () => {
  it('is off unless the env says on, and a kill switch wins', () => {
    expect(workflowsEnabled({})).toBe(false);
    expect(workflowsEnabled({ QWEN_CODE_ENABLE_WORKFLOWS: '1' })).toBe(true);
    expect(
      workflowsEnabled({
        QWEN_CODE_ENABLE_WORKFLOWS: '1',
        QWEN_CODE_DISABLE_WORKFLOWS: '1',
      }),
    ).toBe(false);
  });

  // Decided before anything is written: prompt records are what
  // `check-coverage` matches launches against, so records left by a fan-out
  // that never dispatched would read as a roster that ran and returned
  // nothing — a review reported as covered by agents that do not exist.
  it('routes to legacy without writing anything when workflows are disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    const priorExit = process.exitCode;
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
      expect(process.exitCode).toBe(EXIT_LEGACY_ORCHESTRATION);
      expect(readRecordedPrompts(plan).size).toBe(0);
    } finally {
      process.exitCode = priorExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The runtime gate and the /review gate answer different questions, so a
  // project that turned workflows on for something else has NOT opted its
  // reviews in — and rolling reviews back does not take the runtime with it.
  it('still routes to legacy when the runtime is on but /review is not opted in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    const priorExit = process.exitCode;
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', '1');
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
      expect(process.exitCode).toBe(EXIT_LEGACY_ORCHESTRATION);
      expect(readRecordedPrompts(plan).size).toBe(0);
    } finally {
      process.exitCode = priorExit;
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('emit-workflow — what it writes', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', '1');
    vi.stubEnv('QWEN_REVIEW_WORKFLOW', '1');
    dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    cwd = process.cwd();
    // The script path is repo-relative, like every other review path, so the
    // test has to stand where the command would.
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  // Not a preference: `Workflow({scriptPath})` loads through
  // `readWorkflowFileSecurely`, which realpaths the file and refuses anything
  // outside the saved-workflow directories. A script beside the plan is a
  // script the tool will not open.
  it('writes the script where the Workflow loader will accept it', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });

    const scriptPath = reviewWorkflowScriptPath(plan);
    expect(scriptPath.startsWith(join('.qwen', 'workflows'))).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('export const meta');
    expect(script).toContain('const AGENTS = [');
    expect(script).toContain('parallel(');
  });

  // Nothing large may travel through the model: `args` is inline-only and the
  // sandbox cannot read files, so a roster passed as args is a roster the
  // model has to retype — the failure this command exists to remove.
  it('writes no args file, because the prompts ride inside the script', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });

    const script = readFileSync(reviewWorkflowScriptPath(plan), 'utf8');
    // Every recorded prompt is present in the file itself.
    const recorded = readRecordedPrompts(plan);
    expect(recorded.size).toBeGreaterThan(1);
    for (const prompt of recorded.values()) {
      // The prompt is inside the file as a JSON string literal, so compare
      // against its serialized form rather than the raw text.
      expect(script).toContain(JSON.stringify(prompt));
    }
    expect(existsSync(join(dir, 'args.json'))).toBe(false);
  });

  it('names a script per plan, so concurrent reviews do not overwrite each other', () => {
    const a = join(dir, 'plan-a.json');
    const b = join(dir, 'plan-b.json');
    expect(reviewWorkflowScriptPath(a)).not.toBe(reviewWorkflowScriptPath(b));
    // Stable for the same plan: re-running replaces its own file rather than
    // accumulating one per invocation.
    expect(reviewWorkflowScriptPath(a)).toBe(reviewWorkflowScriptPath(a));
  });
});
