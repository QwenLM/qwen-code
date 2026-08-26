/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { advisorCommand } from './advisor-command.js';
import { CommandKind } from './types.js';

const mockCheckAvailability = vi.hoisted(() => vi.fn());

vi.mock('../../config/advisor-model.js', () => ({
  checkAdvisorModelAvailability: mockCheckAvailability,
  isAdvisorModelEligible: vi.fn(() => true),
}));

vi.mock('../../i18n/index.js', () => ({
  t: (value: string, params?: Record<string, string>) =>
    params
      ? Object.entries(params).reduce(
          (result, [key, replacement]) =>
            result.replace(`{{${key}}}`, replacement),
          value,
        )
      : value,
}));

describe('advisorCommand', () => {
  const setAdvisorModel = vi.fn();
  const setValue = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setAdvisorModel.mockResolvedValue(undefined);
    mockCheckAvailability.mockReturnValue({
      available: true,
      availableModelIds: ['advisor-model'],
    });
  });

  function context() {
    return createMockCommandContext({
      services: {
        config: { setAdvisorModel },
        settings: { setValue },
      },
    });
  }

  it('opens the model picker when no argument is provided', async () => {
    expect(advisorCommand.name).toBe('advisor');
    expect(advisorCommand.kind).toBe(CommandKind.BUILT_IN);

    await expect(advisorCommand.action!(context(), '')).resolves.toEqual({
      type: 'dialog',
      dialog: 'advisor-model',
    });
  });

  it('persists and enables a configured model', async () => {
    const result = await advisorCommand.action!(context(), 'advisor-model');

    expect(mockCheckAvailability).toHaveBeenCalledWith(
      expect.anything(),
      'advisor-model',
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'advisorModel',
      'advisor-model',
    );
    expect(setAdvisorModel).toHaveBeenCalledWith('advisor-model');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Advisor set to advisor-model',
    });
  });

  it('persists off and removes the runtime tool', async () => {
    const result = await advisorCommand.action!(context(), 'off');

    expect(mockCheckAvailability).not.toHaveBeenCalled();
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'advisorModel',
      '',
    );
    expect(setAdvisorModel).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Advisor disabled',
    });
  });

  it('rejects model changes when the session disallows persistence', async () => {
    const result = await advisorCommand.action!(
      createMockCommandContext({
        executionPolicy: { persistModelSelection: false },
        services: {
          config: { setAdvisorModel },
          settings: { setValue },
        },
      }),
      'advisor-model',
    );

    expect(mockCheckAvailability).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(setAdvisorModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'This model selection is not available in this session.',
    });
  });

  it('rejects an unavailable model without changing settings', async () => {
    mockCheckAvailability.mockReturnValue({
      available: false,
      availableModelIds: ['available-model'],
    });

    const result = await advisorCommand.action!(context(), 'missing-model');

    expect(setValue).not.toHaveBeenCalled();
    expect(setAdvisorModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining(
        "Advisor model 'missing-model' is not configured.",
      ),
    });
  });
});
