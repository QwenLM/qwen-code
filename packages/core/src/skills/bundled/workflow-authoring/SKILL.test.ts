/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../config/config.js';
import { parseSkillContent } from '../../skill-load.js';
import {
  DEFAULT_MAX_AGENTS_PER_RUN,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  HARD_MAX_AGENTS_PER_RUN_CEILING,
  HARD_MAX_CONCURRENCY_CEILING,
  HARD_WORKFLOW_SUBAGENT_MAX_MINUTES_CEILING,
  HARD_WORKFLOW_SUBAGENT_MAX_TURNS_CEILING,
  MAX_WORKFLOW_AGENTS_ENV,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
  WORKFLOW_SUBAGENT_DISALLOWED_TOOLS,
  WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
} from '../../../agents/runtime/workflow-orchestrator.js';
import { WORKFLOW_SYNC_EVALUATION_TIMEOUT_MS } from '../../../agents/runtime/workflow-sandbox.js';
import { ToolDisplayNames, ToolNames } from '../../../tools/tool-names.js';
import {
  DEFAULT_STALL_MS,
  MAX_STALL_ATTEMPTS,
  MAX_WORKFLOW_STALL_MS_ENV,
} from '../../../agents/runtime/workflow-stall.js';
import { WorkflowAgentFailedError } from '../../../agents/runtime/workflow-agent-failure.js';
import type { WorkflowAgentDispatch } from '../../../agents/runtime/workflow-orchestrator.js';
import {
  buildWorkflowToolDescription,
  WorkflowTool,
} from '../../../tools/workflow/workflow.js';

function loadSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  return parseSkillContent(fs.readFileSync(skillPath, 'utf8'), skillPath);
}

/** Collapse runs of whitespace so a re-flowed paragraph does not break an anchor. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * The body with runs of whitespace collapsed. The anchors below are
 * sentences, and a hard-wrapped markdown paragraph renders a line break as a
 * space — asserting on the raw text would make every anchor break the moment
 * someone re-flowed a paragraph, which is not the regression these guard.
 */
function skillProse(): string {
  return collapse(loadSkill().body);
}

/** The description a normal session sends, which points at this skill. */
function pointerDescription(): string {
  return collapse(buildWorkflowToolDescription('pointer'));
}

