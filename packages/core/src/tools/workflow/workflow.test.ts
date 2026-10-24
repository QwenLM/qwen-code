/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkflowToolDescription,
  WORKFLOW_NAME_ONLY_SECTION,
  WorkflowTool,
  type WorkflowToolOptions,
} from './workflow.js';
import {
  buildWorkflowSizeGuidelineParagraph,
  resolveWorkflowSizeGuidelineSetting,
} from '../../agents/runtime/workflow-size.js';
import type { Config } from '../../config/config.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import { WorkflowRunRegistry } from '../../agents/workflow-run-registry.js';
import { WorkflowJournal } from '../../agents/runtime/workflow-journal.js';
import {
  DEFAULT_MAX_AGENTS_PER_RUN,
  MAX_WORKFLOW_AGENTS_ENV,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
  WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
} from '../../agents/runtime/workflow-orchestrator.js';
import { Storage } from '../../config/storage.js';
import { ToolErrorType } from '../tool-error.js';
import { MAX_TOKENS_PER_WORKFLOW_ENV } from '../../agents/runtime/workflow-budget.js';
import { NO_JOURNAL_NO_RESUME_NOTE } from '../../agents/workflow-resume-call.js';
import { TurnBudget } from '../../core/turn-budget.js';
import { uiTelemetryService } from '../../telemetry/uiTelemetry.js';
import { EVENT_API_RESPONSE } from '../../telemetry/constants.js';
import { randomUUID } from 'node:crypto';
import { matchesRule, parseRule } from '../../permissions/rule-parser.js';
import { computeWorkflowScriptDigest } from '../../agents/runtime/workflow-saved.js';
import { convertToFunctionResponse } from '../../core/coreToolScheduler.js';
import { WorkflowAgentFailedError } from '../../agents/runtime/workflow-agent-failure.js';
import { WORKFLOW_AUTHORING_SKILL_NAME } from '../../skills/workflow-authoring-skill.js';

/**
 * The description, fixed at construction, points at the `workflow-authoring`
 * skill when the model can load it and inlines the reference when it cannot.
 * A bare `{}` takes the inline branch, so this models the ordinary session:
 * skills on, Skill tool registered (`workflow-description.test.ts` covers the
 * other shape).
 */
function fakeConfig(): Config {
  return {
    getSkillManager: () => ({ getCachedSkills: () => null }),
    getToolRegistry: () => ({
      getAllToolNames: () => [ToolNames.SKILL, ToolNames.WORKFLOW],
      getTool: () => undefined,
    }),
    isSkillEnabled: () => true,
  } as unknown as Config;
}

type Dispatch = WorkflowToolOptions['dispatch'];
/** Config fields that silence the one-time usage banner. */
const QUIET = { getSkipWorkflowUsageWarning: () => true };
const unused = async () => 'unused';
const replyOk = async () => 'ok';
const tagged = async (prompt: string) => `T:${prompt}`;
const live = () => new AbortController().signal;
const CANCELLED_BEFORE_START = {
  llmContent: 'Workflow was cancelled before it could start.',
  returnDisplay: 'Workflow cancelled.',
};
const runIdOf = (scriptPath: string) =>
  scriptPath.match(/(wf_[0-9a-f]+)\.js$/)![1];
const LOAD_SKILL_HINT = `hint: Load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`;
const SURFACES = [
  'pointer',
  'pointer-via-tool-search',
  'withheld',
  'inline',
] as const;

/** Active extensions: `gcp`, with one workflow `gcp:audit` at `scriptPath`. */
function gcpExtensions(scriptPath: string) {
  const workflow = {
    name: 'gcp:audit',
    extensionName: 'gcp',
    scriptPath,
    description: 'Audits the project',
  };
  return [{ name: 'gcp', workflows: [workflow] }];
}

/**
 * One assertion per needle: `toContain` for a string, `toMatch` for a
 * RegExp; each of `lacks` takes the `.not` form.
 */
function expectText(
  text: string,
  has: Array<string | RegExp>,
  lacks: Array<string | RegExp> = [],
) {
  for (const n of has) {
    if (typeof n === 'string') expect(text).toContain(n);
    else expect(text).toMatch(n);
  }
  for (const n of lacks) {
    if (typeof n === 'string') expect(text).not.toContain(n);
    else expect(text).not.toMatch(n);
  }
}

/**
 * Whether an "always allow" rule the tool emitted would let a later call
 * through, checked the way the permission flow checks it: after the default
 * permission (which loads the script) and against the derived match params.
 */
async function grantMatches(
  rule: string,
  config: Config,
  params: Record<string, unknown>,
): Promise<boolean> {
  const invocation = new WorkflowTool(config).build(params as never);
  await invocation.getDefaultPermission();
  return matchesRule(
    parseRule(rule),
    ToolNames.WORKFLOW,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    invocation.getPermissionMatchParams!(),
  );
}

function props(tool: WorkflowTool) {
  return (
    tool.schema.parametersJsonSchema as {
      properties: Record<string, { default?: boolean; description: string }>;
    }
  ).properties;
}

function paramDescription(tool: WorkflowTool, name: string): string {
  return props(tool)[name].description;
}

/**
 * P4b Round 5 (wenshao): `fakeConfig()` never reaches the registry path in
 * `execute()` (register → emitter → complete/fail/cancel): optional chaining
 * short-circuits the missing `getWorkflowRunRegistry()`. This config has a
 * real registry, returned for inspecting post-run state; `extra` adds fields.
 */
function configWithRegistry(extra: Record<string, unknown> = {}) {
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
    ...extra,
  } as unknown as Config;
  return { config, registry };
}

/**
 * The scriptPath approval/description surface classifies the path against
 * the generated-scripts root, so it needs a config with a real `storage`,
 * returned too: the label tests derive their expected roots from it.
 */
function configWithStorage(): { config: Config; storage: Storage } {
  const storage = new Storage(path.join(os.tmpdir(), 'workflow-label-test'));
  return { config: { storage } as unknown as Config, storage };
}

/** One call through the tool: build `params`, execute on `signal`. */
function runTool(
  params: Record<string, unknown>,
  dispatch?: Dispatch,
  config: Config = fakeConfig(),
  signal = live(),
) {
  return new WorkflowTool(config, { dispatch })
    .build(params as never)
    .execute(signal);
}

/** The text of every part of a result's `llmContent`. */
function texts(result: { llmContent: unknown }): string[] {
  return (result.llmContent as Array<{ text: string }>).map((p) => p.text);
}

type Details = {
  type: string;
  title: string;
  prompt: string;
  hideAlwaysAllow?: boolean;
  permissionRules?: string[];
};

/** The approval dialog a built call shows. */
async function confirmOf(
  invocation: ReturnType<WorkflowTool['build']>,
): Promise<Details> {
  return (await invocation.getConfirmationDetails(live())) as Details;
}

function detailsFor(
  params: Record<string, unknown>,
  config: Config = fakeConfig(),
): Promise<Details> {
  return confirmOf(new WorkflowTool(config).build(params as never));
}

/**
 * What a `scriptPath` call is labeled: its transcript title, a line the
 * approval dialog shows and, when given, one it must not show. Returns the
 * dialog.
 */
async function expectLabel(
  config: Config,
  scriptPath: string,
  title: string,
  shown: string,
  hidden?: string,
) {
  const invocation = new WorkflowTool(config).build({ scriptPath });
  expect(invocation.getDescription()).toBe(title);
  const details = await confirmOf(invocation);
  expect(details.prompt).toContain(shown);
  if (hidden !== undefined) expect(details.prompt).not.toContain(hidden);
  return details;
}

