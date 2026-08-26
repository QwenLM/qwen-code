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
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Storage } from '@qwen-code/qwen-code-core';

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
  fanOutBlocker,
} from './emit-workflow.js';
import { buildLaunch } from './agent-prompt.js';
import { briefPath, readRecordedPrompts } from './lib/prompt-record.js';
import { RESIDUE_PATH_CAP, worktreeResidue } from './lib/worktree.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import {
  GeneratedWorkflowDirUnavailableError,
  reviewWorkflowsDir,
  reviewWorkflowScriptPath,
} from './lib/paths.js';
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

  it('threads the project rules into every brief, like --roster does', () => {
    const plan = localPlan();
    const rules = 'RULE: never call it a nit — MARKER-8f3a';
    const agents = buildFanOutRoster(plan, planPath, rules);
    // Agent 7 runs deterministic build and test commands, not a review, so
    // its brief carries no rules; every reviewing role's does.
    const reviewing = agents.filter((a) => a.key !== '7');
    expect(reviewing.length).toBeGreaterThan(1);
    for (const a of reviewing) {
      // The rules live in the brief the agent reads, not in the launch line.
      expect(readFileSync(briefPath(planPath, a.key), 'utf8')).toContain(
        'MARKER-8f3a',
      );
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
    // 1c and 7.
    const diffOnly = localPlan({ untrackedFiles: undefined });
    const agents = buildFanOutRoster(diffOnly, planPath);
    expect(agents.map((a) => a.key)).not.toContain('7');
    expect(agents.map((a) => a.key)).not.toContain('1c');
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
    const territory = localPlan({ srcDiffLines: 2000, diffLines: 6000 });
    expect(fanOutBlocker(territory as unknown as RosterPlan)).toMatch(
      /territory fan-out \(Step 3B\)/,
    );
    expect(() => buildFanOutRoster(territory, planPath)).toThrow(
      /one tool result/,
    );
    // Refused BEFORE anything is written: no brief, no record.
    expect(readRecordedPrompts(planPath).size).toBe(0);
  });

  // A plan whose sizes failed to arrive is not a small review — its topology
  // is UNKNOWABLE, and `isTerritoryFanOut`'s missing-to-zero coercion would
  // bake the guess that it is 3A into the script.
  it('refuses an unsized plan — unknowable topology is not 3A', () => {
    for (const unsized of [
      localPlan({ srcDiffLines: null, diffLines: null }),
      localPlan({ srcDiffLines: undefined }),
      localPlan({ diffLines: Number.NaN }),
    ]) {
      expect(fanOutBlocker(unsized as unknown as RosterPlan)).toMatch(
        /no usable diff size/,
      );
      expect(() => buildFanOutRoster(unsized, planPath)).toThrow(
        /no usable diff size/,
      );
    }
    expect(readRecordedPrompts(planPath).size).toBe(0);
  });

  it('accepts a plan exactly at the 3A thresholds', () => {
    expect(
      fanOutBlocker(
        localPlan({
          srcDiffLines: 500,
          diffLines: 3200,
        }) as unknown as RosterPlan,
      ),
    ).toBeNull();
  });

  // A worktree is not a refusal: `agent({workingDir})` exists and the
  // generated script passes it.
  it('emits a worktree review rather than refusing it', () => {
    const agents = buildFanOutRoster(
      localPlan({ worktreePath: '.qwen/tmp/review-pr-42' }),
      planPath,
    );
    expect(agents.length).toBeGreaterThan(1);
  });
});

