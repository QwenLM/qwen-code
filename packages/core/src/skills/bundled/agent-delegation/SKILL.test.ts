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
import type { SubagentManager } from '../../../subagents/subagent-manager.js';
import { ToolDisplayNames, ToolNames } from '../../../tools/tool-names.js';
import { ToolMode } from '../../../tools/code-mode.js';
import { AgentTool } from '../../../tools/agent/agent.js';
import { parseSkillContent } from '../../skill-load.js';
import { AGENT_DELEGATION_SKILL_NAME } from '../../agent-delegation-skill.js';
import { toolSearchBridgeSentence } from '../../bundled-reference.js';

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

function skillProse(): string {
  return collapse(loadSkill().body);
}

/**
 * The frontmatter `description` and `when_to_use` are per-request surfaces
 * as well, and separate ones from the body: the session-start prelude renders
 * bundled entries verbatim into the `<available_skills>` block
 * (`environmentContext.ts` keeps them whole while trimming towards
 * `MAX_SKILL_LISTING_CHARS`), and `renderAvailableSkillsBlock` appends
 * `when_to_use` inside `<description>`. So a kept rule widened into either
 * field — the natural lever, since it is what lets the model recall the
 * skill — would be charged on every request, and the body-only negative half
 * below would never see it.
 */
function skillFrontmatter(): string {
  const skill = loadSkill();
  // Optional, because the render's gate is truthiness rather than presence.
  return collapse(`${skill.description} ${skill.whenToUse ?? ''}`);
}

/**
 * The Agent tool's description in a session that can load skills — the shape
 * almost every session sends, and the one the moved guidance must be gone
 * from. `skills: false` models a session with no route to any skill, where the
 * reference travels inside the description instead. `skillDeferred: true`
 * models a `tools.eager` allowlist withholding the Skill tool, reachable only
 * through the tool_search + tool_call bridge. `bundledDisabled: true`
 * models a user who turned off the whole bundled level, and
 * `skillDisabledByName: true` one who named this reference in
 * `skills.disabled`; in either the description carries neither.
 * `toolMode: ToolMode.CodeModeOnly` models a session where both bridge tools
 * are hidden, so a deferred Skill tool is reached through the `exec` binding
 * instead.
 */
