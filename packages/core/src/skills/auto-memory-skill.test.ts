/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import { ToolMode } from '../tools/code-mode.js';
import {
  buildManagedAutoMemoryPrompt,
  buildResidentAutoMemoryPrompt,
} from '../memory/prompt.js';
import { toolSearchBridgeSentence } from './bundled-reference.js';
import {
  AUTO_MEMORY_SKILL_NAME,
  MainSessionAutoMemoryPolicy,
  type MainSessionAutoMemoryInputs,
} from './auto-memory-skill.js';

const PROJECT_DIR = '/home/user/.qwen/projects/app/memory';
const USER = { memoryDir: '/home/user/.qwen/memories', indexContent: null };

/**
 * A stub config for each route. `skills: false` models a session with no
 * route to any skill; `skillDeferred` a `tools.eager` allowlist that withholds
 * the Skill tool behind tool_search + tool_call; `bundledDisabled` and
 * `skillDisabledByName` the two user opt-outs.
 */
function stubConfig({
  skills = true,
  skillDeferred = false,
  bundledDisabled = false,
  skillDisabledByName = false,
}: {
  skills?: boolean;
  skillDeferred?: boolean;
  bundledDisabled?: boolean;
  skillDisabledByName?: boolean;
} = {}): Config {
  return {
    getToolMode: () => ToolMode.Direct,
    ...(bundledDisabled
      ? { getDisabledSkillLevels: () => new Set(['bundled']) }
      : {}),
    // Spelled as the literal a user writes in `skills.disabled`, so a drift
    // in the name the production code probes turns this case red.
    ...(skillDisabledByName
      ? {
          isSkillEnabled: (skill: { name: string; level?: string }) =>
            !(skill.level === 'bundled' && skill.name === 'auto-memory'),
        }
      : {}),
    ...(skills
      ? {
          getSkillManager: () => ({}),
          getToolRegistry: () => ({
            getAllToolNames: () =>
              skillDeferred
                ? [ToolNames.SKILL, ToolNames.TOOL_SEARCH, ToolNames.TOOL_CALL]
                : [ToolNames.SKILL],
            isPermissionDeferred: (name: string) =>
              skillDeferred && name === ToolNames.SKILL,
          }),
        }
      : {}),
  } as unknown as Config;
}

const INPUTS: MainSessionAutoMemoryInputs = {
  memoryDir: PROJECT_DIR,
  indexContent: null,
  userSection: USER,
  teamSection: undefined,
};

function build(config: Config): string {
  return new MainSessionAutoMemoryPolicy(INPUTS).forConfig(config);
}

describe('MainSessionAutoMemoryPolicy', () => {
  it('sends the resident policy with a pointer when the skill can be loaded', () => {
    const prompt = build(stubConfig());

    expect(prompt).toContain(`load the \`${AUTO_MEMORY_SKILL_NAME}\` skill`);
    expect(prompt).not.toContain('<types>');
    expect(prompt).not.toContain(
      toolSearchBridgeSentence(ToolDisplayNames.SKILL),
    );
  });

  it('adds the bridge sentence when the Skill tool sits behind tool_search', () => {
    const prompt = build(stubConfig({ skillDeferred: true }));

    expect(prompt).toContain(`load the \`${AUTO_MEMORY_SKILL_NAME}\` skill`);
    expect(prompt).toContain(toolSearchBridgeSentence(ToolDisplayNames.SKILL));
  });

  it('sends the full policy, as before, when no skill can be loaded', () => {
    const prompt = build(stubConfig({ skills: false }));

    expect(prompt).toBe(
      buildManagedAutoMemoryPrompt(PROJECT_DIR, null, USER, undefined, {
        includeIndexes: false,
      }),
    );
    expect(prompt).not.toContain(AUTO_MEMORY_SKILL_NAME);
  });

  it.each([
    ['the bundled level is disabled', { bundledDisabled: true }],
    ['the skill is disabled by name', { skillDisabledByName: true }],
  ])(
    'keeps the resident policy without naming the skill when %s',
    (_why, options) => {
      const prompt = build(stubConfig(options));

      expect(prompt).toBe(
        buildResidentAutoMemoryPrompt(PROJECT_DIR, USER, undefined, ''),
      );
      expect(prompt).not.toContain(AUTO_MEMORY_SKILL_NAME);
    },
  );

  // A subagent reads the policy through a Config derived from the session's
  // (Object.create), and one whose tool policy leaves out the Skill tool holds
  // no skill manager (#12424). The route has to be the reader's, not the
  // session's, or that subagent gets a pointer it cannot follow.
  it('resolves the route for the Config that reads it, so a skill-less subagent gets the full policy', () => {
    const policy = new MainSessionAutoMemoryPolicy(INPUTS);
    const session = stubConfig();
    const subagent = Object.create(session) as Config;
    subagent.getSkillManager = () => null;

    expect(policy.forConfig(session)).toContain(
      `load the \`${AUTO_MEMORY_SKILL_NAME}\` skill`,
    );
    expect(policy.forConfig(subagent)).toContain('<types>');
    expect(policy.forConfig(subagent)).not.toContain(AUTO_MEMORY_SKILL_NAME);
  });

  it('asks for the route on every read', () => {
    const policy = new MainSessionAutoMemoryPolicy(INPUTS);
    const config = stubConfig();
    const getSkillManager = vi.spyOn(
      config as unknown as { getSkillManager: () => unknown },
      'getSkillManager',
    );

    const first = policy.forConfig(config);
    const second = policy.forConfig(config);

    expect(second).toBe(first);
    // Resolved per read, so a change in the Skill tool's reachability shows
    // up on the next request; only the text for a route is reused.
    expect(getSkillManager).toHaveBeenCalledTimes(2);
  });

  // The per-request price of the policy. Measured with these paths at 4,667
  // characters on the pointer route and 15,849 for the full policy it
  // replaces. Raising the budget is a decision about what every request of
  // every session carries; prefer moving guidance into the skill.
  it('keeps the pointer-route policy within its budget', () => {
    const resident = build(stubConfig());
    const full = build(stubConfig({ skills: false }));

    expect(resident.length).toBeLessThanOrEqual(4_800);
    expect(resident.length).toBeLessThan(full.length / 3);
  });
});
