/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { advisorCommand } from './advisor-command.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{{${k}}}`, v),
        key,
      );
    }
    return key;
  },
}));

const mockRunForkedAgent = vi.hoisted(() => vi.fn());
const mockBuildBtwCacheSafeParams = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    generationConfig: {},
    history: [{ role: 'user', parts: [{ text: 'hello' }] }],
    model: 'test-model',
    version: 0,
  }),
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    BTW_MAX_INPUT_LENGTH: 4096,
    runForkedAgent: mockRunForkedAgent,
    buildBtwCacheSafeParams: mockBuildBtwCacheSafeParams,
    resolveModelId: (
      value: string | undefined,
      context?: { fastModel?: string },
    ) => {
      const raw = value?.trim();
      if (!raw || raw.includes(' ')) throw new Error('invalid selector');
      if (raw === 'fast') {
        return context?.fastModel ? { modelId: context.fastModel } : undefined;
      }
      const [authType, ...rest] = raw.split(':');
      return rest.length > 0
        ? { authType, modelId: rest.join(':') }
        : { modelId: raw };
    },
  };
});

const ADVISOR_REVIEW = {
  verdict: 'Sound.',
  risks: 'None found.',
  missingEvidence: 'None.',
  recommendation: 'Proceed.',
};

const advisorResult = (model = 'test-model') => ({
  text: JSON.stringify(ADVISOR_REVIEW),
  jsonResult: ADVISOR_REVIEW,
  model,
  usage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
});

const ADVISOR_MARKDOWN = [
  '## Verdict',
  ADVISOR_REVIEW.verdict,
  '## Risks',
  ADVISOR_REVIEW.risks,
  '## Missing evidence',
  ADVISOR_REVIEW.missingEvidence,
  '## Recommendation',
  ADVISOR_REVIEW.recommendation,
].join('\n\n');

