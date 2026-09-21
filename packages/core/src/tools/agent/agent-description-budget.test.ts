/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentTool } from './agent.js';
import { AGENT_DELEGATION_SKILL_NAME } from '../../skills/agent-delegation-skill.js';
import { readBundledReference } from '../../skills/bundled-reference.js';
import type { Config } from '../../config/config.js';
import type { SubagentManager } from '../../subagents/subagent-manager.js';
import type { SubagentConfig } from '../../subagents/types.js';
import { ToolNames } from '../tool-names.js';

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
  /**
   * Whether the session can load a skill. A session that can gets a pointer
   * at the `agent-delegation` reference; one that cannot has the reference
   * inlined, the route whose description is largest for a session that has
   * not opted the reference out (#12054). Not a floor: `withheld` is smaller
   * than the pointer shape, and the optional blocks stack on either route.
   */
  skills?: boolean;
  /**
   * Whether a `tools.eager` allowlist withholds the Skill tool's schema,
   * leaving it reachable through the tool_search + tool_call bridge. The
   * pointer then carries one bridge sentence.
   */
  skillDeferred?: boolean;
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
  skills = true,
  skillDeferred = false,
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
    // The delegation reference's route, as `bundled-reference.ts` reads it: a
    // skill manager plus a registered Skill tool means the description
    // carries a pointer, and their absence means it carries the reference.
    ...(skills
      ? {
          getSkillManager: () => ({}),
          getToolRegistry: () => ({
            getAllToolNames: () =>
              skillDeferred
                ? [
                    ToolNames.AGENT,
                    ToolNames.SKILL,
                    ToolNames.TOOL_SEARCH,
                    ToolNames.TOOL_CALL,
                  ]
                : [ToolNames.AGENT, ToolNames.SKILL],
            isPermissionDeferred: (name: string) =>
              skillDeferred && name === ToolNames.SKILL,
          }),
        }
      : {}),
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
    // Two subagents, team off, todo on, a pointer at the delegation
    // reference. The catalogue itself is covered by the proportional-growth
    // test below. Measured at 7,386 characters, down from 9,730 before the
    // prompt-writing guidance moved into the bundled skill (#12054).
    const tool = await buildTool();
    expect(tool.description.length).toBeLessThanOrEqual(7_750);
  });

  it('keeps the description within its budget when the Skill tool is behind the bridge', async () => {
    // A `tools.eager` allowlist withholds the Skill tool's schema; the
    // pointer grows by the one-sentence tool_search + tool_call bridge note.
    // Measured at 7,504 — 118 more than the plain pointer. A separate row so
    // the bridge sentence's own growth is visible, not absorbed into the
    // pointer row's headroom.
    const tool = await buildTool({ skillDeferred: true });
    expect(tool.description.length).toBeLessThanOrEqual(7_900);
    // The bridge sentence is the only difference from the pointer shape, so
    // assert the delta too: a reworded or duplicated bridge sentence moves it.
    const pointer = await buildTool();
    expect(
      tool.description.length - pointer.description.length,
    ).toBeLessThanOrEqual(160);
  });

  it('keeps the description within its budget with no subagents configured', async () => {
    // The skeleton on its own — the catalogue collapses to a one-line
    // "no subagents are configured" placeholder. Measured at 7,083.
    const tool = await buildTool({ subagents: [], todo: false });
    expect(tool.description.length).toBeLessThanOrEqual(7_450);
  });

  it('keeps the description within its budget with every optional block on', async () => {
    // Team coordination guidance and the todo clause both present.
    // Measured at 8,370.
    const tool = await buildTool({ team: true, todo: true });
    expect(tool.description.length).toBeLessThanOrEqual(8_750);
  });

  /**
   * The largest route a session that has not opted out can land on, and the
   * shape no setting turns into a pointer: a pointer there would send the
   * model at something it cannot reach. Budgeted separately — and above the
   * pointer shape — so growth in the skill body is visible here.
   *
   * Two things this row is not. It is not the worst case: `teamGuidance` and
   * the todo clause are independent insertions, so they stack on the inlined
   * reference rather than trade places with it, and that shape is 984
   * characters larger (11,396 — its own row below). And it is not a floor
   * nothing can go under: a user opt-out routes to `withheld`, which renders
   * the section empty and measures 7,192, below even the pointer shape's
   * 7,386. What is true of it is that no setting makes it a pointer.
   */
  it('keeps the description within its budget when the reference is inlined', async () => {
    // Default shape, no route to any skill. Measured at 10,412 — 682 more
    // than the description carried before the move: 127 for the inline
    // preamble and its separator, 265 for the reference's own title and
    // framing paragraph, and 465 for the definition-outranks-the-prompt rule
    // with its blank line, less 175 because the relocated prose itself
    // renders shorter here than it did in the description's bullet list.
    // That rule is new text rather than relocated text, and it costs a
    // pointer-shaped session nothing, because only this shape carries the
    // reference body at all.
    const tool = await buildTool({ skills: false });
    expect(tool.description.length).toBeLessThanOrEqual(10_750);
  });

  it('keeps the description within its budget when every block is on and the reference is inlined', async () => {
    // The actual worst case, and the one nothing bounded before: 10,412 for
    // the inlined reference, which already carries the todo clause, plus 984
    // for the team guidance — measured at 11,396. That is above both the
    // 10,710 the all-blocks-on shape measured and the 11,200 it was budgeted
    // at before the move, which is why the optional blocks and the delegation
    // route have to be measured together rather than each against the default
    // shape. The blocks' own deltas are bounded above, so this row and the
    // pointer-shape rows do not leave a gap between them.
    const tool = await buildTool({ team: true, todo: true, skills: false });
    expect(tool.description.length).toBeLessThanOrEqual(11_770);
  });

  /**
   * The point of the move: a session that can load the skill pays a pointer
   * instead of the reference, on every request.
   *
   * Pinned on the mechanism rather than on a magnitude. A gap floor cannot
   * detect the regression it names: guidance pasted back into the description
   * grows both shapes together, so the gap barely moves and the pointer's
   * 7,750 row is what fires — while the one change that reaches a gap floor on
   * its own is a legitimate trim of the reference, which the row's own message
   * then blames on the description. What has to fail loudly is the reference
   * body turning up in the pointer shape.
   */
  it('keeps the reference body out of the pointer and in the inlined description', async () => {
    const [pointer, inlined] = await Promise.all([
      buildTool(),
      buildTool({ skills: false }),
    ]);
    // Read from the reference itself rather than spelled out as a literal, so
    // that editing the skill body — the normal thing to do to it — does not
    // turn this row red. What is pinned is the wiring: the inline shape carries
    // the body, and the pointer shape carries none of it.
    const reference = readBundledReference(AGENT_DELEGATION_SKILL_NAME);
    if (!reference) {
      throw new Error('the agent-delegation reference is unreadable');
    }
    const body = reference.body.trim();
    expect(inlined.description).toContain(body);
    // Paragraph by paragraph, not just as a whole: one paragraph pasted back is
    // the realistic regression, and at under the 364 characters of headroom the
    // pointer row leaves it would slip past every magnitude budget above. The
    // length floor keeps the shared `## Writing the prompt` heading — which the
    // pointer legitimately carries — out of the check. The count floor is
    // deliberately loose: it exists so an emptied or restructured body cannot
    // make the loop vacuous, and must not trip on a legitimate trim.
    const paragraphs = body
      .split('\n\n')
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length >= 40);
    expect(paragraphs.length).toBeGreaterThan(3);
    for (const paragraph of paragraphs) {
      expect(pointer.description).not.toContain(paragraph);
    }
    // The direction, kept as a record rather than as the gate.
    expect(inlined.description.length).toBeGreaterThan(
      pointer.description.length,
    );
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
    // What must survive the gating: the rules that hold either way. Between
    // this list and the `Set to false` / `interactive fork` assertions in
    // agent.test.ts, every sentence of RUN_IN_BACKGROUND_DESCRIPTION is now
    // pinned. The headless-fork clause was the one no test named: deleting
    // it from the constant left every suite green and this 341 delta
    // unchanged, because both arms shrink together.
    for (const clause of [
      'Defaults to true for top-level regular subagents',
      'headless forks always run in the background',
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
    // Description plus serialized schema, default shape. Measured at 11,030
    // characters (7,386 + 3,644): 13,374 before the prompt-writing guidance
    // moved into the bundled `agent-delegation` skill (#12054), and before
    // that higher still, with the teammate-only guidance sent to sessions
    // without teams.
    const tool = await buildTool();
    expect(surfaceLength(tool)).toBeLessThanOrEqual(11_750);
  });

  /**
   * The row above measures the pointer shape, which is what almost every
   * session sends — so on its own it would leave the inline route's surface,
   * which §5 of the design doc lists as a row of its own, unbounded here.
   * The inline surface is *above* the 13,374 every session paid before this
   * PR: a reference that cannot be loaded costs more per turn than the prose
   * it replaced did. That is the deliberate price for reaching skill-less
   * sessions at all, and it is bounded here rather than only described there.
   */
  it('keeps the whole model-visible surface within its budget when the reference is inlined', async () => {
    // Measured at 14,056 (10,412 description + 3,644 schema). The team shape
    // sits 2,331 above this — 984 of description plus 1,347 of schema for the
    // three parameters `isAgentTeamEnabled()` declares — and, exactly as
    // before this PR, that combination is left to the per-part rows rather
    // than to a surface total.
    const tool = await buildTool({ skills: false });
    expect(surfaceLength(tool)).toBeLessThanOrEqual(14_430);
  });
});
