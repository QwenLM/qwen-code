/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const mocks = vi.hoisted(() => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.writeStdoutLine,
  writeStderrLine: mocks.writeStderrLine,
}));
import {
  buildFanOutRoster,
  emitWorkflowCommand,
  workflowsEnabled,
  EXIT_LEGACY_ORCHESTRATION,
} from './emit-workflow.js';
import { buildLaunch } from './agent-prompt.js';
import { briefPath, readRecordedPrompts } from './lib/prompt-record.js';
import { RESIDUE_PATH_CAP, worktreeResidue } from './lib/worktree.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import { reviewWorkflowScriptPath } from './lib/paths.js';
import type { PlanReport } from './lib/report.js';

beforeEach(() => {
  mocks.writeStdoutLine.mockClear();
  mocks.writeStderrLine.mockClear();
});

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

  // A 3B roster grows one agent per chunk and a workflow returns every one of
  // them through a single tool result, so the bigger the fan-out the more of
  // it the scheduler truncates away. The refusal must name that bound — the
  // builder below can express the roster perfectly well.
  it('refuses a territory fan-out, naming the delivery bound', () => {
    expect(() =>
      buildFanOutRoster(
        localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
        planPath,
      ),
    ).toThrow(/territory fan-out \(Step 3B\)/);
    expect(() =>
      buildFanOutRoster(
        localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
        planPath,
      ),
    ).toThrow(/one tool result/);
  });

  // A worktree is not a refusal: `agent({workingDir})` exists and the
  // generated script passes it. This used to throw, pinning a capability
  // claim the runtime disproves.
  it('emits a worktree review rather than refusing it', () => {
    const agents = buildFanOutRoster(
      localPlan({ worktreePath: '.qwen/tmp/review-pr-42' }),
      planPath,
    );
    expect(agents.length).toBeGreaterThan(1);
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
    const cwd = process.cwd();
    const priorExit = process.exitCode;
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', '0');
    vi.stubEnv('QWEN_REVIEW_WORKFLOW', '0');
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '0');
    try {
      // The script path is cwd-relative, so stand where a routing flip would
      // write: a stray generated script must land in the tmpdir, never the repo.
      process.chdir(dir);
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
      expect(process.exitCode).toBe(EXIT_LEGACY_ORCHESTRATION);
      // SKILL.md branches on the literal 6; asserting only the constant would
      // move both sides of the pin together if it were ever renumbered.
      expect(EXIT_LEGACY_ORCHESTRATION).toBe(6);
      expect(readRecordedPrompts(plan).size).toBe(0);
    } finally {
      process.chdir(cwd);
      process.exitCode = priorExit;
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The runtime gate and the /review gate answer different questions, so a
  // project that turned workflows on for something else has NOT opted its
  // reviews in — and rolling reviews back does not take the runtime with it.
  it('still routes to legacy when the runtime is on but /review is not opted in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    const cwd = process.cwd();
    const priorExit = process.exitCode;
    vi.stubEnv('QWEN_CODE_ENABLE_WORKFLOWS', '1');
    vi.stubEnv('QWEN_REVIEW_WORKFLOW', '0');
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '0');
    try {
      process.chdir(dir);
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
      expect(process.exitCode).toBe(EXIT_LEGACY_ORCHESTRATION);
      expect(readRecordedPrompts(plan).size).toBe(0);
    } finally {
      process.chdir(cwd);
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
    // The kill switch is checked first and is not stubbed back by
    // unstubAllEnvs unless it was stubbed: an ambient '1' would route every
    // test below to legacy and fail the write assertions spuriously.
    vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '0');
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
    const priorExit = process.exitCode;
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
    try {
      // The routing contract: a written script means exit 0, not the legacy
      // verdict — SKILL.md branches on it before reading anything else.
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = priorExit;
    }
    // The one line the skill parses to build its single Workflow call; it
    // must carry the absolute path, or the dispatch has nothing to load.
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      `scriptPath: ${resolve(reviewWorkflowScriptPath(plan))}`,
    );

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

  it('refuses a symlinked workflow root before recording prompts', () => {
    const external = mkdtempSync(join(tmpdir(), 'emit-wf-outside-'));
    const plan = join(dir, 'plan.json');
    mkdirSync(join(dir, '.qwen'), { recursive: true });
    symlinkSync(external, join(dir, '.qwen', 'workflows'), 'dir');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');

    try {
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({ plan }),
      ).toThrow(/symlinked saved-workflow path component/);
      expect(readRecordedPrompts(plan).size).toBe(0);
      expect(existsSync(reviewWorkflowScriptPath(plan))).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked .qwen ancestor before recording prompts', () => {
    const external = mkdtempSync(join(tmpdir(), 'emit-wf-outside-'));
    const plan = join(dir, 'plan.json');
    symlinkSync(external, join(dir, '.qwen'), 'dir');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');

    try {
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({ plan }),
      ).toThrow(/symlinked saved-workflow path component/);
      expect(readRecordedPrompts(plan).size).toBe(0);
      expect(existsSync(join(external, 'workflows'))).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('replaces a symlinked script entry without writing through it', () => {
    const external = mkdtempSync(join(tmpdir(), 'emit-wf-victim-'));
    const victim = join(external, 'victim.js');
    const plan = join(dir, 'plan.json');
    const scriptPath = reviewWorkflowScriptPath(plan);
    mkdirSync(join(dir, '.qwen', 'workflows'), { recursive: true });
    writeFileSync(victim, 'keep me', 'utf8');
    symlinkSync(victim, scriptPath);
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');

    try {
      (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
      expect(readFileSync(victim, 'utf8')).toBe('keep me');
      expect(lstatSync(scriptPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(scriptPath, 'utf8')).toContain('export const meta');
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
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

describe('emit-workflow — residue parity with the hand-launched path', () => {
  // The live #9207 shape: a shared review worktree carrying a modified file
  // and a probe no commit contains. A REAL linked worktree, because the
  // probe's identity gate fails closed for anything else — a bare repo
  // fixture could not measure the healthy path.
  let repo: string;
  let tree: string;
  let headSha: string;
  let dir: string;
  let planPath: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = mkdtempSync(join(tmpdir(), 'emit-wf-residue-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'head'], { cwd: repo });
    // Every worktree-mode fetch records the fetched head sha in the plan,
    // and the residue probe fails closed without a usable one — so the
    // fixture anchors like a real plan.
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    tree = join(repo, '.qwen', 'tmp', 'review-wt');
    mkdirSync(dirname(tree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', '-q', tree, 'HEAD'], {
      cwd: repo,
    });
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(tree, '__probe__.test.ts'), 'it("x", () => {});');

    dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify(localPlan({ worktreePath: tree, fetchedSha: headSha })),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  // The hand-launched path probes the worktree and threads what it finds
  // into every build; this command goes through the same `buildLaunch`, so
  // a dirty tree must change both sides identically. Compared on the
  // BRIEFS, not the launch prompts: the residue block is evidence for the
  // agent reading the brief, and the launch prompt only points at it — a
  // prompt-level comparison passes with the block silently dropped.
  it('bakes the same residue evidence the hand-launched roster would', () => {
    const plan = localPlan({ worktreePath: tree, fetchedSha: headSha });
    const residue = worktreeResidue(tree, RESIDUE_PATH_CAP, headSha);
    expect(residue.paths.length).toBeGreaterThan(0);

    const agents = buildFanOutRoster(plan, planPath);
    const workflowBriefs = new Map(
      agents.map((a) => [
        a.key,
        readFileSync(briefPath(planPath, a.key), 'utf8'),
      ]),
    );

    for (const req of requiredAgents(plan as unknown as RosterPlan)) {
      // The rebuild the hand-launched path does: `agent-prompt`'s handler
      // probes the tree and threads the result into every build.
      buildLaunch(
        plan,
        planPath,
        req.role === 'chunk'
          ? { chunk: req.chunk }
          : { role: req.role as never, file: req.file },
        undefined,
        residue,
      );
      expect(workflowBriefs.get(req.key)).toBe(
        readFileSync(briefPath(planPath, req.key), 'utf8'),
      );
    }
    // The fixture IS dirty, so the paragraph must actually be present — a
    // clean tree would let the byte comparison pass vacuously.
    for (const brief of workflowBriefs.values()) {
      expect(brief).toContain(
        'These paths differ from the commit under review',
      );
    }
  });

  // The orchestrator's only notice that the tree it is about to dispatch
  // against is not the commit the plan says it is. The hand-launched path
  // prints it; this command owes the same.
  it('warns on stderr like the hand-launched path, naming the dirty paths', () => {
    buildFanOutRoster(
      localPlan({ worktreePath: tree, fetchedSha: headSha }),
      planPath,
    );
    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'the review worktree carries changes its commit does not',
      ),
    );
    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('a.ts'),
    );
  });

  it('warns that an unmeasured tree is not a clean one', () => {
    buildFanOutRoster(
      localPlan({
        worktreePath: join(dir, 'not-a-worktree'),
        fetchedSha: headSha,
      }),
      planPath,
    );
    expect(mocks.writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'could not measure whether the review worktree is clean',
      ),
    );
  });
});
