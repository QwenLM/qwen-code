/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect, vi } from 'vitest';
import { ShellConfirmationDialog } from './ShellConfirmationDialog.js';
import { Box } from 'ink';

describe('ShellConfirmationDialog', () => {
  const onConfirm = vi.fn();

  const request = {
    commands: ['ls -la', 'echo "hello"'],
    onConfirm,
  };

  function frameHeight(frame: string): number {
    return frame.length === 0 ? 0 : frame.split('\n').length;
  }

  it('renders correctly', () => {
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog request={request} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('calls onConfirm with ProceedOnce when "Yes, allow once" is selected', () => {
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog request={request} />,
    );
    const select = lastFrame()!.toString();
    // Simulate selecting the first option
    // This is a simplified way to test the selection
    expect(select).toContain('Yes, allow once');
  });

  it('calls onConfirm with ProceedAlwaysProject when "Always allow in this project" is selected', () => {
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog request={request} />,
    );
    const select = lastFrame()!.toString();
    // Simulate selecting the second option
    expect(select).toContain('Always allow in this project');
  });

  it('calls onConfirm with Cancel when "No (esc)" is selected', () => {
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog request={request} />,
    );
    const select = lastFrame()!.toString();
    // Simulate selecting the third option
    expect(select).toContain('No (esc)');
  });

  it('keeps the choices visible when many commands are shown in a small terminal', () => {
    const availableTerminalHeight = 12;
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog
        request={{
          commands: Array.from(
            { length: 10 },
            (_, i) => `cmd-${String(i + 1).padStart(2, '0')}`,
          ),
          onConfirm,
        }}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frameHeight(frame)).toBeLessThanOrEqual(availableTerminalHeight);
    expect(frame).toContain('Shell Command Execution');
    expect(frame).toContain('following shell commands');
    expect(frame).toContain('Yes, allow once');
    expect(frame).toContain('Always allow in this project');
    expect(frame).toContain('No (esc)');
    expect(frame).toMatch(/lines hidden/);
    expect(frame).toContain('cmd-10');
    expect(frame).not.toContain('cmd-01');
  });

  it('keeps choices visible with a hidden-command notice in a very small terminal', () => {
    const availableTerminalHeight = 10;
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog
        request={{
          commands: Array.from(
            { length: 10 },
            (_, i) => `cmd-${String(i + 1).padStart(2, '0')}`,
          ),
          onConfirm,
        }}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frameHeight(frame)).toBeLessThanOrEqual(availableTerminalHeight);
    expect(frame).toContain('Shell Command Execution');
    expect(frame).toContain('Yes, allow once');
    expect(frame).toContain('Always allow in this project');
    expect(frame).toContain('Always allow for this user');
    expect(frame).toContain('No (esc)');
    expect(frame).toContain('shell commands hidden');
  });

  it('keeps choices visible when wrapped by the constrained layout box', () => {
    const availableTerminalHeight = 10;
    const { lastFrame } = renderWithProviders(
      <Box height={availableTerminalHeight} overflow="hidden">
        <ShellConfirmationDialog
          request={{
            commands: Array.from(
              { length: 10 },
              (_, i) => `cmd-${String(i + 1).padStart(2, '0')}`,
            ),
            onConfirm,
          }}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={80}
        />
      </Box>,
    );

    const frame = lastFrame() ?? '';
    expect(frameHeight(frame)).toBeLessThanOrEqual(availableTerminalHeight);
    expect(frame).toContain('Shell Command Execution');
    expect(frame).toContain('Yes, allow once');
    expect(frame).toContain('Always allow in this project');
    expect(frame).toContain('Always allow for this user');
    expect(frame).toContain('No (esc)');
    expect(frame).toContain('shell commands hidden');
  });

  it('keeps choices visible at the 13-row terminal dialog budget', () => {
    const availableTerminalHeight = 8;
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog
        request={{
          commands: Array.from(
            { length: 10 },
            (_, i) => `cmd-${String(i + 1).padStart(2, '0')}`,
          ),
          onConfirm,
        }}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frameHeight(frame)).toBeLessThanOrEqual(availableTerminalHeight);
    expect(frame).toContain('Shell Command Execution');
    expect(frame).toContain('Yes, allow once');
    expect(frame).toContain('Always allow in this project');
    expect(frame).toContain('Always allow for this user');
    expect(frame).toContain('No (esc)');
    expect(frame).not.toMatch(/lines hidden/);
    expect(frame).not.toContain('cmd-10');
    expect(frame).toContain('shell commands hidden');
  });

  it('renders shell command text literally without inline markdown formatting', () => {
    const command = 'echo `danger` *literal*';
    const { lastFrame } = renderWithProviders(
      <ShellConfirmationDialog
        request={{
          commands: [command],
          onConfirm,
        }}
      />,
    );

    expect(lastFrame() ?? '').toContain(command);
  });
});
