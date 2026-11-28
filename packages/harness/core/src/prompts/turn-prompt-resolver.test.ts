/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { systemPromptToText } from './system-prompt.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  _resetPromptPolicyForTesting,
  type PromptPolicySnapshot,
} from '../config-service/features/promptPolicy.js';
import { getConfigValue } from '../config-service/index.js';
import type { SystemPromptAssembler } from './system-prompt-assembler.js';
import type {
  PromptAssemblyContext,
  PromptSurface,
  SdkMemoryPromptState,
} from './types.js';
import { createTurnPromptResolver } from './turn-prompt-resolver.js';
import { SIMPLE_SYSTEM_PROMPT_ENV } from './bundle-resolver.js';

const mocks = vi.hoisted(() => ({
  getSystemContext: vi.fn(async () => ({})),
  getConfigValue: vi.fn(),
  createMemoryPromptInput: vi.fn(),
  createPromptRenderInputs: vi.fn(() => ({
    usingTools: {
      cacheVariant: 'test',
      compute: () => null,
    },
    hostCapabilities: Object.freeze([]),
  })),
}));

vi.mock('../context/system-context.js', () => ({
  getSystemContext: mocks.getSystemContext,
}));
vi.mock('./render-inputs.js', () => ({
  createPromptRenderInputs: mocks.createPromptRenderInputs,
  createMemoryPromptInput: mocks.createMemoryPromptInput,
}));
vi.mock('../config-service/index.js', () => ({
  getConfigValue: mocks.getConfigValue,
  subscribeConfigValue: vi.fn(),
}));

let remotePolicy: PromptPolicySnapshot;

function fakeAssembler(): SystemPromptAssembler {
  return {
    build: vi.fn(async () => ['ASSEMBLED']),
  } as unknown as SystemPromptAssembler;
}

async function createResolver(options: {
  assembler: SystemPromptAssembler;
  overrideSystemPrompt?: string;
  customSystemPrompt?: string;
  promptSurface?: PromptSurface;
  sdkMemoryState?: SdkMemoryPromptState;
}) {
  return createTurnPromptResolver({
    agentLoopContext: {} as AgentLoopContext,
    sessionId: 'session',
    cwd: '/workspace',
    promptSurface: options.promptSurface ?? 'headless',
    assembler: options.assembler,
    overrideSystemPrompt: options.overrideSystemPrompt,
    customSystemPrompt: options.customSystemPrompt,
    sdkMemoryState: options.sdkMemoryState,
  });
}

beforeEach(() => {
  vi.stubEnv('QWEN_ACT_DONT_REDERIVE', undefined);
  remotePolicy = Object.freeze({
    bundleByModel: Object.freeze({}),
    sectionGates: Object.freeze({}),
  });
  vi.mocked(getConfigValue).mockImplementation(() => remotePolicy);
  _resetPromptPolicyForTesting();
  mocks.getSystemContext.mockClear();
  mocks.createPromptRenderInputs.mockClear();
  mocks.createMemoryPromptInput.mockReset();
});

afterEach(() => {
  vi.mocked(getConfigValue).mockReset();
  _resetPromptPolicyForTesting();
  vi.unstubAllEnvs();
});

