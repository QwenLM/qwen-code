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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  REVIEW_STEP_3A_SAVED_SCRIPT_NAME,
  type WorkflowArgsFile,
} from './emit-workflow.js';
import { buildLaunch, rosterLabel } from './agent-prompt.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import {
  briefPath,
  promptRecordDir,
  readRecordedPrompts,
} from './lib/prompt-record.js';
import { REVIEW_STEP_3A_WORKFLOW_SCRIPT } from './workflow-script.js';
import type { PlanReport } from './lib/report.js';

const ENABLE_ENV = 'QWEN_CODE_ENABLE_WORKFLOWS';
const DISABLE_ENV = 'QWEN_CODE_DISABLE_WORKFLOWS';

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

  // The payload is exactly what the script reads — no metadata fields that
  // nothing consumes. A field written but never read is a dead switch a
  // future reader has to reason about; this pins the current shape.
  it('writes nothing into the payload the script will not read', () => {
    const payload = buildWorkflowArgs(localPlan(), planPath);
    expect(Object.keys(payload).sort()).toEqual(['agents', 'version']);
  });

  it('follows the reduced roster of a diff-only plan', () => {
    // A plan without an untracked-file list is a diff-only review — no tree
    // to grep or build in, and the roster must shrink with it.
    const diffOnly = buildWorkflowArgs(
      localPlan({ untrackedFiles: undefined }),
      planPath,
    );
    const keys = diffOnly.agents.map((a) => a.key);
    expect(keys).not.toContain('1c');
    expect(keys).not.toContain('7');
  });
});

