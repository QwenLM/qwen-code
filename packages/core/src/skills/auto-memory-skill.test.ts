/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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
  buildMainSessionAutoMemoryPrompt,
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

function build(config: Config): string {
  return buildMainSessionAutoMemoryPrompt(
    config,
    PROJECT_DIR,
    null,
    USER,
    undefined,
  );
}

describe('buildMainSessionAutoMemoryPrompt', () => {
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

  // The per-request price of the policy. Measured with these paths at 4,553
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
