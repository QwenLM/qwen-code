/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EOL } from 'node:os';
import { promises as fsp } from 'node:fs';
import { Box } from 'ink';

// Capture launches of the external editor so the full-plan viewer (#7001)
// can be asserted without spawning a real editor process.
const { launchEditorMock } = vi.hoisted(() => ({
  launchEditorMock: vi.fn((_filePath: string) => Promise.resolve()),
}));
vi.mock('../../hooks/useLaunchEditor.js', () => ({
  useLaunchEditor: () => launchEditorMock,
}));

import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import type {
  ToolCallConfirmationDetails,
  Config,
} from '@qwen-code/qwen-code-core';
import { IdeClient, ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
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

  // Regression coverage for issue #4093: exec confirmations carry a
  // user-facing warning for command substitution. Previously such
  // commands were hard-denied at L4 with an opaque "denied by
  // permission rules" message; we now ask for confirmation and surface
  // the substitution clearly.
  it('renders warnings on exec confirmations when provided', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: 'python3 -c "print($(echo hello))"',
      rootCommand: 'python3',
      warnings: [
        'Contains command substitution ($(...), backticks, <(...), or >(...)).',
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

    const frame = lastFrame() ?? '';
    expect(frame).toContain('command substitution');
  });

  it('omits the warning region when no warnings are provided on exec confirmations', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: 'echo hello',
      rootCommand: 'echo',
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

    expect(lastFrame() ?? '').not.toContain('command substitution');
  });

  // Regression coverage for the round-1 review on PR #4386 (PR #4386 round-2
  // self-review SR-1): the warnings block sits outside the MaxSizedBox
  // cap, so its footprint has to be reserved from `bodyContentHeight`
  // up-front; otherwise the options list can be pushed off-screen on
  // small terminals. The original round-1 test used a single-line
  // command, which made the `MaxSizedBox` clamp `min(content_lines,
  // maxHeight)` reduce to `min(1, X) = 1` regardless of the
  // reservation — i.e. the test was vacuous. Replaced here with a
  // multi-line command so the clamp is actually exercised, and the
  // assertion checks for the `... N lines hidden ...` truncation
  // footer that MaxSizedBox emits ONLY when its cap is active. Without
  // the warnings reservation, the cap is loose enough that the whole
  // command fits and the footer never appears.
  it('clamps the multi-line command body to make room for the warning on a tight compactMode layout', () => {
    // Four-line command: forces MaxSizedBox to clamp once the warnings
    // footprint is reserved. With the reservation: cap is tight enough
    // that the body is truncated and shows a "... N lines hidden ..."
    // footer. Without it: the whole 4-line command renders and the
    // footer is absent.
    const command = [
      'cmd-line-1',
      'cmd-line-2',
      'cmd-line-3',
      'cmd-line-4',
    ].join('\n');
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command,
      rootCommand: 'cmd-line-1',
      warnings: [
        'Contains command substitution ($(...), backticks, <(...), or >(...)).',
      ],
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={10}
        contentWidth={80}
        compactMode={true}
      />,
    );

    const frame = lastFrame() ?? '';
    // MaxSizedBox emits this footer when it clamps; its presence proves
    // the reservation actually narrowed the body cap below the command
    // height. Without `bodyContentHeight -= warningsHeight`, the cap is
    // loose and the footer doesn't appear.
    expect(frame).toMatch(/lines hidden/);
    // Warning + all three compactMode options must still be on-screen.
    expect(frame).toContain('command substitution');
    expect(frame).toContain('Yes, allow once');
    expect(frame).toContain('Allow always');
    expect(frame).toContain('No');
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

  describe('full-plan viewer (#7001)', () => {
    const plan = [
      '# Big Plan',
      ...Array.from({ length: 60 }, (_, i) => `- Step ${i + 1}`),
    ].join('\n');

    const planDetails = (onConfirm = vi.fn()): ToolCallConfirmationDetails => ({
      type: 'plan',
      title: 'Would you like to proceed?',
      plan,
      onConfirm,
    });

    it('shows the open-in-editor hint on plan confirmations', () => {
      launchEditorMock.mockClear();
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={planDetails()}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
      );
      expect(lastFrame()).toContain('o open full plan in editor');
    });

    it('`o` writes the FULL plan to a temp file and opens the editor without confirming', async () => {
      launchEditorMock.mockClear();
      const onConfirm = vi.fn();
      const { stdin } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={planDetails(onConfirm)}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
      );

      stdin.write('o');
      await vi.waitFor(() => expect(launchEditorMock).toHaveBeenCalledTimes(1));

      const openedPath = launchEditorMock.mock.calls[0]![0];
      // The staged file must contain the COMPLETE plan, not the truncated view.
      expect(await fsp.readFile(openedPath, 'utf-8')).toBe(plan);
      // Viewing the plan must not resolve the confirmation either way.
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('Ctrl+O does not open the editor', async () => {
      launchEditorMock.mockClear();
      const { stdin } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={planDetails()}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
      );
      stdin.write('\x0f'); // Ctrl+O
      await new Promise((r) => setTimeout(r, 50));
      expect(launchEditorMock).not.toHaveBeenCalled();
    });

    it('`o` is inert for non-plan confirmations', async () => {
      launchEditorMock.mockClear();
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt: 'https://example.com',
        urls: ['https://example.com'],
        onConfirm: vi.fn(),
      };
      const { stdin, lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
      );
      expect(lastFrame()).not.toContain('o open full plan in editor');
      stdin.write('o');
      await new Promise((r) => setTimeout(r, 50));
      expect(launchEditorMock).not.toHaveBeenCalled();
    });
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

    it('should NOT show "Modify with external editor" when hideModify is true', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{ ...editConfirmationDetails, hideModify: true }}
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

    it('renders edit warnings and honors hideAlwaysAllow on small terminals', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            hideAlwaysAllow: true,
            warnings: [
              'Unknown shell safety',
              'Exact shell command: sed -i s/a/b/ test.txt',
            ],
          }}
          config={mockConfig}
          availableTerminalHeight={10}
          contentWidth={50}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame).toContain('Unknown shell safety');
      expect(frame).toContain('Exact shell command');
      expect(frame).toContain('Yes, allow once');
      expect(frame).not.toContain('Yes, allow always');
    });

    it('budgets edit warnings using their rendered inner width', () => {
      const availableTerminalHeight = 11;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            fileDiff: '@@ -1 +1 @@\n-a\n+b',
            hideAlwaysAllow: true,
            hideModify: true,
            warnings: ['x'.repeat(44)],
          }}
          config={mockConfig}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={50}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame).toContain('x'.repeat(44));
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
    });

    it('keeps a multiline exact command visible within the body budget', () => {
      const availableTerminalHeight = 11;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            fileDiff: '@@ -1 +1 @@\n-a\n+b',
            hideAlwaysAllow: true,
            hideModify: true,
            warnings: [
              'Plan mode could not determine whether this command is read-only.',
              'Exact shell command: `printf a\nprintf b`',
            ],
          }}
          config={mockConfig}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={50}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame).toContain('Plan mode could not determine');
      expect(frame).toContain('Exact shell command');
      expect(frame).toContain('printf a ↵');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
    });

    it('budgets compact edit warnings at the wrapping boundary', () => {
      const availableTerminalHeight = 9;
      const { lastFrame } = renderWithProviders(
        <Box width={50}>
          <ToolConfirmationMessage
            confirmationDetails={{
              ...editConfirmationDetails,
              fileDiff: '@@ -1 +1 @@\n-a\n+b',
              hideAlwaysAllow: true,
              hideModify: true,
              warnings: ['x'.repeat(46), 'y'.repeat(46)],
            }}
            config={mockConfig}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={50}
            compactMode={true}
          />
        </Box>,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame).toContain('x'.repeat(46));
      expect(frame).toContain('y'.repeat(46));
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
    });

    it('keeps one-line compact bodies within the terminal height', () => {
      const availableTerminalHeight = 5;
      const { lastFrame } = renderWithProviders(
        <Box width={50}>
          <ToolConfirmationMessage
            confirmationDetails={{
              ...editConfirmationDetails,
              fileDiff: '@@ -1 +1 @@\n-a\n+b',
              hideAlwaysAllow: true,
              hideModify: true,
              warnings: [
                'Plan mode could not determine whether this command is read-only.',
                'Exact shell command: `printf a\nprintf b`',
              ],
            }}
            config={mockConfig}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={50}
            compactMode={true}
          />
        </Box>,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame).toContain('Exact shell command');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });

    it('keeps the diff placeholder visible without warnings on one-line bodies', () => {
      const availableTerminalHeight = 8;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            fileDiff: '@@ -1 +1 @@\n-a\n+b',
            hideAlwaysAllow: true,
            hideModify: true,
          }}
          config={mockConfig}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={50}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame).toContain('diff hidden');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
    });

    it('keeps compact edit warnings and diff within the available height', () => {
      const availableTerminalHeight = 9;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            fileDiff:
              '@@ -1,3 +1,3 @@\n-old one\n-old two\n+new one\n+new two\n context',
            hideAlwaysAllow: true,
            hideModify: true,
            warnings: [
              'Plan mode could not determine whether this shell command is read-only. Approval applies only to this exact invocation once.',
              `Exact shell command: \`python -c "${"open('result.txt', 'a').write('changed');".repeat(12)}"\``,
            ],
          }}
          config={mockConfig}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={50}
          compactMode={true}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      expect(frame).toContain('Plan mode could not determine');
      expect(frame).toContain('Exact shell command');
      expect(frame).toContain('lines hidden');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });

    it('resolves ordinary IDE edits but skips confirmations that have no IDE diff', async () => {
      const resolveDiffFromCli = vi.fn().mockResolvedValue(undefined);
      const isDiffingEnabled = vi.fn().mockReturnValue(true);
      const getInstanceSpy = vi
        .spyOn(IdeClient, 'getInstance')
        .mockResolvedValue({
          isDiffingEnabled,
          resolveDiffFromCli,
        } as unknown as IdeClient);
      const ideConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => true,
      } as unknown as Config;

      const ordinaryOnConfirm = vi.fn().mockResolvedValue(undefined);
      const ordinary = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            onConfirm: ordinaryOnConfirm,
          }}
          config={ideConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
      );
      await vi.waitFor(() => expect(isDiffingEnabled).toHaveBeenCalled());
      ordinary.stdin.write('\r');
      await vi.waitFor(() =>
        expect(resolveDiffFromCli).toHaveBeenCalledWith(
          '/test.txt',
          'accepted',
        ),
      );
      ordinary.unmount();

      resolveDiffFromCli.mockClear();
      isDiffingEnabled.mockClear();
      const skippedOnConfirm = vi.fn().mockResolvedValue(undefined);
      const skipped = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            ...editConfirmationDetails,
            onConfirm: skippedOnConfirm,
            skipIdeDiff: true,
          }}
          config={ideConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
      );
      await vi.waitFor(() => expect(isDiffingEnabled).toHaveBeenCalled());
      skipped.stdin.write('\r');
      await vi.waitFor(() =>
        expect(skippedOnConfirm).toHaveBeenCalledWith(
          ToolConfirmationOutcome.ProceedOnce,
        ),
      );
      expect(resolveDiffFromCli).not.toHaveBeenCalled();

      skipped.unmount();
      getInstanceSpy.mockRestore();
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

    it('honors hideAlwaysAllow', () => {
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command: 'rm -f /tmp/foo.txt',
        rootCommand: 'rm',
        hideAlwaysAllow: true,
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
      expect(frame).toContain('Yes, allow once');
      expect(frame).not.toContain('Allow always');
      expect(frame).toContain('No');
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
