/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowTool } from './workflow.js';
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
import { matchesRule, parseRule } from '../../permissions/rule-parser.js';

function fakeConfig(): Config {
  return {} as unknown as Config;
}

/**
 * P4b Round 5 (wenshao): the registry integration path inside
 * `WorkflowTool.execute()` (register → emitter → complete/fail/cancel)
 * is not exercised by `fakeConfig()` because optional chaining short-
 * circuits the missing `getWorkflowRunRegistry()` method. This helper
 * builds a config with a real `WorkflowRunRegistry` and returns the
 * registry handle so tests can inspect post-run state.
 */
function configWithRegistry(): {
  config: Config;
  registry: WorkflowRunRegistry;
} {
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
  } as unknown as Config;
  return { config, registry };
}

/**
 * The scriptPath approval/description surface classifies the path against
 * the generated-scripts root, so it needs a config with a real `storage`.
 * The `storage` handle comes back too — the label tests derive their
 * expected roots from it (same shape as {@link configWithRegistry}).
 */
function configWithStorage(): { config: Config; storage: Storage } {
  const storage = new Storage(path.join(os.tmpdir(), 'workflow-label-test'));
  return { config: { storage } as unknown as Config, storage };
}

describe('WorkflowTool', () => {
  it('has the registered name and display name', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(tool.name).toBe(ToolNames.WORKFLOW);
    expect(tool.displayName).toBe(ToolDisplayNames.WORKFLOW);
    const schema = tool.schema.parametersJsonSchema as {
      properties: {
        run_in_background: { default?: boolean; description?: string };
      };
    };
    expect(schema.properties.run_in_background.default).toBe(false);
    expect(schema.properties.run_in_background.description).toContain(
      'cooperatively pause/resume',
    );
  });

  // The description is what makes the model pick pipeline() over a barrier
  // and verify a finding before reporting it. A refactor that drops the
  // policy prose leaves a runtime nobody drives well, and no other test
  // would notice — so anchor the load-bearing claims.
  it('description carries both the runtime facts and the orchestration policy', () => {
    const { description } = new WorkflowTool(fakeConfig());
    // Every env knob the description names is anchored. The four that the
    // orchestrator exports are anchored *through the exported constant*, so
    // a rename on the runtime side fails here too — a hardcoded literal
    // would only have caught a description-side typo, and the model would
    // go on telling users to set a variable nothing reads.
    // `QWEN_CODE_MAX_WORKFLOW_SECONDS` has no exported constant
    // (`workflow-sandbox.ts` reads it inline), so it stays a literal.
    for (const anchor of [
      'min(16, cpus-2)',
      MAX_WORKFLOW_AGENTS_ENV,
      MAX_WORKFLOW_CONCURRENCY_ENV,
      WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
      WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
      'QWEN_CODE_MAX_WORKFLOW_SECONDS',
      'resumeFromRunId',
      '/workflows',
      'node:vm sandbox',
    ]) {
      expect(description).toContain(anchor);
    }
    // The per-call options this half of the description advertises are
    // anchored too — a refactor that drops their sentences leaves the
    // capabilities undiscoverable from the tool surface and no other test
    // would notice.
    expect(description).toContain('workingDir');
    expect(description).toMatch(/no-progress stall watchdog/);
    // One anchor per policy section — dropping any whole section has to
    // turn this test red, which is the regression it exists to catch.
    expect(description).toMatch(/Parallelism on its own is not a reason/);
    expect(description).toMatch(/only before the orchestration step/);
    expect(description).toMatch(/Common single-phase shapes/);
    expect(description).toMatch(/Default to `pipeline\(\)`/);
    expect(description).toMatch(/A barrier is right only when/);
    expect(description).toMatch(/refute/);
    expect(description).toMatch(/against everything already seen/);
    expect(description).toMatch(/log\(\)` what was dropped/);
    // Limits the model has to plan around rather than discover from a
    // mid-run failure — the numbers themselves, not just the knob names.
    // Anchored *through* the exported constant rather than as a literal:
    // the description interpolates `DEFAULT_MAX_AGENTS_PER_RUN`, so this
    // tracks a raised cap automatically, and a regression that pastes the
    // number back in as prose goes red the next time the constant moves.
    expect(description).toContain(
      `up to ${DEFAULT_MAX_AGENTS_PER_RUN} agents total`,
    );
    // `DEFAULT_MAX_WALL_CLOCK_MS` is private to `workflow-sandbox.ts`, so
    // this one is still a hand-synced literal on both sides.
    expect(description).toMatch(/30-minute wall-clock cap/);
    expect(description).toMatch(/nests one level only/);
    expect(description).toMatch(/read `budget\.total`/);
    // The `/workflows` capability list is the one part of the description
    // that trails the runtime: #8320 added cooperative pause/resume to the
    // dialog while this branch was moving the description into a constant,
    // and the base merge conflicted exactly here. Nothing else asserts the
    // control set, so dropping one on the next merge would be silent.
    expect(description).toMatch(/cooperative pause\/resume/);
    // #8690 asked the text to speak this project's own vocabulary. Without
    // a location, "runs a saved workflow" leaves the model no way to reach
    // one: `workflow('<name>')` is a blind guess and `scriptPath` wants an
    // absolute path it cannot construct.
    expect(description).toContain('.qwen/workflows');
  });

  // The policy prose above tells the model how to orchestrate *well*; on its
  // own it reads as encouragement, and the model fans out on tasks nobody
  // asked to spend a fleet on. This gate is the half that says when not to.
  it('description gates the tool on an explicit user request', () => {
    const { description } = new WorkflowTool(fakeConfig());

    // Ordering is the point, not just presence: a gate placed after the
    // "what a workflow is for" pitch reads as a footnote to it. It has to
    // come first, so it frames everything below rather than qualifying it.
    const gate = description.indexOf('**Only on an explicit request**');
    const pitch = description.indexOf('**What a workflow is for**');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(pitch);

    // Each enumerated form is a real qwen trigger. Without the list the gate
    // is unfalsifiable from the model's side — it cannot tell whether the
    // request in front of it qualifies.
    expect(description).toContain(
      'It counts as requested when any of these holds:',
    );
    expect(description).toMatch(/contains the word `workflow`/);
    expect(description).toMatch(/in their own words/);
    expect(description).toMatch(/skill or slash command/);
    expect(description).toMatch(/named a saved workflow/);
    expect(description).toMatch(/resume or continue an earlier run/);

    // Upstream's marker for this is `ultracode`, which does not exist here:
    // naming it would enumerate a trigger no qwen user can pull, and the
    // gate would refuse work that a real trigger should have allowed.
    expect(description).not.toMatch(/ultracode/i);

    // The load-bearing half of the gate. Without an offer-and-ask path the
    // model reads "do not call it" as "refuse", and a user who would have
    // said yes never gets asked. Over-blocking is this change's one real
    // failure mode, so the escape hatch is anchored.
    expect(description).toContain(
      'Do not call this tool unless the user has asked for multi-agent orchestration.',
    );
    expect(description).toContain(
      'Otherwise do not call it, however well the task would parallelize.',
    );
    expect(description).toMatch(/let the user decide/);
    expect(description).toMatch(/skips the ask/);

    // Interpolated, not pasted: the gate justifies itself with the fleet
    // size, so a raised cap has to move this sentence too.
    expect(description).toContain(
      `dispatch up to ${DEFAULT_MAX_AGENTS_PER_RUN} subagents`,
    );
  });

  // ── Approval dialog ────────────────────────────────────────────────────
  //
  // What the user is asked to approve is arbitrary model-authored JavaScript
  // that can fan out to the per-run agent cap, provision git worktrees and
  // spend an uncapped token budget. Before this the entire disclosure was
  // `Run a workflow script (N chars)`, and one click on "always allow"
  // persisted a rule matching every future invocation.
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

    async function detailsFor(
      params: Record<string, unknown>,
      config: Config = fakeConfig(),
    ) {
      const tool = new WorkflowTool(config);
      const invocation = tool.build(params as never);
      return await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
    }

    it('names the workflow, its purpose and its phases', async () => {
      const details = await detailsFor({ script: SCRIPT_WITH_META });
      expect(details.type).toBe('info');
      const info = details as { title: string; prompt: string };
      expect(info.title).toBe('Run a dynamic workflow?');
      expect(info.prompt).toContain('audit-deps');
      expect(info.prompt).toContain('Audit dependencies for CVEs');
      expect(info.prompt).toContain('1. Scan');
      expect(info.prompt).toContain('one agent per manifest');
      expect(info.prompt).toContain('2. Verify');
    });

    // The load-bearing failure mode. Reading meta happens on the approval
    // path now, and `extractAndStripMeta` throws on a malformed literal. A
    // script with a broken meta block must stay approvable-or-rejectable:
    // if the dialog throws, the user cannot even say no.
    it('degrades instead of throwing when meta is malformed', async () => {
      const details = await detailsFor({
        script:
          'export const meta = { name: someIdentifier }\nawait agent("x")',
      });
      const info = details as { prompt: string };
      expect(info.prompt).toContain('declares no meta block');
      expect(info.prompt).toContain('await agent("x")');
    });

    it('renders a script that has no meta block at all', async () => {
      const details = await detailsFor({ script: 'await agent("hello")' });
      expect((details as { prompt: string }).prompt).toContain(
        'await agent("hello")',
      );
    });

    // Before this change nothing was displayed, so nothing could be spoofed.
    // A preview without the screen is what would open the hole: the text is
    // model-authored and reaches a terminal.
    it('strips escape sequences from everything it displays', async () => {
      const details = await detailsFor({
        script: [
          'export const meta = {',
          "  name: 'a\\u001b[31mred\\u001b[0m',",
          "  description: 'plain',",
          '}',
          "await agent('x\\u001b[2Jclear')",
        ].join('\n'),
      });
      const { prompt } = details as { prompt: string };
      expect(prompt).not.toContain('');
      expect(prompt).toContain('ared');
    });

    // `stripAnsiAndControl` removes C0 controls and `\n` is one of them, so
    // the naive call would collapse the excerpt into a single unreadable
    // line. Sanitizing per line is what keeps the script legible.
    it('keeps the script excerpt on multiple lines, and bounds it', async () => {
      const long = Array.from(
        { length: 400 },
        (_, i) => `await agent('step ${i}')`,
      ).join('\n');
      const { prompt } = (await detailsFor({ script: long })) as {
        prompt: string;
      };
      expect(prompt.split('\n').length).toBeGreaterThan(10);
      expect(prompt).toContain('more characters)');
      expect(prompt.length).toBeLessThan(long.length);
    });

    it('shows args, and survives args that cannot be serialized', async () => {
      const ok = (await detailsFor({
        script: 'await agent("x")',
        args: { target: 'packages/core' },
      })) as { prompt: string };
      expect(ok.prompt).toContain('packages/core');

      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      const bad = (await detailsFor({
        script: 'await agent("x")',
        args: circular,
      })) as { prompt: string };
      expect(bad.prompt).toContain('not JSON-serializable');
    });

    // An inline script is fresh model-authored source every time. A blanket
    // grant would transfer the consent the user gave to the script they read
    // onto every script the model writes afterwards.
    it('never lets an inline script be pre-approved', async () => {
      const details = (await detailsFor({ script: SCRIPT_WITH_META })) as {
        hideAlwaysAllow?: boolean;
        permissionRules?: string[];
      };
      expect(details.hideAlwaysAllow).toBe(true);
      // Empty, not absent: `injectPermissionRulesIfMissing` only fills in the
      // bare-tool-name rule when the tool supplies none, and that rule is
      // documented as matching every invocation of the tool.
      expect(details.permissionRules).toEqual([]);
    });

    it('scopes a saved-workflow grant to the path that was approved', async () => {
      const details = (await detailsFor(
        { scriptPath: '/home/u/.qwen/workflows/audit.js' },
        configWithStorage().config,
      )) as { hideAlwaysAllow?: boolean; permissionRules?: string[] };
      expect(details.hideAlwaysAllow).toBeFalsy();
      expect(details.permissionRules).toHaveLength(1);

      // Behavioural, not textual: a rule that reads plausibly but never
      // matches would make "always allow" silently do nothing, which is a
      // worse affordance than not offering it. Parse the rule the tool
      // emitted and check it resolves the same path and only that path.
      const rule = parseRule(details.permissionRules![0]);
      const wouldAllow = (toolParams: Record<string, unknown>) =>
        matchesRule(
          rule,
          ToolNames.WORKFLOW,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          toolParams,
        );
      expect(
        wouldAllow({ scriptPath: '/home/u/.qwen/workflows/audit.js' }),
      ).toBe(true);
      expect(
        wouldAllow({ scriptPath: '/home/u/.qwen/workflows/other.js' }),
      ).toBe(false);
      expect(wouldAllow({ script: 'await agent("x")' })).toBe(false);
    });

    // A generated-root script is a throwaway artifact a tool emitted for this
    // run. Labeling it as a saved workflow would have the user approve — and
    // maybe pre-approve the path rule — under a wrong identity.
    it('labels a generated-root scriptPath as a generated script, not a saved workflow', async () => {
      const { config, storage } = configWithStorage();
      const scriptPath = path.join(
        storage.getGeneratedWorkflowsDir(),
        'fanout-1a2b3c.js',
      );
      const tool = new WorkflowTool(config);
      expect(tool.build({ scriptPath }).getDescription()).toBe(
        'Run generated workflow script (fanout-1a2b3c.js)',
      );
      const details = (await detailsFor({ scriptPath }, config)) as {
        prompt: string;
      };
      expect(details.prompt).toContain(
        `Generated workflow script: ${scriptPath}`,
      );
      expect(details.prompt).not.toContain('Saved workflow');
    });

    it('keeps the saved-workflow label for a saved-root scriptPath', async () => {
      const { config, storage } = configWithStorage();
      const scriptPath = path.join(
        storage.getProjectWorkflowsDir(),
        'deep-research.js',
      );
      const tool = new WorkflowTool(config);
      expect(tool.build({ scriptPath }).getDescription()).toBe(
        'Run saved workflow (deep-research.js)',
      );
      const details = (await detailsFor({ scriptPath }, config)) as {
        prompt: string;
      };
      expect(details.prompt).toContain(`Saved workflow: ${scriptPath}`);
    });

    // The loader canonicalizes `scriptPath` with realpath, so a `..`-laced
    // path can load a file far from its raw spelling. Classifying the raw
    // string would show the opposite identity from what actually loads.
    it('classifies a ..-laced scriptPath by its normalized location', async () => {
      const { config, storage } = configWithStorage();
      // Raw string sits inside the generated root; the `..` segments climb
      // out of it, so the normalized path is no longer under the root.
      const scriptPath = [
        storage.getGeneratedWorkflowsDir(),
        '..',
        '..',
        '..',
        '..',
        'workflows',
        'audit.js',
      ].join(path.sep);
      const tool = new WorkflowTool(config);
      expect(tool.build({ scriptPath }).getDescription()).toBe(
        'Run saved workflow (audit.js)',
      );
      const details = (await detailsFor({ scriptPath }, config)) as {
        prompt: string;
      };
      expect(details.prompt).toContain(`Saved workflow: ${scriptPath}`);
    });

    // The loader trusts the whole subtree under the generated root (writers
    // nest per session), so the label must follow nested scripts too, not
    // just files sitting directly under the root.
    it('labels a nested generated-root scriptPath as a generated script', async () => {
      const { config, storage } = configWithStorage();
      const scriptPath = path.join(
        storage.getGeneratedWorkflowsDir(),
        's-abc',
        'fanout.js',
      );
      const tool = new WorkflowTool(config);
      expect(tool.build({ scriptPath }).getDescription()).toBe(
        'Run generated workflow script (fanout.js)',
      );
      const details = (await detailsFor({ scriptPath }, config)) as {
        prompt: string;
      };
      expect(details.prompt).toContain(
        `Generated workflow script: ${scriptPath}`,
      );
      expect(details.prompt).not.toContain('Saved workflow');
    });

    // The loader decides loadability with `fs.realpath`, so a scriptPath
    // whose spelling diverges from its realpath (a symlink crossing roots)
    // must be labeled by the content that actually loads — classifying the
    // raw string shows the opposite identity from what runs.
    it('labels a symlinked scriptPath by the content that loads', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-lbl-'));
      const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-lbl-rt-'));
      try {
        const storage = new Storage(projectDir, runtimeDir);
        const config = { storage } as unknown as Config;
        const generatedDir = storage.getGeneratedWorkflowsDir();
        const savedDir = storage.getProjectWorkflowsDir();
        await fs.mkdir(generatedDir, { recursive: true });
        await fs.mkdir(savedDir, { recursive: true });

        // A generated-spelled link whose realpath is a saved workflow.
        await fs.writeFile(path.join(savedDir, 'deploy.js'), 'return 1;');
        const generatedSpelling = path.join(generatedDir, 'run.js');
        await fs.symlink(path.join(savedDir, 'deploy.js'), generatedSpelling);

        // A saved-spelled link whose realpath is a generated script.
        const nested = path.join(generatedDir, 's-abc');
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(nested, 'throwaway.js'), 'return 1;');
        const savedSpelling = path.join(savedDir, 'toolgen.js');
        await fs.symlink(path.join(nested, 'throwaway.js'), savedSpelling);

        const savedLoaded = (await detailsFor(
          { scriptPath: generatedSpelling },
          config,
        )) as { prompt: string };
        expect(savedLoaded.prompt).toContain(
          `Saved workflow: ${generatedSpelling}`,
        );
        expect(savedLoaded.prompt).not.toContain('Generated workflow script');

        const generatedLoaded = (await detailsFor(
          { scriptPath: savedSpelling },
          config,
        )) as { prompt: string };
        expect(generatedLoaded.prompt).toContain(
          `Generated workflow script: ${savedSpelling}`,
        );
        expect(generatedLoaded.prompt).not.toContain('Saved workflow');
      } finally {
        await fs.rm(projectDir, { recursive: true, force: true });
        await fs.rm(runtimeDir, { recursive: true, force: true });
      }
    });

    // The loader refuses a symlinked generated-scripts root outright, so the
    // dialog must not claim a generated identity for a path under one — the
    // content it appears to name will not load as a generated script.
    it('labels nothing generated through a symlinked generated root', async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-lbl-'));
      const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-lbl-rt-'));
      const external = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-lbl-ext-'));
      try {
        const storage = new Storage(projectDir, runtimeDir);
        const config = { storage } as unknown as Config;
        const generatedDir = storage.getGeneratedWorkflowsDir();
        await fs.mkdir(path.dirname(generatedDir), { recursive: true });
        await fs.writeFile(path.join(external, 'leak.js'), 'return 1;');
        await fs.symlink(external, generatedDir, 'dir');
        const scriptPath = path.join(generatedDir, 'leak.js');

        const details = (await detailsFor({ scriptPath }, config)) as {
          prompt: string;
        };
        expect(details.prompt).toContain(`Saved workflow: ${scriptPath}`);
        expect(details.prompt).not.toContain('Generated workflow script');
      } finally {
        await fs.rm(projectDir, { recursive: true, force: true });
        await fs.rm(runtimeDir, { recursive: true, force: true });
        await fs.rm(external, { recursive: true, force: true });
      }
    });

    // The cost warning used to arrive only after a successful run — i.e.
    // after the spend it warns about, and never at all on the failure path.
    it('warns about token cost before the spend, exactly once', async () => {
      const { config } = configWithRegistry();
      const first = (await detailsFor(
        { script: 'await agent("x")' },
        config,
      )) as { prompt: string };
      expect(first.prompt).toContain(MAX_TOKENS_PER_WORKFLOW_ENV);

      // The registry latch flips on read, so the second dialog is quiet and
      // the post-hoc copy on the result path suppresses itself too.
      const second = (await detailsFor(
        { script: 'await agent("y")' },
        config,
      )) as { prompt: string };
      expect(second.prompt).not.toContain(MAX_TOKENS_PER_WORKFLOW_ENV);
    });

    it('titles the transcript row with the workflow name', () => {
      const tool = new WorkflowTool(fakeConfig());
      expect(
        tool.build({ script: SCRIPT_WITH_META } as never).getDescription(),
      ).toBe('Run workflow: audit-deps');
      // Falls back to the character count only when there is no meta to read.
      expect(
        tool.build({ script: 'await agent("x")' } as never).getDescription(),
      ).toContain('chars)');
    });
  });

  // A script that never compiled has no run behind it. Reporting it as a
  // failed workflow sends the model looking for a runId that was never
  // minted, and reads as "the orchestration broke" when the real problem is
  // a typo it can fix and re-send.
  it('reports an uncompilable script as not launched, not as a failure', async () => {
    const { config } = configWithRegistry();
    const tool = new WorkflowTool(config);
    const result = await tool
      .build({ script: "const x: string = 'a';\nawait agent(x);" } as never)
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    const text = JSON.stringify(result.llmContent);
    expect(text).toContain('was not launched');
    expect(text).toContain('plain JavaScript');
    // No run happened, so there is no run id to hand back.
    expect(result.workflowRunId).toBeUndefined();
    expect(text).not.toContain('Workflow failed');
  });

  // The tool description is not the only model-visible copy of the caps —
  // the `script` parameter description states them a second time, and a
  // model reading one tool call sees both. Anchoring only the tool
  // description lets a maintainer raise a cap, watch the test above go
  // green again, and stop while `script` still advertises the old number.
  it('script parameter description states the same caps as the tool description', () => {
    const tool = new WorkflowTool(fakeConfig());
    const schema = tool.schema.parametersJsonSchema as {
      properties: { script: { description: string } };
    };
    const scriptDescription = schema.properties.script.description;
    expect(scriptDescription).toContain(
      `At most ${DEFAULT_MAX_AGENTS_PER_RUN} agent() calls per run`,
    );
    expect(scriptDescription).toContain(MAX_WORKFLOW_AGENTS_ENV);
    expect(scriptDescription).toContain(MAX_WORKFLOW_CONCURRENCY_ENV);
    // Both halves must agree on the agent cap, whatever it is.
    expect(tool.description).toContain(
      `${DEFAULT_MAX_AGENTS_PER_RUN} agents total`,
    );
  });

  it('rejects build() when script is missing', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() => tool.build({} as never)).toThrow(/script/);
  });

  it('rejects build() when script is empty string', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() => tool.build({ script: '' })).toThrow(/script/);
  });

  // ── P7b-A1: saved-workflow scriptPath path ──────────────────────────────

  it('rejects build() when both script and scriptPath are given', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() =>
      tool.build({ script: 'return 1', scriptPath: '/x/y.js' }),
    ).toThrow(/exactly one/);
  });

  it('rejects build() when resumeFromRunId is not a wf_<hex> id (path-traversal guard)', () => {
    const tool = new WorkflowTool(fakeConfig());
    expect(() =>
      tool.build({ script: 'return 1', resumeFromRunId: '../../etc/evil' }),
    ).toThrow(/resumeFromRunId/);
    // A well-formed generated id is accepted.
    expect(() =>
      tool.build({
        script: 'return 1',
        resumeFromRunId: 'wf_1a2b3c4d5e6f7081',
      }),
    ).not.toThrow();
  });

  it('build() accepts a scriptPath without inline script', () => {
    const tool = new WorkflowTool(configWithStorage().config);
    const invocation = tool.build({
      scriptPath: '/abs/deep-research.js',
    });
    expect(invocation.params.scriptPath).toBe('/abs/deep-research.js');
    // Description reflects the saved-workflow filename, not a char count.
    expect(invocation.getDescription()).toContain('deep-research.js');
  });

  it('rejects background runs outside an interactive completion channel', () => {
    const headlessRegistry = new WorkflowRunRegistry();
    headlessRegistry.setCompletionCallback(vi.fn());
    const headlessConfig = {
      isInteractive: () => false,
      getWorkflowRunRegistry: () => headlessRegistry,
    } as unknown as Config;
    expect(() =>
      new WorkflowTool(headlessConfig).build({
        script: 'return 1',
        run_in_background: true,
      }),
    ).toThrow(/interactive TUI/i);

    const interactiveRegistry = new WorkflowRunRegistry();
    const interactiveConfig = {
      isInteractive: () => true,
      getWorkflowRunRegistry: () => interactiveRegistry,
    } as unknown as Config;
    expect(() =>
      new WorkflowTool(interactiveConfig).build({
        script: 'return 1',
        run_in_background: true,
      }),
    ).toThrow(/completion channel/i);
    expect(() =>
      new WorkflowTool(interactiveConfig).buildSessionOwnedBackground({
        script: 'return 1',
      }),
    ).toThrow(/completion channel/i);

    interactiveRegistry.setCompletionCallback(vi.fn());
    const acpConfig = {
      isInteractive: () => true,
      getExperimentalZedIntegration: () => true,
      getWorkflowRunRegistry: () => interactiveRegistry,
    } as unknown as Config;
    expect(() =>
      new WorkflowTool(acpConfig).build({
        script: 'return 1',
        run_in_background: true,
      }),
    ).toThrow(/interactive TUI/i);
  });

  it('starts a session-owned background run outside the interactive TUI', async () => {
    const registry = new WorkflowRunRegistry();
    registry.setCompletionCallback(vi.fn());
    const config = {
      storage: new Storage(path.join(os.tmpdir(), 'workflow-session-owned')),
      isInteractive: () => false,
      getWorkflowRunRegistry: () => registry,
      getSkipWorkflowUsageWarning: () => true,
    } as unknown as Config;

    const result = await new WorkflowTool(config, {
      dispatch: async () => 'unused',
    })
      .buildSessionOwnedBackground({
        script: `phase('Inspect'); return { status: 'ready' };`,
      })
      .execute(new AbortController().signal);

    expect(result.workflowRunId).toMatch(/^wf_[0-9a-f]+$/);
    const run = registry.get(result.workflowRunId!);
    expect(run?.isBackgrounded).toBe(true);
    await vi.waitFor(() =>
      expect(registry.get(result.workflowRunId!)?.status).toBe('completed'),
    );
  });

  it('does not register a background run when the caller is already aborted', async () => {
    const registry = new WorkflowRunRegistry();
    registry.setCompletionCallback(vi.fn());
    const config = {
      isInteractive: () => true,
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    const dispatch = vi.fn(async () => 'unused');
    const caller = new AbortController();
    caller.abort();

    const result = await new WorkflowTool(config, { dispatch })
      .build({ script: 'return 1', run_in_background: true })
      .execute(caller.signal);

    expect(result).toEqual({
      llmContent: 'Workflow was cancelled before it could start.',
      returnDisplay: 'Workflow cancelled.',
      aborted: true,
    });
    expect(registry.list()).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports a registry-side cancel during background preflight as cancelled, not failed', async () => {
    // `sessionTaskCancel` on a run that is still loading aborts the run's
    // own controller via `cancelStarting`; the caller's signal stays live,
    // so the catch cannot recognise the outcome from `signal.aborted`.
    const registry = new WorkflowRunRegistry();
    registry.setCompletionCallback(vi.fn());
    const config = {
      storage: new Storage(path.join(os.tmpdir(), 'workflow-preflight-test')),
      isInteractive: () => true,
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    const caller = new AbortController();
    const dispatch = vi.fn(async () => 'unused');
    const load = vi
      .spyOn(WorkflowJournal.prototype, 'load')
      .mockImplementation(async () => {
        expect(registry.cancelStarting('wf_1234abcd')).toBe(true);
        return { results: new Map(), started: new Map() };
      });

    try {
      const result = await new WorkflowTool(config, { dispatch })
        .build({
          script: 'return 1',
          resumeFromRunId: 'wf_1234abcd',
          run_in_background: true,
        })
        .execute(caller.signal);

      expect(caller.signal.aborted).toBe(false);
      expect(result).toEqual({
        llmContent: 'Workflow was cancelled before it could start.',
        returnDisplay: 'Workflow cancelled.',
      });
      expect(registry.list()).toHaveLength(0);
      expect(registry.isStarting('wf_1234abcd')).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it('reports a registry-side cancel during foreground preflight as cancelled, not failed', async () => {
    // The foreground path is the tool's default mode, and the same
    // registry-side sources reach it: `sessionTaskCancel` fires
    // `cancelStarting` on a resume whose terminal entry was evicted from
    // the registry, and `abortAll` on session dispose. Registering anyway
    // let the settlement classifier — blind to the run's own controller —
    // settle the run `completed` for this dispatch-free script.
    const registry = new WorkflowRunRegistry();
    registry.setCompletionCallback(vi.fn());
    const config = {
      storage: new Storage(path.join(os.tmpdir(), 'workflow-preflight-test')),
      isInteractive: () => true,
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    const caller = new AbortController();
    const dispatch = vi.fn(async () => 'unused');
    const load = vi
      .spyOn(WorkflowJournal.prototype, 'load')
      .mockImplementation(async () => {
        expect(registry.cancelStarting('wf_1234abcd')).toBe(true);
        return { results: new Map(), started: new Map() };
      });

    try {
      const result = await new WorkflowTool(config, { dispatch })
        .build({
          script: 'return 1',
          resumeFromRunId: 'wf_1234abcd',
        })
        .execute(caller.signal);

      expect(caller.signal.aborted).toBe(false);
      expect(result).toEqual({
        llmContent: 'Workflow was cancelled before it could start.',
        returnDisplay: 'Workflow cancelled.',
      });
      expect(registry.list()).toHaveLength(0);
      expect(registry.isStarting('wf_1234abcd')).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it('does not register when cancellation arrives during background preflight', async () => {
    const registry = new WorkflowRunRegistry();
    registry.setCompletionCallback(vi.fn());
    const config = {
      storage: new Storage(path.join(os.tmpdir(), 'workflow-preflight-test')),
      isInteractive: () => true,
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    const caller = new AbortController();
    const dispatch = vi.fn(async () => 'unused');
    const load = vi
      .spyOn(WorkflowJournal.prototype, 'load')
      .mockImplementation(async () => {
        caller.abort();
        return { results: new Map(), started: new Map() };
      });

    try {
      const result = await new WorkflowTool(config, { dispatch })
        .build({
          script: 'return 1',
          resumeFromRunId: 'wf_1234abcd',
          run_in_background: true,
        })
        .execute(caller.signal);

      expect(result).toEqual({
        llmContent: 'Workflow was cancelled before it could start.',
        returnDisplay: 'Workflow cancelled.',
        aborted: true,
      });
      expect(registry.list()).toHaveLength(0);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it('run_in_background=true returns a live handle without late tool updates', async () => {
    const registry = new WorkflowRunRegistry();
    registry.setCompletionCallback(vi.fn());
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
    const updateOutput = vi.fn();
    const invocation = tool.build({
      script: `phase('slow'); return await agent('work');`,
      run_in_background: true,
    });
    (
      invocation as unknown as { setCallId: (callId: string) => void }
    ).setCallId('workflow-tool-call');
    const execution = invocation.execute(
      new AbortController().signal,
      updateOutput,
    );

    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    const result = await execution;
    const entry = registry.list()[0]!;
    expect(entry.status).toBe('running');
    expect(entry.isBackgrounded).toBe(true);
    expect(entry.toolUseId).toBe('workflow-tool-call');
    expect(result.workflowRunId).toBe(entry.runId);
    expect(result.llmContent).toEqual([
      {
        text: `Workflow started in background.\nRun ID: ${entry.runId}\nStatus: running`,
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

  it('run_in_background=false preserves the foreground ToolResult byte-for-byte', async () => {
    const run = async (runInBackground: false | undefined) => {
      const registry = new WorkflowRunRegistry();
      const config = {
        getWorkflowRunRegistry: () => registry,
        getSkipWorkflowUsageWarning: () => true,
      } as unknown as Config;
      const params = {
        script: `phase('one'); return { answer: 42 };`,
        resumeFromRunId: 'wf_1234abcd',
        ...(runInBackground === undefined
          ? {}
          : { run_in_background: runInBackground }),
      };
      return new WorkflowTool(config, { dispatch: async () => 'unused' })
        .build(params)
        .execute(new AbortController().signal);
    };

    await expect(run(false)).resolves.toEqual(await run(undefined));
  });

  // A headless run (`qwen --prompt`, CI, a cron job) has no TUI, no approval
  // bridge, and a closed stdin. `getDefaultPermission()` is 'ask', which the
  // scheduler resolves against the run's approval mode — but nothing INSIDE
  // the tool or the runner may reach for interactivity, or the foreground
  // call would hang forever on a prompt no one can answer. This is the
  // regression test for that contract; the background half is already
  // refused explicitly (see the interactive-TUI guard above).
  it('foreground execute() completes with no interactive session or completion channel', async () => {
    const registry = new WorkflowRunRegistry();
    const config = {
      isInteractive: () => false,
      getWorkflowRunRegistry: () => registry,
      getSkipWorkflowUsageWarning: () => true,
    } as unknown as Config;
    expect(registry.hasCompletionCallback()).toBe(false);

    const result = await new WorkflowTool(config, {
      dispatch: async (prompt) => `answered:${prompt}`,
    })
      .build({ script: `return await agent('what is it');` })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.llmContent)).toContain('answered:what is it');
  });

  it('execute() loads a saved-workflow scriptPath and records its provenance', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tool-'));
    try {
      const registry = new WorkflowRunRegistry();
      const config = {
        getWorkflowRunRegistry: () => registry,
        storage: new Storage(projectDir),
      } as unknown as Config;
      // The scriptPath MUST live under a saved-workflow dir (the resolver
      // refuses paths outside it — the #2 path-traversal / symlink guard).
      const dir = new Storage(projectDir).getProjectWorkflowsDir();
      await fs.mkdir(dir, { recursive: true });
      const scriptPath = path.join(dir, 'greet.js');
      await fs.writeFile(scriptPath, 'return await agent("hi");', 'utf8');
      const tool = new WorkflowTool(config, {
        dispatch: async (prompt) => `T:${prompt}`,
      });
      const invocation = tool.build({ scriptPath });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.llmContent)).toContain('T:hi');
      // The registry entry carries the resolved absolute path (run provenance
      // for the snapshot writer).
      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].scriptPath).toBe(scriptPath);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('build() returns an invocation that exposes the script as description', () => {
    const tool = new WorkflowTool(fakeConfig());
    const invocation = tool.build({
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
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async (prompt) => `T:${prompt}`,
    });
    const invocation = tool.build({
      script: `phase("plan");
               const r = await agent("write hello", { label: "h1" });
               return r;`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const text = JSON.stringify(result.llmContent);
    expect(text).toContain('T:write hello');
    // FIX-7: llmContent now contains just the result, not the full JSON wrapper.
    // The runId should NOT appear in llmContent when the result is a plain string.
    // (It does appear in returnDisplay, which we don't test here.)
    expect(JSON.stringify(result.returnDisplay)).toMatch(/wf_[0-9a-f]{16}/);
  });

  // P2 (PR #4732): parallel() runs end-to-end through the full stack
  // (WorkflowTool → orchestrator counter+limiter+parallelImpl → sandbox
  // in-realm revival → script return → safeStringifyResult).
  it('execute() runs parallel() end-to-end and returns the revived array', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async (prompt) => `T:${prompt}`,
    });
    const invocation = tool.build({
      script: `return await parallel([() => agent("a"), () => agent("b")]);`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual(['T:a', 'T:b']);
  });

  // P3 (PR #5xxx): schema mode end-to-end through WorkflowTool. The
  // dispatch returns the validated structured payload as an object; the
  // sandbox revives it per-call into the vm realm; the script reads it
  // as a vm-realm object; safeStringifyResult JSON-stringifies it for the
  // LLM. A regression in any layer of that chain would surface here.
  it('execute() runs agent({schema}) end-to-end and returns the revived object', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async (prompt, opts) => {
        if (opts.schema !== undefined) {
          return { extracted: prompt.toUpperCase(), confidence: 0.9 };
        }
        return prompt;
      },
    });
    const invocation = tool.build({
      script:
        'const r = await agent("hello", { schema: { type: "object", properties: { extracted: { type: "string" } } } }); return r;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual({
      extracted: 'HELLO',
      confidence: 0.9,
    });
  });

  // PR #4947 R2 T8 (qwen-code-ci-bot): pipeline() through WorkflowTool
  // exercises a vm wrapper path that is structurally distinct from parallel's
  // single-argument call — pipeline uses `callPipeline.apply(null, arguments)`
  // and `[items].concat(stages)` to spread the variadic stage list
  // (workflow-sandbox.ts pipeline wrapper). A regression in the vm-to-host
  // stage forwarding would not be caught by the parallel E2E test above.
  it('execute() runs pipeline() end-to-end and returns the revived array', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `return await pipeline([1, 2], (x) => x * 10, (x) => x + 1);`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    expect(JSON.parse(llmText)).toEqual([11, 21]);
  });

  // TST-C3: execute() should return an error result (not throw) when the script throws.
  it('execute() returns an error result when the script throws', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'throw new Error("scripted failure")',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('scripted failure');
    expect(JSON.stringify(result.llmContent)).toContain('Workflow failed');
    // T4 (PR #4732 R1): assert the machine-readable error type so a
    // refactor removing the field doesn't go uncaught.
    expect(result.error!.type).toBe('execution_failed');
  });

  // T19 (PR #4732 R1): phases / logs accumulated before a script failure
  // must be included in the user-visible display so debugging is possible.
  it('execute() includes phases + logs in returnDisplay when script fails', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `
        phase("plan");
        log("computing");
        phase("execute");
        log("about to fail");
        throw new Error("boom");
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    const display = String(result.returnDisplay);
    expect(display).toContain('Workflow failed: boom');
    expect(display).toContain('plan');
    expect(display).toContain('execute');
    expect(display).toContain('computing');
    expect(display).toContain('about to fail');
  });

  // T12 / T18 (PR #4732 R1): a script that returns a BigInt or a circular
  // value must not be reported as a workflow failure — the script ran fine,
  // only the post-processing JSON.stringify hit a limitation.
  it('execute() degrades gracefully on BigInt return values (success, not failure)', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'return 1n + 2n;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toMatch(/non-JSON-serializable value of type bigint/);
  });

  it('execute() degrades gracefully on circular return values', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'const a = {}; a.self = a; return a;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toMatch(/non-JSON-serializable value of type object/);
  });

  // T30 (PR #4732 R3): sibling drift of the R1 T12/T18 fix. llmContent
  // already degrades per-field on non-serializable result, but the
  // returnDisplay payload (runId + phases + logs + result) used to be
  // wrapped in a single JSON.stringify — one bad `result` collapsed the
  // entire display to "(display payload not JSON-serializable)", losing
  // the runId, the phases, AND the logs. safeStringifyDisplayPayload now
  // degrades per-field on the failure path so always-serializable
  // metadata survives regardless of which field went bad.
  it('execute() preserves runId/phases/logs in returnDisplay when result is non-JSON-serializable', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'phase("compute"); const a = {}; a.self = a; return a;',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const display = String(result.returnDisplay);
    // runId, the phase, and a result placeholder must all survive.
    expect(display).toMatch(/wf_[0-9a-f]{16}/);
    expect(display).toContain('compute');
    expect(display).toContain('non-JSON-serializable');
    // The atomic-failure fallback must NOT appear — that would mean the
    // whole display payload had thrown.
    expect(display).not.toContain('display payload not JSON-serializable');
  });

  // P4: execute() surfaces the extracted `export const meta = {...}` in
  // the returnDisplay payload so the user (and a future /workflows
  // listing) can see the workflow's name / description / phases.
  it('execute() surfaces meta in returnDisplay when the script declares it', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: `export const meta = { name: 'demo', description: 'demo workflow', phases: [{ title: 'plan' }] }
               return 1;`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const display = String(result.returnDisplay);
    expect(display).toContain('"meta"');
    expect(display).toContain('demo workflow');
    expect(display).toContain('"phases"');
  });

  it('execute() omits meta key from returnDisplay when the script has no declaration', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: 'return 1;',
    });
    const result = await invocation.execute(new AbortController().signal);
    const display = String(result.returnDisplay);
    expect(display).not.toContain('"meta"');
  });

  // P4: when the script body throws AFTER meta parsed, the meta is still
  // visible on the failure display via the WorkflowExecutionError.meta
  // field that the tool's catch block surfaces.
  it('execute() includes meta in failure returnDisplay when body throws', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: `export const meta = { name: 'fails', description: 'will throw' }
               throw new Error("body boom")`,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    const display = String(result.returnDisplay);
    expect(display).toContain('Workflow failed');
    expect(display).toContain('"fails"');
    expect(display).toContain('will throw');
  });

  // TST-C3: llmContent must be the unwrapped script return value (FIX-7).
  it('execute() strips the JSON wrapper from llmContent (script return is verbatim)', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: 'return { kind: "report", body: "hello" };',
    });
    const result = await invocation.execute(new AbortController().signal);
    const llmText = (result.llmContent as Array<{ text: string }>)[0].text;
    // The llmText should be the JSON of just the script's return value,
    // NOT a wrapper with {runId, result, phases, logs}.
    expect(JSON.parse(llmText)).toEqual({ kind: 'report', body: 'hello' });
  });

  // FIX-C9 (TST-M2): scripts without an explicit `return` resolve to
  // undefined. WorkflowTool surfaces a clear placeholder rather than the
  // literal string "undefined".
  // FIX-G (Round 4 test Minor): args threading through WorkflowTool.build()
  // → orchestrator.run() → sandbox. A regression where args is dropped
  // (e.g. forgetting to pass `args: this.params.args` to orchestrator.run)
  // would go uncaught.
  it('execute() threads params.args through to the sandbox args global', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: 'return args.who',
      args: { who: 'world' },
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toBe('world');
  });

  it('execute() handles scripts that return undefined (no explicit return)', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'ignored',
    });
    const invocation = tool.build({
      script: 'phase("noop"); /* no return */',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const llmText = (result.llmContent as Array<{ text: string }>)[0]!.text;
    expect(llmText).toBe('(workflow returned no value)');
  });

  // P4a adversarial review (MEDIUM): if a script's return value happens to
  // have the same shape as a WorkflowMeta declaration (`{ name, description,
  // phases }`), the safeStringifyDisplayPayload spread must NOT clobber the
  // top-level `meta` key with the result. Both must appear distinctly in
  // the display so the user can see the declared meta independently of
  // whatever the script happened to return.
  it('execute() display surfaces meta + meta-shaped result distinctly', async () => {
    const tool = new WorkflowTool(fakeConfig(), {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `
        export const meta = { name: 'declared', description: 'the declared meta' }
        return { name: 'returned', description: 'looks like meta but is the script result', phases: [{ title: 'X' }] }
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
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
    // Defensive: the literal text appearance of both names must be
    // distinct — a regression that merged them would still satisfy a
    // single-side toEqual on a shared object, so check the rendered
    // display contains both string literals at separate offsets.
    expect(display.indexOf('"declared"')).toBeGreaterThan(-1);
    expect(display.indexOf('"returned"')).toBeGreaterThan(-1);
    expect(display.indexOf('"declared"')).not.toBe(
      display.indexOf('"returned"'),
    );
  });

  // P4b Round 5 (wenshao): the registry integration seam — register on
  // execute() start, emitter wires the live state, complete on success,
  // fail on caught exception, cancel on signal.aborted — was completely
  // unexercised by tests using fakeConfig() (optional chaining short-
  // circuited the missing getWorkflowRunRegistry method, so every call
  // site resolved to undefined). These three tests pin the contract
  // against the actual WorkflowRunRegistry instance.

  it('execute() success path registers the run + mirrors meta/phases/result + transitions to completed', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, {
      dispatch: async () => 'mock-answer',
    });
    const invocation = tool.build({
      script: `
        export const meta = { name: 'demo', description: 'desc' }
        phase('Plan')
        phase('Build')
        const a = await agent('q1')
        return { a }
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
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
    const tool = new WorkflowTool(config, {
      dispatch: async () => 'unused',
    });
    const invocation = tool.build({
      script: `
        phase('Plan')
        throw new Error('intentional script body failure')
      `,
    });
    const result = await invocation.execute(new AbortController().signal);
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
    const tool = new WorkflowTool(config, {
      dispatch: async () => {
        throw new Error('aborted-by-signal');
      },
    });
    const invocation = tool.build({
      script: `
        phase('Plan')
        await agent('q1')
        return 1
      `,
    });
    const result = await invocation.execute(aborter.signal);
    expect(result.error).toBeDefined();

    const entries = registry.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The fail-vs-cancel branching at workflow.ts catch arm: when
    // signal.aborted is true at the moment of catch, the registry
    // records 'cancelled' so the dialog distinguishes user-initiated
    // stops from script bugs.
    expect(entry.status).toBe('cancelled');
    expect(entry.endTime).toBeDefined();
  });

  // P4 Round 7 (wenshao): end-to-end simulation of the dialog-cancel
  // race. The dialog's `cancelSelected` calls `registry.cancel()` which
  // flips status to 'cancelled' + aborts the registry entry's
  // controller (the same `dispatchController` the tool's catch arm
  // sees). Then the in-flight dispatch rejects, the catch arm runs,
  // and `setRecentLogs(runId, logs)` is called — pre-fix this was
  // rejected by the `status === 'running'` guard, so the cancelled
  // dialog row always showed an empty Logs section. Post-fix the
  // guard allows 'cancelled' too and the script's `log()` output
  // survives.
  //
  // This drives the EXACT production flow: real WorkflowTool +
  // real WorkflowRunRegistry + real sandbox emitting through the
  // real emitter wiring. The dialog itself isn't reachable in the
  // current TUI build (pre-existing pill-focus infra gap that
  // wenshao R7 noted is out of P4 scope), so this test stands in
  // for what a tmux dialog-cancel would assert.
  it('R7: dialog-cancel race during run — logs accumulated before cancel survive', async () => {
    const { config, registry } = configWithRegistry();
    // Controllable dispatch: hangs until the in-flight reject is
    // triggered externally (simulating the dialog cancel's abort
    // cascading through dispatchController into the dispatch).
    let dispatchInflight:
      | { reject: (err: Error) => void; prompt: string }
      | undefined;
    const dispatch = async (prompt: string): Promise<string> =>
      new Promise<string>((_resolve, reject) => {
        dispatchInflight = { reject, prompt };
      });

    const tool = new WorkflowTool(config, { dispatch });
    const invocation = tool.build({
      script: `
        phase('Plan');
        log('before agent dispatch');
        const a = await agent('q1');
        log('after agent: ' + a);
        return { a };
      `,
    });

    const outerSignal = new AbortController().signal;
    const executePromise = invocation.execute(outerSignal);

    // Wait for execute() to register the run and queue the dispatch.
    for (let i = 0; i < 200; i++) {
      if (registry.list().length > 0 && dispatchInflight) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(registry.list()).toHaveLength(1);
    const runId = registry.list()[0]!.runId;

    // Simulate the dialog cancel: flip status to 'cancelled' AND abort
    // the registry entry's controller. The dispatchController IS this
    // controller, so aborting it causes the dispatch to be cascaded.
    registry.cancel(runId, Date.now());
    expect(registry.get(runId)!.status).toBe('cancelled');

    // Cause the in-flight dispatch to reject (the production path: the
    // dispatchController abort propagates through the orchestrator's
    // limiter / countedDispatch to the test dispatch).
    dispatchInflight!.reject(new Error('aborted by dialog cancel'));

    // Tool's catch arm runs. With R7 fix the setRecentLogs call lands;
    // before R7 it was silently dropped because the guard rejected
    // 'cancelled'.
    const result = await executePromise;
    expect(result.error).toBeDefined();

    const final = registry.get(runId)!;
    expect(final.status).toBe('cancelled');
    // R7 fix verification: logs accumulated BEFORE the cancel are
    // preserved on the registry entry so the dialog's Logs section
    // is non-empty.
    expect(final.recentLogs.length).toBeGreaterThan(0);
    expect(
      final.recentLogs.some((l) => l.includes('before agent dispatch')),
    ).toBe(true);
  });

  // ── P5 T7: one-time usage warning banner ──────────────────────────────

  it('P5 T7: prepends the usage banner on the first run only', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, {
      dispatch: async () => 'ok',
    });

    const first = await tool
      .build({ script: 'return 1' })
      .execute(new AbortController().signal);
    expect(typeof first.returnDisplay).toBe('string');
    expect(first.returnDisplay as string).toMatch(
      /Workflows have no per-run token cap|Workflow token cap is/,
    );
    expect(first.returnDisplay as string).toMatch(/skipWorkflowUsageWarning/);
    // Second invocation: latch already flipped on the registry.
    const second = await tool
      .build({ script: 'return 2' })
      .execute(new AbortController().signal);
    expect(second.returnDisplay as string).not.toMatch(
      /skipWorkflowUsageWarning/,
    );

    // Sanity: the registry exposes both runs.
    expect(registry.list().length).toBe(2);
  });

  it('P5 T7: suppressed by skipWorkflowUsageWarning setting', async () => {
    const registry = new WorkflowRunRegistry();
    const config = {
      getWorkflowRunRegistry: () => registry,
      getSkipWorkflowUsageWarning: () => true,
    } as unknown as Config;
    const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
    const result = await tool
      .build({ script: 'return 1' })
      .execute(new AbortController().signal);
    expect(result.returnDisplay as string).not.toMatch(
      /skipWorkflowUsageWarning/,
    );
    // The latch SHOULD remain unflipped — settings suppression
    // bypasses the call so a later session that re-enables the
    // setting still gets its banner.
    expect(registry.shouldShowUsageWarning()).toBe(true);
  });

  // ── P5 T7 R1: failure-path latch + status='failed' contract ─────────

  it('P5 T7 R1: failure path does NOT emit banner or consume the latch', async () => {
    // Reason: coreToolScheduler overrides `returnDisplay` with
    // `error.message` whenever `result.error` is set. Emitting the
    // banner on the failure path would be invisible AND would
    // silently flip the latch — the next successful run would miss
    // the banner. The contract is: latch flips only when the banner
    // is actually rendered to the user (success path).
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
    const failed = await tool
      .build({ script: 'throw new Error("script-boom");' })
      .execute(new AbortController().signal);
    expect(failed.returnDisplay as string).not.toMatch(
      /skipWorkflowUsageWarning/,
    );
    expect(failed.returnDisplay as string).toMatch(/Workflow failed: /);
    // Latch unconsumed: a later successful run still gets the banner.
    expect(registry.shouldShowUsageWarning()).toBe(true);
    // Registry status contract: failed → 'failed', error preserved.
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.status).toBe('failed');
    expect(registry.list()[0]!.error).toMatch(/script-boom/);
  });

  it('P5 T7 R1: failed-then-succeeded → banner appears on the SUCCESS run', async () => {
    const { config, registry } = configWithRegistry();
    const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
    await tool
      .build({ script: 'throw new Error("first-fail");' })
      .execute(new AbortController().signal);
    const success = await tool
      .build({ script: 'return 1' })
      .execute(new AbortController().signal);
    expect(success.returnDisplay as string).toMatch(/skipWorkflowUsageWarning/);
    expect(registry.list()).toHaveLength(2);
    expect(registry.list()[0]!.status).toBe('failed');
    expect(registry.list()[1]!.status).toBe('completed');
  });

  it('P5 R1 #10: capped banner shape (`total !== null`) — was untested', async () => {
    const { config } = configWithRegistry();
    const originalEnv = process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'];
    process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'] = '50000';
    try {
      const tool = new WorkflowTool(config, { dispatch: async () => 'ok' });
      const result = await tool
        .build({ script: 'return 1' })
        .execute(new AbortController().signal);
      const display = result.returnDisplay as string;
      // Capped banner has "Workflow token cap is <total>" copy.
      expect(display).toMatch(/Workflow token cap is 50000/);
      expect(display).toMatch(/skipWorkflowUsageWarning/);
      // Capped banner must NOT carry the uncapped "have no per-run" copy.
      expect(display).not.toMatch(/Workflows have no per-run token cap/);
    } finally {
      if (originalEnv === undefined) {
        delete process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'];
      } else {
        process.env['QWEN_CODE_MAX_TOKENS_PER_WORKFLOW'] = originalEnv;
      }
    }
  });
});
