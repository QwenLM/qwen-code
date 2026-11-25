/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import type { SkillDefinition } from '@qwen-code/resource';
import { ENV_MAX_SUBAGENT_SPAWN_DEPTH } from '../../config/brand.js';
import { AGENT_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import {
  prepareSkillBody,
  type InlineSkillActivationOptions,
} from '../inlineSkillActivation.js';
import { registerSimplifySkill } from './simplify.js';

function loadSkill(): SkillDefinition {
  let skill: SkillDefinition | undefined;
  registerSimplifySkill({
    registerBundledSkill(definition) {
      skill = { ...definition, skillRoot: '', isBuiltin: true } as SkillDefinition;
    },
  });
  return skill!;
}

const skill = loadSkill();

type ActivateOptions = InlineSkillActivationOptions & {
  /** Tools the main registry reports; only consulted when `toolNames` is absent. */
  registryTools?: string[];
  args?: string;
};

async function activate({
  registryTools = [],
  args,
  ...options
}: ActivateOptions = {}) {
  const config = {
    getSessionId: () => 'simplify-test',
    getModel: () => 'test-model',
    getToolRegistry: () => ({
      getFunctionDeclarations: () => registryTools.map((name) => ({ name })),
    }),
  } as unknown as Config;
  return prepareSkillBody(config, skill, 'simplify', '', args, undefined, options);
}

const ANGLES = ['Reuse', 'Simplification', 'Efficiency', 'Altitude'];

describe('simplify activation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is invocable only by the user', () => {
    expect(skill.userInvocable).toBe(true);
    expect(skill.disableModelInvocation).toBe(true);
  });

  it('delegates by default and preserves an explicit target', async () => {
    const prompt = await activate({
      registryTools: [AGENT_TOOL_NAME],
      args: '  src/a.ts  ',
    });
    expect(prompt).toMatch(/^Review target: `src\/a.ts`\n\n/);
    expect(prompt).toContain('4 cleanup agents in parallel');
    expect(prompt).toContain('Wait for all four agents to complete.');
  });

  it('prefers caller tools over the main registry', async () => {
    const prompt = await activate({
      registryTools: [AGENT_TOOL_NAME],
      toolNames: [],
    });
    expect(prompt).toContain('4 cleanup angles, single pass');
    expect(prompt).toContain('State clearly in the summary');
    expect(prompt).not.toContain('Launch four independent review agents');
    for (const angle of ANGLES) {
      expect(prompt).toContain(`### ${angle}`);
    }
  });

  it('falls back inline when the main session has no Agent tool', async () => {
    expect(await activate({ registryTools: ['Read'] })).toContain(
      '4 cleanup angles, single pass',
    );
  });

  it('falls back at the depth cap even when an exact fork retains Agent', async () => {
    vi.stubEnv(ENV_MAX_SUBAGENT_SPAWN_DEPTH, '2');
    const toolNames = [AGENT_TOOL_NAME, 'Read'];
    expect(await activate({ toolNames, agentDepth: 1 })).toContain(
      '4 cleanup agents in parallel',
    );
    expect(await activate({ toolNames, agentDepth: 2 })).toContain(
      '4 cleanup angles, single pass',
    );
  });

  it('omits a blank target and assumes delegation when tool context is unknown', async () => {
    const prompt = await skill.getBody!('   ');
    expect(prompt).not.toContain('Review target:');
    expect(prompt).toContain('4 cleanup agents in parallel');
  });
});