/** Runs `fn` over fresh temp dirs, one per prefix, removed afterwards. */
async function withTempDirs(
  prefixes: string[],
  fn: (dirs: string[]) => Promise<void>,
): Promise<void> {
  const dirs: string[] = [];
  try {
    for (const prefix of prefixes) {
      dirs.push(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    }
    await fn(dirs);
  } finally {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Writes `script` at `file` under the saved-workflows dir; returns its path. */
async function writeSaved(
  storage: Storage,
  file: string,
  script: string,
): Promise<string> {
  const scriptPath = path.join(storage.getProjectWorkflowsDir(), file);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

describe('WorkflowTool', () => {
  it('has the registered name and display name', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(tool.name).toBe(ToolNames.WORKFLOW);
    expect(tool.displayName).toBe(ToolDisplayNames.WORKFLOW);
    expect(props(tool)['run_in_background'].default).toBe(false);
    expect(props(tool)['run_in_background'].description).toContain(
      'cooperatively pause/resume',
    );
  });

  // The description makes the model call this tool for the right request and
  // plan around the right limits. The authoring contract moved to the
  // `workflow-authoring` skill: SKILL.test.ts anchors what lives there, and
  // the `lacks` list here is what must NOT come back.
  it('description carries the opt-in rule and the runtime facts', () => {
    expectText(
      new WorkflowTool(fakeConfig()).description,
      [
        // Env knobs the orchestrator exports are anchored *through the
        // constant*, so a runtime-side rename fails here too (a literal only
        // catches a description-side typo while the model goes on naming a
        // variable nothing reads). `QWEN_CODE_MAX_WORKFLOW_SECONDS` has no
        // exported constant (`workflow-sandbox.ts` reads it inline).
        'min(16, availableParallelism()-2)',
        MAX_WORKFLOW_AGENTS_ENV,
        MAX_WORKFLOW_CONCURRENCY_ENV,
        WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
        WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
        'QWEN_CODE_MAX_WORKFLOW_SECONDS',
        'resumeFromRunId',
        '/workflows',
        'node:vm sandbox',
        // The one line of policy that stays: it stops orchestration by reflex.
        /Parallelism on its own is not a reason/,
        // Limits to plan around rather than discover mid-run, as numbers.
        // Interpolated, so a raised cap is tracked and a number pasted back
        // as prose goes red the next time the constant moves.
        `up to ${DEFAULT_MAX_AGENTS_PER_RUN} agents total`,
        // `DEFAULT_MAX_WALL_CLOCK_MS` is private to `workflow-sandbox.ts`, so
        // this one is still a hand-synced literal on both sides.
        /30-minute wall-clock cap/,
        // The `/workflows` control list trails the runtime: #8320 added
        // cooperative pause/resume while this text moved into a constant,
        // and the merge conflicted exactly here. Nothing else pins it.
        /cooperative pause\/resume/,
        // #8690: speak this project's vocabulary. Without a location the
        // model cannot reach a saved workflow: `workflow('<name>')` is a
        // blind guess and `scriptPath` wants a path it cannot construct.
        '.qwen/workflows',
        // The result surface: without these the model expects no script
        // path back, and resumes by re-sending the whole source.
        /Every run hands back its runId/,
        /read it before diagnosing/,
        // The null/throw split stays here, not in the skill: it governs how
        // the model READS a result, which every turn touching one needs.
        /`agent\(\)` resolves to `null` when that admitted agent fails on its own/,
        /exhausted stall retries/,
        /run-level rejections no later call could survive/i,
      ],
      [
        // The journal writes `started` per dispatch, then `result` or
        // `failed`, so any per-agent count is wrong (the skill has the lines).
        /journal holds one/,
        // Part of the null/throw split above.
        /user stopped it/,
      ],
    );
  });

  // Which guidance moved to the `workflow-authoring` skill is pinned in one
  // two-way table in `skills/bundled/workflow-authoring/SKILL.test.ts`: each
  // anchor present in the skill and absent here, whitespace collapsed.

  // A resume with no journal used to run every agent again under the old id,
  // and the schema promised exactly that.
  it('says a resume needs its journal, and promises no live re-run without one', () => {
    expectText(
      paramDescription(new WorkflowTool(fakeConfig()), 'resumeFromRunId'),
      [
        'A run whose journal is not on disk has nothing to resume and is refused',
        'call again without `resumeFromRunId`',
      ],
      ['without one, every agent() call runs live'],
    );
  });

  // Both parameters describe the persisted file `resumeFromRunId` says to
  // edit; one side left on the old contract (re-send the script) fails here.
  it('scriptPath and resumeFromRunId describe the persisted inline script', () => {
    const { scriptPath, resumeFromRunId } = props(
      new WorkflowTool(fakeConfig()),
    );
    expect(scriptPath.description).toContain('inline/<runId>.js');
    expectText(resumeFromRunId.description, [
      /Pass the `scriptPath` the original run returned/,
      /not the script text/,
    ]);
  });

  // The policy prose alone reads as encouragement, and the model fans out on
  // tasks nobody asked to spend a fleet on. This gate says when not to.
  it('description gates the tool on an explicit user request', () => {
    const { description } = new WorkflowTool(fakeConfig());
    // Ordering is the point: after the "what a workflow is for" pitch the
    // gate reads as a footnote. First, it frames everything below.
    const gate = description.indexOf('**Only on an explicit request**');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(
      description.indexOf('**What a workflow is for**'),
    );
    expectText(
      description,
      [
        // Each form is a real qwen trigger; without the list the model cannot
        // tell whether the request in front of it qualifies.
        'It counts as requested when any of these holds:',
        /contains the word `workflow`/,
        /in their own words/,
        /skill or slash command/,
        /named a saved workflow/,
        /resume or continue an earlier run/,
        // The load-bearing half: without an offer-and-ask path the model
        // reads "do not call it" as "refuse", and a user who would say yes is
        // never asked. Over-blocking is this change's one real failure mode.
        'Do not call this tool unless the user has asked for multi-agent orchestration.',
        'Otherwise do not call it, however well the task would parallelize.',
        /let the user decide/,
        /skips the ask/,
        // Interpolated: a raised cap has to move this sentence too.
        `dispatch up to ${DEFAULT_MAX_AGENTS_PER_RUN} subagents`,
      ],
      // Upstream's marker `ultracode` does not exist here: naming it lists a
      // trigger no qwen user can pull, and refuses work a real one allows.
      [/ultracode/i],
    );
  });

  // ── Approval dialog ────────────────────────────────────────────────────
  //
  // The user approves model-authored JavaScript that can fan out to the
  // per-run agent cap, provision git worktrees and spend an uncapped token
  // budget. The disclosure used to be `Run a workflow script (N chars)`, and
  // one "always allow" persisted a rule matching every future invocation.
  describe('approval dialog', () => {
    const SCRIPT_WITH_META = `export const meta = {
  name: 'audit-deps',
  description: 'Audit dependencies for CVEs',
  phases: [
    { title: 'Scan', detail: 'one agent per manifest' },
    { title: 'Verify' },
  ],
}
phase('Scan')
await agent('scan package.json')
`;
    const promptFor = async (script: string) =>
      (await detailsFor({ script })).prompt;

    // Declared phases say what the author meant; the structure says where the
    // agents actually are. A reader approving a fan-out needs both.
    it('shows where the agents are, read from the script', async () => {
      const prompt = await promptFor(
        [
          "const plan = await agent('plan the audit')",
          'const found = await parallel([',
          "  () => agent('scan src/core'),",
          "  () => agent('scan src/cli'),",
          '])',
          'while (budget.remaining() > 50_000) {',
          "  await agent('look again')",
          '}',
          'return found',
        ].join('\n'),
      );
      expect(prompt).toContain(
        [
          'Structure (where the script calls agent(); a loop or a fan-out runs each call many times):',
          '  step — "plan the audit"',
          '  parallel, 2 agent() call sites — "scan src/core", "scan src/cli"',
          '  loop while (budget.remaining() > 50_000) — "look again"',
        ].join('\n'),
      );
    });

    it('caps the structure rows and names the rest', async () => {
      const prompt = await promptFor(
        Array.from(
          { length: 14 },
          (_, i) => `await parallel([() => agent('batch ${i}')])`,
        ).join('\n'),
      );
      expect(prompt).toContain('  parallel — "batch 11"');
      expect(prompt).not.toContain('"batch 12"');
      expect(prompt).toContain('  … and 2 more');
    });

    it('leaves the structure out when the script dispatches no agent', async () => {
      expect(await promptFor('return 1')).not.toContain('Structure');
    });

    // A fan-out's width is data, so no row prints a number an approver could
    // take for its agent count, and one over functions built earlier is still
    // listed as a fan-out rather than left looking like a single step.
    it('shows no agent count for a fan-out, however it is written', async () => {
      const prompt = await promptFor(
        [
          'const thunks = args.files.map((f) => () => agent(`read ${f}`))',
          'const read = await parallel(thunks)',
          'await parallel(read.map((r) => () => agent(`check ${r}`)))',
        ].join('\n'),
      );
      expect(prompt).toContain(
        [
          '  step — "read …"',
          '  parallel — runs functions built elsewhere in the script',
          '  parallel — "check …"',
        ].join('\n'),
      );
      expect(prompt).not.toContain('×');
    });

    it('names the workflow, its purpose and its phases', async () => {
      const info = await detailsFor({ script: SCRIPT_WITH_META });
      expect(info.type).toBe('info');
      expect(info.title).toBe('Run a dynamic workflow?');
      expect(info.prompt).toContain('audit-deps');
      expect(info.prompt).toContain('Audit dependencies for CVEs');
      expect(info.prompt).toContain('1. Scan');
      expect(info.prompt).toContain('one agent per manifest');
      expect(info.prompt).toContain('2. Verify');
    });

    // The load-bearing failure mode: meta is read on the approval path, and
    // `extractAndStripMeta` throws on a malformed literal. If the dialog
    // throws, the user cannot even say no.
    it('degrades instead of throwing when meta is malformed', async () => {
      const prompt = await promptFor(
        'export const meta = { name: someIdentifier }\nawait agent("x")',
      );
      expect(prompt).toContain('declares no meta block');
      expect(prompt).toContain('await agent("x")');
    });

    it('renders a script that has no meta block at all', async () => {
      expect(await promptFor('await agent("hello")')).toContain(
        'await agent("hello")',
      );
    });

    // Nothing was displayed before, so nothing could be spoofed; a preview
    // without the screen would open the hole: the text is model-authored and
    // reaches a terminal.
    it('strips escape sequences from everything it displays', async () => {
      const prompt = await promptFor(
        [
          'export const meta = {',
          "  name: 'a\\u001b[31mred\\u001b[0m',",
          "  description: 'plain',",
          '}',
          "await agent('x\\u001b[2Jclear')",
        ].join('\n'),
      );
      expect(prompt).not.toContain('');
      expect(prompt).toContain('ared');
    });

    // `stripAnsiAndControl` removes C0 controls, `\n` among them: the naive
    // call collapses the excerpt into one unreadable line. Sanitizing per
    // line keeps the script legible.
    it('keeps the script excerpt on multiple lines, and bounds it', async () => {
      const long = Array.from(
        { length: 400 },
        (_, i) => `await agent('step ${i}')`,
      ).join('\n');
      const prompt = await promptFor(long);
      expect(prompt.split('\n').length).toBeGreaterThan(10);
      expect(prompt).toContain('more characters)');
      expect(prompt.length).toBeLessThan(long.length);
    });

    it('shows args, and survives args that cannot be serialized', async () => {
      const ok = await detailsFor({
        script: 'await agent("x")',
        args: { target: 'packages/core' },
      });
      expect(ok.prompt).toContain('packages/core');

      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const bad = await detailsFor({
        script: 'await agent("x")',
        args: circular,
      });
      expect(bad.prompt).toContain('not JSON-serializable');
    });

    // An inline script is fresh model-authored source every time. A blanket
    // grant would transfer the consent the user gave to the script they read
    // onto every script the model writes afterwards.
    it('never lets an inline script be pre-approved', async () => {
      const details = await detailsFor({ script: SCRIPT_WITH_META });
      expect(details.hideAlwaysAllow).toBe(true);
      // Empty, not absent: `injectPermissionRulesIfMissing` fills in the
      // bare-tool-name rule only when the tool supplies none, and that rule
      // is documented as matching every invocation of the tool.
      expect(details.permissionRules).toEqual([]);
    });

    it('never pre-approves a persisted inline script path', async () => {
      const { config, storage } = configWithStorage();
      const details = await detailsFor(
        {
          scriptPath: storage.getInlineWorkflowScriptPath('wf_1234abcd'),
          resumeFromRunId: 'wf_1234abcd',
        },
        config,
      );
      expect(details.hideAlwaysAllow).toBe(true);
      expect(details.permissionRules).toEqual([]);
    });

    it('scopes a saved-workflow grant to the path and content that were approved', async () => {
      await withTempDirs(['wf-grant-', 'wf-grant-rt-'], async ([proj, rt]) => {
        const storage = new Storage(proj, rt);
        const config = { storage } as unknown as Config;
        const scriptPath = await writeSaved(storage, 'audit.js', 'return 1;');
        const otherPath = await writeSaved(storage, 'other.js', 'return 1;');

        const details = await detailsFor({ scriptPath }, config);
        expect(details.hideAlwaysAllow).toBeFalsy();
        expect(details.permissionRules).toHaveLength(1);

        // Behavioural, not textual: a plausible rule that never matches makes
        // "always allow" silently do nothing, worse than not offering it.
        const rule = details.permissionRules![0];
        const matches = (params: Record<string, unknown>) =>
          grantMatches(rule, config, params);
        expect(await matches({ scriptPath })).toBe(true);
        expect(await matches({ scriptPath: otherPath })).toBe(false);
        expect(await matches({ script: 'return 1;' })).toBe(false);
        // The model cannot restore a stale grant by supplying the digest.
        const digest = computeWorkflowScriptDigest('return 1;');
        await fs.writeFile(scriptPath, 'return 2;');
        expect(await matches({ scriptPath })).toBe(false);
        expect(await matches({ scriptPath, sha256: digest })).toBe(false);
      });
    });

    // With nothing loaded there is no content to pin a grant to, and a bare
    // path rule would approve whatever the file later holds.
    it('offers no grant for a scriptPath that cannot be loaded', async () => {
      const details = await detailsFor(
        { scriptPath: '/home/u/.qwen/workflows/audit.js' },
        configWithStorage().config,
      );
      expect(details.hideAlwaysAllow).toBe(true);
      expect(details.permissionRules).toEqual([]);
      expect(details.prompt).toContain('Cannot load the script:');
    });

    // - generated root: a throwaway a tool emitted for this run; labeled
    //   saved, the user would approve (maybe pre-approve the path rule) under
    //   a wrong identity.
    // - `..`-laced: the loader canonicalizes with realpath, so the raw string
    //   (in the generated root, `..` climbing out) loads far from its
    //   spelling; classified raw it shows the opposite identity.
    // - nested: the loader trusts the whole generated subtree (writers nest
    //   per session), so the label must follow nested scripts.
    it.each([
      [
        'labels a generated-root scriptPath as a generated script, not a saved workflow',
        (s: Storage) =>
          path.join(s.getGeneratedWorkflowsDir(), 'fanout-1a2b3c.js'),
        'Run generated workflow script (fanout-1a2b3c.js)',
        'Generated workflow script',
        'Saved workflow',
      ],
      [
        'keeps the saved-workflow label for a saved-root scriptPath',
        (s: Storage) =>
          path.join(s.getProjectWorkflowsDir(), 'deep-research.js'),
        'Run saved workflow (deep-research.js)',
        'Saved workflow',
        undefined,
      ],
      [
        'classifies a ..-laced scriptPath by its normalized location',
        (s: Storage) =>
          [
            s.getGeneratedWorkflowsDir(),
            '..',
            '..',
            '..',
            '..',
            'workflows',
            'audit.js',
          ].join(path.sep),
        'Run saved workflow (audit.js)',
        'Saved workflow',
        undefined,
      ],
      [
        'labels a nested generated-root scriptPath as a generated script',
        (s: Storage) =>
          path.join(s.getGeneratedWorkflowsDir(), 's-abc', 'fanout.js'),
        'Run generated workflow script (fanout.js)',
        'Generated workflow script',
        'Saved workflow',
      ],
    ])('%s', async (_title, pathIn, title, label, hidden) => {
      const { config, storage } = configWithStorage();
      const scriptPath = pathIn(storage);
      await expectLabel(
        config,
        scriptPath,
        title,
        `${label}: ${scriptPath}`,
        hidden,
      );
    });

    // The loader decides loadability with `fs.realpath`, so a scriptPath
    // whose spelling diverges from its realpath (a symlink crossing roots)
    // must be labeled by the content that actually loads.
    it('labels a symlinked scriptPath by the content that loads', async () => {
      await withTempDirs(['wf-lbl-', 'wf-lbl-rt-'], async ([proj, rt]) => {
        const storage = new Storage(proj, rt);
        const config = { storage } as unknown as Config;
        const generatedDir = storage.getGeneratedWorkflowsDir();
        await fs.mkdir(generatedDir, { recursive: true });

        // A generated-spelled link whose realpath is a saved workflow.
        const deploy = await writeSaved(storage, 'deploy.js', 'return 1;');
        const generatedSpelling = path.join(generatedDir, 'run.js');
        await fs.symlink(deploy, generatedSpelling);

        // A saved-spelled link whose realpath is a generated script.
        const nested = path.join(generatedDir, 's-abc');
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(nested, 'throwaway.js'), 'return 1;');
        const savedSpelling = path.join(
          storage.getProjectWorkflowsDir(),
          'toolgen.js',
        );
        await fs.symlink(path.join(nested, 'throwaway.js'), savedSpelling);

        const savedLoaded = (
          await detailsFor({ scriptPath: generatedSpelling }, config)
        ).prompt;
        expect(savedLoaded).toContain(`Saved workflow: ${generatedSpelling}`);
        expect(savedLoaded).not.toContain('Generated workflow script');

        const generatedLoaded = (
          await detailsFor({ scriptPath: savedSpelling }, config)
        ).prompt;
        expect(generatedLoaded).toContain(
          `Generated workflow script: ${savedSpelling}`,
        );
        expect(generatedLoaded).not.toContain('Saved workflow');
      });
    });

    // The loader refuses a symlinked generated-scripts root outright, so the
    // dialog must not claim a generated identity for a path under one.
    it('labels nothing generated through a symlinked generated root', async () => {
      await withTempDirs(
        ['wf-lbl-', 'wf-lbl-rt-', 'wf-lbl-ext-'],
        async ([proj, rt, external]) => {
          const storage = new Storage(proj, rt);
          const generatedDir = storage.getGeneratedWorkflowsDir();
          await fs.mkdir(path.dirname(generatedDir), { recursive: true });
          await fs.writeFile(path.join(external, 'leak.js'), 'return 1;');
          await fs.symlink(external, generatedDir, 'dir');
          const scriptPath = path.join(generatedDir, 'leak.js');

          const { prompt } = await detailsFor({ scriptPath }, {
            storage,
          } as unknown as Config);
          expect(prompt).toContain(`Saved workflow: ${scriptPath}`);
          expect(prompt).not.toContain('Generated workflow script');
        },
      );
    });

    // The cost warning used to arrive only after a successful run — after
    // the spend it warns about, and never at all on the failure path.
    it('warns about token cost before the spend, exactly once', async () => {
      const { config } = configWithRegistry();
      const first = await detailsFor({ script: 'await agent("x")' }, config);
      expect(first.prompt).toContain(MAX_TOKENS_PER_WORKFLOW_ENV);

      // The registry latch flips on read, so the second dialog is quiet and
      // the post-hoc copy on the result path suppresses itself too.
      const second = await detailsFor({ script: 'await agent("y")' }, config);
      expect(second.prompt).not.toContain(MAX_TOKENS_PER_WORKFLOW_ENV);
    });

    it('titles the transcript row with the workflow name', () => {
      const tool = new WorkflowTool(fakeConfig());
      expect(tool.build({ script: SCRIPT_WITH_META }).getDescription()).toBe(
        'Run workflow: audit-deps',
      );
      // Falls back to the character count only when there is no meta to read.
      expect(
        tool.build({ script: 'await agent("x")' }).getDescription(),
      ).toContain('chars)');
    });
  });

  // A script that never compiled has no run behind it. Reported as a failed
  // workflow, the model goes looking for a runId never minted, and it reads
  // as "the orchestration broke" when the real problem is a typo it can fix
  // and re-send.
  it('reports an uncompilable script as not launched, not as a failure', async () => {
    const result = await runTool(
      { script: "const x: string = 'a';\nawait agent(x);" },
      undefined,
      configWithRegistry().config,
    );

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    const text = JSON.stringify(result.llmContent);
    expect(text).toContain('was not launched');
    expect(text).toContain('plain JavaScript');
    // No run happened, so there is no run id to hand back.
    expect(result.workflowRunId).toBeUndefined();
    expect(text).not.toContain('Workflow failed');
  });

  // The caps used to be stated in the description and again in `script`, and
  // raising one could leave the other advertising the old number. The tool
  // surface now has one model-visible copy (the detail lives in the skill):
  // the second must not grow back, and the one left must be the constant.
  it('states each cap once, in the tool description only', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(tool.description).toContain(
      `up to ${DEFAULT_MAX_AGENTS_PER_RUN} agents total`,
    );
    expectText(
      paramDescription(tool, 'script'),
      // What `script` still owns: the source's shape, and where to go next.
      [
        'async IIFE',
        'Pass THUNKS to parallel(), not eager calls',
        'all of `Date`',
        WORKFLOW_AUTHORING_SKILL_NAME,
      ],
      [
        String(DEFAULT_MAX_AGENTS_PER_RUN),
        MAX_WORKFLOW_AGENTS_ENV,
        MAX_WORKFLOW_CONCURRENCY_ENV,
        // The per-option error strings a script checks for moved with the
        // options; the skill's test asserts they are there.
        'subagent completed without calling StructuredOutput',
        'agent type',
        // Throw-to-null settlement (#11196): a resurrected "throws" claim
        // would contradict the description beside it.
        'Unresolved names throw',
        "'remote' throws",
      ],
    );
  });

  // Every model-visible string is paid for on every turn, so each has a
  // budget. The headroom is a paragraph: one legitimate clause fits, pasted
  // option prose does not. The description's was raised from 4,500 when it
  // gained the size guideline paragraph (~290 chars), putting it at 4,502.
  it.each([
    ['the description', 4_800],
    ['script', 900],
    ['scriptPath', 950],
    ['name', 400],
    ['args', 250],
    ['resumeFromRunId', 850],
    ['run_in_background', 450],
  ])('keeps %s within its per-turn budget', (name, budget) => {
    const tool = new WorkflowTool(fakeConfig());
    const text =
      name === 'the description'
        ? tool.description
        : paramDescription(tool, name);
    expect(text.length).toBeLessThanOrEqual(budget);
  });

  // A name-only session swaps the authoring pointer for the lock section and
  // rewrites two parameter descriptions; it is paid for on every turn too.
  it('keeps the name-only surface within the same budgets', () => {
    const tool = new WorkflowTool({
      ...fakeConfig(),
      isWorkflowNameOnly: () => true,
    } as unknown as Config);
    expect(tool.description.length).toBeLessThanOrEqual(4_800);
    expect(paramDescription(tool, 'name').length).toBeLessThanOrEqual(400);
    expect(
      paramDescription(tool, 'resumeFromRunId').length,
    ).toBeLessThanOrEqual(850);
  });

  // The inline fallback carries the whole reference and grows with it, but
  // still needs a ceiling. Raised from 24,000 when the reference gained the
  // turn token budget (it stood at 23,973); then from 25,000 for the size
  // limits and guideline paragraph (25,759); from 26,500 for
  // `agent({tools})`, what the allowlist refuses and cannot promise (26,900);
  // from 27,500, reached exactly by the resume refusals, for how a run
  // interrupted by its process exiting is listed; from 28,000, nearly
  // reached, when the `schema` entry gained what is refused before dispatch
  // and what a failed structured result reports; from 28,500 for the dynamic
  // import() refusal and the per-call batch limit with its batching example
  // (29,211).
  it('keeps the inline fallback description within its budget', () => {
    const tool = new WorkflowTool({
      ...fakeConfig(),
      getToolRegistry: () => ({
        getAllToolNames: () => [ToolNames.WORKFLOW],
        getTool: () => undefined,
      }),
    } as unknown as Config);

    expect(tool.authoringSurface).toBe('inline');
    expect(tool.description.length).toBeLessThanOrEqual(29_500);
  });

  it.each([
    ['rejects build() when script is missing', {}, /script/],
    ['rejects build() when script is empty string', { script: '' }, /script/],
    // ── P7b-A1: saved-workflow scriptPath path ──────────────────────────
    [
      'rejects build() when both script and scriptPath are given',
      { script: 'return 1', scriptPath: '/x/y.js' },
      /exactly one/,
    ],
  ])('%s', (_title, params, error) => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() => tool.build(params as never)).toThrow(error);
  });

  it('rejects build() when resumeFromRunId is not a wf_<hex> id (path-traversal guard)', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() =>
      tool.build({ script: 'return 1', resumeFromRunId: '../../etc/evil' }),
    ).toThrow(/resumeFromRunId/);
    expect(() =>
      tool.build({
        script: 'return 1',
        resumeFromRunId: 'wf_1a2b3c4d5e6f7081',
      }),
    ).not.toThrow();
  });

  it('build() accepts a scriptPath without inline script', () => {
    const tool = new WorkflowTool(configWithStorage().config);
    const invocation = tool.build({ scriptPath: '/abs/deep-research.js' });
    expect(invocation.params.scriptPath).toBe('/abs/deep-research.js');
    // Description reflects the saved-workflow filename, not a char count.
    expect(invocation.getDescription()).toContain('deep-research.js');
  });

  it('rejects background runs outside an interactive completion channel', () => {
    const background = { script: 'return 1', run_in_background: true };
    const headless = configWithRegistry({ isInteractive: () => false });
    headless.registry.setCompletionCallback(vi.fn());
    expect(() => new WorkflowTool(headless.config).build(background)).toThrow(
      /interactive TUI/i,
    );

    const { config, registry } = configWithRegistry({
      isInteractive: () => true,
    });
    expect(() => new WorkflowTool(config).build(background)).toThrow(
      /completion channel/i,
    );
    expect(() =>
      new WorkflowTool(config).buildSessionOwnedBackground({
        script: 'return 1',
      }),
    ).toThrow(/completion channel/i);

    registry.setCompletionCallback(vi.fn());
    const acpConfig = {
      isInteractive: () => true,
      getExperimentalZedIntegration: () => true,
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    expect(() => new WorkflowTool(acpConfig).build(background)).toThrow(
      /interactive TUI/i,
    );
  });

  // A retry of a saved workflow whose file is no longer readable falls back to
  // the run's inline source and passes no name (the ACP retry path). The
  // runner still resolves the name from the resumed run, so the notice says
  // to copy the saved workflow and must not also say "fix the script". A
  // foreground resume's trailer carries the same advice.
  it('keeps the authoring hint off a saved workflow resumed from its inline source', async () => {
    await withTempDirs(['workflow-session-hint-'], async ([runtimeDir]) => {
      const { config, registry } = configWithRegistry({
        ...fakeConfig(),
        storage: new Storage(path.join(runtimeDir, 'project'), runtimeDir),
        isInteractive: () => false,
        ...QUIET,
      });
      const completion = vi.fn();
      registry.setCompletionCallback(completion);
      const script = 'throw new Error("boom");';
      const tool = new WorkflowTool(config, { dispatch: unused });
      expect(tool.authoringSurface).toBe('pointer');
      const first = await tool
        .buildSessionOwnedBackground({ script }, 'review-and-fix')
        .execute(live());
      await vi.waitFor(() => expect(completion).toHaveBeenCalledTimes(1));
      const runId = first.workflowRunId;
      expect(runId).toMatch(/^wf_/);
      // The completion callback fires from fail()/complete() while the
      // runner's finally block still holds the run's handle; a resume that
      // lands before releaseHandle is refused with "has not exited yet".
      await registry.getHandle(runId!)?.completion;

      await tool
        .buildSessionOwnedBackground({ script, resumeFromRunId: runId })
        .execute(live());
      await vi.waitFor(() => expect(completion).toHaveBeenCalledTimes(2));
      await registry.getHandle(runId!)?.completion;
      const retryText = completion.mock.calls[1][1] as string;
      expect(retryText).toContain(
        'This reads the saved /review-and-fix workflow',
      );
      expect(retryText).not.toContain('hint:');

      const foreground = await tool
        .build({ script, resumeFromRunId: runId })
        .execute(live());
      const trailer = texts(foreground).join('\n');
      expect(trailer).toContain('this reads the saved workflow');
      expect(trailer).not.toContain('hint:');
    });
  });

  it('starts a session-owned background run outside the interactive TUI', async () => {
    await withTempDirs(['workflow-session-owned-'], async ([runtimeDir]) => {
      const { config, registry } = configWithRegistry({
        storage: new Storage(path.join(runtimeDir, 'project'), runtimeDir),
        isInteractive: () => false,
        ...QUIET,
      });
      registry.setCompletionCallback(vi.fn());
      const result = await new WorkflowTool(config, { dispatch: unused })
        .buildSessionOwnedBackground(
          { script: `phase('Inspect'); return { status: 'ready' };` },
          'review-and-fix',
        )
        .execute(live());

      expect(result.workflowRunId).toMatch(/^wf_[0-9a-f]+$/);
      const run = registry.get(result.workflowRunId!);
      expect(run?.isBackgrounded).toBe(true);
      expect(run?.workflowName).toBe('review-and-fix');
      await vi.waitFor(() =>
        expect(registry.get(result.workflowRunId!)?.status).toBe('completed'),
      );
      await registry.getHandle(result.workflowRunId!)?.completion;
    });
  });

  it('does not register a background run when the caller is already aborted', async () => {
    const { config, registry } = configWithRegistry({
      isInteractive: () => true,
    });
    registry.setCompletionCallback(vi.fn());
    const dispatch = vi.fn(unused);
    const caller = new AbortController();
    caller.abort();

    const result = await runTool(
      { script: 'return 1', run_in_background: true },
      dispatch,
      config,
      caller.signal,
    );

    expect(result).toEqual(CANCELLED_BEFORE_START);
    expect(registry.list()).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * Resumes `wf_1234abcd` with the journal load stubbed to run `during` (a
   * cancel from one side or the other) mid-preflight.
   */
  async function cancelDuringPreflight(
    during: (registry: WorkflowRunRegistry, caller: AbortController) => void,
    background: boolean,
  ) {
    const { config, registry } = configWithRegistry({
      storage: new Storage(path.join(os.tmpdir(), 'workflow-preflight-test')),
      isInteractive: () => true,
    });
    registry.setCompletionCallback(vi.fn());
    const caller = new AbortController();
    const dispatch = vi.fn(unused);
    const load = vi
      .spyOn(WorkflowJournal.prototype, 'load')
      .mockImplementation(async () => {
        during(registry, caller);
        return {
          kind: 'loaded' as const,
          replay: { results: new Map(), started: new Map(), failed: new Set() },
        };
      });
    try {
      const result = await runTool(
        {
          script: 'return 1',
          resumeFromRunId: 'wf_1234abcd',
          ...(background ? { run_in_background: true } : {}),
        },
        dispatch,
        config,
        caller.signal,
      );
      return { result, registry, caller, dispatch };
    } finally {
      load.mockRestore();
    }
  }

  // `sessionTaskCancel` on a run that is still loading aborts the run's own
  // controller via `cancelStarting`; the caller's signal stays live, so the
  // catch cannot recognise the outcome from `signal.aborted`.
  it('reports a registry-side cancel during background preflight as cancelled, not failed', async () => {
    const { result, registry, caller, dispatch } = await cancelDuringPreflight(
      (r) => expect(r.cancelStarting('wf_1234abcd')).toBe(true),
      true,
    );
    expect(caller.signal.aborted).toBe(false);
    expect(result).toEqual(CANCELLED_BEFORE_START);
    expect(registry.list()).toHaveLength(0);
    expect(registry.isStarting('wf_1234abcd')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // The foreground path is the default mode, and the same registry-side
  // sources reach it: `sessionTaskCancel` fires `cancelStarting` on a resume
  // whose terminal entry was evicted, and `abortAll` on session dispose.
  // Registering anyway let the settlement classifier (blind to the run's own
  // controller) settle this dispatch-free run `completed`.
  it('reports a registry-side cancel during foreground preflight as cancelled, not failed', async () => {
    const { result, registry, caller, dispatch } = await cancelDuringPreflight(
      (r) => expect(r.cancelStarting('wf_1234abcd')).toBe(true),
      false,
    );
    expect(caller.signal.aborted).toBe(false);
    expect(result).toEqual(CANCELLED_BEFORE_START);
    expect(registry.list()).toHaveLength(0);
    expect(registry.isStarting('wf_1234abcd')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not register when cancellation arrives during background preflight', async () => {
    const { result, registry, dispatch } = await cancelDuringPreflight(
      (_registry, caller) => caller.abort(),
      true,
    );
    expect(result).toEqual(CANCELLED_BEFORE_START);
    expect(registry.list()).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('run_in_background=true returns a live handle without late tool updates', async () => {
    const { config, registry } = configWithRegistry({
      isInteractive: () => true,
      ...QUIET,
    });
    registry.setCompletionCallback(vi.fn());
    let resolveDispatch: ((value: string) => void) | undefined;
    const tool = new WorkflowTool(config, {
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    const updateOutput = vi.fn();
    const invocation = tool.build({
      script: `phase('slow'); return await agent('work');`,
      run_in_background: true,
    });
    (
      invocation as unknown as { setCallId: (callId: string) => void }
    ).setCallId('workflow-tool-call');
    const execution = invocation.execute(live(), updateOutput);

    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    const result = await execution;
    const entry = registry.list()[0]!;
    expect(entry.status).toBe('running');
    expect(entry.isBackgrounded).toBe(true);
    expect(entry.toolUseId).toBe('workflow-tool-call');
    expect(result.workflowRunId).toBe(entry.runId);
    expect(result.llmContent).toEqual([
      {
        text:
          `Workflow started in background.\nRun ID: ${entry.runId}\n` +
          `Status: running\nYou will be notified when it settles. ` +
          `Use /workflows ${entry.runId} for the live phase tree.`,
      },
    ]);
    expect(result.returnDisplay).toBe(
      `Workflow ${entry.runId} started in the background (status: running). Use Background Tasks to observe, cooperatively pause/resume, or stop it.`,
    );
    expect(updateOutput).not.toHaveBeenCalled();

    resolveDispatch?.('done');
    await registry.getHandle(entry.runId)!.completion;
    expect(registry.get(entry.runId)?.status).toBe('completed');
    expect(updateOutput).not.toHaveBeenCalled();
  });

  it('keeps a client-started workflow in the foreground and reports its completion', async () => {
    const registry = new WorkflowRunRegistry();
    const completion = vi.fn();
    registry.setCompletionCallback(completion);
    const config = {
      isInteractive: () => true,
      getWorkflowRunRegistry: () => registry,
      getSkipWorkflowUsageWarning: () => true,
    } as unknown as Config;
    let resolveDispatch: ((value: string) => void) | undefined;
    const tool = new WorkflowTool(config, {
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    const invocation = tool.build({
      script: `phase('audit'); return { result: await agent('check fr') };`,
    });
    (
      invocation as unknown as {
        setCompletionNotificationEnabled: (enabled: boolean) => void;
      }
    ).setCompletionNotificationEnabled(true);
    const updateOutput = vi.fn();
    let settled = false;
    const execution = invocation
      .execute(new AbortController().signal, updateOutput)
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    expect(settled).toBe(false);
    expect(registry.list()[0].isBackgrounded).toBe(false);
    expect(
      updateOutput.mock.calls.some(([text]) =>
        text.includes('watch progress in this tool card.'),
      ),
    ).toBe(true);
    expect(completion).not.toHaveBeenCalled();
    resolveDispatch?.('French checked');
    const result = await execution;
    expect(JSON.stringify(result.llmContent)).toContain('French checked');
    expect(completion).toHaveBeenCalledOnce();
    expect(completion.mock.calls[0][0]).toContain('French checked');
    expect(completion.mock.calls[0][1]).toContain('French checked');
  });

  it.each(['caller', 'dialog'])(
    'replaces running progress with cancelled state after %s cancellation',
    async (source) => {
      const { config, registry } = configWithRegistry();
      config.isInteractive = () => true;
      const completion = vi.fn();
      registry.setCompletionCallback(completion);
      let rejectDispatch: ((error: Error) => void) | undefined;
      const invocation = new WorkflowTool(config, {
        dispatch: () =>
          new Promise<string>((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      }).build({ script: "phase('audit'); return await agent('held agent');" });
      (
        invocation as unknown as {
          setCompletionNotificationEnabled: (enabled: boolean) => void;
        }
      ).setCompletionNotificationEnabled(true);
      const caller = new AbortController();
      const updateOutput = vi.fn();
      const execution = invocation.execute(caller.signal, updateOutput);
      await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
      const runId = registry.list()[0].runId;
      expect(updateOutput.mock.lastCall?.[0]).toContain('"status": "running"');
      expect(updateOutput.mock.lastCall?.[0]).toContain(
        `Workflow ${runId}: watch progress in this tool card.`,
      );

      if (source === 'caller') caller.abort();
      else registry.cancel(runId, Date.now());
      rejectDispatch?.(new Error('Request was aborted'));
      await execution;

      const lastDisplay = updateOutput.mock.lastCall?.[0];
      expect(lastDisplay).toContain(runId);
      expect(lastDisplay).toContain('"status": "cancelled"');
      expect(lastDisplay).not.toContain('"status": "running"');
      expect(lastDisplay).not.toContain('watch progress');
      expect(registry.get(runId)?.dispatches[0].status).toBe('cancelled');
      expect(completion).not.toHaveBeenCalled();
    },
  );

  it.each([
    { interactive: false, acp: false },
    { interactive: true, acp: true },
  ])(
    'keeps completion routing unchanged outside the TUI: %j',
    async ({ interactive, acp }) => {
      const registry = new WorkflowRunRegistry();
      const completion = vi.fn();
      registry.setCompletionCallback(completion);
      const config = {
        isInteractive: () => interactive,
        getExperimentalZedIntegration: () => acp,
        getWorkflowRunRegistry: () => registry,
        getSkipWorkflowUsageWarning: () => true,
      } as unknown as Config;
      const invocation = new WorkflowTool(config).build({
        script: 'return 42;',
      });
      (
        invocation as unknown as {
          setCompletionNotificationEnabled: (enabled: boolean) => void;
        }
      ).setCompletionNotificationEnabled(true);
      const result = await invocation.execute(new AbortController().signal);
      expect(JSON.stringify(result.llmContent)).toContain('42');
      expect(completion).not.toHaveBeenCalled();
    },
  );

  it('run_in_background=false preserves the foreground ToolResult byte-for-byte', async () => {
    const run = (runInBackground: false | undefined) =>
      runTool(
        {
          script: `phase('one'); return { answer: 42 };`,
          resumeFromRunId: 'wf_1234abcd',
          ...(runInBackground === undefined
            ? {}
            : { run_in_background: runInBackground }),
        },
        unused,
        configWithRegistry(QUIET).config,
      );

    await expect(run(false)).resolves.toEqual(await run(undefined));
  });

  // A headless run (`qwen --prompt`, CI, cron) has no TUI, no approval bridge
  // and a closed stdin. `getDefaultPermission()` is 'ask', which the
  // scheduler resolves against the approval mode, but nothing INSIDE the tool
  // or runner may reach for interactivity, or the foreground call hangs on a
  // prompt no one can answer. The background half is refused explicitly (see
  // the interactive-TUI guard above).
  it('foreground execute() completes with no interactive session or completion channel', async () => {
    const { config, registry } = configWithRegistry({
      isInteractive: () => false,
      ...QUIET,
    });
    expect(registry.hasCompletionCallback()).toBe(false);

    const result = await runTool(
      { script: `return await agent('what is it');` },
      async (prompt) => `answered:${prompt}`,
      config,
    );

    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.llmContent)).toContain('answered:what is it');
  });

  it('execute() loads a saved-workflow scriptPath and records its provenance', async () => {
    await withTempDirs(['wf-tool-', 'wf-tool-rt-'], async ([proj, rt]) => {
      const storage = new Storage(proj, rt);
      const { config, registry } = configWithRegistry({ storage });
      // The scriptPath MUST live under a saved-workflow dir (the resolver
      // refuses paths outside it — the #2 path-traversal / symlink guard).
      const scriptPath = await writeSaved(
        storage,
        'greet.js',
        'return await agent("hi");',
      );
      const result = await runTool({ scriptPath }, tagged, config);
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.llmContent)).toContain('T:hi');
      // The registry entry carries the resolved absolute path (run provenance
      // for the snapshot writer).
      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].scriptPath).toBe(scriptPath);
      expect(entries[0].workflowName).toBe('greet');
    });
  });

  it('build() returns an invocation that exposes the script as description', () => {
    const invocation = new WorkflowTool(fakeConfig()).build({
      script: 'return 1',
    });
    expect(invocation.params.script).toBe('return 1');
    expect(invocation.getDescription()).toContain('workflow');
  });

  it('getDefaultPermission returns "ask"', async () => {
    const tool = new WorkflowTool(fakeConfig());
    const invocation = tool.build({ script: 'return 1' });
    expect(await invocation.getDefaultPermission()).toBe('ask');
  });

  it('execute() runs the script via WorkflowOrchestrator with injected dispatch and returns a ToolResult', async () => {
    const result = await runTool(
      {
        script: `phase("plan");
               const r = await agent("write hello", { label: "h1" });
               return r;`,
      },
      tagged,
    );
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.llmContent)).toContain('T:write hello');
    // FIX-7: llmContent holds just the result, not the full JSON wrapper, so
    // a plain-string result carries no runId there; returnDisplay does.
    expect(JSON.stringify(result.returnDisplay)).toMatch(/wf_[0-9a-f]{16}/);
  });

  // End to end, checking the unwrapped return value (first llmContent part):
  // - parallel() (P2, PR #4732): WorkflowTool → orchestrator counter +
  //   limiter + parallelImpl → sandbox in-realm revival → safeStringifyResult.
  // - agent({schema}) (P3): dispatch's structured payload is revived per call
  //   into the vm realm, read there, and stringified for the LLM; a
  //   regression in any layer of that chain surfaces here.
  // - pipeline() (PR #4947 R2 T8, qwen-code-ci-bot): its vm wrapper spreads
  //   the variadic stages (`callPipeline.apply(null, arguments)`,
  //   `[items].concat(stages)` in workflow-sandbox.ts), a vm-to-host
  //   forwarding path parallel's single-argument call never takes.
  it.each([
    [
      'execute() runs parallel() end-to-end and returns the revived array',
      `return await parallel([() => agent("a"), () => agent("b")]);`,
      tagged,
      ['T:a', 'T:b'],
    ],
    [
      'execute() runs agent({schema}) end-to-end and returns the revived object',
      'const r = await agent("hello", { schema: { type: "object", properties: { extracted: { type: "string" } } } }); return r;',
      (async (prompt, opts) =>
        opts.schema !== undefined
          ? { extracted: prompt.toUpperCase(), confidence: 0.9 }
          : prompt) as Dispatch,
      { extracted: 'HELLO', confidence: 0.9 },
    ],
    [
      'execute() runs pipeline() end-to-end and returns the revived array',
      `return await pipeline([1, 2], (x) => x * 10, (x) => x + 1);`,
      unused,
      [11, 21],
    ],
  ])('%s', async (_title, script, dispatch, expected) => {
    const result = await runTool({ script }, dispatch);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(texts(result)[0])).toEqual(expected);
  });

  it('execute() preserves returned VM Errors and collections in the card and model result', async () => {
    const tool = new WorkflowTool(fakeConfig());
    const invocation = tool.build({
      script: `return {
        error: new Error('disk full'),
        failed: new Map([['agent-1', new Error('rate limited')]]),
        errors: new Set(['agent-2: timeout'])
      };`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const expected = {
      error: 'Error: disk full',
      failed: [['agent-1', 'Error: rate limited']],
      errors: ['agent-2: timeout'],
    };
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual(expected);
    const displayJson = String(result.returnDisplay).match(
      /```json\n([\s\S]*?)\n```/,
    )![1];
    expect(JSON.parse(displayJson).result).toEqual(expected);
  });

  // TST-C3: execute() should return an error result (not throw) when the script throws.
  it('execute() returns an error result when the script throws', async () => {
    const result = await runTool(
      { script: 'throw new Error("scripted failure")' },
      unused,
    );
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('scripted failure');
    expect(JSON.stringify(result.llmContent)).toContain('Workflow failed');
    expect(String(result.returnDisplay)).toMatch(
      /"runId"\s*:\s*"wf_[0-9a-f]+"/,
    );
    // T4 (PR #4732 R1): the machine-readable type, so dropping it is caught.
    expect(result.error!.type).toBe('execution_failed');
  });

  // One script each, read through returnDisplay:
  // - T19 (PR #4732 R1): phases / logs from before a failure must be shown,
  //   or the failure cannot be debugged.
  // - T30 (PR #4732 R3), drift of the R1 T12/T18 fix: the display payload
  //   (runId + phases + logs + result) was one JSON.stringify, so one bad
  //   `result` collapsed it all to "(display payload not
  //   JSON-serializable)". safeStringifyDisplayPayload now degrades per field.
  // - P4: declared meta is shown (for the user and a future /workflows
  //   listing), also when the body throws after meta parsed
  //   (WorkflowExecutionError.meta, surfaced by the catch).
  it.each([
    [
      'execute() includes phases + logs in returnDisplay when script fails',
      `
        phase("plan");
        log("computing");
        phase("execute");
        log("about to fail");
        throw new Error("boom");
      `,
      true,
      [
        'Workflow failed: boom',
        'plan',
        'execute',
        'computing',
        'about to fail',
      ],
      [],
    ],
    [
      'execute() preserves runId/phases/logs in returnDisplay when result is non-JSON-serializable',
      'phase("compute"); const a = {}; a.self = a; return a;',
      false,
      [/wf_[0-9a-f]{16}/, 'compute', 'non-JSON-serializable'],
      ['display payload not JSON-serializable'],
    ],
    [
      'execute() surfaces meta in returnDisplay when the script declares it',
      `export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'plan' }] }
               return 1;`,
      false,
      ['"meta"', 'demo workflow', '"phases"'],
      [],
    ],
    [
      'execute() omits meta key from returnDisplay when the script has no declaration',
      'return 1;',
      undefined,
      [],
      ['"meta"'],
    ],
    [
      'execute() includes meta in failure returnDisplay when body throws',
      `export const meta = { name: 'fails', description: 'will throw' }
               throw new Error("body boom")`,
      true,
      ['Workflow failed', '"fails"', 'will throw'],
      [],
    ],
  ])('%s', async (_title, script, failed, has, lacks) => {
    const result = await runTool({ script }, unused);
    if (failed === true) expect(result.error).toBeDefined();
    if (failed === false) expect(result.error).toBeUndefined();
    expectText(String(result.returnDisplay), has, lacks);
  });

  // T12 / T18 (PR #4732 R1): a script that returns a BigInt or a circular
  // value must not be reported as a workflow failure — the script ran fine,
  // only the post-processing JSON.stringify hit a limitation.
  // FIX-C9 (TST-M2): a script without an explicit `return` resolves to
  // undefined, surfaced as a clear placeholder, not the string "undefined".
  // FIX-G (Round 4 test Minor): args thread through WorkflowTool.build() →
  // orchestrator.run() → sandbox; dropping them (e.g. forgetting
  // `args: this.params.args` in orchestrator.run) would go uncaught.
  it.each([
    [
      'execute() degrades gracefully on BigInt return values (success, not failure)',
      { script: 'return 1n + 2n;' },
      /non-JSON-serializable value of type bigint/,
    ],
    [
      'execute() degrades gracefully on circular return values',
      { script: 'const a = {}; a.self = a; return a;' },
      /non-JSON-serializable value of type object/,
    ],
    [
      'execute() threads params.args through to the sandbox args global',
      { script: 'return args.who', args: { who: 'world' } },
      'world',
    ],
    [
      'execute() handles scripts that return undefined (no explicit return)',
      { script: 'phase("noop"); /* no return */' },
      '(workflow returned no value)',
    ],
  ])('%s', async (_title, params, expected) => {
    const result = await runTool(params, unused);
    expect(result.error).toBeUndefined();
    const llmText = texts(result)[0];
    if (typeof expected === 'string') expect(llmText).toBe(expected);
    else expect(llmText).toMatch(expected);
  });

  it.each([
    'const a = {}; a.self = a; return a;',
    'return { error: new Error("disk full"), count: 1n };',
    'return new Map([["agent-1", 1n]]);',
  ])(
    'execute() preserves runId/phases/logs when result cannot be serialized: %s',
    async (script) => {
      const tool = new WorkflowTool(fakeConfig(), {
        dispatch: async () => 'unused',
      });
      const invocation = tool.build({
        script: `phase("compute"); log("before result"); ${script}`,
      });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      const display = String(result.returnDisplay);
      // runId, the phase, and a result placeholder must all survive.
      expect(display).toMatch(/wf_[0-9a-f]{16}/);
      expect(display).toContain('compute');
      expect(display).toContain('before result');
      expect(display).toContain('non-JSON-serializable');
      // The atomic-failure fallback must NOT appear — that would mean the
      // whole display payload had thrown.
      expect(display).not.toContain('display payload not JSON-serializable');
    },
  );

  // TST-C3: llmContent must be the unwrapped script return value (FIX-7).
  it('execute() strips the JSON wrapper from llmContent (script return is verbatim)', async () => {
    const result = await runTool(
      { script: 'return { kind: "report", body: "hello" };' },
      unused,
    );
    const parts = texts(result);
    // The first part is the JSON of the script's return value alone, NOT a
    // wrapper with {runId, result, phases, logs}.
    expect(JSON.parse(parts[0])).toEqual({ kind: 'report', body: 'hello' });
    // The run handle is a SECOND part, so the first still parses as what the
    // script returned. (The scheduler joins the two with a newline; see the
    // convertToFunctionResponse tests below.)
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(
      /^--- workflow run ---\nrunId: wf_[0-9a-f]+\ntokens: 0 spent \(no cap\)$/,
    );
  });

  // P4a adversarial review (MEDIUM): a return value shaped like a
  // WorkflowMeta declaration (`{ name, description, phases }`) must not
  // clobber the top-level `meta` key in the safeStringifyDisplayPayload
  // spread; both appear distinctly so the declared meta stays visible.
  it('execute() display surfaces meta + meta-shaped result distinctly', async () => {
    const result = await runTool(
      {
        script: `
        export const meta = { name: 'declared', description: 'the declared meta' }
        return { name: 'returned', description: 'looks like meta but is the script result', phases: [{ title: 'X' }] }
      `,
      },
      unused,
    );
    expect(result.error).toBeUndefined();
    const display = result.returnDisplay as string;
    const jsonText = display.replace(/^```json\n/, '').replace(/\n```$/, '');
    const parsed = JSON.parse(jsonText) as {
      meta: { name: string; description: string };
      result: { name: string; description: string; phases: object[] };
    };
    expect(parsed.meta).toEqual({
      name: 'declared',
      description: 'the declared meta',
    });
    expect(parsed.result).toEqual({
      name: 'returned',
      description: 'looks like meta but is the script result',
      phases: [{ title: 'X' }],
    });
    // Defensive: a merge could still satisfy a single-side toEqual on a
    // shared object, so both literals must render at separate offsets.
    expect(display.indexOf('"declared"')).toBeGreaterThan(-1);
    expect(display.indexOf('"returned"')).toBeGreaterThan(-1);
    expect(display.indexOf('"declared"')).not.toBe(
      display.indexOf('"returned"'),
    );
  });

  // P4b Round 5 (wenshao): the registry seam (register on execute() start,
  // emitter wires live state, complete on success, fail on a caught
  // exception, cancel on signal.aborted) was unexercised with fakeConfig():
  // optional chaining resolved every call site to undefined. These three pin
  // the contract against a real WorkflowRunRegistry.

  it('execute() success path registers the run + mirrors meta/phases/result + transitions to completed', async () => {
    const { config, registry } = configWithRegistry();
    const result = await runTool(
      {
        script: `
        export const meta = { name: 'demo', description: 'desc' }
        phase('Plan')
        phase('Build')
        const a = await agent('q1')
        return { a }
      `,
      },
      async () => 'mock-answer',
      config,
    );
    expect(result.error).toBeUndefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('completed');
    expect(entry.runId).toMatch(/^wf_[a-f0-9]{16}$/);
    // The tool fast-tracks meta.name → entry.description when the
    // synthesized default (runId) was used at register time.
    expect(entry.description).toBe('demo');
    expect(entry.meta).toEqual({ name: 'demo', description: 'desc' });
    expect(entry.phases).toEqual(['Plan', 'Build']);
    expect(entry.currentPhase).toBe('Build');
    expect(entry.agentsDispatched).toBe(1);
    expect(entry.agentsCompleted).toBe(1);
    expect(entry.result).toEqual({ a: 'mock-answer' });
    expect(entry.error).toBeUndefined();
    expect(entry.endTime).toBeDefined();
  });

  it('execute() failure path records the error message + transitions to failed', async () => {
    const { config, registry } = configWithRegistry();
    const result = await runTool(
      {
        script: `
        phase('Plan')
        throw new Error('intentional script body failure')
      `,
      },
      unused,
      config,
    );
    expect(result.error).toBeDefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/intentional script body failure/);
    expect(entry.phases).toEqual(['Plan']);
    expect(entry.endTime).toBeDefined();
  });

  it('execute() pre-aborted signal transitions the entry to cancelled (not failed)', async () => {
    const { config, registry } = configWithRegistry();
    // Pre-abort so dispatch sees the cancellation immediately. The catch
    // arm distinguishes user-intent (signal.aborted) from script bugs.
    const aborter = new AbortController();
    aborter.abort();
    const result = await runTool(
      {
        script: `
        phase('Plan')
        await agent('q1')
        return 1
      `,
      },
      async () => {
        throw new Error('aborted-by-signal');
      },
      config,
      aborter.signal,
    );
    expect(result.error).toBeDefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The fail-vs-cancel branch in the workflow.ts catch arm: signal.aborted
    // at catch time records 'cancelled', so the dialog tells user-initiated
    // stops from script bugs.
    expect(entry.status).toBe('cancelled');
    expect(entry.endTime).toBeDefined();
  });

  // P4 Round 7 (wenshao): the dialog-cancel race, end to end.
  // `cancelSelected` → `registry.cancel()` flips status to 'cancelled' and
  // aborts the entry's controller (the tool's `dispatchController`); the
  // in-flight dispatch rejects and the catch arm calls `setRecentLogs`, which
  // a `status === 'running'` guard used to drop, leaving a cancelled row's
  // Logs empty. This is the EXACT production flow (real tool, registry,
  // sandbox, emitter); the dialog itself is unreachable in the current TUI
  // build (a pill-focus gap wenshao R7 put out of P4 scope), so this stands in
  // for a tmux dialog-cancel check.
  it('R7: dialog-cancel race during run — logs accumulated before cancel survive', async () => {
    const { config, registry } = configWithRegistry();
    // Hangs until the in-flight reject is triggered externally (the dialog
    // cancel's abort cascading through dispatchController).
    let dispatchInflight:
      | { reject: (err: Error) => void; prompt: string }
      | undefined;
    const dispatch = async (prompt: string): Promise<string> =>
      new Promise<string>((_resolve, reject) => {
        dispatchInflight = { reject, prompt };
      });

    const executePromise = runTool(
      {
        script: `
        phase('Plan');
        log('before agent dispatch');
        const a = await agent('q1');
        log('after agent: ' + a);
        return { a };
      `,
      },
      dispatch,
      config,
    );

    // Wait for execute() to register the run and queue the dispatch.
    for (let i = 0; i < 200; i++) {
      if (registry.list().length > 0 && dispatchInflight) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.list()).toHaveLength(1);
    const runId = registry.list()[0]!.runId;

    // The dialog cancel: flip status and abort the entry's controller, which
    // IS the dispatchController, so the dispatch is cascaded.
    registry.cancel(runId, Date.now());
    expect(registry.get(runId)!.status).toBe('cancelled');

    // The production path: the abort propagates through the orchestrator's
    // limiter / countedDispatch and the in-flight dispatch rejects.
    dispatchInflight!.reject(new Error('aborted by dialog cancel'));

    // The catch arm runs; with the R7 fix its setRecentLogs call lands
    // instead of being dropped by a guard that rejected 'cancelled'.
    const result = await executePromise;
    expect(result.error).toBeDefined();

    const final = registry.get(runId)!;
    expect(final.status).toBe('cancelled');
    // R7 fix: logs from BEFORE the cancel stay on the entry, so the
    // dialog's Logs section is non-empty.
    expect(final.recentLogs.length).toBeGreaterThan(0);
    expect(
      final.recentLogs.some((l) => l.includes('before agent dispatch')),
    ).toBe(true);
  });

  // ── P5 T7: one-time usage warning banner ──────────────────────────────

  /** The returnDisplay of one run of `script` against `config`. */
  const displayOf = async (script: string, config: Config) =>
    (await runTool({ script }, replyOk, config)).returnDisplay as string;

  it('P5 T7: prepends the usage banner on the first run only', async () => {
    const { config, registry } = configWithRegistry();

    const first = await displayOf('return 1', config);
    expect(typeof first).toBe('string');
    expect(first).toMatch(
      /Workflows have no per-run token cap|Workflow token cap is/,
    );
    expect(first).toMatch(/skipWorkflowUsageWarning/);
    // Second invocation: latch already flipped on the registry.
    const second = await displayOf('return 2', config);
    expect(second).not.toMatch(/skipWorkflowUsageWarning/);

    expect(registry.list().length).toBe(2);
  });

  it('P5 T7: suppressed by skipWorkflowUsageWarning setting', async () => {
    const { config, registry } = configWithRegistry(QUIET);
    const display = await displayOf('return 1', config);
    expect(display).not.toMatch(/skipWorkflowUsageWarning/);
    // The latch stays unflipped: the setting bypasses the call, so a later
    // session that re-enables it still gets its banner.
    expect(registry.shouldShowUsageWarning()).toBe(true);
  });

  // ── P5 T7 R1: failure-path latch + status='failed' contract ─────────

  // coreToolScheduler overrides `returnDisplay` with `error.message` when
  // `result.error` is set, so a banner on the failure path would be invisible
  // AND silently flip the latch, and the next successful run would miss it.
  // The latch flips only when the banner is actually rendered (success path).
  it('P5 T7 R1: failure path does NOT emit banner or consume the latch', async () => {
    const { config, registry } = configWithRegistry();
    const failed = await displayOf('throw new Error("script-boom");', config);
    expect(failed).not.toMatch(/skipWorkflowUsageWarning/);
    expect(failed).toMatch(/Workflow failed: /);
    // Latch unconsumed: a later successful run still gets the banner.
    expect(registry.shouldShowUsageWarning()).toBe(true);
    // Registry status contract: failed → 'failed', error preserved.
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.status).toBe('failed');
    expect(registry.list()[0]!.error).toMatch(/script-boom/);
  });

  it('P5 T7 R1: failed-then-succeeded → banner appears on the SUCCESS run', async () => {
    const { config, registry } = configWithRegistry();
    await displayOf('throw new Error("first-fail");', config);
    const success = await displayOf('return 1', config);
    expect(success).toMatch(/skipWorkflowUsageWarning/);
    expect(registry.list()).toHaveLength(2);
    expect(registry.list()[0]!.status).toBe('failed');
    expect(registry.list()[1]!.status).toBe('completed');
  });

  it('names the turn target, not a per-run cap, when the message set one', async () => {
    const turns = new TurnBudget();
    turns.beginTurn({
      promptId: 'turn',
      sessionId: 'banner-turn',
      budget: 500_000,
      directiveText: '+500k',
      outputTokensAtTurnStart: 0,
    });
    const { config } = configWithRegistry({
      getSessionId: () => 'banner-turn',
      getTurnBudget: () => turns,
    });

    const display = await displayOf('return 1', config);

    expect(display).toContain(
      "This turn's output-token target is 500000 (set by `+500k` in your message)",
    );
    expect(display).not.toMatch(
      /Workflows have no per-run token cap|Workflow token cap is/,
    );
  });

  it('P5 R1 #10: capped banner shape (`total !== null`) — was untested', async () => {
    const { config } = configWithRegistry();
    vi.stubEnv('QWEN_CODE_MAX_TOKENS_PER_WORKFLOW', '50000');
    try {
      const display = await displayOf('return 1', config);
      expect(display).toMatch(/Workflow token cap is 50000/);
      expect(display).toMatch(/skipWorkflowUsageWarning/);
      expect(display).not.toMatch(/Workflows have no per-run token cap/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ── The run handle the model gets back ──────────────────────────────
  //
  // A result used to be the script's return value alone: no run id for
  // `/workflows`, no journal of per-agent results, no resume short of
  // re-sending the source. The trailer carries all three, and is safe to add
  // because it never touches the first part.
  describe('run handle trailer', () => {
    let runtimeDir: string;
    let projectRoot: string;

    beforeEach(async () => {
      runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tool-rt-'));
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tool-proj-'));
      vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
    });

    // Also restores the token cap a test may have stubbed.
    afterEach(async () => {
      vi.unstubAllEnvs();
      await fs.rm(runtimeDir, { recursive: true, force: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
    });

    /**
     * Real storage and registry over the ordinary session `fakeConfig()`
     * models: the authoring reference is a skill the model can load, which is
     * what the failure hint tells it to do.
     */
    function storedConfig(): { config: Config; storage: Storage } {
      const storage = new Storage(projectRoot);
      const { config } = configWithRegistry({
        ...fakeConfig(),
        storage,
        ...QUIET,
      });
      return { config, storage };
    }

    /** One call through a fresh {@link storedConfig}, with its text parts. */
    async function runStored(
      params: Record<string, unknown>,
      dispatch?: Dispatch,
    ) {
      const { config, storage } = storedConfig();
      const result = await runTool(params, dispatch, config);
      const parts = texts(result);
      return { config, storage, result, parts, trailer: parts[1] };
    }

    it('names the persisted script, the journal and the resume call', async () => {
      const { storage, result, parts, trailer } = await runStored(
        { script: 'await agent("one"); return "done";' },
        async () => 'answer',
      );
      expect(parts[0]).toBe('done');
      const runId = runIdOf(result.scriptPath!);
      expectText(trailer, [
        `runId: ${runId}`,
        `script: ${storage.getInlineWorkflowScriptPath(runId)}`,
        `journal: ${storage.getWorkflowRunJournalPath(runId)}`,
        'agents: 1 dispatched · 1 completed · 0 cached · 0 failed · 0 cancelled',
        'tokens: 0 spent (no cap)',
        `resume: Workflow({ scriptPath: ${JSON.stringify(result.scriptPath)}, resumeFromRunId: "${runId}" })`,
      ]);
      // Named paths are real files, not a format the runtime never wrote.
      await expect(fs.readFile(result.scriptPath!, 'utf8')).resolves.toBe(
        'await agent("one"); return "done";',
      );
      await expect(fs.stat(result.journalPath!)).resolves.toBeDefined();
      expect(trailer).toContain('longest unchanged prefix');
    });

    it('creates the journal before a dispatch-free result names it', async () => {
      const { result } = await runStored({ script: 'return "done";' });
      await expect(fs.stat(result.journalPath!)).resolves.toBeDefined();
    });

    it('annotates the dispatched count when a resume re-runs an agent', async () => {
      const { config } = storedConfig();
      const first = await runTool(
        { script: `return await agent('one');` },
        async () => {
          throw new WorkflowAgentFailedError('first attempt failed', 'error');
        },
        config,
      );
      const resumed = await runTool(
        {
          scriptPath: first.scriptPath,
          resumeFromRunId: runIdOf(first.scriptPath!),
        },
        async () => 'recovered',
        config,
      );

      const trailer = texts(resumed)[1];
      expect(trailer).toContain(
        'agents: 1 dispatched (1 re-ran from a prior run) · 1 completed',
      );
      expect(trailer).not.toContain('· 1 respawned');
    });

    it('omits the file lines when the config has no storage', async () => {
      const result = await runTool(
        { script: 'return "done";' },
        async () => 'answer',
        configWithRegistry(QUIET).config,
      );

      const [value, trailer] = texts(result);
      expect(value).toBe('done');
      expectText(trailer, ['runId: '], ['script: ', 'journal: ', 'resume: ']);
      expect(result.scriptPath).toBeUndefined();
      expect(result.journalPath).toBeUndefined();
    });

    // A well-formed result may use only the agents that DID come back, so
    // "completed" proves no whole fan-out; the failures section shows the gap.
    it('names the failed agents in the trailer of a successful run', async () => {
      const { result, parts, trailer } = await runStored(
        {
          script:
            'const out = await parallel([' +
            "() => agent('good', { label: 'good' }), " +
            "() => agent('bad', { label: 'flaky' })]); " +
            'return out;',
        },
        async (prompt: string) => {
          if (prompt === 'bad') {
            throw new WorkflowAgentFailedError(
              'Workflow subagent did not complete (terminate mode: MAX_TURNS).',
              'max_turns',
              'MAX_TURNS',
            );
          }
          return `r:${prompt}`;
        },
      );

      // The script's own value is untouched: the failed slot is `null`.
      expect(JSON.parse(parts[0])).toEqual(['r:good', null]);
      expect(trailer).toContain('1 failed');
      expect(trailer).toContain('failures (1):');
      expect(trailer).toContain('[flaky] Workflow subagent did not complete');
      expect(result.error).toBeUndefined();
    });

    it('omits the failures section when every agent came back', async () => {
      const { trailer } = await runStored(
        { script: "return await agent('x');" },
        async () => 'fine',
      );
      expect(trailer).not.toContain('failures (');
      // `respawned` is a resume-only fact; a fresh run must not report a
      // fifth outcome that is always zero.
      expect(trailer).not.toContain('respawned');
    });

    // The contract the description states, end to end through the real
    // sandbox: a sequential `await agent()` reads `null` for an agent that
    // failed on its own, and the run still succeeds.
    it('hands a sequential await agent() null instead of ending the run', async () => {
      const { result, parts } = await runStored(
        {
          script:
            "const a = await agent('x'); " +
            "return a === null ? 'agent failed' : 'agent said ' + a;",
        },
        async () => {
          throw new WorkflowAgentFailedError('model errored', 'error', 'ERROR');
        },
      );
      expect(parts[0]).toBe('agent failed');
      expect(result.error).toBeUndefined();
      expect(parts[1]).toContain('failures (1):');

      // The record reaches the file a resume reads. The orchestrator tests
      // pin WHEN it is written (in-memory journal) and the journal tests the
      // append; this is the one place both run together for real.
      const lines = (await fs.readFile(result.journalPath!, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => line['type'])).toEqual([
        'launched',
        'started',
        'failed',
      ]);
      expect(lines[2]['key']).toBe(lines[1]['key']);
      expect(lines[2]['agentId']).toBe(lines[1]['agentId']);
    });

    // The failure path is where the logs matter: `returnDisplay` carries them
    // for the user, but the scheduler replaces it with `error.message` for the
    // model, so without this part the model sees the message alone.
    it('carries the trailer and the last log lines on the failure path', async () => {
      const { result, parts } = await runStored(
        { script: 'log("about to fail"); throw new Error("boom");' },
        unused,
      );
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(parts[0]).toBe('Workflow failed: boom');
      expect(parts[1]).toContain('--- workflow run ---');
      expect(parts[1]).toContain('script: ');
      expect(parts[1]).toContain('logs (last ');
      expect(parts[1]).toContain('about to fail');
      expect(result.error?.message).toContain('--- workflow run ---');
      // A script that threw is a script to rewrite, and the description only
      // points at the reference — the model may never have read it.
      expect(parts[1]).toContain(LOAD_SKILL_HINT);
    });

    // Pointing at a skill the model cannot reach is worse than silence: the
    // reference is inlined in the description it read. Both halves are read
    // from one tool, so the hint and the description cannot drift apart.
    it('points at the inlined reference when the skill is unreachable', async () => {
      const { config } = storedConfig();
      Object.assign(config, {
        getToolRegistry: () => ({
          getAllToolNames: () => [ToolNames.WORKFLOW],
          getTool: () => undefined,
        }),
      });
      const tool = new WorkflowTool(config, { dispatch: unused });
      const result = await tool
        .build({ script: 'throw new Error("boom");' })
        .execute(live());

      expect(tool.description).toContain('# Workflow authoring reference');
      const trailer = texts(result)[1];
      expect(trailer).toContain(
        "hint: See the authoring reference in this tool's description",
      );
      expect(trailer).not.toContain('hint: Load the');
    });

    // The description is fixed when the tool is built. A `/skills` toggle
    // after that must not flip the hint into describing a different
    // description than the one the model is holding.
    it('keeps the hint consistent with the description after a mid-session toggle', async () => {
      const { config } = storedConfig();
      const tool = new WorkflowTool(config, { dispatch: unused });
      Object.assign(config, { isSkillEnabled: () => false });

      const result = await tool
        .build({ script: 'throw new Error("boom");' })
        .execute(live());

      expect(tool.description).toContain(
        `load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
      );
      expect(texts(result)[1]).toContain(LOAD_SKILL_HINT);
    });

    // The earliest, most common first-attempt failure returns no trailer, so
    // the hint has to ride on the message itself.
    it('carries the hint on a script that fails to compile', async () => {
      const result = await runTool({
        script: "const target: string = 'x';\nawait agent(target);",
      });

      const text = texts(result).join('\n');
      expect(text).toContain('was not launched');
      expect(text).toContain(LOAD_SKILL_HINT);
      expect(result.error?.message).toContain('hint:');
    });

    // The hint belongs to a failure: on a success, telling the model to read
    // the reference is noise on the path that needs it least.
    it('adds no authoring hint to a successful run', async () => {
      const { trailer } = await runStored(
        { script: "return await agent('x');" },
        async () => 'fine',
      );
      expect(trailer).not.toContain('hint:');
    });

    it('does not offer to restart a user-cancelled foreground run', async () => {
      const { config } = storedConfig();
      const registry = config.getWorkflowRunRegistry()!;
      let finishDispatch: ((value: string) => void) | undefined;
      const execution = runTool(
        { script: 'return await agent("slow");' },
        () =>
          new Promise<string>((resolve) => {
            finishDispatch = resolve;
          }),
        config,
      );
      await vi.waitFor(() => expect(registry.list()).toHaveLength(1));
      const runId = registry.list()[0]!.runId;
      await vi.waitFor(() =>
        expect(registry.get(runId)?.dispatches).toHaveLength(1),
      );
      registry.cancel(runId, Date.now());
      finishDispatch?.('late');

      const result = await execution;
      const text = texts(result).join('\n');
      expect(text).toContain('Workflow cancelled');
      expect(text).toContain('1 cancelled');
      expect(text).not.toContain('resume: Workflow(');
      expect(text).not.toContain('hint:');
      expect(result.error).toBeDefined();
    });

    it("advises copying an extension's workflow file before changing it", async () => {
      const { config, storage } = storedConfig();
      const realScriptPath = await fs.realpath(
        await writeSaved(
          storage,
          path.join('..', 'extensions', 'gcp', 'workflows', 'audit.js'),
          'throw new Error("boom")',
        ),
      );
      Object.assign(config, {
        getActiveExtensions: () => gcpExtensions(realScriptPath),
      });

      const text = texts(
        await runTool({ scriptPath: realScriptPath }, undefined, config),
      ).join('\n');

      expect(text).toContain(
        "this reads an extension's workflow file; copy it into .qwen/workflows",
      );
      expect(text).not.toContain('this reads the saved workflow');
    });

    it('does not advise editing a saved workflow to resume one run', async () => {
      const { config, storage } = storedConfig();
      const scriptPath = await writeSaved(
        storage,
        'deploy.js',
        'throw new Error("boom")',
      );

      const trailer = texts(
        await runTool({ scriptPath }, undefined, config),
      )[1];

      expect(trailer).toContain('this reads the saved workflow');
      expect(trailer).not.toContain('edit that file first');
      // "Fix the script, and retry" would contradict the resume advice to
      // copy the saved workflow before changing it.
      expect(trailer).not.toContain('hint:');
    });

    it('does not promise replay when the journal path is unavailable', async () => {
      const { config, storage } = storedConfig();
      const scriptPath = await writeSaved(
        storage,
        'deploy.js',
        'throw new Error("boom")',
      );
      vi.spyOn(WorkflowJournal.prototype, 'ensureExists').mockResolvedValueOnce(
        false,
      );

      const result = await runTool({ scriptPath }, undefined, config);
      const trailer = texts(result)[1];

      // A resume replays the journal, so with none written the trailer says
      // so instead of handing back a call that would be refused.
      expect(trailer).toContain(NO_JOURNAL_NO_RESUME_NOTE);
      expect(trailer).not.toContain('resumeFromRunId:');
      expect(trailer).not.toContain('longest unchanged prefix');
      expect(result.journalPath).toBeUndefined();
    });

    it('keeps only the bounded tail of failure logs', async () => {
      const logs = Array.from(
        { length: 25 },
        (_, index) => `log("progress ${index + 1}");`,
      ).join('');
      const { trailer } = await runStored({
        script: `${logs}throw new Error("boom");`,
      });

      expect(trailer).toContain('logs (last 20):');
      expect(trailer).toContain('progress 25');
      expect(trailer).toContain('progress 6');
      expect(trailer).not.toContain('progress 5\n');
    });

    it('reports disjoint failed dispatch counts', async () => {
      const { trailer } = await runStored(
        {
          script:
            'return await parallel([() => agent("good"), () => agent("bad")]);',
        },
        async (prompt) => {
          if (prompt === 'bad') throw new Error('failed');
          return 'fine';
        },
      );

      expect(trailer).toContain(
        'agents: 2 dispatched · 1 completed · 0 cached · 1 failed · 0 cancelled',
      );
    });

    it('reports the configured token cap in spent-over-total order', async () => {
      vi.stubEnv(MAX_TOKENS_PER_WORKFLOW_ENV, '1000');
      const { trailer } = await runStored({ script: 'return "done";' });

      expect(trailer).toContain('tokens: 0 / 1000 spent');
    });

    // A `+500k` turn in a session charged 400k before it began: the script
    // reads the turn's figures, not the run's; the trailer keeps the run's
    // spend apart from the turn's; the registry records no per-run cap; and
    // once the turn spent its target, the next agent() is refused undispatched.
    it('measures a +500k directive against the whole turn', async () => {
      const { config } = storedConfig();
      const sessionId = `turn-budget-${randomUUID()}`;
      const turns = new TurnBudget();
      Object.assign(config, {
        getSessionId: () => sessionId,
        getTurnBudget: () => turns,
      });
      const charge = (outputTokens: number) =>
        uiTelemetryService.addEvent(
          {
            'event.name': EVENT_API_RESPONSE,
            model: 'qwen-main',
            prompt_id: 'main',
            duration_ms: 1,
            input_token_count: 1,
            output_token_count: outputTokens,
            total_token_count: outputTokens + 1,
            cached_content_token_count: 0,
            thoughts_token_count: 0,
          } as unknown as Parameters<typeof uiTelemetryService.addEvent>[0],
          sessionId,
        );
      charge(400_000);
      turns.beginTurn({
        promptId: 'main',
        sessionId,
        budget: 500_000,
        directiveText: '+500k',
        outputTokensAtTurnStart:
          uiTelemetryService.getTotalOutputTokens(sessionId),
      });
      charge(150_000);

      const dispatch = vi.fn(unused);
      const measured = texts(
        await runTool(
          {
            script:
              'return [budget.total, budget.spent(), budget.remaining()];',
          },
          dispatch,
          config,
        ),
      );

      expect(JSON.parse(measured[0])).toEqual([500_000, 150_000, 350_000]);
      expect(measured[1]).toContain(
        'tokens: 0 spent by this run · 150000 / 500000 this turn (+500k directive)',
      );
      expect(
        config.getWorkflowRunRegistry().list()[0]!.tokenBudgetTotal,
      ).toBeNull();

      charge(350_000);
      const refused = await runTool(
        { script: 'await agent("one"); return "done";' },
        dispatch,
        config,
      );

      expect(texts(refused)[0]).toContain(
        'token budget exceeded (500000 / 500000 output tokens)',
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('names the script and journal on a background launch', async () => {
      const { config, storage } = storedConfig();
      Object.assign(config, { isInteractive: () => true });
      config.getWorkflowRunRegistry()!.setCompletionCallback(vi.fn());
      let resolveDispatch: ((value: string) => void) | undefined;
      const result = await runTool(
        { script: 'return await agent("slow");', run_in_background: true },
        () =>
          new Promise<string>((resolve) => {
            resolveDispatch = resolve;
          }),
        config,
      );

      const runId = result.workflowRunId!;
      const text = texts(result)[0];
      expectText(text, [
        `Script file: ${storage.getInlineWorkflowScriptPath(runId)}`,
        `Journal: ${storage.getWorkflowRunJournalPath(runId)}`,
        `Use /workflows ${runId}`,
      ]);
      await expect(fs.stat(result.journalPath!)).resolves.toBeDefined();

      resolveDispatch?.('done');
      await config.getWorkflowRunRegistry!()!.getHandle(runId)!.completion;
    });

    // The whole point of persisting the script: a resume can edit the file
    // and re-run without re-sending the source, and the journal still serves
    // every agent() call whose prompt and opts did not change.
    it('resumes from the persisted script after the file is edited', async () => {
      const { config } = storedConfig();
      const dispatch = vi.fn(async () => 'from the agent');
      const first = await runTool(
        { script: 'const a = await agent("one"); return a;' },
        dispatch,
        config,
      );

      const scriptPath = first.scriptPath!;
      expect(dispatch).toHaveBeenCalledTimes(1);

      // Only the post-processing changes; the agent() call is byte-identical,
      // so the journal keys still match.
      await fs.writeFile(
        scriptPath,
        'const a = await agent("one"); return a.toUpperCase();',
        'utf8',
      );
      dispatch.mockClear();

      const second = texts(
        await runTool(
          { scriptPath, resumeFromRunId: runIdOf(scriptPath) },
          dispatch,
          config,
        ),
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(second[0]).toBe('FROM THE AGENT');
      expect(second[1]).toContain('1 cached');
    });

    // The trailer tells the model to resume by passing the generated copy
    // back as `scriptPath`. That copy is still the model's script, so a
    // failure there keeps the hint the first run had.
    it('keeps the hint when a generated script is re-run by path and fails', async () => {
      const { config } = storedConfig();
      const first = await runTool(
        { script: 'throw new Error("first");' },
        unused,
        config,
      );
      expect(first.scriptPath).toBeDefined();

      const second = await runTool(
        { scriptPath: first.scriptPath! },
        unused,
        config,
      );

      const trailer = texts(second)[1];
      expect(trailer).toContain('edit that generated copy first');
      expect(trailer).toContain(LOAD_SKILL_HINT);
    });

    it('carries the original args in the resume call', async () => {
      const { result, trailer } = await runStored(
        {
          script: 'return await agent(`one ${args.who}`);',
          args: { who: 'world' },
        },
        async () => 'answer',
      );

      // A resume without the original args still runs — it just misses every
      // journal key, because the script bakes args into the agent prompts.
      expect(trailer).toContain(
        `resume: Workflow({ scriptPath: ${JSON.stringify(result.scriptPath)}, resumeFromRunId: "`,
      );
      expect(trailer).toContain('args: {"who":"world"}');
      expect(trailer).not.toContain('too large to inline');
    });

    it('names args it cannot inline instead of truncating the call', async () => {
      const { trailer } = await runStored(
        { script: 'return "done";', args: { blob: 'x'.repeat(400) } },
        async () => 'answer',
      );

      expect(trailer).toContain('resume: Workflow({');
      expect(trailer).not.toContain('args:');
      expect(trailer).toContain('too large to inline here');
    });

    // What the model reads: `convertToFunctionResponse` joins every text part
    // into one `functionResponse.output` with newlines (#1520), so the trailer
    // arrives appended to the value: not a part to ignore, and not altering
    // the value's own bytes.
    it('reaches the model as the return value with the trailer appended', async () => {
      const { result, parts } = await runStored(
        { script: 'return { kind: "report" };' },
        async () => 'answer',
      );

      const [response] = convertToFunctionResponse(
        'Workflow',
        'call-1',
        result.llmContent,
      );
      const output = response.functionResponse?.response?.['output'];
      expect(output).toBe(`${parts[0]}\n${parts[1]}`);
      expect(String(output)).toContain('"kind": "report"');
      expect(String(output)).toContain('}\n--- workflow run ---\n');
    });

    it('reaches the model with the failure message followed by the trailer', async () => {
      const { result, parts } = await runStored(
        { script: 'log("about to fail"); throw new Error("boom");' },
        unused,
      );

      expect(result.error?.message).toBe(`${parts[0]}\n${parts[1]}`);
      expect(result.error?.message).toMatch(
        /^Workflow failed: boom\n--- workflow run ---/,
      );
    });
  });
});

describe('WorkflowTool — extension workflow labels', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-ext-label-')),
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function extensionScript(): Promise<string> {
    const scriptPath = path.join(dir, 'gcp', 'workflows', 'audit.js');
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, 'return 1;\n', 'utf8');
    return scriptPath;
  }

  function configWithExtensionWorkflow(scriptPath: string, active: boolean) {
    const { config } = configWithStorage();
    Object.assign(config, {
      getActiveExtensions: () => (active ? gcpExtensions(scriptPath) : []),
    });
    return config;
  }

  it('names an active extension workflow instead of calling it saved', async () => {
    const scriptPath = await extensionScript();
    const details = await expectLabel(
      configWithExtensionWorkflow(scriptPath, true),
      scriptPath,
      'Run extension workflow (gcp:audit)',
      'Extension workflow: gcp:audit',
      'Saved workflow',
    );
    expect(details.prompt).toContain('Audits the project');
    expect(details.prompt).toContain(`Loaded from: ${scriptPath}`);
    // Same path-scoped pre-approval as any other saved script.
    expect(details.permissionRules).toHaveLength(1);
  });

  it('runs an active extension workflow by its qualified name', async () => {
    const scriptPath = await extensionScript();
    const config = configWithExtensionWorkflow(scriptPath, true);
    const invocation = new WorkflowTool(config).build({ name: 'gcp:audit' });

    expect(invocation.getDescription()).toBe(
      'Run extension workflow (gcp:audit)',
    );
    expect(await invocation.getDefaultPermission()).toBe('ask');
    const details = await confirmOf(invocation);
    const digest = computeWorkflowScriptDigest('return 1;\n');
    expect(details.prompt).toContain('Extension workflow: gcp:audit');
    expect(details.prompt).toContain('Audits the project');
    expect(details.prompt).toContain(`Loaded from: ${scriptPath}`);
    expect(details.prompt).toContain(`Script (sha256 ${digest}):`);
    expect(details.prompt).toContain('return 1;');
    expect(details.permissionRules).toHaveLength(1);
    const rule = details.permissionRules![0];
    // The colon inside the qualified name stays part of the value.
    expect(rule).toMatch(new RegExp(`\\(name:gcp:audit,sha256:${digest}\\)$`));
    expect(await grantMatches(rule, config, { name: 'gcp:audit' })).toBe(true);
    // Once the extension is disabled the name no longer loads, so the grant
    // has no content to match.
    expect(
      await grantMatches(rule, configWithExtensionWorkflow(scriptPath, false), {
        name: 'gcp:audit',
      }),
    ).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'names an extension workflow reached through a symlinked ancestor',
    async () => {
      const scriptPath = await extensionScript();
      // Discovery records real paths; the call spells the path through a
      // symlink, the way macOS `/var` resolves to `/private/var`.
      const alias = path.join(dir, 'alias');
      await fs.symlink(path.join(dir, 'gcp'), alias);
      // The approval dialog labels the same call the same way.
      await expectLabel(
        configWithExtensionWorkflow(scriptPath, true),
        path.join(alias, 'workflows', 'audit.js'),
        'Run extension workflow (gcp:audit)',
        'Extension workflow: gcp:audit',
        'Saved workflow',
      );
    },
  );

  it("keeps the saved-workflow label for the user's own script while an extension is active", async () => {
    const scriptPath = await extensionScript();
    const ownScript = path.join(dir, 'project/.qwen/workflows/deploy.js');
    await fs.mkdir(path.dirname(ownScript), { recursive: true });
    await fs.writeFile(ownScript, 'return 1;\n', 'utf8');
    await expectLabel(
      configWithExtensionWorkflow(scriptPath, true),
      ownScript,
      'Run saved workflow (deploy.js)',
      `Saved workflow: ${ownScript}`,
      'Extension workflow',
    );
  });

  it('falls back to the saved-workflow label once the extension is inactive', async () => {
    const scriptPath = await extensionScript();
    await expectLabel(
      configWithExtensionWorkflow(scriptPath, false),
      scriptPath,
      'Run saved workflow (audit.js)',
      `Saved workflow: ${scriptPath}`,
    );
  });
});

// `tools.workflowNameOnly`: the model may run named workflows only. The lock
// sits on `build`, the entry every model and client call takes, and not on
// the parameter validation the host's own runs share.
describe('WorkflowTool — name-only sessions', () => {
  function lockedConfig(extra: Record<string, unknown> = {}): Config {
    return {
      ...fakeConfig(),
      isWorkflowNameOnly: () => true,
      ...extra,
    } as unknown as Config;
  }

  it.each([
    [{ script: 'return 1' }, 'script'],
    [{ scriptPath: '/proj/.qwen/workflows/audit.js' }, 'scriptPath'],
    [{ script: 'return 1', resumeFromRunId: 'wf_0123' }, 'script'],
    [{ name: 'audit', scriptPath: '/w/a.js' }, 'scriptPath'],
  ])('refuses %j, naming %s', (params, field) => {
    const tool = new WorkflowTool(lockedConfig());
    // An Error expected value compares the whole message, not a substring.
    expect(() => tool.build(params as never)).toThrow(
      new Error(
        `WorkflowTool: this session restricts the Workflow tool to named workflows (tools.workflowNameOnly). Not allowed here: ${field}. Invoke as {name, args} only.`,
      ),
    );
  });

  it('names both fields when a call carries both', () => {
    expect(() =>
      new WorkflowTool(lockedConfig()).build({
        script: 'return 1',
        scriptPath: '/w/a.js',
      } as never),
    ).toThrow('Not allowed here: script, scriptPath.');
  });

  // The lock counts a source the way validation does, so a field validation
  // ignores cannot refuse a call that would run by name.
  it.each([
    [{ name: 'audit', scriptPath: '' }],
    [{ name: 'audit', script: '' }],
  ])('accepts %j as the named call validation reads it as', (params) => {
    const locked = new WorkflowTool(lockedConfig());
    const unlocked = new WorkflowTool(fakeConfig());
    expect(locked.build(params as never).getDescription()).toBe(
      unlocked.build(params as never).getDescription(),
    );
  });

  it('accepts a name, and a name resuming a run', () => {
    const tool = new WorkflowTool(lockedConfig());
    expect(tool.build({ name: 'audit' }).getDescription()).toBe(
      'Run saved workflow (audit)',
    );
    expect(() =>
      tool.build({ name: 'audit', resumeFromRunId: 'wf_0123' }),
    ).not.toThrow();
  });

  it('gives the model a schema without script or scriptPath, and name not required', () => {
    const tool = new WorkflowTool(lockedConfig());
    const { required } = tool.schema.parametersJsonSchema as {
      required?: string[];
    };
    expect(props(tool)).not.toHaveProperty('script');
    expect(props(tool)).not.toHaveProperty('scriptPath');
    expect(required).toBeUndefined();
    expect(paramDescription(tool, 'name')).toContain(
      'This session runs named workflows only',
    );
    expect(paramDescription(tool, 'resumeFromRunId')).toContain(
      'pass the same `name` and `args`',
    );
    expect(paramDescription(tool, 'resumeFromRunId')).not.toContain(
      'scriptPath',
    );
  });

  it('describes the lock and points at no authoring reference', () => {
    const tool = new WorkflowTool(lockedConfig());
    expect(tool.authoringSurface).toBe('withheld');
    expect(tool.description).toContain(WORKFLOW_NAME_ONLY_SECTION);
    expect(tool.description).toContain('**Only on an explicit request**');
    expect(tool.description).toContain('**Runtime**');
    expect(tool.description).not.toContain(
      `load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill`,
    );
    // The lock follows the decision and comes before the runtime facts.
    expect(tool.description.indexOf(WORKFLOW_NAME_ONLY_SECTION)).toBeLessThan(
      tool.description.indexOf('**Runtime**'),
    );
    // Every surface collapses to the same text under the lock.
    const locked = (surface: (typeof SURFACES)[number]) =>
      buildWorkflowToolDescription(surface, undefined, null, {
        nameOnly: true,
      });
    for (const surface of SURFACES) {
      expect(locked(surface)).toBe(locked('withheld'));
    }
  });

  // The shared decision and runtime text send the model to `scriptPath` and
  // to editing a persisted script; a locked session refuses both, so only the
  // lock section may mention a script path there.
  it('carries no script-path advice outside the lock section', () => {
    const locked = new WorkflowTool(lockedConfig()).description;
    const rest = locked.replace(WORKFLOW_NAME_ONLY_SECTION, '');
    expect(rest).not.toContain('scriptPath');
    expect(rest).not.toContain('edits that file');
    expect(rest).toContain("reached through `name` or `workflow('<name>')`.");
    expect(rest).toContain('`workflow(nameOrRef, args?)`');
    // The replaced sentences are real text in the unlocked description, so a
    // wording edit there fails here instead of leaving advice behind.
    const open = new WorkflowTool(fakeConfig()).description;
    expect(open).toContain(
      "reached through `name`, `workflow('<name>')` or `scriptPath`.",
    );
    expect(open).toContain('`scriptPath` additionally accepts');
    expect(open).toContain('a resume edits that file');
  });

  it('leaves an unlocked session exactly as it was', () => {
    const unlocked = new WorkflowTool({
      ...fakeConfig(),
      isWorkflowNameOnly: () => false,
    } as unknown as Config);
    const baseline = new WorkflowTool(fakeConfig());
    expect(unlocked.description).toBe(baseline.description);
    expect(unlocked.schema).toEqual(baseline.schema);
    expect(unlocked.authoringSurface).toBe(baseline.authoringSurface);
    expect(() => unlocked.build({ script: 'return 1' })).not.toThrow();
  });

  async function hostSession() {
    const runtimeDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-name-only-host-')),
    );
    const storage = new Storage(path.join(runtimeDir, 'project'), runtimeDir);
    const workflowsDir = storage.getProjectWorkflowsDir();
    await fs.mkdir(path.join(workflowsDir, 'sub'), { recursive: true });
    const registry = new WorkflowRunRegistry();
    registry.setNameOnly(true);
    const completion = vi.fn();
    registry.setCompletionCallback(completion);
    const config = lockedConfig({
      storage,
      isInteractive: () => false,
      getWorkflowRunRegistry: () => registry,
      ...QUIET,
    });
    const tool = new WorkflowTool(config, { dispatch: unused });
    const run = async (
      params: Parameters<WorkflowTool['buildSessionOwnedBackground']>[0],
      workflowName?: string,
    ) => {
      const result = await tool
        .buildSessionOwnedBackground(params, workflowName)
        .execute(live());
      await registry.getHandle(result.workflowRunId!)?.completion;
      return registry.get(result.workflowRunId!)!;
    };
    return { runtimeDir, workflowsDir, registry, completion, tool, run };
  }

  async function withHostSession(
    fn: (session: Awaited<ReturnType<typeof hostSession>>) => Promise<void>,
  ) {
    const session = await hostSession();
    try {
      await fn(session);
    } finally {
      await fs.rm(session.runtimeDir, { recursive: true, force: true });
    }
  }

  // The host is not the model: ACP run-script, run-saved, retry and rerun go
  // through buildSessionOwnedBackground and must keep working under the lock,
  // nested workflow({ scriptPath }) included.
  it("runs the host's own script-backed runs, nesting by path included", async () => {
    await withHostSession(async ({ workflowsDir, tool, run }) => {
      const inner = path.join(workflowsDir, 'inner.js');
      await fs.writeFile(inner, "return 'inner-ran';", 'utf8');
      expect(() =>
        tool.buildSessionOwnedBackground({ scriptPath: '/w/a.js' }),
      ).not.toThrow();
      const entry = await run({
        script: `return await workflow({ scriptPath: ${JSON.stringify(inner)} });`,
      });
      expect(entry.status).toBe('completed');
      expect(entry.result).toBe('inner-ran');
    });
  });

  // A name recorded from a path does not always lead back to that path: a
  // file in a subdirectory gets its basename as a name no lookup resolves.
  // Only a name that resolves to the script that ran may be offered.
  it('offers a resume by name only when the name leads back to the script that ran', async () => {
    await withHostSession(async ({ workflowsDir, completion, run }) => {
      const failing = "throw new Error('boom');";
      const top = path.join(workflowsDir, 'audit.js');
      const nested = path.join(workflowsDir, 'sub', 'report.js');
      await fs.writeFile(top, failing, 'utf8');
      await fs.writeFile(nested, failing, 'utf8');

      const matched = await run({ scriptPath: top }, 'audit');
      expect(matched.resumeName).toBe('audit');
      expect(completion.mock.calls[0][1] as string).toContain(
        `Resume: Workflow({ name: "audit", resumeFromRunId: "${matched.runId}" })`,
      );

      const unmatched = await run({ scriptPath: nested }, 'report');
      expect(unmatched.resumeName).toBeUndefined();
      const text = completion.mock.calls[1][1] as string;
      expect(text).toContain(
        'This session runs named workflows only, and this run cannot be resumed by name, so only whoever started it can retry it.',
      );
      expect(text).not.toContain('Workflow({');
    });
  });
});

// The size guideline is part of what the model plans a run around, so every
// description shape carries it — and none does when the user removed it.
describe('WorkflowTool size guideline', () => {
  it('states the default guideline after the runtime facts', () => {
    const { description } = new WorkflowTool(fakeConfig());
    const paragraph = buildWorkflowSizeGuidelineParagraph(
      resolveWorkflowSizeGuidelineSetting(undefined),
    );
    expect(paragraph).not.toBeNull();
    const at = description.indexOf(paragraph!);
    expect(at).toBeGreaterThan(description.indexOf('**Runtime**'));
    expect(at).toBeLessThan(description.indexOf('**Writing the script**'));
  });

  it('states a configured guideline, and none when unrestricted', () => {
    const withSize = (size: string) =>
      new WorkflowTool({
        ...fakeConfig(),
        getWorkflowSizeGuideline: () => ({ size, isDefault: false }),
      } as unknown as Config).description;
    expect(withSize('small')).toContain(
      'A workflow size guideline is configured for this session: small',
    );
    expect(withSize('unrestricted')).not.toContain('size guideline');
  });

  it('carries the guideline in every description shape', () => {
    const setting = resolveWorkflowSizeGuidelineSetting('large');
    const paragraph = buildWorkflowSizeGuidelineParagraph(setting)!;
    for (const surface of SURFACES) {
      expect(
        buildWorkflowToolDescription(surface, undefined, setting),
      ).toContain(paragraph);
    }
    expect(buildWorkflowToolDescription('pointer')).not.toContain(
      'size guideline',
    );
  });
});

describe('WorkflowTool — saved workflows by name', () => {
  let projectDir: string;
  let runtimeDir: string;
  let storage: Storage;

  beforeEach(async () => {
    projectDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-name-')),
    );
    runtimeDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'wf-name-rt-')),
    );
    storage = new Storage(projectDir, runtimeDir);
    await fs.mkdir(storage.getProjectWorkflowsDir(), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  const APPROVED = `export const meta = { name: 'nightly-audit', description: 'Audits the tree' };\nreturn 'approved-v1';\n`;
  const saveWorkflow = (name: string, script: string) =>
    writeSaved(storage, `${name}.js`, script);

  /** A registry config over this describe's storage; `nameOnly` sets the lock. */
  function nameConfig(nameOnly?: boolean): Config {
    return Object.assign(
      configWithRegistry().config,
      { storage },
      nameOnly === undefined ? {} : { isWorkflowNameOnly: () => nameOnly },
    );
  }

  /** Builds a by-name call and runs its default-permission check. */
  async function checkedByName(name: string, config: Config) {
    const invocation = new WorkflowTool(config).build({ name });
    await invocation.getDefaultPermission();
    return invocation;
  }

  it('accepts exactly one of script, scriptPath and name', () => {
    const tool = new WorkflowTool(fakeConfig());
    const exactlyOne =
      'provide exactly one of `script`, `scriptPath` or `name`';
    expect(() =>
      tool.build({ name: 'nightly-audit', script: 'return 1;' } as never),
    ).toThrow(exactlyOne);
    expect(() =>
      tool.build({ name: 'nightly-audit', scriptPath: '/w/a.js' } as never),
    ).toThrow(exactlyOne);
    expect(() => tool.build({} as never)).toThrow('`name` (a saved workflow)');
    expect(tool.build({ name: 'nightly-audit' }).getDescription()).toBe(
      'Run saved workflow (nightly-audit)',
    );
  });

  it('shows the script it loaded and pins the grant to it', async () => {
    const scriptPath = await saveWorkflow('nightly-audit', APPROVED);
    const config = nameConfig();
    const invocation = new WorkflowTool(config).build({
      name: 'nightly-audit',
    });

    expect(await invocation.getDefaultPermission()).toBe('ask');
    const details = await confirmOf(invocation);
    const digest = computeWorkflowScriptDigest(APPROVED);
    expect(details.prompt).toContain('Saved workflow: nightly-audit');
    expect(details.prompt).toContain('Audits the tree');
    expect(details.prompt).toContain(`Loaded from: ${scriptPath}`);
    expect(details.prompt).toContain(`Script (sha256 ${digest}):`);
    expect(details.prompt).toContain("return 'approved-v1';");
    expect(details.hideAlwaysAllow).toBeFalsy();
    expect(details.permissionRules).toHaveLength(1);

    const rule = details.permissionRules![0];
    const matches = (params: Record<string, unknown>) =>
      grantMatches(rule, config, params);
    expect(rule).toMatch(
      new RegExp(`\\(name:nightly-audit,sha256:${digest}\\)$`),
    );
    expect(await matches({ name: 'nightly-audit' })).toBe(true);
    await saveWorkflow('other-audit', APPROVED);
    expect(await matches({ name: 'other-audit' })).toBe(false);
    await saveWorkflow('nightly-audit', APPROVED.replace('v1', 'v2'));
    expect(await matches({ name: 'nightly-audit' })).toBe(false);
    expect(await matches({ name: 'nightly-audit', sha256: digest })).toBe(
      false,
    );
  });

  it('shows the structure of the script it loaded', async () => {
    await saveWorkflow(
      'nightly-audit',
      `${APPROVED}await parallel([() => agent('audit src'), () => agent('audit docs')]);\n`,
    );
    const details = await confirmOf(
      await checkedByName('nightly-audit', nameConfig()),
    );
    expect(details.prompt).toContain(
      '  parallel, 2 agent() call sites — "audit src", "audit docs"',
    );
  });

  it('hands back a resume call by name in a name-only session', async () => {
    await saveWorkflow('nightly-audit', APPROVED);
    for (const nameOnly of [true, false]) {
      const invocation = await checkedByName(
        'nightly-audit',
        nameConfig(nameOnly),
      );
      const result = await invocation.execute(live());
      const trailer = texts(result).join('\n');
      if (nameOnly) {
        expect(trailer).toMatch(
          /resume: Workflow\(\{ name: "nightly-audit", resumeFromRunId: "wf_[0-9a-f]+" \}\)/,
        );
        expect(trailer).not.toContain('resume: Workflow({ scriptPath');
      } else {
        expect(trailer).toContain(
          `resume: Workflow({ scriptPath: ${JSON.stringify(result.scriptPath)}, resumeFromRunId: "`,
        );
      }
    }
  });

  // The run executes the approved read, but a resume would look the name up
  // again. When the name no longer leads back to that script, the trailer
  // must not offer it.
  it('offers no resume by name once the name stops leading to the script that ran', async () => {
    const scriptPath = await saveWorkflow('nightly-audit', APPROVED);
    const invocation = await checkedByName('nightly-audit', nameConfig(true));
    await fs.rm(scriptPath);

    const trailer = texts(await invocation.execute(live())).join('\n');
    expect(trailer).toContain('approved-v1');
    expect(trailer).toContain('runId: wf_');
    expect(trailer).not.toContain('resume:');
  });

  // The lock reaches a nested call only when the model started the run.
  it('refuses a nested workflow({scriptPath}) in a run the model started by name', async () => {
    const inner = await saveWorkflow('inner', "return 'inner-ran';");
    await saveWorkflow(
      'outer',
      `return await workflow({ scriptPath: ${JSON.stringify(inner)} });`,
    );
    for (const nameOnly of [true, false]) {
      const invocation = await checkedByName('outer', nameConfig(nameOnly));
      const text = JSON.stringify(
        (await invocation.execute(live())).llmContent,
      );
      if (nameOnly) {
        expect(text).toContain(
          'this session restricts workflows to named workflows',
        );
        expect(text).not.toContain('inner-ran');
      } else {
        expect(text).toContain('inner-ran');
      }
    }
  });

  it('runs the content that was approved, not a later edit', async () => {
    await saveWorkflow('nightly-audit', APPROVED);
    const invocation = await checkedByName('nightly-audit', nameConfig());
    await invocation.getConfirmationDetails(live());

    await saveWorkflow(
      'nightly-audit',
      APPROVED.replace('approved-v1', 'edited-v2'),
    );
    const result = await invocation.execute(live());

    const text = JSON.stringify(result.llmContent);
    expect(result.error).toBeUndefined();
    expect(text).toContain('approved-v1');
    expect(text).not.toContain('edited-v2');
  });

  // A typo should come back to the model with the names it can use, not as
  // an approval prompt for a run that cannot start.
  it('fails an unknown name without asking and never retries the lookup', async () => {
    await saveWorkflow('nightly-audit', APPROVED);
    const invocation = new WorkflowTool(nameConfig()).build({
      name: 'nightly-audti',
    });

    expect(await invocation.getDefaultPermission()).toBe('allow');
    const details = await confirmOf(invocation);
    expect(details.prompt).toContain('Cannot load the script:');
    expect(details.hideAlwaysAllow).toBe(true);
    expect(details.permissionRules).toEqual([]);

    // A file that appears after the check must not run unapproved.
    await saveWorkflow('nightly-audti', APPROVED);
    await expect(invocation.execute(live())).rejects.toThrow(
      /no workflow with that name\. Available: .*nightly-audit/,
    );
  });
});