async function agentDescription({
  skills = true,
  bundledDisabled = false,
  skillDisabledByName = false,
  skillDeferred = false,
  toolMode = ToolMode.Direct,
}: {
  skills?: boolean;
  bundledDisabled?: boolean;
  skillDisabledByName?: boolean;
  skillDeferred?: boolean;
  /**
   * Always declared on the stub rather than left absent: an omitted
   * `getToolMode` yields `undefined`, which the route resolver treats exactly
   * like `Direct`, so a stub without the method cannot tell the two apart and
   * the CodeModeOnly guard would be untested on this path.
   */
  toolMode?: ToolMode;
} = {}): Promise<string> {
  const subagentManager = {
    listSubagents: vi.fn().mockResolvedValue([]),
    addChangeListener: vi.fn().mockReturnValue(() => {}),
    getAvailableModelGrades: vi.fn().mockReturnValue(new Map()),
  } as unknown as SubagentManager;
  const config = {
    getSubagentManager: () => subagentManager,
    getLlmClient: () => undefined,
    isAgentTeamEnabled: () => false,
    isTodoWriteEnabled: () => true,
    getToolMode: () => toolMode,
    // Read before the Skill tool is asked about: a user opt-out wins over the
    // lack of a route, which is the ordering the withheld test below pins.
    ...(bundledDisabled
      ? { getDisabledSkillLevels: () => new Set(['bundled']) }
      : {}),
    // The other opt-out lever, `skills.disabled` naming this reference. It
    // decides on the name it is handed, as the real `Config.isSkillEnabled`
    // does, and the disabled name is spelled out as the literal a user writes
    // in `settings.json` rather than read from the exported constant — so a
    // drift in the name the production code probes turns the by-name case red
    // instead of quietly leaving the reference in every request.
    ...(skillDisabledByName
      ? {
          isSkillEnabled: (skill: { name: string; level?: string }) =>
            skill.level === 'bundled' && skill.name !== 'agent-delegation',
        }
      : {}),
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
  return collapse(tool.description);
}

describe('bundled agent-delegation skill', () => {
  it('is the delegation-prompt reference, and says what it does not carry', () => {
    const skill = loadSkill();

    expect(skill.name).toBe(AGENT_DELEGATION_SKILL_NAME);
    expect(skill.description).toContain('Load before writing a delegation');
    // The reference is loadable on the model's own initiative, so it has to
    // say where the rules it does not repeat live. A model that read only
    // this must not conclude it has the whole contract.
    expect(skill.description).toContain("the Agent tool's own description");
    expect(skillProse()).toContain(
      "stay in the Agent tool's description — this reference does not repeat them",
    );
  });

  // Guidance that left the tool description for this skill. Each anchor is
  // asserted in BOTH directions, in one table: present in the skill, and
  // absent from the description a session that can load skills sends. Either
  // half alone would let the guidance vanish, or be pasted back, with every
  // test green.
  describe.each([
    ['Brief the agent like a smart colleague'],
    ["Explain what you're trying to accomplish and why"],
    ["Describe what you've already learned or ruled out"],
    // Relocated verbatim from the description's bullet list; pinned here
    // because nothing else in the repo asserts this sentence.
    ['Give enough context about the surrounding problem'],
    ['If you need a short response, say so explicitly'],
    ['For lookups, provide the exact target'],
    ['Provide clear, detailed prompts so the agent can work autonomously'],
    ['Clearly tell the agent whether you expect it to write code'],
    ['Terse command-style prompts produce shallow, generic work'],
    ['Never delegate understanding'],
    ['based on your findings, fix the bug'],
    // Prettier normalizes markdown emphasis to `_`, so this sentence reads
    // `_directive_` here where the tool description spelled it `*directive*`.
    ['With the default full history, the prompt is a _directive_'],
    ['what another agent is handling'],
    ['test-runner'],
    ['function isPrime(n)'],
  ])('moved out of the tool description: %s', (anchor) => {
    it('is in the skill', () => {
      expect(skillProse()).toContain(anchor);
    });
    it('is not in the description', async () => {
      expect(await agentDescription()).not.toContain(anchor);
    });
    // The move only saves what the listing does not charge again: a bundled
    // entry is kept whole by `trimSkillEntriesTowardsBudget`, so a moved rule
    // widened into the frontmatter would be paid for on every request with
    // the skill never loaded, and `skillProse()` above — body-only — would
    // not see it.
    it('is not in the skill frontmatter either', () => {
      expect(skillFrontmatter()).not.toContain(anchor);
    });
  });

  /**
   * The other half of the split, asserted the same way round: what a model
   * must have without loading anything. These decide whether to delegate at
   * all, shape the call itself, or keep a background agent safe — a session
   * that never loads the skill still has to get them right, so they stay in
   * the description and stay out of the reference, in its body and in the
   * frontmatter that the session-start listing charges for on every request.
   */
  describe.each([
    // The block that decides against delegating, and the first item §2 of the
    // design doc lists as deliberately kept. A general compression pass is the
    // live pressure — one was reverted under review in #12142 — and nothing
    // else in the repo asserts this text.
    ['When NOT to use the Agent tool'],
    ["Don't peek"],
    ["Don't race"],
    ["Don't relaunch"],
    ['## When to fork'],
    ["Don't set `model` on a fork"],
    ['Pass a short `name`'],
    ['Omitting `subagent_type` does NOT fork'],
    ['give concurrent agents disjoint write scopes'],
    ["Treat the agent's output as evidence"],
  ])('kept in the tool description: %s', (anchor) => {
    it('is in the description', async () => {
      expect(await agentDescription()).toContain(anchor);
    });
    it('is not in the skill', () => {
      expect(skillProse()).not.toContain(anchor);
    });
    // Not folded into `skillProse()` above: widening that helper would let the
    // moved-out table's positive half match frontmatter text too, and a rule
    // duplicated into the listing is charged every turn whether or not the
    // skill is ever loaded.
    it('is not in the skill frontmatter either', () => {
      expect(skillFrontmatter()).not.toContain(anchor);
    });
  });

  it('is named by the description that replaced it', async () => {
    const description = await agentDescription();

    expect(description).toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
    // The pointer has to say what is in there, or the model cannot tell
    // whether this turn needs it.
    expect(description).toContain('what to put in the prompt');
    // The heading the moved section used to own. `agent.test.ts` asserted it
    // before the split and no other test carries it, so without this assertion
    // the pointer could lose the heading that separates it from the fork
    // guidance above it and every test would stay green.
    expect(description).toContain('## Writing the prompt');
  });

  /**
   * A `tools.eager` allowlist that withholds the Skill tool leaves it
   * registered behind the tool_search + tool_call bridge, and the pointer has
   * to say so — otherwise the model tries the Skill tool by name and gets
   * EXECUTION_DENIED. The Workflow side pins the same sentence in
   * workflow-description.test.ts. Mutation check: returning POINTER for the
   * 'pointer-via-tool-search' surface, or passing the bare tool name instead
   * of ToolDisplayNames.SKILL, turns this red.
   */
  it('names the tool_search + tool_call bridge when the Skill tool is deferred', async () => {
    const description = await agentDescription({ skillDeferred: true });

    expect(description).toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
    expect(description).toContain(
      toolSearchBridgeSentence(ToolDisplayNames.SKILL),
    );
  });

  /**
   * The same deferral under `ToolMode.CodeModeOnly`, where both bridge tools
   * are hidden (`code-mode.ts` `HIDDEN_TOOLS`) and the deferred Skill tool is
   * reached through the `exec` binding. The guard that keeps the bridge
   * sentence out of the route exists for this tool above all: `AgentTool`
   * freezes its surface in the constructor, so a dead instruction here is
   * wrong for every remaining turn of the session, while the Workflow
   * description re-asks per turn. `workflow-authoring-skill.test.ts` pins the
   * guard on the Workflow route; this pins it on the Agent route.
   * Mutation check: dropping
   * `config.getToolMode?.() !== ToolMode.CodeModeOnly &&` from
   * `resolveBundledReferenceRoute` turns this red, exactly as it turns the
   * Workflow row red.
   */
  it('points straight at the skill when CodeModeOnly hides the bridge', async () => {
    const description = await agentDescription({
      skillDeferred: true,
      toolMode: ToolMode.CodeModeOnly,
    });

    expect(description).toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
    expect(description).not.toContain(
      toolSearchBridgeSentence(ToolDisplayNames.SKILL),
    );
  });

  /**
   * A dispatch must not try to override the subagent it names. #12142's review
   * threads carry a real one that asked a read-only, single-file subagent to
   * search the whole repository. The rule sits in this reference rather than in
   * the description because it is prompt-writing craft: a session that never
   * loads it still cannot widen a subagent's tools, it only wastes the call.
   */
  it("says a custom subagent's definition outranks the prompt", async () => {
    const anchor = "custom subagent's own definition outranks";

    expect(skillProse()).toContain(anchor);
    expect(await agentDescription()).not.toContain(anchor);
  });

  /**
   * A session with no route to any skill gets the reference itself: a pointer
   * there would send the model at something it cannot load. The body is
   * asserted through one moved anchor, so this fails if the inline shape ever
   * silently drops to a pointer.
   */
  it('travels in the description when no skill can be loaded', async () => {
    const description = await agentDescription({ skills: false });

    expect(description).toContain('Skills cannot be loaded in this session');
    // The clause that reconciles this preamble with the same request's
    // <available_skills> prelude, which lists this skill by name: without it
    // the description denies a skill the listing just offered, and the model
    // spends a call finding out. Dropping it from INLINE_NOTE turns this red.
    expect(description).toContain('even one named in a skill listing');
    expect(description).toContain('Never delegate understanding');
    expect(description).not.toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
  });

  /**
   * The user opt-out is the one route that must not be satisfied by inlining
   * instead: `skills.disabled` naming this reference, or the whole `bundled`
   * level turned off, has to remove the text rather than move it to a seat
   * that costs more per turn. Asserted with the Skill tool both present and
   * absent, because the opt-out outranks the lack of a route — that ordering
   * is the invariant, not an implementation detail of `bundled-reference.ts`.
   *
   * The heading check is what keeps the shape clean: with the section empty,
   * the description must not be left carrying `## Writing the prompt` over
   * nothing, nor the inline preamble.
   */
  it.each([
    ['a Skill tool is registered', true],
    ['no route to any skill exists', false],
  ])(
    'carries nothing when the user turned it off and %s',
    async (_, skills) => {
      const description = await agentDescription({
        skills,
        bundledDisabled: true,
      });

      expect(description).not.toContain(
        `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
      );
      expect(description).not.toContain(
        'Skills cannot be loaded in this session',
      );
      expect(description).not.toContain('Never delegate understanding');
      expect(description).not.toContain('## Writing the prompt');
      // What must survive the opt-out, not only what it removes: a resident
      // block gated on the delegation surface would vanish for a user who
      // opted out while every negative assertion above stayed green.
      expect(description).toContain("Don't race");
      expect(description).toContain('## When to fork');
    },
  );

  /**
   * The other opt-out lever. Turning off the whole `bundled` level reaches
   * `getDisabledSkillLevels`; naming this reference in `skills.disabled`
   * reaches `isSkillEnabled`, which is a separate branch of
   * `resolveBundledReferenceRoute` and the one a user is far likelier to set.
   * Without this row the by-name branch had no coverage here at all, and a
   * drift in the name the production code probes would leave the reference in
   * every request while the user's opt-out silently stopped working. Mirrors
   * the by-name rows in `workflow-authoring-skill.test.ts`.
   */
  it.each([
    ['a Skill tool is registered', true],
    ['no route to any skill exists', false],
  ])('carries nothing when disabled by name and %s', async (_, skills) => {
    const description = await agentDescription({
      skills,
      skillDisabledByName: true,
    });

    expect(description).not.toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
    expect(description).not.toContain(
      'Skills cannot be loaded in this session',
    );
    expect(description).not.toContain('Never delegate understanding');
    expect(description).not.toContain('## Writing the prompt');
    // The surviving-anchor half as well. This is the lever a user is likelier
    // to set, and it carried no positive assertion at all.
    expect(description).toContain("Don't race");
    expect(description).toContain('## When to fork');
  });

  /**
   * One sentence left the description without arriving here, and this pins it
   * as a deliberate dedup rather than a loss. Base `agent.ts` also carried
   * "After launching an agent, do not fabricate or predict what it found
   * before it returns…"; the resident **Don't race** bullet already states the
   * same rule more strongly and stays in every shape, so keeping both would
   * have charged every request for the same instruction twice.
   *
   * Asserted in every shape, one per route and per opt-out lever, because the
   * surviving rule is the one that has to hold in each: were it ever gated
   * behind the reference, a session that never loads the skill would lose the
   * rule entirely.
   */
  it("keeps Don't race and drops the sentence it already covers", async () => {
    const dropped = 'do not fabricate or predict what it found';
    const surviving = 'Never fabricate or predict its results in any format';

    expect(skillProse()).not.toContain(dropped);
    for (const description of [
      await agentDescription(),
      await agentDescription({ skills: false }),
      await agentDescription({ bundledDisabled: true }),
      await agentDescription({ skillDisabledByName: true }),
    ]) {
      expect(description).not.toContain(dropped);
      expect(description).toContain(surviving);
    }
  });
});
