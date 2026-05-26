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

    // After the TUI display optimization, compact rendering is the only
    // path — plan-specific options ("Yes, and auto-accept edits", etc.)
    // collapse to the generic 3-option set, but the body still renders
    // the plan markdown and the title still drives the question line.
    expect(lastFrame()).toContain('Yes, allow once');
    expect(lastFrame()).toContain('Allow always');
    expect(lastFrame()).toContain('No');
    expect(lastFrame()).toContain('Would you like to proceed?');
    expect(lastFrame()).toContain('Implementation Plan');
    expect(lastFrame()).toContain('Step one');
  });

  describe('compact option set (post TUI display optimization)', () => {
    // After the TUI display optimization, every confirmation type renders
    // the same fixed 3-option set ("Yes, allow once" / "Allow always" /
    // "No") regardless of folder trust or per-type variants. Trust gating
    // on the "Allow always" outcome itself is now enforced upstream
    // (scheduler / settings), not by hiding the option here.
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
      },
      {
        description: 'for exec confirmations',
        details: execConfirmationDetails,
      },
      {
        description: 'for info confirmations',
        details: infoConfirmationDetails,
      },
      {
        description: 'for mcp confirmations',
        details: mcpConfirmationDetails,
      },
    ])('$description', ({ details }) => {
      it('renders the fixed compact 3-option set regardless of folder trust', () => {
        const trustedConfig = {
          isTrustedFolder: () => true,
          getIdeMode: () => false,
        } as unknown as Config;

        const { lastFrame: trustedFrame } = renderWithProviders(
          <ToolConfirmationMessage
            confirmationDetails={details}
            config={trustedConfig}
            availableTerminalHeight={30}
            contentWidth={80}
          />,
        );

        const trusted = trustedFrame() ?? '';
        expect(trusted).toContain('Yes, allow once');
        expect(trusted).toContain('Allow always');
        expect(trusted).toContain('No');
        // Project/user-scope variants no longer surface in the compact
        // 3-option set.
        expect(trusted).not.toContain('Always allow in this project');
        expect(trusted).not.toContain('Always allow for this user');

        const untrustedConfig = {
          isTrustedFolder: () => false,
          getIdeMode: () => false,
        } as unknown as Config;

        const { lastFrame: untrustedFrame } = renderWithProviders(
          <ToolConfirmationMessage
            confirmationDetails={details}
            config={untrustedConfig}
            availableTerminalHeight={30}
            contentWidth={80}
          />,
        );

        const untrusted = untrustedFrame() ?? '';
        // Same fixed option set whether trusted or not — trust gating
        // happens downstream of this component.
        expect(untrusted).toContain('Yes, allow once');
        expect(untrusted).toContain('Allow always');
        expect(untrusted).toContain('No');
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

    // After the TUI display optimization the compact 3-option set drops
    // "Modify with external editor" entirely (and the `preferredEditor`
    // setting therefore no longer surfaces in the inline banner). The
    // original tests gated visibility on that setting; the new behavior
    // is: it is never shown, regardless of `preferredEditor`.
    it('omits "Modify with external editor" even when preferredEditor is set', () => {
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

      expect(lastFrame()).not.toContain('Modify with external editor');
    });

    it('omits "Modify with external editor" when preferredEditor is not set', () => {
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

  // Note: The `describe('compactMode')` block was removed when the TUI
  // display optimization made compact rendering the only path. The
  // `compactMode` prop is now a deprecated no-op preserved for binary
  // compatibility with external fixtures; the renderer always behaves
  // as if it were `true`. Coverage for the compact body / question /
  // option-set is now folded into the `compact option set` describe
  // above and the always-on render path is the default for every other
  // test in this file.
});
