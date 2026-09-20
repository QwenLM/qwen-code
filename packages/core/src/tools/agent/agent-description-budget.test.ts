/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentTool } from './agent.js';
import type { Config } from '../../config/config.js';
import type { SubagentManager } from '../../subagents/subagent-manager.js';
import type { SubagentConfig } from '../../subagents/types.js';

/**
 * Per-turn size budgets for the Agent tool's model-visible surface.
 *
 * Every character of a tool's description and parameter schema is sent on
 * every request, so each has a budget — the discipline
 * `workflow.test.ts` already applies to the Workflow tool, under the same
 * reasoning quoted in `skills/workflow-authoring-skill.ts`: "only the turn
 * that actually writes a script needs it, while a tool description is paid
 * for on every turn."
 *
 * Agent needs this more than Workflow did, because its description is
 * assembled at runtime: `refreshSubagents()` appends the live subagent-type
 * catalogue, and two optional blocks come and go with
 * `isAgentTeamEnabled()` / `isTodoWriteEnabled()`. Nothing measured that,
 * so the surface could grow release over release without any signal (#12054).
 *
 * The budgets below are set from measurement plus a paragraph of headroom,
 * not from a target: one legitimate clause fits, a block of prose pasted
 * back does not. Raising one is a normal part of a change that adds
 * guidance — moving it without noticing is what this pins.
 */

const SUBAGENT_A: SubagentConfig = {
  name: 'file-search',
  description: 'Specialized agent for searching and analyzing files',
  systemPrompt: 'You are a file search specialist.',
  level: 'project',
  filePath: '/project/.qwen/agents/file-search.md',
};

const SUBAGENT_B: SubagentConfig = {
  name: 'code-review',
  description: 'Agent for reviewing code quality and best practices',
  systemPrompt: 'You are a code review specialist.',
  level: 'user',
  filePath: '/home/user/.qwen/agents/code-review.md',
};

interface Shape {
  subagents?: SubagentConfig[];
  team?: boolean;
  todo?: boolean;
}

/**
 * Builds an AgentTool and waits for the async `refreshSubagents()` the
 * constructor kicks off, so `description` is the assembled one rather than
 * the placeholder passed to `super()`.
 */
async function buildTool({
  subagents = [SUBAGENT_A, SUBAGENT_B],
  team = false,
  todo = true,
}: Shape = {}): Promise<AgentTool> {
  const subagentManager = {
    listSubagents: vi.fn().mockResolvedValue(subagents),
    addChangeListener: vi.fn().mockReturnValue(() => {}),
    getAvailableModelGrades: vi.fn().mockReturnValue(new Map()),
  } as unknown as SubagentManager;

  const config = {
    getSubagentManager: () => subagentManager,
    getLlmClient: () => undefined,
    isAgentTeamEnabled: () => team,
    isTodoWriteEnabled: () => todo,
  } as unknown as Config;

  const tool = new AgentTool(config);
  await tool.refreshSubagents();
  return tool;
}

function paramDescription(tool: AgentTool, name: string): string {
  const schema = tool.schema.parametersJsonSchema as {
    properties: Record<string, { description?: string }>;
  };
  // No `?? ''` fallback: a budget row must fail when the parameter it names
  // is renamed or stops being declared, not pass on an empty string. Every
  // name in the lists below is present in the shape that list measures, so
  // this throws only when a row has gone stale.
  const description = schema.properties[name]?.description;
  if (description === undefined) {
    throw new Error(`agent schema has no budgeted parameter "${name}"`);
  }
  return description;
}

/** What the model is actually charged for: description plus the schema. */
function surfaceLength(tool: AgentTool): number {
  return (
    tool.description.length +
    JSON.stringify(tool.schema.parametersJsonSchema).length
  );
}

