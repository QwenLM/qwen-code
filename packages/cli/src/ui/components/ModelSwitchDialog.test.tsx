/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelSwitchDialog, VisionSwitchOutcome } from './ModelSwitchDialog.js';

// Mock the useKeypress hook
const mockUseKeypress = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: mockUseKeypress,
}));

// Mock the RadioButtonSelect component
const mockRadioButtonSelect = vi.hoisted(() => vi.fn());
vi.mock('./shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: mockRadioButtonSelect,
}));

describe('ModelSwitchDialog', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock RadioButtonSelect to return a simple div
    mockRadioButtonSelect.mockReturnValue(
      React.createElement('div', { 'data-testid': 'radio-select' }),
    );
  });

  it('should setup RadioButtonSelect with correct options', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const expectedItems = [
      {
        key: 'switch-once',
        label: 'Switch for this request only',
        value: VisionSwitchOutcome.SwitchOnce,
      },
      {
        key: 'switch-session',
        label: 'Switch session to vision model',
        value: VisionSwitchOutcome.SwitchSessionToVL,
      },
      {
        key: 'continue',
        label: 'Continue with current model',
        value: VisionSwitchOutcome.ContinueWithCurrentModel,
      },
    ];

    const callArgs = mockRadioButtonSelect.mock.calls[0][0];
    expect(callArgs.items).toEqual(expectedItems);
    expect(callArgs.initialIndex).toBe(0);
    expect(callArgs.isFocused).toBe(true);
  });

  it('should call onSelect when an option is selected', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const callArgs = mockRadioButtonSelect.mock.calls[0][0];
    expect(typeof callArgs.onSelect).toBe('function');

    // Simulate selection of "Switch for this request only"
    const onSelectCallback = mockRadioButtonSelect.mock.calls[0][0].onSelect;
    onSelectCallback(VisionSwitchOutcome.SwitchOnce);

    expect(mockOnSelect).toHaveBeenCalledWith(VisionSwitchOutcome.SwitchOnce);
  });

  it('should call onSelect with SwitchSessionToVL when second option is selected', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const onSelectCallback = mockRadioButtonSelect.mock.calls[0][0].onSelect;
    onSelectCallback(VisionSwitchOutcome.SwitchSessionToVL);

    expect(mockOnSelect).toHaveBeenCalledWith(
      VisionSwitchOutcome.SwitchSessionToVL,
    );
  });

  it('should call onSelect with ContinueWithCurrentModel when third option is selected', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const onSelectCallback = mockRadioButtonSelect.mock.calls[0][0].onSelect;
    onSelectCallback(VisionSwitchOutcome.ContinueWithCurrentModel);

    expect(mockOnSelect).toHaveBeenCalledWith(
      VisionSwitchOutcome.ContinueWithCurrentModel,
    );
  });

  it('should setup escape key handler to call onSelect with ContinueWithCurrentModel', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    expect(mockUseKeypress).toHaveBeenCalledWith(expect.any(Function), {
      isActive: true,
    });

    // Simulate escape key press
    const keypressHandler = mockUseKeypress.mock.calls[0][0];
    keypressHandler({ name: 'escape' });

    expect(mockOnSelect).toHaveBeenCalledWith(
      VisionSwitchOutcome.ContinueWithCurrentModel,
    );
  });

  it('should not call onSelect for non-escape keys', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const keypressHandler = mockUseKeypress.mock.calls[0][0];
    keypressHandler({ name: 'enter' });

    expect(mockOnSelect).not.toHaveBeenCalled();
  });

  it('should set initial index to 0 (first option)', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const callArgs = mockRadioButtonSelect.mock.calls[0][0];
    expect(callArgs.initialIndex).toBe(0);
  });

  describe('VisionSwitchOutcome enum', () => {
    it('should have correct enum values', () => {
      expect(VisionSwitchOutcome.SwitchOnce).toBe('once');
      expect(VisionSwitchOutcome.SwitchSessionToVL).toBe('session');
      expect(VisionSwitchOutcome.ContinueWithCurrentModel).toBe('persist');
    });
  });

  it('should handle multiple onSelect calls correctly', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const onSelectCallback = mockRadioButtonSelect.mock.calls[0][0].onSelect;

    // Call multiple times
    onSelectCallback(VisionSwitchOutcome.SwitchOnce);
    onSelectCallback(VisionSwitchOutcome.SwitchSessionToVL);
    onSelectCallback(VisionSwitchOutcome.ContinueWithCurrentModel);

    expect(mockOnSelect).toHaveBeenCalledTimes(3);
    expect(mockOnSelect).toHaveBeenNthCalledWith(
      1,
      VisionSwitchOutcome.SwitchOnce,
    );
    expect(mockOnSelect).toHaveBeenNthCalledWith(
      2,
      VisionSwitchOutcome.SwitchSessionToVL,
    );
    expect(mockOnSelect).toHaveBeenNthCalledWith(
      3,
      VisionSwitchOutcome.ContinueWithCurrentModel,
    );
  });

  it('should pass isFocused prop to RadioButtonSelect', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const callArgs = mockRadioButtonSelect.mock.calls[0][0];
    expect(callArgs.isFocused).toBe(true);
  });

  it('should handle escape key multiple times', () => {
    render(<ModelSwitchDialog onSelect={mockOnSelect} />);

    const keypressHandler = mockUseKeypress.mock.calls[0][0];

    // Call escape multiple times
    keypressHandler({ name: 'escape' });
    keypressHandler({ name: 'escape' });

    expect(mockOnSelect).toHaveBeenCalledTimes(2);
    expect(mockOnSelect).toHaveBeenCalledWith(
      VisionSwitchOutcome.ContinueWithCurrentModel,
    );
  });
});