describe('advisorCommand', () => {
  let mockContext: CommandContext;
  let setValue: Mock;
  let setAdvisorConfig: Mock;

  const createSettings = (
    merged: Record<string, unknown> = {},
    userSettings: Record<string, unknown> = {},
    workspaceSettings: Record<string, unknown> = {},
  ): LoadedSettings => {
    const user = { settings: userSettings };
    const workspace = { settings: workspaceSettings };
    return {
      merged,
      user,
      workspace,
      setValue,
      isTrusted: true,
      forScope: (scope: SettingScope) =>
        scope === SettingScope.Workspace ? workspace : user,
    } as unknown as LoadedSettings;
  };

  const createConfig = (overrides: Record<string, unknown> = {}) => ({
    getGeminiClient: () => ({
      getHistoryForForkWindow: () => [
        { role: 'user', parts: [{ text: 'hello' }] },
      ],
    }),
    getModel: () => 'test-model',
    getFastModel: () => undefined,
    getContentGeneratorConfig: () => ({ authType: 'openai' }),
    getAdvisorModel: () => undefined,
    getAllConfiguredModels: () => [
      {
        id: 'advisor-model',
        label: 'Advisor',
        authType: 'openai',
      },
      {
        id: 'vision-only',
        label: 'Vision Only',
        authType: 'openai',
        visionOnly: true,
      },
    ],
    getAvailableModelsForAuthType: (authType: string) =>
      authType === 'openai'
        ? [
            {
              id: 'advisor-model',
              label: 'Advisor',
              authType: 'openai',
            },
          ]
        : [],
    setAdvisorConfig,
    getSessionId: () => 'test-session-id',
    getApprovalMode: () => 'default',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setValue = vi.fn();
    setAdvisorConfig = vi.fn().mockResolvedValue(undefined);
    mockBuildBtwCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: [{ role: 'user', parts: [{ text: 'hello' }] }],
      model: 'test-model',
      version: 0,
    });
    mockContext = createMockCommandContext({
      services: {
        config: createConfig(),
        settings: createSettings(),
      },
    });
  });

  it('has correct metadata', () => {
    expect(advisorCommand.name).toBe('advisor');
    expect(advisorCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(advisorCommand.description).toBeTruthy();
    expect(advisorCommand.supportedModes).toEqual(['interactive', 'acp']);
  });

  it('opens the Advisor model picker when run without args interactively', async () => {
    const result = await advisorCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'advisor-model',
    });
  });

  it('prints an actionable message for no-arg ACP use', async () => {
    const result = await advisorCommand.action!(
      { ...mockContext, executionMode: 'acp' },
      '',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Current Advisor model: not set\nUse "/advisor <model-id>" to enable Advisor or "/advisor off" to disable it.',
    });
  });

  it('shows the current Advisor status without opening the picker', async () => {
    const result = await advisorCommand.action!(mockContext, 'status');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Current Advisor model: not set\nUse "/advisor <model-id>" to enable Advisor or "/advisor off" to disable it.',
    });
    expect(setValue).not.toHaveBeenCalled();
    expect(setAdvisorConfig).not.toHaveBeenCalled();
  });

  it('shows the active Advisor model in status output', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: createConfig({
          getAdvisorModel: () => 'advisor-model',
        }),
        settings: createSettings({ advisorModel: 'advisor-model' }),
      },
    });

    const result = await advisorCommand.action!(mockContext, 'status');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Current Advisor model: advisor-model\nUse "/advisor <model-id>" to enable Advisor or "/advisor off" to disable it.',
    });
  });

  it('rejects extra args for Advisor status', async () => {
    const result = await advisorCommand.action!(mockContext, 'status now');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /advisor status',
    });
    expect(setValue).not.toHaveBeenCalled();
    expect(setAdvisorConfig).not.toHaveBeenCalled();
  });

  it('offers status completion for Advisor', async () => {
    await expect(
      advisorCommand.completion!(mockContext, 'sta'),
    ).resolves.toEqual([
      {
        value: 'status',
        description: 'Show the current Advisor model',
      },
    ]);
  });

  it('persists and applies an Advisor model selector', async () => {
    const result = await advisorCommand.action!(mockContext, 'advisor-model');

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'advisorModel',
      'advisor-model',
    );
    expect(setAdvisorConfig).toHaveBeenCalledWith({
      model: 'advisor-model',
      maxUses: undefined,
      modelOverride: false,
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Advisor Model: advisor-model',
    });
  });

  it('validates the fast alias against its resolved model', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: createConfig({
          getFastModel: () => 'advisor-model',
          getAllConfiguredModels: () => [
            { id: 'advisor-model', authType: 'openai', fastOnly: true },
          ],
          getAvailableModelsForAuthType: () => [
            { id: 'advisor-model', authType: 'openai', fastOnly: true },
          ],
        }),
        settings: createSettings(),
      },
    });

    const result = await advisorCommand.action!(mockContext, 'fast');

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'advisorModel',
      'fast',
    );
    expect(result).toMatchObject({ messageType: 'info' });
  });

  it('returns a message result for /advisor <selector> in ACP mode', async () => {
    const result = await advisorCommand.action!(
      { ...mockContext, executionMode: 'acp' },
      'advisor-model',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'advisorModel',
      'advisor-model',
    );
    expect(setAdvisorConfig).toHaveBeenCalledWith({
      model: 'advisor-model',
      maxUses: undefined,
      modelOverride: false,
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Advisor Model: advisor-model',
    });
  });

  it('persists an empty tombstone and disables Advisor for /advisor off', async () => {
    const result = await advisorCommand.action!(mockContext, 'off');

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'advisorModel',
      '',
    );
    expect(setAdvisorConfig).toHaveBeenCalledWith({
      model: undefined,
      maxUses: undefined,
      modelOverride: false,
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Advisor disabled',
    });
  });

  it('disables Advisor in the scope that owns advisorModel', async () => {
    mockContext = createMockCommandContext({
      services: {
        config: createConfig(),
        settings: createSettings(
          { advisorModel: 'workspace-advisor' },
          { modelProviders: {} },
          { advisorModel: 'workspace-advisor' },
        ),
      },
    });

    await advisorCommand.action!(mockContext, 'off');

    expect(setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'advisorModel',
      '',
    );
  });

  it('returns a message result for /advisor off in ACP mode', async () => {
    const result = await advisorCommand.action!(
      { ...mockContext, executionMode: 'acp' },
      'off',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'advisorModel',
      '',
    );
    expect(setAdvisorConfig).toHaveBeenCalledWith({
      model: undefined,
      maxUses: undefined,
      modelOverride: false,
    });
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Advisor disabled',
    });
  });

  it('rejects unknown selectors instead of treating them as review focus', async () => {
    const result = await advisorCommand.action!(mockContext, 'missing-model');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
    expect(
      String(result && 'content' in result ? result.content : ''),
    ).toContain("Advisor model 'missing-model' is not configured.");
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
  });

  it('rejects mutually exclusive scope flags', async () => {
    const result = await advisorCommand.action!(
      mockContext,
      '--project --global advisor-model',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Cannot use both --project and --global. Choose one scope flag.',
    });
  });

  it('runs the manual structured review under /advisor review', async () => {
    mockRunForkedAgent.mockResolvedValue(advisorResult('resolved-model'));

    const result = await advisorCommand.action!(
      mockContext,
      'review check the error handling',
    );

    expect(result).toBeUndefined();
    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('check the error handling'),
        disableModelFallbacks: true,
      }),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ADVISOR,
        text: ADVISOR_MARKDOWN,
        model: 'resolved-model',
      },
      expect.any(Number),
    );
  });

  it('passes the active Advisor model as model override for manual review', async () => {
    mockRunForkedAgent.mockResolvedValue(advisorResult('stronger-model'));
    mockContext = createMockCommandContext({
      services: {
        config: createConfig({
          getAdvisorModel: () => 'stronger-model',
        }),
        settings: createSettings({ advisorModel: 'stronger-model' }),
      },
    });

    await advisorCommand.action!(mockContext, 'review');

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'stronger-model',
      }),
    );
  });

  it('uses the active Advisor model over persisted settings for manual review', async () => {
    mockRunForkedAgent.mockResolvedValue(advisorResult('session-model'));
    mockContext = createMockCommandContext({
      services: {
        config: createConfig({
          getAdvisorModel: () => 'session-model',
        }),
        settings: createSettings({ advisorModel: 'persisted-model' }),
      },
    });

    await advisorCommand.action!(mockContext, 'review');

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'session-model',
      }),
    );
  });

  it('returns manual review errors in ACP mode', async () => {
    mockRunForkedAgent.mockRejectedValue(new Error('bad json'));

    const result = await advisorCommand.action!(
      { ...mockContext, executionMode: 'acp' },
      'review',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Advisor review failed: bad json',
    });
  });

  it('returns manual review output in ACP mode', async () => {
    mockRunForkedAgent.mockResolvedValue(advisorResult('resolved-model'));

    const result = await advisorCommand.action!(
      { ...mockContext, executionMode: 'acp' },
      'review check risk',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: ADVISOR_MARKDOWN,
    });
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });
});