describe('emit-workflow — what it refuses', () => {
  const planPath = '/tmp/plan.json';
  let envEnable: string | undefined;
  let envDisable: string | undefined;

  beforeEach(() => {
    envEnable = process.env[ENABLE_ENV];
    envDisable = process.env[DISABLE_ENV];
    process.env[ENABLE_ENV] = '1';
    delete process.env[DISABLE_ENV];
  });

  afterEach(() => {
    if (envEnable === undefined) delete process.env[ENABLE_ENV];
    else process.env[ENABLE_ENV] = envEnable;
    if (envDisable === undefined) delete process.env[DISABLE_ENV];
    else process.env[DISABLE_ENV] = envDisable;
  });

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

  // This command's output is one Workflow call. A session without the
  // Workflow tool has nothing to call — and the refusal must come before any
  // brief or prompt record exists, because records are obligations the
  // coverage gate later demands an agent for.
  it('refuses when workflows are disabled, before writing anything', () => {
    delete process.env[ENABLE_ENV];
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      const out = join(dir, 'out');
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({ plan, out }),
      ).toThrow(/workflows are disabled/);
      expect(existsSync(out)).toBe(false);
      expect(existsSync(promptRecordDir(plan))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors the kill switch over the opt-in', () => {
    process.env[ENABLE_ENV] = '1';
    process.env[DISABLE_ENV] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({
          plan,
          out: join(dir, 'out'),
        }),
      ).toThrow(/workflows are disabled/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A parseable file is not yet a plan. Non-object JSON used to die in the
  // roster internals as a bare TypeError; an object that is not a plan used
  // to emit a full roster from garbage fields.
  it('refuses a plan file that is not a plan object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, 'null', 'utf8');
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({
          plan,
          out: join(dir, 'out'),
        }),
      ).toThrow(/is not a plan report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a JSON object that is missing plan fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    try {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, '{}', 'utf8');
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({
          plan,
          out: join(dir, 'out'),
        }),
      ).toThrow(/has no diffPathAbsolute/);
      writeFileSync(
        plan,
        JSON.stringify(localPlan({ chunks: undefined })),
        'utf8',
      );
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({
          plan,
          out: join(dir, 'out'),
        }),
      ).toThrow(/has no chunks/);
      writeFileSync(
        plan,
        JSON.stringify(localPlan({ files: undefined })),
        'utf8',
      );
      expect(() =>
        (emitWorkflowCommand.handler as (a: unknown) => void)({
          plan,
          out: join(dir, 'out'),
        }),
      ).toThrow(/has no files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('emit-workflow — what it writes', () => {
  let dir: string;
  let prevCwd: string;
  let envEnable: string | undefined;
  let envDisable: string | undefined;

  beforeEach(() => {
    envEnable = process.env[ENABLE_ENV];
    envDisable = process.env[DISABLE_ENV];
    process.env[ENABLE_ENV] = '1';
    delete process.env[DISABLE_ENV];
    dir = mkdtempSync(join(tmpdir(), 'emit-wf-'));
    prevCwd = process.cwd();
    // The script is written into `<cwd>/.qwen/workflows/` — the project's
    // saved-workflow dir — so point the command at the temp tree.
    process.chdir(dir);
    (writeStdoutLine as unknown as Mock).mockClear();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (envEnable === undefined) delete process.env[ENABLE_ENV];
    else process.env[ENABLE_ENV] = envEnable;
    if (envDisable === undefined) delete process.env[DISABLE_ENV];
    else process.env[DISABLE_ENV] = envDisable;
    rmSync(dir, { recursive: true, force: true });
  });

  const savedScriptPath = () =>
    join(dir, '.qwen', 'workflows', `${REVIEW_STEP_3A_SAVED_SCRIPT_NAME}.js`);

  it('writes a script and an args file the run can be pointed at', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const out = join(dir, 'out');
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan, out });

    // The script goes into the saved-workflow dir — byte for byte the
    // exhaustively-tested constant — because `Workflow({scriptPath})`
    // refuses to load a file from anywhere else.
    const script = readFileSync(savedScriptPath(), 'utf8');
    expect(script).toBe(REVIEW_STEP_3A_WORKFLOW_SCRIPT);

    const args = JSON.parse(
      readFileSync(join(out, 'args.json'), 'utf8'),
    ) as WorkflowArgsFile;
    expect(args.version).toBe(1);
    expect(args.agents.length).toBeGreaterThan(1);
    // The prompts live in the args file, so nothing asks a caller to carry
    // them — which is the property the whole command exists for.
    for (const a of args.agents) {
      expect(typeof a.prompt).toBe('string');
      expect(a.prompt.length).toBeGreaterThan(80);
    }

    // The briefless half of the delivery gate reads recorded prompts: every
    // emitted agent must be recorded exactly as dispatched. (The gate's
    // other half — transcripts — is not produced by a workflow dispatch
    // until coverage reads the workflow journal, #8769.)
    const recorded = readRecordedPrompts(plan);
    for (const a of args.agents) {
      expect(recorded.get(a.key)).toBe(a.prompt);
    }

    // The stdout lines are the orchestrator's contract, printed exactly as
    // the Workflow tool can honor it: one call, the script by its saved
    // path, and the args as their parsed JSON contents — `args` is
    // inline-only on the tool, so no line may describe a path form.
    const lines = (writeStdoutLine as unknown as Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`${args.agents.length} agents required`);
    expect(lines[0]).toContain('Workflow({ scriptPath:');
    expect(lines[0]).toContain('PARSED JSON contents');
    expect(lines[1]).toBe(`scriptPath: ${savedScriptPath()}`);
    expect(lines[2]).toContain(`args file: ${join(out, 'args.json')}`);
    expect(lines[2]).toContain('there is no path form');
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

  // A retry of the same review re-emits the same script under the same
  // saved name. That is this command's own artifact at identical content —
  // let it pass. Anything ELSE at that name is the user's and is refused
  // (covered below).
  it('re-emits idempotently over its own saved script', () => {
    mkdirSync(join(dir, '.qwen', 'workflows'), { recursive: true });
    writeFileSync(savedScriptPath(), REVIEW_STEP_3A_WORKFLOW_SCRIPT, 'utf8');
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const out = join(dir, 'out');
    (emitWorkflowCommand.handler as (a: unknown) => void)({ plan, out });
    expect(readFileSync(savedScriptPath(), 'utf8')).toBe(
      REVIEW_STEP_3A_WORKFLOW_SCRIPT,
    );
    expect(existsSync(join(out, 'args.json'))).toBe(true);
  });

  it('refuses --out naming an existing file, before writing any record', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const notADir = join(dir, 'not-a-dir');
    writeFileSync(notADir, 'in the way', 'utf8');
    expect(() =>
      (emitWorkflowCommand.handler as (a: unknown) => void)({
        plan,
        out: notADir,
      }),
    ).toThrow(/emit-workflow: cannot create the --out directory/);
    expect(existsSync(promptRecordDir(plan))).toBe(false);
  });

  it('refuses to overwrite an existing args.json, before writing any record', () => {
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'args.json'), '{"hand":"written"}', 'utf8');
    expect(() =>
      (emitWorkflowCommand.handler as (a: unknown) => void)({ plan, out }),
    ).toThrow(/already exists — refusing to overwrite it/);
    // The refusal preceded every build write: no briefs, no records.
    expect(existsSync(promptRecordDir(plan))).toBe(false);
    expect(readFileSync(join(out, 'args.json'), 'utf8')).toBe(
      '{"hand":"written"}',
    );
  });

  it('refuses a foreign file at the saved script name', () => {
    mkdirSync(join(dir, '.qwen', 'workflows'), { recursive: true });
    writeFileSync(savedScriptPath(), '// a workflow the user wrote', 'utf8');
    const plan = join(dir, 'plan.json');
    writeFileSync(plan, JSON.stringify(localPlan()), 'utf8');
    expect(() =>
      (emitWorkflowCommand.handler as (a: unknown) => void)({
        plan,
        out: join(dir, 'out'),
      }),
    ).toThrow(/already exists and is not the script this command writes/);
    expect(existsSync(promptRecordDir(plan))).toBe(false);
    expect(readFileSync(savedScriptPath(), 'utf8')).toBe(
      '// a workflow the user wrote',
    );
  });
});
