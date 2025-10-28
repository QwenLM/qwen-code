/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EOL } from 'node:os';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import type {
  ToolCallConfirmationDetails,
  Config,
} from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import type { LoadedSettings } from '../../../config/settings.js';

describe('ToolConfirmationMessage', () => {
  const mockConfig = {
    isTrustedFolder: () => true,
    getIdeMode: () => false,
  } as unknown as Config;

  it('should not display urls if prompt and url are the same', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt: 'https://example.com',
      urls: ['https://example.com'],
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={30}
        terminalWidth={80}
      />,
    );

    expect(lastFrame()).not.toContain('URLs to fetch:');
  });

  it('should display urls if prompt and url are different', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt:
        'fetch https://github.com/google/gemini-react/blob/main/README.md',
      urls: [
        'https://raw.githubusercontent.com/google/gemini-react/main/README.md',
      ],
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={30}
        terminalWidth={80}
      />,
    );

    expect(lastFrame()).toContain('URLs to fetch:');
    expect(lastFrame()).toContain(
      '- https://raw.githubusercontent.com/google/gemini-react/main/README.md',
    );
  });

  it('should render plan confirmation with markdown plan content', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'plan',
      title: 'Would you like to proceed?',
      plan: '# Implementation Plan\n- Step one\n- Step two'.replace(/\n/g, EOL),
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={30}
        terminalWidth={80}
      />,
    );

    expect(lastFrame()).toContain('Yes, and auto-accept edits');
    expect(lastFrame()).toContain('Yes, and manually approve edits');
    expect(lastFrame()).toContain('No, keep planning');
    expect(lastFrame()).toContain('Implementation Plan');
    expect(lastFrame()).toContain('Step one');
  });

  describe('with folder trust', () => {
    const editConfirmationDetails: ToolCallConfirmationDetails = {
      type: 'edit',
      title: 'Confirm Edit',
      fileName: 'test.txt',
      filePath: '/test.txt',
      fileDiff: '...diff...',
      originalContent: 'a',
      newContent: 'b',
      onConfirm: vi.fn(),
    };

    const execConfirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'echo "hello"',
      rootCommand: 'echo',
      onConfirm: vi.fn(),
    };

    const infoConfirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt: 'https://example.com',
      urls: ['https://example.com'],
      onConfirm: vi.fn(),
    };

    const mcpConfirmationDetails: ToolCallConfirmationDetails = {
      type: 'mcp',
      title: 'Confirm MCP Tool',
      serverName: 'test-server',
      toolName: 'test-tool',
      toolDisplayName: 'Test Tool',
      onConfirm: vi.fn(),
    };

    describe.each([
      {
        description: 'for edit confirmations',
        details: editConfirmationDetails,
        alwaysAllowText: 'Yes, allow always',
      },
      {
        description: 'for exec confirmations',
        details: execConfirmationDetails,
        alwaysAllowText: 'Yes, allow always',
      },
      {
        description: 'for info confirmations',
        details: infoConfirmationDetails,
        alwaysAllowText: 'Yes, allow always',
      },
      {
        description: 'for mcp confirmations',
        details: mcpConfirmationDetails,
        alwaysAllowText: 'always allow',
      },
    ])('$description', ({ details, alwaysAllowText }) => {
      it('should show "allow always" when folder is trusted', () => {
        const mockConfig = {
          isTrustedFolder: () => true,
          getIdeMode: () => false,
        } as unknown as Config;

        const { lastFrame } = renderWithProviders(
          <ToolConfirmationMessage
            confirmationDetails={details}
            config={mockConfig}
            availableTerminalHeight={30}
            terminalWidth={80}
          />,
        );

        expect(lastFrame()).toContain(alwaysAllowText);
      });

      it('should NOT show "allow always" when folder is untrusted', () => {
        const mockConfig = {
          isTrustedFolder: () => false,
          getIdeMode: () => false,
        } as unknown as Config;

        const { lastFrame } = renderWithProviders(
          <ToolConfirmationMessage
            confirmationDetails={details}
            config={mockConfig}
            availableTerminalHeight={30}
            terminalWidth={80}
          />,
        );

        expect(lastFrame()).not.toContain(alwaysAllowText);
      });
    });
  });

  describe('external editor option', () => {
    const editConfirmationDetails: ToolCallConfirmationDetails = {
      type: 'edit',
      title: 'Confirm Edit',
      fileName: 'test.txt',
      filePath: '/test.txt',
      fileDiff: '...diff...',
      originalContent: 'a',
      newContent: 'b',
      onConfirm: vi.fn(),
    };

    it('should show "Modify with external editor" when preferredEditor is set', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          terminalWidth={80}
        />,
        {
          settings: {
            merged: { general: { preferredEditor: 'vscode' } },
          } as unknown as LoadedSettings,
        },
      );

      expect(lastFrame()).toContain('Modify with external editor');
    });

    it('should NOT show "Modify with external editor" when preferredEditor is not set', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          terminalWidth={80}
        />,
        {
          settings: {
            merged: { general: {} },
          } as unknown as LoadedSettings,
        },
      );

      expect(lastFrame()).not.toContain('Modify with external editor');
    });
  });
});