describe('emit-workflow — where it writes', () => {
  let dir: string;
  let projectDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    projectDir = join(dir, 'project-dir');
    // The harness exports both for every review subcommand; the session id
    // carries a dot on purpose, because the harness's directory names do not.
    vi.stubEnv('QWEN_CODE_PROJECT_DIR', projectDir);
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'sess.1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(plan: string): void {
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan });
  }

  // Not a preference: `Workflow({scriptPath})` loads through
  // `readWorkflowFileSecurely`, which accepts the saved-workflow directories
  // and the generated-scripts root and nothing else. A script beside the
  // plan is a script the tool will not open; a script in a saved directory
  // is a slash command.
  it('writes the script under the generated-scripts root, per session', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    run(plan);

    const scriptPath = reviewWorkflowScriptPath(plan);
    expect(dirname(scriptPath)).toBe(
      join(projectDir, 'workflows', 'generated', 'review', 'sess_1'),
    );
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('export const meta');
    expect(script).toContain('const AGENTS = [');
    expect(script).toContain('parallel(');
    // The one line the skill will parse to build its single Workflow call;
    // it must carry the absolute path, or the dispatch has nothing to load.
    expect(mocks.writeStdoutLine).toHaveBeenCalledWith(
      `scriptPath: ${resolve(scriptPath)}`,
    );
  });

  // The writer's directory and the loader's trusted root are computed by two
  // packages from two inputs. Pin them together through core's own function:
  // a project dir exported by the harness is `storage.getProjectDir()`, and
  // the loader trusts `storage.getGeneratedWorkflowsDir()` under it.
  it('lands inside the root the Workflow loader trusts', () => {
    const home = join(dir, 'home');
    vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
    vi.stubEnv('QWEN_RUNTIME_DIR', '');
    const storage = new Storage(join(dir, 'workspace'));
    const env = {
      QWEN_CODE_PROJECT_DIR: storage.getProjectDir(),
      QWEN_CODE_SESSION_ID: 'sess',
    };
    const root = storage.getGeneratedWorkflowsDir();
    expect(reviewWorkflowsDir(env).startsWith(root + sep)).toBe(true);
    expect(reviewWorkflowScriptPath('/tmp/p.json', env).startsWith(root)).toBe(
      true,
    );
  });

  it('refuses to build anything when the harness exported no project dir', () => {
    vi.stubEnv('QWEN_CODE_PROJECT_DIR', '');
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    expect(() => run(plan)).toThrow(GeneratedWorkflowDirUnavailableError);
    // Decided before anything was written: a roster whose briefs and records
    // exist for a script that has nowhere to go would read to the coverage
    // gate as a launched fan-out that returned nothing.
    expect(readRecordedPrompts(plan).size).toBe(0);
    expect(existsSync(join(projectDir))).toBe(false);
  });

  it('falls back to a fixed subdirectory when there is no session id', () => {
    vi.stubEnv('QWEN_CODE_SESSION_ID', '');
    expect(reviewWorkflowsDir()).toBe(
      join(projectDir, 'workflows', 'generated', 'review', 'no-session'),
    );
  });

  // Nothing large may travel through the model: `args` is inline-only and the
  // sandbox cannot read files, so a roster passed as args is a roster the
  // model has to retype — the failure this command exists to remove.
  it('carries every recorded prompt inside the script itself', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    run(plan);

    const script = readFileSync(reviewWorkflowScriptPath(plan), 'utf8');
    const recorded = readRecordedPrompts(plan);
    expect(recorded.size).toBeGreaterThan(1);
    for (const prompt of recorded.values()) {
      // The prompt is inside the file as a JSON string literal, so compare
      // against its serialized form rather than the raw text.
      expect(script).toContain(JSON.stringify(prompt));
    }
  });

  it('bakes the worktree pin from the plan', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify(localPlan({ worktreePath: '.qwen/tmp/review-pr-42' })),
      'utf8',
    );
    run(plan);
    expect(readFileSync(reviewWorkflowScriptPath(plan), 'utf8')).toContain(
      'const WORKING_DIR = ".qwen/tmp/review-pr-42";',
    );
  });

  it('replaces a symlinked script entry without writing through it', () => {
    const victim = join(dir, 'victim.js');
    const plan = join(dir, 'plan.json');
    const scriptPath = reviewWorkflowScriptPath(plan);
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(victim, 'keep me', 'utf8');
    symlinkSync(victim, scriptPath);
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');

    run(plan);
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(scriptPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(scriptPath, 'utf8')).toContain('export const meta');
  });

  it('leaves no temp file behind, on success or on a failed write', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    run(plan);
    const scriptDir = dirname(reviewWorkflowScriptPath(plan));
    const tempFiles = () =>
      readdirSync(scriptDir).filter((n) => n.endsWith('.tmp'));
    expect(tempFiles()).toEqual([]);

    // The failed-write half: the rename throws AFTER the temp file exists,
    // the case the finally cleanup exists for. A non-empty directory at the
    // target makes renameSync throw on every platform.
    const scriptPath = reviewWorkflowScriptPath(plan);
    rmSync(scriptPath);
    mkdirSync(scriptPath);
    writeFileSync(join(scriptPath, 'blocker'), 'keep me out', 'utf8');
    expect(() => run(plan)).toThrow();
    expect(tempFiles()).toEqual([]);
  });

  it('names a script per plan, so concurrent reviews do not overwrite each other', () => {
    const a = join(dir, 'plan-a.json');
    const b = join(dir, 'plan-b.json');
    expect(reviewWorkflowScriptPath(a)).not.toBe(reviewWorkflowScriptPath(b));
    // A relative spelling of the same plan is the same script.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(reviewWorkflowScriptPath('plan-a.json')).toBe(
        reviewWorkflowScriptPath(a),
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it('refuses an unreadable rules path before writing anything', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    expect(() =>
      (emitWorkflowCommand.handler as (a: unknown) => void)({
        plan,
        rules: join(dir, 'missing-rules.md'),
      }),
    ).toThrow(/cannot read the rules/);
    expect(readRecordedPrompts(plan).size).toBe(0);
    expect(existsSync(reviewWorkflowScriptPath(plan))).toBe(false);
  });

  it('threads --rules through the handler into every reviewing brief', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const rulesPath = join(dir, 'rules.md');
    writeFileSync(
      rulesPath,
      'RULE: every brief must carry this — MARKER-rules-7c1e',
      'utf8',
    );

    (emitWorkflowCommand.handler as (a: unknown) => void)({
      plan,
      rules: rulesPath,
    });

    expect(existsSync(reviewWorkflowScriptPath(plan))).toBe(true);
    const keys = [...readRecordedPrompts(plan).keys()];
    // Agent 7 runs deterministic build and test commands, not a review, so
    // its brief carries no rules; every reviewing role's does.
    const reviewing = keys.filter((key) => key !== '7');
    expect(reviewing.length).toBeGreaterThan(1);
    for (const key of reviewing) {
      expect(readFileSync(briefPath(plan, key), 'utf8')).toContain(
        'MARKER-rules-7c1e',
      );
    }
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