describe('AgentTool per-turn size budgets', () => {
  it('keeps the description within its budget in the default shape', async () => {
    // Two subagents, team off, todo on. The catalogue itself is covered by
    // the proportional-growth test below. Measured at ~9,730 characters.
    const tool = await buildTool();
    expect(tool.description.length).toBeLessThanOrEqual(10_200);
  });

  it('keeps the description within its budget with no subagents configured', async () => {
    // The skeleton on its own — the catalogue collapses to a one-line
    // "no subagents are configured" placeholder. Measured at ~9,470.
    const tool = await buildTool({ subagents: [], todo: false });
    expect(tool.description.length).toBeLessThanOrEqual(9_900);
  });

  it('keeps the description within its budget with every optional block on', async () => {
    // Team coordination guidance and the todo clause both present.
    // Measured at ~10,710.
    const tool = await buildTool({ team: true, todo: true });
    expect(tool.description.length).toBeLessThanOrEqual(11_200);
  });

  // The two optional blocks are the part a reader can lose track of,
  // because neither is visible in the default shape.
  it('keeps the team guidance block within its budget', async () => {
    const [withTeam, withoutTeam] = await Promise.all([
      buildTool({ team: true }),
      buildTool({ team: false }),
    ]);
    const block = withTeam.description.length - withoutTeam.description.length;
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThanOrEqual(1_100);
  });

  it('keeps the todo guidance block within its budget', async () => {
    const [withTodo, withoutTodo] = await Promise.all([
      buildTool({ todo: true }),
      buildTool({ todo: false }),
    ]);
    const block = withTodo.description.length - withoutTodo.description.length;
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThanOrEqual(350);
  });

  /**
   * The catalogue is the one part of this surface with no upper bound: it
   * grows with every subagent a project, user, or extension registers, and
   * each refresh calls `llmClient.setTools()`, which rewrites the tool
   * declarations at the front of the prompt prefix.
   *
   * A budget cannot cap it without capping how many agents a user may
   * define. What can be pinned is that an entry costs only its own
   * rendered line — so growth stays proportional to the roster rather than
   * to per-entry prose added later.
   */
  it('charges a subagent entry only its own rendered line', async () => {
    const [one, two] = await Promise.all([
      buildTool({ subagents: [SUBAGENT_A] }),
      buildTool({ subagents: [SUBAGENT_A, SUBAGENT_B] }),
    ]);
    const rendered = `\n- **${SUBAGENT_B.name}**: ${SUBAGENT_B.description}`;
    expect(two.description.length - one.description.length).toBe(
      rendered.length,
    );
  });

  // Parameter descriptions are declared statically in the constructor, so
  // these budgets are flat. This is every parameter the *default* shape
  // declares — the next test pins that — with two deliberate omissions from
  // the other shapes: `model`, added only when `getAvailableModelGrades()` is
  // non-empty (this fixture leaves it empty), and `name` /
  // `plan_mode_required` / `read_only`, declared only when
  // `isAgentTeamEnabled()`.
  const DEFAULT_SHAPE_PARAM_BUDGETS: Array<[string, number]> = [
    ['run_in_background', 850],
    ['fork_tools', 600],
    ['working_dir', 600],
    ['isolation', 350],
    ['fork_turns', 320],
    ['fork_profile', 250],
    ['todo_id', 180],
    ['subagent_type', 150],
    ['description', 100],
    ['prompt', 100],
  ];

  it.each<[string, number]>(DEFAULT_SHAPE_PARAM_BUDGETS)(
    'keeps the %s parameter description within its budget',
    async (name, budget) => {
      const tool = await buildTool();
      expect(paramDescription(tool, name).length).toBeLessThanOrEqual(budget);
    },
  );

  /**
   * The rows above are only a ratchet if they cover the shape they measure:
   * a parameter added to the schema and left off the list would grow the
   * request with no row noticing, which is the failure this file exists to
   * prevent (#12054).
   */
  it('budgets every parameter the default shape declares', async () => {
    const tool = await buildTool();
    const schema = tool.schema.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(
      DEFAULT_SHAPE_PARAM_BUDGETS.map(([name]) => name).sort(),
    );
  });

  /**
   * `run_in_background`'s teammate half is about the `name` parameter,
   * which is only declared when `isAgentTeamEnabled()`. It used to be sent
   * unconditionally, so a default install paid 341 characters explaining
   * how to combine this parameter with one it had not been given — the same
   * shape as a prompt naming a tool the model was not offered (#12032).
   *
   * Asserting the exact delta rather than a bound: the note either tracks
   * the flag or it does not.
   */
  it('appends the teammate note only when the team feature is on', async () => {
    const [withTeam, withoutTeam] = await Promise.all([
      buildTool({ team: true }),
      buildTool({ team: false }),
    ]);
    const off = paramDescription(withoutTeam, 'run_in_background');
    const on = paramDescription(withTeam, 'run_in_background');

    expect(off).not.toContain('Named teammates');
    expect(on).toContain('Named teammates');
    expect(on.length - off.length).toBe(341);
    // What must survive the gating: the rules that hold either way.
    for (const clause of [
      'Defaults to true for top-level regular subagents',
      'Nested agents run in the foreground',
      'Unnamed caller-owned working_dir launches run in the foreground',
      'A configured default comes from a subagent definition',
    ]) {
      expect(off).toContain(clause);
      expect(on).toContain(clause);
    }
  });

  it('keeps run_in_background within its budget with the team note on', async () => {
    const tool = await buildTool({ team: true });
    expect(
      paramDescription(tool, 'run_in_background').length,
    ).toBeLessThanOrEqual(1_200);
  });

  /**
   * The default-shape total is kept as a separate assertion because the
   * description and schema can trade places without either per-part budget
   * noticing. Optional blocks have their own bounds above.
   */
  it('keeps the whole model-visible surface within its budget', async () => {
    // Description plus serialized schema, default shape. Measured at ~13,720
    // characters after the teammate-only guidance moved behind the team flag.
    const tool = await buildTool();
    expect(surfaceLength(tool)).toBeLessThanOrEqual(14_200);
  });
});
