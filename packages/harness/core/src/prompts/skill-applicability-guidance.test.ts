/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import { getConfigValue } from '../config-service/index.js';
import { _resetPromptPolicyForTesting } from '../config-service/features/promptPolicy.js';
import { SKILL_TOOL_NAME } from '../tools/tool-names.js';
import { SIMPLE_SYSTEM_PROMPT_ENV } from './bundle-resolver.js';
import { createPromptRenderInputs } from './render-inputs.js';
import { SystemPromptAssembler } from './system-prompt-assembler.js';
import { systemPromptToText } from './system-prompt.js';
import { createTurnPromptResolver } from './turn-prompt-resolver.js';

vi.mock('../config-service/index.js', () => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
}));

const explicitSkillGuidance = `When the user types \`/<skill-name>\`, invoke it via ${SKILL_TOOL_NAME}. Only use skills listed in the user-invocable skills section — don't guess.`;
const skillApplicabilityGuidance =
  'When selecting a skill yourself, do not use a skill based solely on keywords, superficial relevance, or the availability of a potentially applicable skill.';

function context(
  skillsAvailable = true,
  skillToolEnabled = true,
): AgentLoopContext {
  return {
    config: {
      getModel: () => 'unconfigured',
      getWorkingDir: () => '/workspace/project',
      getWorkspaceContext: () => ({
        getDirectories: () => ['/workspace/project'],
      }),
      getLanguage: () => undefined,
      getSkillManager: () => ({
        getModelVisibleSkills: () =>
          skillsAvailable ? [{ name: 'review' }] : [],
      }),
    },
    toolRegistry: {
      getAllToolNames: () => (skillToolEnabled ? [SKILL_TOOL_NAME] : []),
    },
  } as unknown as AgentLoopContext;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(getConfigValue).mockReset();
  _resetPromptPolicyForTesting();
});

it.each(['full', 'lean'] as const)(
  'selects Skill applicability guidance by the effective model with safe %s cache reuse',
  async (bundle) => {
    vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, bundle === 'lean' ? '1' : '0');
    vi.stubEnv(`${BRAND_FIXED_ENV_PREFIX}FRONTEND_GUIDANCE`, undefined);
    vi.mocked(getConfigValue).mockReturnValue({
      behaviorByModel: {
        ultimate: { skillApplicabilityGuidance: true },
        smodel: { skillApplicabilityGuidance: true },
        disabled: { skillApplicabilityGuidance: false },
      },
    });
    const assembler = new SystemPromptAssembler({
      sessionId: `skill-applicability-${bundle}`,
    });
    const turn = (overrideSystemPrompt?: string) =>
      createTurnPromptResolver({
        agentLoopContext: context(),
        promptSurface: 'sdk',
        sessionId: `skill-applicability-${bundle}`,
        cwd: '/workspace/project',
        assembler,
        sdkMemoryState: { owner: 'none' },
        overrideSystemPrompt,
      });
    const resolve = await turn();
    for (const model of [
      'ultimate',
      'smodel',
      'disabled',
      'unconfigured',
      'ULTIMATE',
      'ultimate',
    ]) {
      const result = await resolve(model);
      const text = systemPromptToText(result.blocks);
      expect(text).toContain('# Session-specific guidance');
      expect(text).toContain(explicitSkillGuidance);
      if (model === 'ultimate' || model === 'smodel') {
        expect(text).toContain(
          `- ${explicitSkillGuidance} ${skillApplicabilityGuidance}`,
        );
      } else {
        expect(text).not.toContain(skillApplicabilityGuidance);
      }
    }

    vi.mocked(getConfigValue).mockReturnValue({
      behaviorByModel: { ultimate: { skillApplicabilityGuidance: false } },
    });
    expect(systemPromptToText((await resolve('ultimate')).blocks)).toContain(
      skillApplicabilityGuidance,
    );
    const nextTurn = await turn();
    expect(
      systemPromptToText((await nextTurn('ultimate')).blocks),
    ).not.toContain(skillApplicabilityGuidance);
    expect(systemPromptToText((await nextTurn('smodel')).blocks)).not.toContain(
      skillApplicabilityGuidance,
    );

    vi.mocked(getConfigValue).mockReturnValue({
      behaviorByModel: { ultimate: { skillApplicabilityGuidance: true } },
    });
    const enabledAgain = await turn();
    expect(
      systemPromptToText((await enabledAgain('ultimate')).blocks),
    ).toContain(skillApplicabilityGuidance);
    const fixed = await turn('Fixed system prompt');
    expect(systemPromptToText((await fixed('ultimate')).blocks)).not.toContain(
      skillApplicabilityGuidance,
    );
    assembler.clearCache();
  },
);

it.each([
  { skillsAvailable: false, skillToolEnabled: true },
  { skillsAvailable: true, skillToolEnabled: false },
])(
  'requires both Skill prerequisites: %j',
  async ({ skillsAvailable, skillToolEnabled }) => {
    const inputs = createPromptRenderInputs(
      context(skillsAvailable, skillToolEnabled),
      'default',
      'sdk',
      { owner: 'none' },
    );
    const text = await inputs.sessionGuidance?.computeForBundle('full', true);
    expect(text).not.toContain(explicitSkillGuidance);
    expect(text).not.toContain(skillApplicabilityGuidance);
  },
);
