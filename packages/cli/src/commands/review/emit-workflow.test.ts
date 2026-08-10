/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  buildWorkflowArgs,
  emitWorkflowCommand,
  type WorkflowArgsFile,
} from './emit-workflow.js';
import { buildLaunch, rosterLabel } from './agent-prompt.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import { briefPath, readRecordedPrompts } from './lib/prompt-record.js';
import { REVIEW_STEP_3A_WORKFLOW_SCRIPT } from './workflow-script.js';
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

  // The script's progress display consumes the label the args carry, and
  // nothing downstream re-derives it — pin the wiring at the source, so a
  // substitution of a different label source fails here, not in a run.
  it('labels every agent with the roster label the reader sees', () => {
    const plan = localPlan();
    const payload = buildWorkflowArgs(plan, planPath);
    for (const req of requiredAgents(plan as unknown as RosterPlan)) {
      const emitted = payload.agents.find((a) => a.key === req.key);
      expect(emitted?.label).toBe(rosterLabel(req));
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
    // A plan without an untracked-file list is a diff-only review — no tree
    // to grep or build in. The args file is the record of what the run could
    // do, so the mode it declares must follow the plan, and the reduced
    // roster of a diff-only review must follow with it.
    const diffOnly = buildWorkflowArgs(
      localPlan({ untrackedFiles: undefined }),
      planPath,
    );
    expect(diffOnly.mode).toBe('diff-only');
    const keys = diffOnly.agents.map((a) => a.key);
    expect(keys).not.toContain('1c');
    expect(keys).not.toContain('7');
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
    (writeStdoutLine as unknown as Mock).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a script and an args file the run can be pointed at', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const out = join(dir, 'out');
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan, out });

    // The script is the exhaustively-tested constant, byte for byte — a
    // transformed or stale script must fail here, not at workflow runtime.
    const script = readFileSync(join(out, 'script.js'), 'utf8');
    expect(script).toBe(REVIEW_STEP_3A_WORKFLOW_SCRIPT);

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

    // The delivery gate reads recorded prompts, not briefs: every emitted
    // agent must be recorded exactly as dispatched, or check-coverage fails a
    // correct workflow run as "briefless".
    const recorded = readRecordedPrompts(plan);
    for (const a of args.agents) {
      expect(recorded.get(a.key)).toBe(a.prompt);
    }

    // The stdout lines are the orchestrator's contract — one count, and each
    // path labelled with its own file. A swap or mislabel sends the single
    // Workflow call at the wrong file.
    const lines = (writeStdoutLine as unknown as Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`${args.agents.length} agents required`);
    expect(lines[1]).toBe(`scriptPath: ${join(out, 'script.js')}`);
    expect(lines[2]).toBe(`args: ${join(out, 'args.json')}`);
  });

  it('injects the project rules into every brief it emits', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const rules = join(dir, 'rules.md');
    writeFileSync(rules, 'No `any` in new code.\n');
    const out = join(dir, 'out');
    (emitWorkflowCommand.handler as (a: unknown) => void)({
      plan,
      rules,
      out,
    });

    // The rules are in the BRIEFS, which the launch prompts point at — a
    // rules file that never reached a brief is a review that silently
    // enforced no project rules. Agent 7 is the declared exception: it runs
    // deterministic commands, not code review, so it must NOT get them.
    const args = JSON.parse(
      readFileSync(join(out, 'args.json'), 'utf8'),
    ) as WorkflowArgsFile;
    expect(args.agents.length).toBeGreaterThan(1);
    for (const a of args.agents) {
      const briefText = readFileSync(briefPath(plan, a.key), 'utf8');
      if (a.key === '7') {
        expect(briefText).not.toContain('## Project rules');
      } else {
        expect(briefText).toContain('## Project rules');
        expect(briefText).toContain('No `any` in new code.');
      }
    }
  });
});
