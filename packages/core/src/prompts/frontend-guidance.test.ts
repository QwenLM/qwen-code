/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { getConfigValue } from '../config-service/index.js';
import {
  _resetPromptPolicyForTesting,
  getPromptPolicySnapshot,
} from '../config-service/features/promptPolicy.js';
import { SystemPromptAssembler } from './system-prompt-assembler.js';
import { systemPromptToText } from './system-prompt.js';
import { createTurnPromptResolver } from './turn-prompt-resolver.js';
import { SIMPLE_SYSTEM_PROMPT_ENV } from './bundle-resolver.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import type { QoderListedModel } from '../qoder/models/qoder-model-fields.js';
import { testListedModel } from '../test-utils/listed-model.js';

const FRONTEND_GUIDANCE_ENV = `${BRAND_FIXED_ENV_PREFIX}FRONTEND_GUIDANCE`;

vi.mock('../config-service/index.js', () => ({
  getConfigValue: vi.fn(),
  subscribeConfigValue: vi.fn(),
}));

const manager = { getModel: vi.fn() };
const duck: QoderListedModel = testListedModel('lmodel', {
  display_name: 'QoDuck',
});
const marker = '# Frontend Design Guidance';
const builtin =
  'Make the details users need to distinguish or understand clear in context.';
const legacy = 'For UI or frontend changes, start the dev server';

afterEach(() => {
  manager.getModel.mockReset();
  vi.unstubAllEnvs();
  vi.mocked(getConfigValue).mockReset();
  _resetPromptPolicyForTesting();
});

it.each(['full', 'lean'] as const)(
  'gates and replaces the %s frontend section across turns and model switches',
  async (bundle) => {
    vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, bundle === 'lean' ? '1' : '0');
    vi.stubEnv(FRONTEND_GUIDANCE_ENV, undefined);
    const assembler = new SystemPromptAssembler({ sessionId: bundle });
    const getModel = manager.getModel.mockReturnValue(duck);
    const turn = (keepCodingInstructions = true, overrideSystemPrompt?: string) =>
      createTurnPromptResolver({
        overrideSystemPrompt,
        promptSurface: 'sdk',
        sessionId: bundle,
        cwd: '/workspace',
        assembler,
        sdkMemoryState: { owner: 'none' },
        agentLoopContext: {
          config: {
            hasModelProviderManager: () => true,
            getModelProviderManager: () => manager,
            isAutoMemoryEnabled: () => false,
            getWorkingDir: () => process.cwd(),
            getWorkspaceContext: () => ({
              getDirectories: () => [process.cwd()],
            }),
            getLanguage: () => undefined,
            getOutputStyle: () => ({
              name: 'test',
              prompt: '',
              keepCodingInstructions,
            }),
            getSkillManager: () => ({ getModelVisibleSkills: () => [] }),
          },
          toolRegistry: { getAllToolNames: () => [] },
        } as unknown as AgentLoopContext,
      });
    const setPolicy = (profile: Record<string, unknown>) =>
      vi.mocked(getConfigValue).mockReturnValue({
        behaviorByModel: { lmodel: profile, other: profile },
      });
    const render = async (
      resolve: Awaited<ReturnType<typeof turn>>,
      model: QoderListedModel = duck,
    ) => systemPromptToText((await resolve(model.key, model)).blocks);

    const baseline = await render(await turn());
    expect(baseline).not.toContain(marker);
    expect(baseline.includes(legacy)).toBe(bundle === 'full');
    vi.stubEnv(FRONTEND_GUIDANCE_ENV, '1');
    const forced = await turn();
    expect(await render(forced)).toContain(builtin);
    expect(await render(forced, { ...duck, key: 'other' })).toBe(baseline);
    vi.stubEnv(FRONTEND_GUIDANCE_ENV, undefined);
    setPolicy({ frontendGuidanceText: 'remote only' });
    expect(await render(await turn())).toBe(baseline);
    setPolicy({ frontendGuidance: true });
    const builtInText = await render(await turn());
    expect(builtInText).toContain(builtin);
    expect(builtInText.split(marker)).toHaveLength(2);
    expect(builtInText).not.toContain(legacy);

    setPolicy({
      frontendGuidance: true,
      frontendGuidanceText: '- First variant',
    });
    const first = await turn();
    const firstText = await render(first);
    expect(firstText).toContain(marker + '\n\n- First variant');
    expect(firstText).not.toContain(builtin);
    expect(await render(first, { ...duck, key: 'other' })).toBe(baseline);
    expect(await render(first, { ...duck, source: 'custom' })).toBe(baseline);
    expect(await render(first, { ...duck, catalogSource: 'user' })).toBe(baseline);
    expect(await render(first, { ...duck, connection: {} })).toBe(baseline);
    expect(await render(first, { ...duck, displayName: 'Other' })).toBe(firstText);
    expect(await render(first)).toBe(firstText);
    expect(getModel).not.toHaveBeenCalled();
    expect(systemPromptToText((await first(duck.key)).blocks)).toBe(firstText);
    getModel.mockReturnValue({ ...duck, key: 'LMODEL' });
    expect(systemPromptToText((await first(duck.key)).blocks)).toBe(baseline);
    getModel.mockReturnValue(duck);
    const fixed = await render(await turn(true, 'fixed'));
    expect(fixed).toMatch(/\n\nfixed$/);
    expect(fixed).not.toContain(marker);

    setPolicy({
      frontendGuidance: true,
      frontendGuidanceText: '- Second variant',
    });
    expect(await render(first)).toBe(firstText);
    const secondText = await render(await turn());
    expect(secondText).toContain('- Second variant');
    expect(secondText).not.toContain('- First variant');
    const noCoding = await render(await turn(false));
    expect(noCoding).not.toContain(marker);
    expect(noCoding).not.toContain(legacy);

    setPolicy({ frontendGuidance: true });
    expect(await render(await turn())).toBe(builtInText);
    vi.stubEnv(FRONTEND_GUIDANCE_ENV, '0');
    expect(await render(await turn())).toBe(baseline);
    vi.stubEnv(FRONTEND_GUIDANCE_ENV, '1');
    setPolicy({
      frontendGuidance: false,
      frontendGuidanceText: '- First variant',
    });
    expect(await render(await turn())).toBe(firstText);
  },
);

it.each([42, null, undefined, '', '   '])(
  'retains the last valid policy for invalid frontend text %j',
  (text) => {
    const profile = (value: unknown) => ({
      behaviorByModel: {
        lmodel: { frontendGuidance: true, frontendGuidanceText: value },
      },
    });
    vi.mocked(getConfigValue).mockReturnValue(profile('  first\n'));
    const previous = getPromptPolicySnapshot();
    expect(previous.behaviorByModel?.['lmodel']?.frontendGuidanceText).toBe(
      'first',
    );
    vi.mocked(getConfigValue).mockReturnValue(profile(text));
    expect(getPromptPolicySnapshot()).toBe(previous);
  },
);