describe('createTurnPromptResolver prompt policy wiring', () => {
  it.each(['default', 'custom', 'override'])(
    'does not collect or append Git in the %s system prompt',
    async (source) => {
      mocks.getSystemContext.mockResolvedValue({
        gitStatus: 'unused Git snapshot',
      });
      const resolve = await createResolver({
        assembler: fakeAssembler(),
        customSystemPrompt: source === 'custom' ? 'CUSTOM' : undefined,
        overrideSystemPrompt: source === 'override' ? 'OVERRIDE' : undefined,
      });
      const result = await resolve('test-model');
      expect(systemPromptToText(result.blocks)).not.toContain('gitStatus');
      expect(systemPromptToText(result.blocks)).not.toContain(
        'unused Git snapshot',
      );
      expect(mocks.getSystemContext).not.toHaveBeenCalled();
    },
  );

  it.each(['local_tui', 'headless', 'sdk', 'remote_worker'] as const)(
    'honors the effective model turn-update veto on %s',
    async (promptSurface) => {
      remotePolicy = {
        bundleByModel: {},
        sectionGates: {},
        behaviorByModel: {
          configured: {
            mitigations: true,
            modernDefaults: true,
            turnUpdates: false,
          },
          fallback: { modernDefaults: true },
        },
        behaviorFlags: { turnUpdates: true },
      };
      vi.stubEnv('QWEN_TURN_UPDATES', undefined);
      const assembler = fakeAssembler();
      const resolve = await createResolver({ assembler, promptSurface });
      await resolve('configured');
      const context = vi.mocked(assembler.build).mock.calls.at(-1)![0];
      expect(context.communication).toEqual({
        variant: 'outcome_first',
        finalMessageRequired: true,
      });
      expect(context.enabledSectionGates).not.toContain(
        'communication.turn_updates',
      );
      expect(context.enabledSectionGates).toContain('behavior.autonomy');
      expect(context.enabledSectionGates).toContain('behavior.delivering_work');

      await resolve('fallback');
      expect(
        vi.mocked(assembler.build).mock.calls.at(-1)![0].communication?.variant,
      ).toBe('turn_updates');
    },
  );

  it.each(['local_tui', 'headless', 'sdk', 'remote_worker'] as const)(
    'resolves behavior for the effective model and captures overrides per turn on %s',
    async (promptSurface) => {
      remotePolicy = {
        bundleByModel: {},
        sectionGates: {},
        behaviorByModel: {
          configured: { mitigations: true, modernDefaults: true },
        },
      };
      vi.stubEnv('QWEN_TURN_UPDATES', 'false');
      vi.stubEnv('QWEN_DELIVERING_WORK', 'false');
      vi.stubEnv('QWEN_ACT_DONT_REDERIVE', 'true');
      const assembler = fakeAssembler();
      const resolve = await createResolver({ assembler, promptSurface });
      vi.stubEnv('QWEN_TURN_UPDATES', 'true');
      vi.stubEnv('QWEN_ACT_DONT_REDERIVE', 'false');
      await resolve('configured');
      let context = vi.mocked(assembler.build).mock.calls.at(-1)![0];
      expect(context.communication).toEqual({
        variant: 'outcome_first',
        finalMessageRequired: true,
      });
      expect(context.enabledSectionGates).toContain('behavior.autonomy');
      expect(context.enabledSectionGates).not.toContain(
        'behavior.delivering_work',
      );
      expect(context.enabledSectionGates).toContain(
        'behavior.act_dont_rederive',
      );
      await resolve('alibaba/qwen3.8-max');
      context = vi.mocked(assembler.build).mock.calls.at(-1)![0];
      expect(context.communication?.variant).toBe('standard');
      expect(context.enabledSectionGates).not.toContain('behavior.autonomy');
      expect(context.enabledSectionGates).toContain(
        'behavior.act_dont_rederive',
      );
      const nextTurn = await createResolver({ assembler, promptSurface });
      await nextTurn('configured');
      expect(
        vi.mocked(assembler.build).mock.calls.at(-1)![0].enabledSectionGates,
      ).not.toContain('behavior.act_dont_rederive');
      expect(
        vi.mocked(assembler.build).mock.calls.at(-1)![0].communication?.variant,
      ).toBe('turn_updates');
    },
  );

  it('uses Full by default and Lean when the effective model is enabled remotely', async () => {
    const assembler = fakeAssembler();
    let resolve = await createResolver({ assembler });
    await expect(resolve('custom')).resolves.toMatchObject({
      source: 'default',
      bundle: 'full',
    });

    remotePolicy = Object.freeze({
      bundleByModel: Object.freeze({ custom: 'lean' }),
      sectionGates: Object.freeze({}),
    });
    _resetPromptPolicyForTesting();
    resolve = await createResolver({ assembler });
    await expect(resolve('custom')).resolves.toMatchObject({
      source: 'default',
      bundle: 'lean',
    });
  });

  it('lets the local Full override win over remote Lean', async () => {
    vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, 'false');
    remotePolicy = Object.freeze({
      bundleByModel: Object.freeze({ custom: 'lean' }),
      sectionGates: Object.freeze({}),
    });
    const resolve = await createResolver({ assembler: fakeAssembler() });

    await expect(resolve('custom')).resolves.toMatchObject({
      source: 'default',
      bundle: 'full',
    });
  });

  it('bypasses bundles for custom prompts', async () => {
    remotePolicy = Object.freeze({
      bundleByModel: Object.freeze({ custom: 'lean' }),
      sectionGates: Object.freeze({}),
    });

    const customAssembler = fakeAssembler();
    const customResolve = await createResolver({
      assembler: customAssembler,
      customSystemPrompt: 'CUSTOM',
    });
    await expect(customResolve('custom')).resolves.toMatchObject({
      source: 'custom',
    });
    expect(customAssembler.build).not.toHaveBeenCalled();
  });

  it('selects the CLI-generated SDK memory variant for a fixed prompt source', async () => {
    remotePolicy = Object.freeze({
      bundleByModel: Object.freeze({ leanModel: 'lean' }),
      sectionGates: Object.freeze({}),
    });
    const resolve = await createResolver({
      assembler: fakeAssembler(),
      customSystemPrompt: 'CUSTOM',
      promptSurface: 'sdk',
      sdkMemoryState: {
        owner: 'sdk',
        promptsByBundle: Object.freeze({
          full: 'FULL SDK MEMORY',
          lean: 'LEAN SDK MEMORY',
        }),
        shapeKey: 1,
      },
    });

    await expect(resolve('fullModel')).resolves.toMatchObject({
      blocks: expect.arrayContaining([
        { type: 'text', text: expect.stringContaining('FULL SDK MEMORY') },
      ]),
    });
    const lean = await resolve('leanModel');
    expect(lean.memoryPromptVersion).toBe('skill');
    expect(systemPromptToText(lean.blocks)).toContain('LEAN SDK MEMORY');
    expect(systemPromptToText(lean.blocks)).not.toContain('FULL SDK MEMORY');
  });

  it('does not append CLI-generated memory instructions to an SDK override', async () => {
    const resolve = await createResolver({
      assembler: fakeAssembler(),
      overrideSystemPrompt: 'SDK OVERRIDE',
      promptSurface: 'sdk',
      sdkMemoryState: {
        owner: 'sdk',
        promptsByBundle: Object.freeze({
          full: 'FULL SDK MEMORY',
          lean: 'LEAN SDK MEMORY',
        }),
        shapeKey: 1,
      },
    });

    const result = await resolve('leanModel');
    expect(systemPromptToText(result.blocks)).toContain('SDK OVERRIDE');
    expect(systemPromptToText(result.blocks)).not.toContain('SDK MEMORY');
  });

  it('forwards enabled section gates into the final assembly context', async () => {
    remotePolicy = Object.freeze({
      bundleByModel: Object.freeze({}),
      sectionGates: Object.freeze({
        'behavior.delivering_work': 'enable',
      }),
    });
    const assembler = fakeAssembler();
    const resolve = await createResolver({ assembler });
    await resolve('custom');

    const context = vi.mocked(assembler.build).mock.calls[0]?.[0] as
      | PromptAssemblyContext
      | undefined;
    expect(context?.enabledSectionGates).toEqual(['behavior.delivering_work']);
  });
});

it('refreshes memory input on re-resolution while retaining turn bundle policy', async () => {
  const assembler = fakeAssembler();
  mocks.createMemoryPromptInput.mockReturnValue({
    owner: 'native',
    cacheVariant: 'memory:initial',
    computeForBundle: () => 'short',
  });
  const resolve = await createResolver({ assembler });
  await resolve('model');
  expect(
    vi.mocked(assembler.build).mock.calls.at(-1)![0].renderInputs.memory
      ?.cacheVariant,
  ).toBe('memory:initial');
  mocks.createMemoryPromptInput.mockReturnValue({
    owner: 'native',
    cacheVariant: 'memory:updated',
    computeForBundle: () => 'full',
  });
  await resolve('model');
  expect(
    vi.mocked(assembler.build).mock.calls.at(-1)![0].renderInputs.memory
      ?.cacheVariant,
  ).toBe('memory:updated');
  expect(mocks.getSystemContext).not.toHaveBeenCalled();
  expect(mocks.createPromptRenderInputs).toHaveBeenCalledTimes(1);
});
