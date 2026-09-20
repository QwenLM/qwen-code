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
import { ToolNames } from '../../../tools/tool-names.js';
import { AgentTool } from '../../../tools/agent/agent.js';
import { parseSkillContent } from '../../skill-load.js';
import { AGENT_DELEGATION_SKILL_NAME } from '../../agent-delegation-skill.js';

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
 * The Agent tool's description in a session that can load skills — the shape
 * almost every session sends, and the one the moved guidance must be gone
 * from. `skills: false` models a session with no route to any skill, where the
 * reference travels inside the description instead.
 */
async function agentDescription({ skills = true } = {}): Promise<string> {
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
    ...(skills
      ? {
          getSkillManager: () => ({}),
          getToolRegistry: () => ({
            getAllToolNames: () => [ToolNames.AGENT, ToolNames.SKILL],
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
  });

  /**
   * The other half of the split, asserted the same way round: what a model
   * must have without loading anything. These decide whether to delegate at
   * all, shape the call itself, or keep a background agent safe — a session
   * that never loads the skill still has to get them right, so they stay in
   * the description and stay out of the reference.
   */
  describe.each([
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
  });

  it('is named by the description that replaced it', async () => {
    const description = await agentDescription();

    expect(description).toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
    // The pointer has to say what is in there, or the model cannot tell
    // whether this turn needs it.
    expect(description).toContain('what to put in the prompt');
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
    expect(description).toContain('Never delegate understanding');
    expect(description).not.toContain(
      `load the \`${AGENT_DELEGATION_SKILL_NAME}\` skill`,
    );
  });
});
