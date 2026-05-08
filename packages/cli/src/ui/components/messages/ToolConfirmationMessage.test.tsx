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
        contentWidth={80}
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
        contentWidth={80}
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
        contentWidth={80}
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
        alwaysAllowText: 'Always allow in this project',
      },
      {
        description: 'for info confirmations',
        details: infoConfirmationDetails,
        alwaysAllowText: 'Always allow in this project',
      },
      {
        description: 'for mcp confirmations',
        details: mcpConfirmationDetails,
        alwaysAllowText: 'Always allow in this project',
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
            contentWidth={80}
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
            contentWidth={80}
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
          contentWidth={80}
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
          contentWidth={80}
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

  describe('compactMode', () => {
    it('renders the command and exec-specific question for exec confirmations', () => {
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command: 'rm -f /tmp/foo.txt',
        rootCommand: 'rm',
        onConfirm: vi.fn(),
      };

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
          compactMode={true}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame).toContain('rm -f /tmp/foo.txt');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('Allow always');
      expect(frame).toContain('No');
      // Compact mode swaps the type-specific exec question for the
      // generic prompt (the body already shows the command) and trims
      // project/user-scope variants.
      expect(frame).not.toContain('Allow execution of:');
      expect(frame).not.toContain('Always allow in this project');
      expect(frame).not.toContain('Always allow for this user');
    });

    it('renders MCP server and tool name for mcp confirmations', () => {
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'mcp',
        title: 'Confirm MCP Tool',
        serverName: 'my-server',
        toolName: 'my-tool',
        toolDisplayName: 'My Tool',
        onConfirm: vi.fn(),
      };

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
          compactMode={true}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame).toContain('MCP Server: my-server');
      expect(frame).toContain('Tool: my-tool');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('Allow always');
      expect(frame).toContain('No');
      // Compact mode swaps the type-specific mcp question for the
      // generic prompt (the body already shows server + tool) and trims
      // project/user-scope variants.
      expect(frame).not.toContain('Allow execution of MCP tool');
      expect(frame).not.toContain('Always allow in this project');
      expect(frame).not.toContain('Always allow for this user');
    });

    it('caps multi-line exec body at 5 lines with overflow indicator', () => {
      const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`);
      const command = `cat <<'EOF'\n${lines.join('\n')}\nEOF`;
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command,
        rootCommand: 'cat',
        onConfirm: vi.fn(),
      };

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          availableTerminalHeight={50}
          contentWidth={80}
          compactMode={true}
        />,
      );

      const frame = lastFrame() ?? '';
      // Head of the command is preserved (so the user sees what's being
      // run); the heredoc tail elides behind the overflow indicator.
      expect(frame).toContain("cat <<'EOF'");
      expect(frame).toContain('Line 1');
      expect(frame).not.toContain('Line 8');
      expect(frame).not.toContain('Line 12');
      expect(frame).toMatch(/\.{3} last \d+ lines hidden \.{3}/);
    });
  });
});