describe('bundled workflow-authoring skill', () => {
  it('is the authoring reference, and says it does not authorize a run', () => {
    const skill = loadSkill();

    expect(skill.name).toBe('workflow-authoring');
    expect(skill.description).toContain('Load before authoring');
    // The reference is loadable on the model's own initiative, so it has to
    // repeat the boundary: reading how to write a script is not permission
    // to run one. The opt-in rule lives in the tool description.
    expect(skill.description).toContain('does not itself authorize');
    expect(skillProse()).toContain('does not authorize a run');
  });

  // Guidance that left the tool description for this skill. Each anchor is
  // asserted in BOTH directions here, in one table: present in the skill, and
  // absent from the description a normal session sends. Either half alone
  // would let the guidance vanish, or be pasted back, with every test green.
  describe.each([
    ['only before the orchestration step'],
    ['Common single-phase shapes'],
    ['Default to `pipeline()`'],
    ['A barrier is right only when'],
    [
      'spawn independent verifiers prompted to _refute_, and drop what a majority refutes',
    ],
    ['against everything already seen'],
    ['`log()` what was dropped'],
    ['workingDir'],
    ['no-progress stall watchdog'],
    ['Call-shape validation failures'],
    ["named, with its error, in the run's failures list"],
    ['is not an agent dispatch'],
    ['nests one level only'],
    ['read `budget.total`'],
    ['subagent completed without calling StructuredOutput'],
    ['Unresolved names make the admitted agent() resolve to null'],
  ])('moved out of the tool description: %s', (anchor) => {
    it('is in the skill', () => {
      expect(skillProse()).toContain(anchor);
    });
    it('is not in the description', () => {
      expect(pointerDescription()).not.toContain(anchor);
    });
  });

  // Kept in both on purpose: each is what a model needs to decide whether to
  // call the tool or how to read a result, which every turn that touches a
  // workflow needs. An edit to one copy must be checked against the other.
  it.each([
    ['Parallelism on its own is not a reason'],
    ['un-level rejections no later call could survive'],
  ])('is stated in both the skill and the description: %s', (anchor) => {
    expect(skillProse()).toContain(anchor);
    expect(pointerDescription()).toContain(anchor);
  });

  // Every limit the reference states, anchored to the sentence that states it
  // and built from the constant the runtime enforces. A bare digit would be
  // satisfied by unrelated prose ("stage 3", "1000" inside "10000"); a
  // sentence is not. The wall clock and the concurrency formula have no
  // exported constant and stay literals.
  it.each([
    [`up to ${MAX_STALL_ATTEMPTS} attempts total`],
    [`Stall retries: ${MAX_STALL_ATTEMPTS} attempts per`],
    [`${DEFAULT_MAX_AGENTS_PER_RUN} \`agent()\` calls per run`],
    [`the ${DEFAULT_MAX_AGENTS_PER_RUN}-agent cap`],
    [
      `Default ${DEFAULT_STALL_MS} (override via \`${MAX_WORKFLOW_STALL_MS_ENV}\``,
    ],
    [
      `${DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS} turns (\`${WORKFLOW_SUBAGENT_MAX_TURNS_ENV}\`, clamped to ${HARD_WORKFLOW_SUBAGENT_MAX_TURNS_CEILING})`,
    ],
    [
      `${DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES} minutes (\`${WORKFLOW_SUBAGENT_MAX_MINUTES_ENV}\`, clamped to ${HARD_WORKFLOW_SUBAGENT_MAX_MINUTES_CEILING})`,
    ],
    [
      `\`${MAX_WORKFLOW_AGENTS_ENV}\` (clamped to ${HARD_MAX_AGENTS_PER_RUN_CEILING})`,
    ],
    [
      `\`${MAX_WORKFLOW_CONCURRENCY_ENV}\` (clamped to ${HARD_MAX_CONCURRENCY_CEILING})`,
    ],
    ['`QWEN_CODE_MAX_WORKFLOW_SECONDS` (applied as given)'],
    ['30-minute wall-clock cap per run'],
    [
      `${WORKFLOW_SYNC_EVALUATION_TIMEOUT_MS / 1000} seconds for the script's synchronous code before its first \`await\`, with no override`,
    ],
    ['max(2, min(16, availableParallelism()-2))'],
  ])('states the runtime limit: %s', (anchor) => {
    expect(skillProse()).toContain(anchor);
  });

  it.each([
    // The sandbox itself.
    ['async IIFE'],
    ['`node:vm` sandbox'],
    // meta: the full contract, including the field the approval dialog prints.
    ['optionally `whenToUse` and `phases: [{ title, detail? }]`'],
    // parallel(): the eager form is refused, after the dispatches were spent.
    ['`parallel([() => agent(...)])`'],
    ['a non-function element rejects the whole batch'],
    ['`parallel()` itself rejects on invalid arguments'],
    // Determinism: all of Date, and the workaround.
    ['so does all of `Date`'],
    ['`new Date()`'],
    ['stamp the result after the workflow returns'],
    // pipeline(): null drops the item and skips its later stages.
    ['its remaining stages are skipped'],
    // The phase option is ambient, not per call.
    ['every dispatch issued after it'],
    ['It is not scoped to the one call'],
    // effort: the rule it shares with /effort, where it does not reach, and
    // what changes the key.
    ['model?, effort?, agentType?'],
    ["limited to the tiers `/effort` offers for the agent's model"],
    ["the tiers its provider's built-in table accepts"],
    ['becomes the next stronger tier it does offer'],
    ['leaves the agent with the effort it would have had without the option'],
    ["The session's own effort is never changed"],
    ['replaces any thinking budget the agent would otherwise inherit'],
    ['still takes precedence over the tier'],
    [
      "a `model` override that switches provider starts from that model's own reasoning settings",
    ],
    ['A different effort is a different resume cache key'],
    // disallowedTools only narrows, names what it accepts, and a schema agent
    // cannot deny its answer.
    ['stallMs?, disallowedTools? })'],
    ['never re-enable one'],
    ['`mcp__<server>__*`'],
    ["such as `'Bash'`, resolves the call to null"],
    ['include `structured_output` resolves to null'],
    ['not on their order or duplicates'],
    ['named by its tool name or its display name'],
    // What the disallowed-tool floor means for a script. The tools themselves
    // are checked against the orchestrator's own list below.
    ['cannot fan out further'],
    // workflow(): both forms, that a bare string is a name, and that its
    // rejection is only loud at the top level.
    ['`workflow({ scriptPath:'],
    ['A bare string is always a name'],
    [
      'inside `parallel()`/`pipeline()` it becomes a position-aligned `null` like any other thunk rejection',
    ],
    ['so null-check a `workflow()` result too'],
    // isolation: every refusal, and the workaround for the nested one.
    ['when the session is already inside a worktree'],
    ['pass it as `workingDir`'],
    ['git is not available or the directory is not a git repository'],
    // Concurrency follows the runtime's own source of parallelism.
    ['follows CPU affinity and container CPU limits'],
    // Labels: the failures list carries nothing else.
    ['Make it unique per dispatch'],
    // The journal: every line type, and what a bare `started` means.
    ['a `started` line when an agent is dispatched'],
    ['Only `result` lines feed the resume cache'],
    ['means the run was interrupted'],
    // Saving is a different skill.
    ['`workflow-creator` skill'],
  ])('states the script contract: %s', (anchor) => {
    expect(skillProse()).toContain(anchor);
  });

  // Generated from the list the orchestrator enforces rather than copied from
  // it: a tool added there and not named here turns this red, and so does a
  // tool named here that the list no longer holds.
  it('names exactly the tools a workflow subagent can never use', () => {
    const prose = skillProse();
    const lead = 'Workflow subagents can never use ';
    const start = prose.indexOf(lead);
    const end = prose.indexOf(', whatever their `agentType`', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const named = prose.slice(start + lead.length, end).split(/,\s*(?:or\s+)?/);
    const displayNames = WORKFLOW_SUBAGENT_DISALLOWED_TOOLS.map((name) => {
      const key = Object.keys(ToolNames).find(
        (candidate) => ToolNames[candidate as keyof typeof ToolNames] === name,
      );
      return key
        ? (ToolDisplayNames as Record<string, string>)[key]
        : undefined;
    });

    expect(displayNames).not.toContain(undefined);
    expect(named).toHaveLength(displayNames.length);
    for (const displayName of displayNames) {
      expect(named.some((item) => item.includes(displayName!))).toBe(true);
    }
  });

  // Ultracode is an upstream concept qwen-code does not have. A stray
  // mention would send the model looking for a keyword nothing detects.
  it('does not mention concepts this build lacks', () => {
    expect(loadSkill().body.toLowerCase()).not.toContain('ultracode');
  });
});

// The worked example is the part a model copies, so it is run, not grepped.
// One reviewer and one verifier fail; the run must say so by name in its log,
// and the confirmed list must hold only what was actually verified.
describe('the worked example', () => {
  function extractExample(): string {
    const body = loadSkill().body;
    const match = body.match(/```js\n([\s\S]*?)```/);
    if (!match) throw new Error('SKILL.md has no ```js example');
    return match[1];
  }

  it('checks for null in the stage that dispatched, and gives verifiers distinct labels', () => {
    const example = extractExample();

    expect(example).toContain('if (review === null)');
    expect(example).toContain('if (verdict === null)');
    expect(example).toContain('`verify:${dimension.key}:${index + 1}`');
  });

  function runExample(
    dispatch: (prompt: string, opts: { label?: string }) => Promise<unknown>,
    args?: unknown,
  ) {
    return new WorkflowTool({} as unknown as Config, {
      // The stub returns plain objects for `schema` dispatches, which the
      // production dispatch would have validated; the cast says so.
      dispatch: dispatch as unknown as WorkflowAgentDispatch,
    })
      .build({
        script: extractExample(),
        ...(args === undefined ? {} : { args }),
      })
      .execute(new AbortController().signal);
  }

  function payloadOf(result: { returnDisplay?: unknown }) {
    const display = String(result.returnDisplay);
    return JSON.parse(
      display.slice(
        display.indexOf('```json\n') + 8,
        display.lastIndexOf('\n```'),
      ),
    ) as {
      logs: string[];
      result: {
        confirmed: Array<{ file: string }>;
        refuted: Array<{ file: string; verdict: { why: string } }>;
      };
    };
  }

  const failed = () =>
    new WorkflowAgentFailedError(
      'did not complete (terminate mode: MAX_TURNS).',
      'max_turns',
      'MAX_TURNS',
    );

  // One reviewer fails, one verifier fails, and one finding is refuted. The
  // run must name both lost agents, and `confirmed` must hold only what a
  // verifier actually upheld — the refuted finding is the case that pins the
  // `verdict.isReal` filter.
  it('logs every agent it loses by name, and confirms only upheld findings', async () => {
    const result = await runExample(
      async (_prompt, opts) => {
        const label = opts.label ?? '';
        if (label === 'review:security' || label === 'verify:performance:1') {
          throw failed();
        }
        if (label === 'review:correctness') {
          return {
            findings: [
              { file: 'correctness-a.ts', claim: 'upheld claim' },
              { file: 'correctness-b.ts', claim: 'refuted claim' },
            ],
          };
        }
        if (label.startsWith('review:')) {
          return { findings: [{ file: `${label}.ts`, claim: `of ${label}` }] };
        }
        if (label === 'verify:correctness:2') {
          return { isReal: false, why: 'refuted' };
        }
        return { isReal: true, why: 'reproduced' };
      },
      { target: 'HEAD' },
    );

    expect(result.error).toBeUndefined();
    const payload = payloadOf(result);
    expect(payload.logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('review:security came back empty'),
        expect.stringContaining('verify:performance:1 came back empty'),
        'confirmed 1 finding(s), refuted 1',
      ]),
    );
    expect(payload.result.confirmed.map((entry) => entry.file)).toEqual([
      'correctness-a.ts',
    ]);
    // A verifier can be wrong too, so what it refuted is returned with its
    // reason, not only counted.
    expect(
      payload.result.refuted.map((entry) => [entry.file, entry.verdict.why]),
    ).toEqual([['correctness-b.ts', 'refuted']]);
  });

  // A stage that throws drops its dimension to a null slot. Flattening would
  // hide that, so the example has to log it by name.
  it('logs a dimension dropped by a stage that threw', async () => {
    const result = await runExample(
      async (_prompt, opts) => {
        const label = opts.label ?? '';
        // Not a list: the verify stage's `.map` throws for this dimension.
        if (label === 'review:performance') return { findings: 'not a list' };
        if (label.startsWith('review:')) return { findings: [] };
        return { isReal: true, why: 'reproduced' };
      },
      { target: 'HEAD' },
    );

    expect(result.error).toBeUndefined();
    expect(payloadOf(result).logs).toEqual(
      expect.arrayContaining([
        'performance was dropped before its findings were verified',
      ]),
    );
  });

  // Called without its input, the example must fail loudly rather than
  // report a clean, empty success built from reviewers told to review nothing.
  it('refuses to run without args.target', async () => {
    const dispatch = vi.fn(async () => ({ findings: [] }));
    const result = await runExample(dispatch);

    expect(result.error?.message).toContain('args.target is required');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
