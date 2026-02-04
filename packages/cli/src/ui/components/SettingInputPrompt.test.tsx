/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { SettingInputPrompt } from './SettingInputPrompt.js';
import { TextInput } from './shared/TextInput.js';

vi.mock('./shared/TextInput.js', () => ({
  TextInput: vi.fn(() => null),
}));

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const MockedTextInput = vi.mocked(TextInput);

describe('SettingInputPrompt', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const terminalWidth = 80;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders setting name and description', () => {
    const { lastFrame } = render(
      <SettingInputPrompt
        settingName="API_KEY"
        settingDescription="Enter your API key"
        sensitive={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
        terminalWidth={terminalWidth}
      />,
    );

    expect(lastFrame()).toContain('API_KEY');
    expect(lastFrame()).toContain('Enter your API key');
  });

  it('renders TextInput for non-sensitive values', () => {
    render(
      <SettingInputPrompt
        settingName="USERNAME"
        settingDescription="Enter your username"
        sensitive={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
        terminalWidth={terminalWidth}
      />,
    );

    expect(MockedTextInput).toHaveBeenCalled();
  });

  it('does not render TextInput for sensitive values (uses PasswordInput)', () => {
    MockedTextInput.mockClear();
    render(
      <SettingInputPrompt
        settingName="SECRET_KEY"
        settingDescription="Enter your secret key"
        sensitive={true}
        onSubmit={onSubmit}
        onCancel={onCancel}
        terminalWidth={terminalWidth}
      />,
    );

    // TextInput should not be called for sensitive input
    expect(MockedTextInput).not.toHaveBeenCalled();
  });

  it('shows masked input placeholder for sensitive mode', () => {
    const { lastFrame } = render(
      <SettingInputPrompt
        settingName="PASSWORD"
        settingDescription="Enter your password"
        sensitive={true}
        onSubmit={onSubmit}
        onCancel={onCancel}
        terminalWidth={terminalWidth}
      />,
    );

    // Should show the sensitive placeholder hint
    expect(lastFrame()).toContain('PASSWORD');
    expect(lastFrame()).toContain('Enter your password');
  });

  it('displays help text for submit and cancel', () => {
    const { lastFrame } = render(
      <SettingInputPrompt
        settingName="CONFIG"
        settingDescription="Enter config value"
        sensitive={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
        terminalWidth={terminalWidth}
      />,
    );

    expect(lastFrame()).toContain('Enter');
    expect(lastFrame()).toContain('Escape');
  });

  it('passes correct props to TextInput for non-sensitive input', () => {
    render(
      <SettingInputPrompt
        settingName="ENDPOINT"
        settingDescription="Enter endpoint URL"
        sensitive={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
        terminalWidth={terminalWidth}
      />,
    );

    expect(MockedTextInput).toHaveBeenCalledWith(
      expect.objectContaining({
        value: '',
        isActive: true,
        inputWidth: expect.any(Number),
      }),
      undefined,
    );
  });
});
