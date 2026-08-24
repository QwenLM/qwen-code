/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { subagentGenerator } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../../test-utils/render.js';
import { DescriptionInput } from './DescriptionInput.js';
import type { CreationWizardState, WizardAction } from '../types.js';
import type { TextInputProps } from '../../shared/TextInput.js';

const textInputMock = vi.hoisted(() => ({
  props: null as TextInputProps | null,
}));

vi.mock('../../shared/TextInput.js', () => ({
  TextInput: (props: TextInputProps) => {
    textInputMock.props = props;
    return null;
  },
}));

vi.mock('@qwen-code/qwen-code-core', async (importActual) => {
  const actual =
    await importActual<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    subagentGenerator: vi.fn(),
  };
});

const baseState: CreationWizardState = {
  currentStep: 3,
  location: 'project',
  generationMethod: 'qwen',
  userDescription: 'Review code changes',
  generatedSystemPrompt: '',
  generatedDescription: '',
  generatedName: '',
  selectedTools: [],
  color: 'blue',
  isGenerating: false,
  validationErrors: [],
  canProceed: true,
};

describe('DescriptionInput', () => {
  it('aborts in-flight generation when unmounted', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(subagentGenerator).mockImplementation(
      async (_description, _config, signal) => {
        capturedSignal = signal;
        return new Promise(() => undefined);
      },
    );

    let app!: ReturnType<typeof renderWithProviders>;
    act(() => {
      app = renderWithProviders(
        <DescriptionInput
          state={baseState}
          dispatch={vi.fn<(action: WizardAction) => void>()}
          onNext={vi.fn()}
          onPrevious={vi.fn()}
          onCancel={vi.fn()}
          config={{} as Config}
        />,
      );
    });

    expect(textInputMock.props?.onSubmit).toBeDefined();

    await act(async () => {
      textInputMock.props?.onSubmit?.('Review code changes');
    });

    expect(capturedSignal?.aborted).toBe(false);

    act(() => {
      app.unmount();
    });

    expect(capturedSignal?.aborted).toBe(true);
  });
});
