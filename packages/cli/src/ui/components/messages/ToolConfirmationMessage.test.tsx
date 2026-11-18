/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EOL } from 'node:os';
import { promises as fsp } from 'node:fs';
import { Box, Text } from 'ink';
import type React from 'react';

// Capture launches of the external editor so the full-plan viewer (#7001)
// can be asserted without spawning a real editor process.
const { launchEditorMock, isEditorAvailableMock } = vi.hoisted(() => ({
  launchEditorMock: vi.fn((_filePath: string) => Promise.resolve()),
  // Editor availability probes PATH for a real binary (`command -v code`),
  // so leaving it unstubbed would make these tests depend on whether the
  // host happens to have the configured editor installed. Default to
  // "configured means available" and opt out per test. The detection itself
  // is covered by packages/core/src/utils/editor.test.ts.
  isEditorAvailableMock: vi.fn((editor: string | undefined) => Boolean(editor)),
}));
vi.mock('../../hooks/useLaunchEditor.js', () => ({
  useLaunchEditor: () => launchEditorMock,
}));
vi.mock('@qwen-code/qwen-code-core/utils/editor.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/qwen-code-core/utils/editor.js')
    >();
  return {
    ...actual,
    isEditorAvailable: isEditorAvailableMock,
  };
});

import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import type {
  ToolCallConfirmationDetails,
  Config,
} from '@qwen-code/qwen-code-core';
import { IdeClient, ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import {
  renderWithProviders,
  withProviders,
} from '../../../test-utils/render.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { render } from 'ink-testing-library';
import { act, useEffect } from 'react';
import { useKeypressContext } from '../../contexts/KeypressContext.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { ContextMenuOverlay } from '../../context-menu/ContextMenuOverlay.js';
import {
  ContextMenuProvider,
  useContextMenu,
  type ContextMenuContextValue,
} from '../../context-menu/ContextMenuContext.js';
import {
  OverflowProvider,
  useOverflowState,
} from '../../contexts/OverflowContext.js';

// Prints the global hidden-content count so the ctrl+s reveal shortcut can be
// asserted: ShowMoreLines only renders when that set is non-empty.
const OverflowProbe: React.FC = () => {
  const state = useOverflowState();
  return <Text>{`overflowing:${state ? state.overflowingIds.size : -1}`}</Text>;
};

// ink flushes the post-effect re-render on its own throttle, which can take
// longer than any fixed sleep under load, so poll for the expected frame with
// a bounded timeout instead.
const WAIT_FOR_FRAME = { timeout: 2000, interval: 10 };

describe('ToolConfirmationMessage', () => {
  // The tree is wrapped in the real ContextMenuProvider (as DefaultAppLayout
  // does) and `MenuProbe` captures its API so a case can open the menu the way
  // ContentMouseController does on a right-click.
  let menuApi: ContextMenuContextValue | null = null;
  const MenuProbe = () => {
    menuApi = useContextMenu();
    return null;
  };

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

  it('preserves urls when the prompt is rendered as plain text', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Hook confirmation',
      prompt: 'Review the literal target',
      urls: ['https://example.com/target'],
      renderPromptAsPlainText: true,
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

    expect(lastFrame()).toContain('Review the literal target');
    expect(lastFrame()).toContain('URLs to fetch:');
    expect(lastFrame()).toContain('- https://example.com/target');
  });

  it('renders plain-text info prompts without interpreting Markdown or links', () => {
    const prompt =
      'Save "[visible](https://hidden.example/target) **bold** `code` <u>under</u>"';
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Hook confirmation',
      prompt,
      renderPromptAsPlainText: true,
      hideAlwaysAllow: true,
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={30}
        contentWidth={160}
      />,
    );

    expect(lastFrame()).toContain(prompt);
    expect(lastFrame()).not.toContain('\u001b]8;;');
  });

  it('renders every line of a short multiline plain-text info prompt', () => {
    const prompt =
      'Save this exact content to the bound Mem0 repository memory?\n"LINK [visible label](https://hidden.example/secret-target) BOLD **bold-value** CODE `code-value` UNDER <u>under-value</u>"';
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Hook confirmation',
      prompt,
      renderPromptAsPlainText: true,
      hideAlwaysAllow: true,
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={10}
        contentWidth={98}
      />,
    );

    expect(lastFrame()).toContain(
      'Save this exact content to the bound Mem0 repository memory?',
    );
    expect(lastFrame()).toContain(
      '"LINK [visible label](https://hidden.example/secret-target) BOLD **bold-value** CODE',
    );
    expect(lastFrame()).toContain('`code-value` UNDER <u>under-value</u>"');
  });

  it('marks overflow in constrained plain-text info prompts', () => {
    const prompt = `Confirm exact content:\n${JSON.stringify(
      [
        'PROMPT_TOP',
        ...Array.from({ length: 80 }, (_, index) => `line-${index}`),
        'PROMPT_TAIL',
      ].join('\n'),
    )}`;
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Hook confirmation',
      prompt,
      renderPromptAsPlainText: true,
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={12}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('PROMPT_TOP');
    expect(frame).toMatch(/last \d+ lines hidden/);
    expect(frame).not.toContain('PROMPT_TAIL');
  });

  it('renders the complete plain-text info prompt when unconstrained', () => {
    const prompt = `Confirm exact content:\n${JSON.stringify(
      [
        'PROMPT_TOP',
        ...Array.from({ length: 80 }, (_, index) => `line-${index}`),
        'PROMPT_TAIL',
      ].join('\n'),
    )}`;
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: 'Hook confirmation',
      prompt,
      renderPromptAsPlainText: true,
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('PROMPT_TOP');
    expect(frame).toContain('PROMPT_TAIL');
    expect(frame).not.toContain('lines hidden');
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

  it('renders classifier fallback guidance and the Default Mode option', async () => {
    const onConfirm = vi.fn();
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: 'touch /tmp/marker',
      rootCommand: 'touch',
      hideAlwaysAllow: true,
      autoModeFallback: {
        reason: 'classifier_unavailable',
        message:
          "Auto Mode couldn't classify this action. Switching to Default Mode is recommended.",
      },
      onConfirm,
    };

    const { lastFrame, stdin } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={12}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain("Auto Mode couldn't classify this action");
    expect(frame).toContain(
      'Switch to Default Mode and allow once (recommended)',
    );
    expect(frame).not.toContain('Always allow');

    stdin.write('\x1b[B');
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
      ),
    );
  });

  it('renders blocked retry guidance without offering a mode switch', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: 'touch /tmp/marker',
      rootCommand: 'touch',
      hideAlwaysAllow: true,
      autoModeFallback: {
        reason: 'classifier_blocked_retry',
        message: 'This exact action was previously blocked.',
      },
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={12}
        contentWidth={80}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('This exact action was previously blocked.');
    expect(frame).toContain('Yes, allow once');
    expect(frame).not.toContain('Switch to Default Mode');
    expect(frame).not.toContain('Always allow');
  });

  it('offers a mode switch after consecutive classifier failures', () => {
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: 'touch /tmp/marker',
      rootCommand: 'touch',
      hideAlwaysAllow: true,
      autoModeFallback: {
        reason: 'consecutive_unavailable',
        message: 'Auto Mode could not classify consecutive actions.',
      },
      onConfirm: vi.fn(),
    };

    const { lastFrame } = renderWithProviders(
      <ToolConfirmationMessage
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        availableTerminalHeight={12}
        contentWidth={80}
      />,
    );

    expect(lastFrame() ?? '').toContain(
      'Switch to Default Mode and allow once (recommended)',
    );
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
    // the warnings actually took rows away from the command body. Without
    // that reservation the grant is looser and the footer does not appear.
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

    describe('unguarded entrances', () => {
      const infoDetails = (
        onConfirm: ToolCallConfirmationDetails['onConfirm'] = vi.fn(),
      ): ToolCallConfirmationDetails => ({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt: 'https://example.com',
        urls: ['https://example.com'],
        onConfirm,
      });

      const planDetails = (
        onConfirm: ToolCallConfirmationDetails['onConfirm'] = vi.fn(),
      ): ToolCallConfirmationDetails => ({
        type: 'plan',
        title: 'Would you like to proceed?',
        plan: '# Plan\n- Step 1',
        onConfirm,
      });

      const renderWith = (
        trusted: boolean,
        details: ToolCallConfirmationDetails,
        compactMode = false,
      ) => {
        const config = {
          isTrustedFolder: () => trusted,
          getIdeMode: () => false,
        } as unknown as Config;
        return renderWithProviders(
          <ToolConfirmationMessage
            confirmationDetails={details}
            config={config}
            availableTerminalHeight={30}
            contentWidth={80}
            compactMode={compactMode}
          />,
        );
      };

      it('compactMode offers "Allow always" only in a trusted folder', () => {
        expect(renderWith(true, infoDetails(), true).lastFrame()).toContain(
          'Allow always',
        );
        const untrusted = renderWith(false, infoDetails(), true).lastFrame();
        expect(untrusted).toContain('Yes, allow once');
        expect(untrusted).not.toContain('Allow always');
      });

      it('plan exit offers auto-accept only in a trusted folder', () => {
        expect(renderWith(true, planDetails()).lastFrame()).toContain(
          'Yes, and auto-accept edits',
        );
        const untrusted = renderWith(false, planDetails()).lastFrame();
        // Both remaining exits must survive: the gate admits DEFAULT and PLAN.
        expect(untrusted).toContain('Yes, and manually approve edits');
        expect(untrusted).toContain('restore previous mode');
        expect(untrusted).not.toContain('Yes, and auto-accept edits');
      });

      it('subscribes to the promise onConfirm returns instead of letting it float', async () => {
        // A floating rejection reaches the process-level handler (llm.tsx) and
        // shows a "file a bug report" banner over a correctly-refused action,
        // so the call site must consume what onConfirm returns. Asserted via a
        // thenable: `Promise.resolve(x).catch(...)` subscribes through `then`,
        // a bare `onConfirm(outcome)` statement never does.
        const then = vi.fn();
        const thenable = { then } as unknown as Promise<void>;
        const onConfirm = vi.fn(() => thenable);
        const { stdin } = renderWith(true, infoDetails(onConfirm));

        stdin.write('\r');

        await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
        expect(then).toHaveBeenCalled();
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
    const execConfirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'echo hello',
      rootCommand: 'echo',
      onConfirm: vi.fn(),
    };
    const preferredEditorSettings = {
      merged: { general: { preferredEditor: 'vscode' } },
    } as unknown as LoadedSettings;

    it('should show "Modify with external editor" when preferredEditor is set', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;
      isEditorAvailableMock.mockClear();

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
        { settings: preferredEditorSettings },
      );

      expect(lastFrame()).toContain('Modify with external editor');
      expect(isEditorAvailableMock).toHaveBeenCalledWith('vscode');
    });

    it('probes editor availability once for the dialog lifetime', () => {
      isEditorAvailableMock.mockClear();

      const component = (height: number) => (
        <ToolConfirmationMessage
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={height}
          contentWidth={80}
        />
      );
      const { lastFrame, rerender } = renderWithProviders(component(30), {
        settings: preferredEditorSettings,
      });

      expect(lastFrame()).toContain('Modify with external editor');
      expect(isEditorAvailableMock).toHaveBeenCalledTimes(1);

      // A terminal resize re-renders the dialog; the availability probe shells
      // out, so it must not run again.
      rerender(
        withProviders(component(31), { settings: preferredEditorSettings }),
      );

      expect(lastFrame()).toContain('Modify with external editor');
      expect(isEditorAvailableMock).toHaveBeenCalledTimes(1);
    });

    // #10745: the option was offered whenever `preferredEditor` was merely
    // set, so picking it tried to launch a binary that is not installed and
    // the modify flow failed. Offer it only when the editor is available.
    it('should NOT show "Modify with external editor" when the configured editor is unavailable', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;
      isEditorAvailableMock.mockClear();
      isEditorAvailableMock.mockReturnValueOnce(false);

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
        { settings: preferredEditorSettings },
      );

      expect(lastFrame()).toContain('Yes, allow once');
      expect(lastFrame()).not.toContain('Modify with external editor');
    });

    it('should NOT show "Modify with external editor" when preferredEditor is not set', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;
      isEditorAvailableMock.mockClear();

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

      expect(isEditorAvailableMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain('Modify with external editor');
    });

    it('should NOT show "Modify with external editor" when hideModify is true', () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getIdeMode: () => false,
      } as unknown as Config;
      isEditorAvailableMock.mockClear();

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{ ...editConfirmationDetails, hideModify: true }}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
        { settings: preferredEditorSettings },
      );

      expect(isEditorAvailableMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain('Modify with external editor');
    });

    it('should NOT probe editor availability in compactMode', () => {
      isEditorAvailableMock.mockClear();

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
          compactMode={true}
        />,
        { settings: preferredEditorSettings },
      );

      expect(lastFrame()).toContain('Yes, allow once');
      expect(isEditorAvailableMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain('Modify with external editor');
    });

    it('should NOT probe editor availability for a non-edit confirmation', () => {
      isEditorAvailableMock.mockClear();

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={execConfirmationDetails}
          config={mockConfig}
          availableTerminalHeight={30}
          contentWidth={80}
        />,
        { settings: preferredEditorSettings },
      );

      expect(lastFrame()).toContain('Yes, allow once');
      expect(isEditorAvailableMock).not.toHaveBeenCalled();
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
      // The warnings cannot keep their wrapped text inside the compact ceiling,
      // so each is cut to one truncated row and the diff keeps the rows left
      // over, clipped with its own counted footer.
      expect(frame).toContain('Plan mode could not determine');
      expect(frame).toContain('Exact shell command');
      expect(frame).toContain('lines hidden');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });

    it('announces an edit diff dropped to a two-row body budget', async () => {
      // Surrounding chrome for this shape is seven rows (two outer padding, one
      // body margin, the question, its margin, two options), so nine rows leave
      // a two-row body: one row for the warning, one for the announcement.
      const availableTerminalHeight = 9;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                ...editConfirmationDetails,
                fileDiff: '@@ -1 +1 @@\n-a\n+b',
                hideAlwaysAllow: true,
                hideModify: true,
                warnings: ['Unknown shell safety'],
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toMatch(/\.\.\. diff hidden \.\.\./);
        expect(frame).toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      expect(frame).toContain('Unknown shell safety');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
    });

    it('counts the edit warnings a one-row body budget drops whole', async () => {
      // Eight rows leave a one-row body and the diff is the thing being
      // authorised, so it keeps that row. Both warnings go — every row of them,
      // not just their tails — and the count rides the row that survived so the
      // removal is announced rather than silent.
      const availableTerminalHeight = 8;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                ...editConfirmationDetails,
                fileDiff: '@@ -1 +1 @@\n-a\n+b',
                hideAlwaysAllow: true,
                hideModify: true,
                warnings: [
                  'Unknown shell safety',
                  'Exact shell command: sed -i s/a/b/ test.txt',
                ],
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toMatch(/\+2 warning\(s\) hidden/);
        // One id for the diff that has no room to render, one for the warnings
        // dropped with no row of their own to say so.
        expect(frame).toMatch(/overflowing:[1-9]/);
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      expect(frame).toContain('... diff hidden ...');
      expect(frame).not.toContain('Exact shell command:');
      expect(frame).not.toContain('Unknown shell safety');
      expect(frame).toContain('Apply this change?');
      expect(frame).toContain('Yes, allow once');
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
    it('keeps classifier fallback guidance and all choices visible', () => {
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command: 'touch /tmp/marker',
        rootCommand: 'touch',
        hideAlwaysAllow: true,
        autoModeFallback: {
          reason: 'classifier_unavailable',
          message:
            "Auto Mode couldn't classify this action. Switching to Default Mode is recommended.",
        },
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
      expect(frame).toContain("Auto Mode couldn't classify this action");
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain(
        'Switch to Default Mode and allow once (recommended)',
      );
      expect(frame).toContain('No');
      expect(frame).not.toContain('Allow always');
    });

    it('budgets the two-option blocked retry layout on a tight terminal', () => {
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command: ['line-1', 'line-2', 'line-3', 'line-4'].join('\n'),
        rootCommand: 'line-1',
        hideAlwaysAllow: true,
        autoModeFallback: {
          reason: 'classifier_blocked_retry',
          message: 'This exact action was previously blocked.',
        },
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
      expect(frame.split(EOL).length).toBeLessThanOrEqual(10);
      expect(frame).toContain('previously blocked');
      expect(frame).toContain('line-1');
      expect(frame).toContain('line-4');
      expect(frame).not.toContain('hidden');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
      expect(frame).not.toContain('Switch to Default Mode');
      expect(frame).not.toContain('Allow always');
    });

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

    it('keeps a five-line compact command whole on a tall terminal', () => {
      const command = [
        'npm run deploy \\',
        '  --dry-run \\',
        '  --verbose \\',
        '  --project=prod \\',
        '  --force',
      ].join('\n');
      const confirmationDetails: ToolCallConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command,
        rootCommand: 'npm',
        hideAlwaysAllow: true,
        onConfirm: vi.fn(),
      };

      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          availableTerminalHeight={40}
          contentWidth={50}
          compactMode={true}
        />,
      );

      const frame = lastFrame() ?? '';
      // The compact ceiling replaces the terminal-sized grant, it does not
      // borrow rows out of it: the chrome was already charged, so a command
      // exactly as tall as the ceiling keeps every row and pays no footer.
      expect(frame).toContain('npm run deploy');
      expect(frame).toContain('--force');
      expect(frame).not.toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });
  });

  // A body taller than the dialog's height budget pushes the question line and
  // the option list out of the viewport, so the user decides blind.
  describe('keeps the question and options inside the height budget', () => {
    const longPrompt = Array.from(
      { length: 40 },
      (_, i) => `finding ${i + 1}`,
    ).join('\n\n');

    it('caps exec warnings and the command they squeeze into one row', async () => {
      // Seven rows of chrome (two outer padding, one body margin, the question,
      // its margin, two options) leave a five-row body. Five one-row warnings
      // cannot all fit that, so the box is capped with a counted footer and the
      // command keeps the row left over as a pinned truncated row. Uncapped and
      // unpinned, the same input puts seven body rows under a five-row cap, and
      // the cap answers by compressing rows onto each other.
      //
      // The warning box cuts its head, not its tail: the warning naming the
      // exact action is the last one and the one that changes the approval, so
      // it is the row that has to survive a cut.
      const availableTerminalHeight = 12;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'exec',
                title: 'Confirm Shell Command',
                command: 'npm run deploy -- --dry-run --verbose --project=prod',
                rootCommand: 'npm',
                hideAlwaysAllow: true,
                warnings: [
                  'warning one: writes to production',
                  'warning two: outside workspace',
                  'warning three: network access',
                  'warning four: reads secrets',
                  'warning five: deletes state',
                ],
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toMatch(/first \d+ lines hidden/);
        expect(frame).toMatch(/overflowing:[1-9]/);
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      // A contiguous block of the warnings, counted, with the tail of the list
      // intact: the dropped rows are the earlier mode warnings.
      expect(frame).toContain('warning three: network access');
      expect(frame).toContain('warning five: deletes state');
      expect(frame).not.toContain('warning one: writes to production');
      // The command keeps a row and says the rest continues; it was squeezed to
      // one pinned truncated row, not dropped and not left as blank rows.
      expect(frame).toContain('npm run deploy');
      expect(frame).not.toContain('--project=prod');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No, suggest changes (esc)');
    });

    it('keeps the command row when one warning takes the whole body budget', async () => {
      // Eight rows of chrome leave a one-row body, and the warning used to take
      // it: the command fell to zero rows and disappeared, leaving
      // `Yes, allow once` answering a command the user never saw. The command is
      // the thing being authorised, so it keeps the row and says what went.
      const availableTerminalHeight = 8;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'exec',
                title: 'Confirm Shell Command',
                command: 'npm run deploy -- --dry-run --verbose --project=prod',
                rootCommand: 'npm',
                hideAlwaysAllow: true,
                warnings: ['warning one: writes to production'],
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('npm run deploy');
        expect(frame).toMatch(/overflowing:[1-9]/);
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // The warning that gave up its row is counted on the row that kept it, so
      // the removal is visible and not merely registered.
      expect(frame).toContain('+1 warning(s) hidden');
      expect(frame).not.toContain('warning one');
      expect(frame).not.toContain('--project=prod');
      expect(frame).toContain("Allow execution of: 'npm'?");
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No, suggest changes (esc)');
    });

    it('keeps the command row in a compact exec whose warnings take the body', async () => {
      // The compact ceiling replaces the grant rather than charging the chrome
      // twice, so a four-row compact exec also lands on a one-row body. Same
      // invariant at the other chrome tier: the command survives, truncated and
      // registered, and it carries the warning count.
      const availableTerminalHeight = 4;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'exec',
                title: 'Confirm Shell Command',
                command: 'npm run deploy -- --dry-run --verbose --project=prod',
                rootCommand: 'npm',
                hideAlwaysAllow: true,
                warnings: ['warning one: writes to production'],
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
              compactMode={true}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('npm run deploy');
        expect(frame).toMatch(/overflowing:[1-9]/);
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      expect(frame).toContain('+1 warning(s) hidden');
      expect(frame).not.toContain('warning one');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });

    it('announces an exec command the body budget shrinks to a single row', async () => {
      // The floor of the body grant is one row, and with no warnings that row
      // is the command's. `MaxSizedBox` cannot honour a one-row ask — its floor
      // is two rows and one goes to its own footer — so the cue here is a
      // pinned truncated row that registers the truncation.
      const availableTerminalHeight = 8;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'exec',
                title: 'Confirm Shell Command',
                command: 'npm run deploy -- --dry-run --verbose --project=prod',
                rootCommand: 'npm',
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('npm run deploy');
        expect(frame).toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      expect(frame).not.toContain('--project=prod');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No, suggest changes (esc)');
    });

    it('caps a long inline-Markdown info prompt', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm',
            prompt: longPrompt,
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      expect(frame).toContain('finding 1');
      expect(frame).toContain('finding 2');
      expect(frame).not.toContain('finding 40');
      expect(frame).toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No, suggest changes (esc)');
    });

    it('caps a long destination list to a contiguous prefix', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: 'fetch every page below',
            urls: Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`),
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No, suggest changes (esc)');
      // The destinations are what is being authorised, so a clipped list must
      // still show some of them, from the head of the list, and say how many
      // are missing. Rows used to be compressed instead of cut, which rendered
      // a scattered sample (e.com/6, /14, /22) that reads as a tail cut.
      expect(frame).toContain('URLs to fetch:');
      const shownUrls = frame.match(/https:\/\/e\.com\/\d+/g) ?? [];
      expect(shownUrls.length).toBeGreaterThan(0);
      // The whole shown list has to be the prefix, not just its first entry: a
      // compressed sample (/0, /7, /14) keeps the head and the absent tail yet
      // reads as a list the user can extrapolate.
      expect(shownUrls).toEqual(shownUrls.map((_, i) => `https://e.com/${i}`));
      // And the marker counts exactly what that prefix left out.
      const hiddenUrls = Number(
        frame.match(/\.\.\. (\d+) more URLs hidden \.\.\./)?.[1],
      );
      expect(hiddenUrls).toBe(30 - shownUrls.length);
    });

    it('keeps the destinations when a long prose prompt competes with them', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: ['https://example.com/deep/target'],
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // The prose used to claim the whole budget and evict the block that
      // names the host being fetched from.
      expect(frame).toContain('URLs to fetch:');
      expect(frame).toContain('https://example.com/deep/target');
      expect(frame).toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
    });

    it('announces a plain-text prompt dropped to make room for destinations', async () => {
      const availableTerminalHeight = 11;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'info',
                title: 'Confirm Web Fetch',
                prompt: longPrompt,
                renderPromptAsPlainText: true,
                urls: ['https://example.com/deep/target'],
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        expect(lastFrame() ?? '').toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // The probe prints a row of its own, so the dialog keeps one row of slack.
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      // A one-row prose budget cannot hold a MaxSizedBox plus its footer, so the
      // prose is dropped whole. The announcement says a whole prompt went, not
      // that some of its rows did, and it registers the reveal that gets it
      // back: silently vanishing text is what made the first fix hard to trust.
      expect(frame).not.toContain('finding 1');
      expect(frame).toMatch(/\.\.\. prompt hidden \.\.\./);
      expect(frame).not.toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('URLs to fetch:');
      expect(frame).toContain('https://example.com/deep/target');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
    });

    it('gives the last row to the destinations when the prose has none', () => {
      const availableTerminalHeight = 11;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`),
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // No prose row survives here, and a marker for the prose would have cost
      // the destinations their own marker — the extra row pushed it past the cap
      // and Ink cut it off, hiding the count that matters most. The positive
      // witness is where the destinations' count sits: it owns the body's last
      // row, with only the margin between it and the question.
      expect(frame).not.toContain('finding 1');
      expect(frame).not.toMatch(/last \d+ lines hidden/);
      const lines = frame.split(EOL);
      const urlMarkerRow = lines.findIndex((line) =>
        /more URLs hidden/.test(line),
      );
      const questionRow = lines.findIndex((line) =>
        line.includes('Do you want to proceed?'),
      );
      expect(urlMarkerRow).toBeGreaterThan(-1);
      expect(questionRow).toBeGreaterThan(urlMarkerRow);
      expect(
        lines
          .slice(urlMarkerRow + 1, questionRow)
          .join('')
          .trim(),
      ).toBe('');
      expect(frame).toContain('https://e.com/0');
      expect(frame).toContain('Do you want to proceed?');
    });

    it('still shows a plain-text prompt that fits a one-row budget', () => {
      const availableTerminalHeight = 8;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: 'Summarise the fetched page for a maintainer.',
            renderPromptAsPlainText: true,
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // MaxSizedBox floors its own ceiling at MINIMUM_MAX_HEIGHT, but a body
      // that needs no footer still fits in one row. The floor only justifies
      // dropping content that would have been clipped anyway.
      expect(frame).toContain('Summarise the fetched page for a maintainer.');
      expect(frame).not.toMatch(/last \d+ lines? hidden/);
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
    });

    it('shows a destination that wraps instead of reporting it hidden', () => {
      const availableTerminalHeight = 11;
      const wrappedUrl =
        'https://example.com/api/v1/export?signature=abcdef0123456789abcdef';
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: [wrappedUrl],
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // The list holds one destination that needs two wrapped rows, which is
      // exactly what is left after the label. Charging a marker row before
      // asking whether anything survives used to hide the only host and still
      // announce it as hidden.
      expect(frame).toContain('https://example.com/api/v1/export');
      expect(frame).not.toMatch(/more URLs? hidden/);
      expect(frame).toContain('Do you want to proceed?');
    });

    it('keeps a host on screen when the body budget is three rows', () => {
      const availableTerminalHeight = 10;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`),
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // Blank row, label, one host, marker. Handing back the blank row is what
      // keeps a host on screen; a label over an empty list answers nothing.
      expect(frame).toContain('URLs to fetch:');
      expect(frame).toContain('https://e.com/0');
      expect(frame).toContain('... 29 more URLs hidden ...');
      expect(frame).toContain('Do you want to proceed?');
    });

    it('keeps a host on screen when the body budget is two rows', () => {
      const availableTerminalHeight = 9;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`),
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // Down to its last two rows the block drops its own label before it
      // drops a destination: the host is the thing being authorised.
      expect(frame).not.toContain('URLs to fetch:');
      expect(frame).toContain('https://e.com/0');
      expect(frame).not.toContain('finding 1');
      expect(frame).toContain('Yes, allow once');
    });

    it('announces a destination list no whole URL fits into', async () => {
      const availableTerminalHeight = 9;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'info',
                title: 'Confirm Web Fetch',
                prompt: 'fetch both exports below',
                urls: [
                  'https://example.com/api/v1/export?signature=abcdef0123456789',
                  'https://example.com/api/v1/export?signature=fedcba9876543210',
                ],
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toMatch(/\.\.\. 2 more URLs hidden \.\.\./);
        expect(frame).toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // Two body rows, and neither can hold one of these destinations whole. The
      // block still spends a row on the count instead of disappearing, so the
      // dialog never offers approval for hosts that appear nowhere on screen.
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      expect(frame).not.toContain('https://example.com/api');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
    });

    it('renders every destination that fits instead of sampling them', () => {
      const availableTerminalHeight = 11;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: ['https://e.com/0', 'https://e.com/1', 'https://e.com/2'],
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // Four body rows, three one-row destinations and a label: the list fits
      // once the blank row is handed back, so charging a footer row first would
      // have announced two destinations as hidden that were on screen.
      expect(frame).toContain('URLs to fetch:');
      expect(frame).toContain('https://e.com/0');
      expect(frame).toContain('https://e.com/1');
      expect(frame).toContain('https://e.com/2');
      expect(frame).not.toMatch(/more URLs? hidden/);
      expect(frame).toContain('Do you want to proceed?');
    });

    it('says one URL when a single destination is hidden', () => {
      const availableTerminalHeight = 9;
      const wrappedUrl =
        'https://example.com/api/v1/export?signature=abcdef0123456789abcdef';
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm Web Fetch',
            prompt: longPrompt,
            urls: ['https://e.com/0', wrappedUrl],
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      const singular = (frame.match(/\.\.\. 1 more URL hidden \.\.\./g) ?? [])
        .length;
      const plural = (frame.match(/\.\.\. \d+ more URLs hidden \.\.\./g) ?? [])
        .length;
      expect(singular).toBe(1);
      expect(plural).toBe(0);
    });

    it('counts an inline-Markdown prompt by what it renders', () => {
      const availableTerminalHeight = 8;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm',
            prompt: '**Fetch** **the** **Q4** **report** **today!**',
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
          }}
          config={mockConfig}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={40}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      // Emphasis is stripped by the renderer: this prompt is one row wide once
      // it is on screen, two rows wide in Markdown source. Counting the source
      // spends the budget on rows the user never sees and reports a tail that
      // was never hidden.
      expect(frame).toContain('Fetch the Q4 report today!');
      expect(frame).not.toMatch(/last \d+ lines? hidden/);
      expect(frame).toContain('Do you want to proceed?');
    });

    it('counts a link target the renderer keeps visible', async () => {
      const availableTerminalHeight = 8;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'info',
                title: 'Confirm',
                prompt:
                  '[google.com](https://attacker.example/api/v1/export?signature=abcdef0123456789)',
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('... prompt hidden ...');
        expect(frame).toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // A deceptive label renders as `label (target)`, so the text on screen is
      // longer than the label alone. Counting only the label sees a body that
      // fits the single-row grant, hands it to a box that Ink then clips with
      // nothing said; counting what the renderer draws drops the block whole
      // and spends the row on the announcement instead.
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      expect(frame).toContain('overflowing:1');
      expect(frame).not.toContain('google.com');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
    });

    it('offers the reveal shortcut for a body clipped without MaxSizedBox', async () => {
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'info',
                title: 'Confirm',
                prompt: longPrompt,
                urls: ['https://example.com/deep/target'],
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={12}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        expect(lastFrame()).toMatch(/last \d+ lines hidden/);
      }, WAIT_FOR_FRAME);
      await vi.waitFor(() => {
        expect(lastFrame()).toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      expect(lastFrame()).toContain('https://example.com/deep/target');
    });

    it('grants the whole body when no terminal height was given', async () => {
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'info',
                title: 'Confirm',
                prompt: longPrompt,
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              contentWidth={50}
              compactMode={true}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        expect(lastFrame() ?? '').toContain('overflowing:0');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // Compact mode caps the body at five rows so an inline subagent approval
      // cannot fill the screen. That ceiling only makes sense next to a granted
      // height, which ctrl-s reveals more of; with no height granted there is
      // nothing to reveal back, so the body keeps every row it has.
      expect(frame).toContain('finding 40');
      expect(frame).not.toMatch(/hidden/);
      expect(frame).toContain('Yes, allow once');
    });

    it('caps long MCP server and tool labels', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'mcp',
            title: 'Confirm MCP tool',
            serverName: 'server-'.repeat(40),
            toolName: 'tool-'.repeat(40),
            toolDisplayName: 'a very long tool display name',
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      expect(frame).toContain('MCP Server:');
      expect(frame).toContain('server-server-server');
      expect(frame).toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('Allow execution of MCP tool');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No, suggest changes (esc)');
    });

    it('keeps one MCP identity row when the body budget is a single row', async () => {
      // Compact chrome is one question row plus two option rows, so a
      // four-row terminal leaves the body exactly one row: the budget under
      // which the sizing box cannot answer the ask at all.
      const availableTerminalHeight = 4;
      const { lastFrame } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'mcp',
                title: 'Confirm MCP tool',
                serverName: 'srv',
                toolName: 'tool-'.repeat(20),
                toolDisplayName: 'a very long tool display name',
                hideAlwaysAllow: true,
                onConfirm: vi.fn(),
              }}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
              compactMode={true}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        expect(lastFrame() ?? '').toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // The probe prints a row of its own, so the dialog keeps one row of slack.
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      // The body budget floors at one row, but the sizing box used for the two
      // identity rows floors its own ceiling at two and spends one of them on a
      // footer, so it cannot answer a one-row budget with one row. At that point
      // the identity rows are replaced by a pinned single row instead of letting
      // the box render past the cap and take the options with it.
      expect(frame).toContain('Tool: tool-');
      expect(frame).not.toContain('MCP Server:');
      // The row is truncated, so it shows that a longer name exists, and it
      // registers the overflow that makes ctrl-s offer the whole name.
      expect(frame).toContain('…');
      expect(frame).not.toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });

    it('keeps the auto-mode banner, the command and every option in one budget', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'exec',
            title: 'Confirm Shell Command',
            command: 'npm run deploy -- --dry-run',
            rootCommand: 'npm',
            hideAlwaysAllow: true,
            autoModeFallback: {
              reason: 'classifier_unavailable',
              message:
                "Auto Mode couldn't classify this action. Switching to Default Mode is recommended.",
            },
            onConfirm: vi.fn(),
          }}
          config={mockConfig}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={80}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight,
      );
      // The banner and the extra option are each charged once, not once while
      // sizing the body and again while capping it, which left the command the
      // banner is warning about with no rows at all.
      expect(frame).toContain("Auto Mode couldn't classify this action");
      expect(frame).toContain('npm run deploy -- --dry-run');
      expect(frame).toContain(
        'Switch to Default Mode and allow once (recommended)',
      );
      expect(frame).toContain('No, suggest changes (esc)');
    });

    it('caps the body of a compact confirmation', () => {
      const availableTerminalHeight = 8;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm',
            prompt: longPrompt,
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      // Here the grant is exactly the compact ceiling, so this pins the boundary:
      // three chrome rows plus a five-row body, four prose rows and the row that
      // counts the rest. A body clipped down to nothing would still pass a
      // frame-size check, so the surviving rows are asserted too; the ceiling
      // itself, where the grant is larger, is pinned by the tall-terminal case.
      expect(frame).toContain('finding 1');
      expect(frame).toContain('finding 2');
      expect(frame).not.toContain('finding 3');
      expect(frame).toContain('... last 75 lines hidden ...');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      expect(frame).toContain('No');
    });

    it('holds the compact body ceiling on a tall terminal', () => {
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm',
            prompt: longPrompt,
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
          }}
          config={mockConfig}
          availableTerminalHeight={40}
          contentWidth={50}
          compactMode={true}
        />,
      );

      const frame = lastFrame() ?? '';
      // The compact ceiling is a ceiling, not a floor: spare terminal height
      // must not let an inline subagent approval grow to the whole screen. Three
      // chrome rows plus the five-row body, and the frame is measured against
      // that, so a ceiling that grew by two rows would red here.
      expect(frame.split(EOL).length).toBeLessThanOrEqual(8);
      expect(frame).toContain('finding 1');
      expect(frame).toContain('finding 2');
      expect(frame).not.toContain('finding 3');
      expect(frame).not.toContain('finding 40');
      expect(frame).toContain('... last 75 lines hidden ...');
      expect(frame).toContain('Yes, allow once');
    });

    it('caps compact MCP identity rows', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'mcp',
            title: 'Confirm MCP tool',
            serverName: 'server-'.repeat(20),
            toolName: 'tool-'.repeat(20),
            toolDisplayName: 'a very long tool display name',
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
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
      expect(frame).toContain('MCP Server:');
      expect(frame).toContain('server-server-server');
      expect(frame).toMatch(/last \d+ lines hidden/);
      expect(frame).toContain('Do you want to proceed?');
    });

    it('keeps the open-in-editor hint when the plan budget is one row', () => {
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'plan',
            title: 'Allow entry into Plan Mode?',
            plan: longPrompt,
            onConfirm: vi.fn(),
          }}
          config={mockConfig}
          availableTerminalHeight={9}
          contentWidth={50}
        />,
      );

      const frame = lastFrame() ?? '';
      // A body that cannot render at least one row is skipped rather than
      // rendered, so the only way to read the whole plan stays on screen. The
      // announcement that says so is the last row and is what the last row gets
      // cut away here, not the hint.
      expect(frame).toContain('o open full plan in editor');
      expect(frame).not.toMatch(/plan hidden/);
      expect(frame).toContain('Allow entry into Plan Mode?');
    });

    it('keeps the plan hint on a row of its own when the plan is clipped', () => {
      const availableTerminalHeight = 12;
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'plan',
            title: 'Allow entry into Plan Mode?',
            plan: longPrompt,
            onConfirm: vi.fn(),
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
      // The hint is the way out of a clipped plan, so it must survive as its own
      // row. Two unpinned Ink rows sharing a line overwrite each other rather
      // than clip a prefix, so an exact row match is the meaningful assertion.
      const hintRows = frame
        .split(EOL)
        .filter((line) => line.trim() === 'o open full plan in editor');
      expect(hintRows).toHaveLength(1);
      // The hint is a way out, not a substitute: this budget leaves rows for
      // plan text, so the plan itself has to be on screen beside it.
      expect(frame).toContain('finding 1');
      expect(frame).toContain('Allow entry into Plan Mode?');
    });

    it('announces the plan dropped to a two-row body budget', async () => {
      const availableTerminalHeight = 11;
      const details = {
        type: 'plan' as const,
        title: 'Allow entry into Plan Mode?',
        plan: longPrompt,
        onConfirm: vi.fn(),
      };
      const { lastFrame, rerender } = render(
        <OverflowProvider>
          {withProviders(
            <ToolConfirmationMessage
              confirmationDetails={details}
              config={mockConfig}
              availableTerminalHeight={availableTerminalHeight}
              contentWidth={50}
            />,
          )}
          <OverflowProbe />
        </OverflowProvider>,
      );

      await vi.waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toMatch(/plan hidden/);
        expect(frame).toContain('overflowing:1');
      }, WAIT_FOR_FRAME);
      const frame = lastFrame() ?? '';
      // The probe prints a row of its own, so the dialog keeps one row of slack.
      expect(frame.split(EOL).length).toBeLessThanOrEqual(
        availableTerminalHeight + 1,
      );
      // Two rows are enough for the hint and the announcement, both of which
      // point somewhere: `o` opens the whole plan in an editor, ctrl-s lifts the
      // budget in place. Silently deleting the plan is what made the first fix
      // hard to trust.
      expect(frame).toContain('o open full plan in editor');
      expect(frame).toContain('Allow entry into Plan Mode?');
      // Registering the overflow is what makes the reveal shortcut appear.
      expect(frame).toContain('overflowing:1');

      // The id belongs to this confirmation, not to the provider: leaving the
      // confirmation must take the reveal hint back with it.
      rerender(
        <OverflowProvider>
          <OverflowProbe />
        </OverflowProvider>,
      );
      await vi.waitFor(
        () => expect(lastFrame() ?? '').toContain('overflowing:0'),
        WAIT_FOR_FRAME,
      );
    });

    it('leaves a body that fits the budget untouched', () => {
      const { lastFrame } = renderWithProviders(
        <ToolConfirmationMessage
          confirmationDetails={{
            type: 'info',
            title: 'Confirm',
            prompt: 'Delete node_modules?',
            hideAlwaysAllow: true,
            onConfirm: vi.fn(),
          }}
          config={mockConfig}
          availableTerminalHeight={12}
          contentWidth={50}
        />,
      );

      const frame = lastFrame() ?? '';
      expect(frame).toContain('Delete node_modules?');
      expect(frame).toContain('Do you want to proceed?');
      expect(frame).toContain('Yes, allow once');
      // A body that fits must not be clipped, so no truncation marker.
      expect(frame).not.toMatch(/hidden/);
    });
  });

  it.each([true, false])(
    'handles a right-click and keys in one stdin chunk (menu items: %s)',
    async (hasItems) => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onMenuSelect = vi.fn();
      const onUnderlyingKey = vi.fn();
      const onMenuChange = vi.fn();
      const OpenOnRightPress = () => {
        const { subscribeMouse, unsubscribeMouse } = useKeypressContext();
        const { menu, openMenu } = useContextMenu();
        useKeypress(onUnderlyingKey, { isActive: menu === null });
        useEffect(() => {
          const handler = () => {
            openMenu(
              hasItems
                ? [
                    {
                      id: 'open-link',
                      label: 'Open Link',
                      onSelect: onMenuSelect,
                    },
                  ]
                : [],
              { x: 0, y: 0 },
            );
            // AppContainer is outside the provider and relies on this callback.
            expect(onMenuChange).toHaveBeenLastCalledWith(hasItems);
          };
          subscribeMouse(handler);
          return () => unsubscribeMouse(handler);
        }, [subscribeMouse, unsubscribeMouse, openMenu]);
        return null;
      };
      const { stdin } = render(
        withProviders(
          <ContextMenuProvider onMenuChange={onMenuChange}>
            <ToolConfirmationMessage
              confirmationDetails={{
                type: 'exec',
                title: 'Confirm Execution',
                command: 'echo test',
                rootCommand: 'echo',
                onConfirm,
              }}
              config={mockConfig}
              availableTerminalHeight={30}
              contentWidth={80}
            />
            <OpenOnRightPress />
            <ContextMenuOverlay />
          </ContextMenuProvider>,
        ),
      );
      await act(async () => {});
      await act(async () => {
        stdin.write('\x1b[<2;10;5M\x1b[Z\x1b[C\r');
      });
      if (hasItems) {
        expect(onUnderlyingKey).not.toHaveBeenCalled();
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onMenuSelect).not.toHaveBeenCalled();
        // Once rendered, Enter belongs to the menu, then to the dialog again.
        await act(async () => {
          stdin.write('\r');
        });
        expect(onMenuSelect).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
        await act(async () => {
          stdin.write('\r');
        });
      } else {
        expect(onUnderlyingKey).toHaveBeenCalled();
      }
      await vi.waitFor(() =>
        expect(onConfirm).toHaveBeenCalledWith(
          ToolConfirmationOutcome.ProceedOnce,
        ),
      );
    },
  );

  it('does not act on a key aimed at an open context menu', async () => {
    // The teammate tab mounts this dialog while AgentChatContent's
    // ContentMouseController makes the right-click menu openable there.
    // KeypressContext broadcasts to every subscriber and discards return
    // values (the overlay cannot consume a key for us), so the dialog has to
    // go quiet itself — RadioButtonSelect's initialIndex is 0 with
    // "allow once" first, so one Enter aimed at "Open Link" would otherwise
    // approve the pending call and Esc would silently deny it.
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'touch /tmp/marker',
      rootCommand: 'touch',
      onConfirm,
    };

    const { stdin } = render(
      withProviders(
        <ContextMenuProvider>
          <ToolConfirmationMessage
            confirmationDetails={confirmationDetails}
            config={mockConfig}
            availableTerminalHeight={30}
            contentWidth={80}
          />
          <MenuProbe />
        </ContextMenuProvider>,
      ),
    );

    // Control: with no menu open, Enter still approves the pending call.
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
      ),
    );
    onConfirm.mockClear();

    await act(async () => {
      menuApi?.openMenu(
        [{ id: 'open-link', label: 'Open Link', onSelect: () => {} }],
        { x: 4, y: 2 },
      );
    });
    expect(menuApi?.menu).not.toBeNull();

    await act(async () => {
      stdin.write('\r'); // would approve (ProceedOnce is index 0)
      stdin.write('\x1b'); // would deny (handleConfirm(Cancel))
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not submit a nested custom answer aimed at an open context menu', async () => {
    // The `ask_user_question` flavour nests a free-text TextInput one level
    // below the dialog's own subscriber. Quieting only the dialog left that
    // input hot, so one Enter aimed at "Open Link" submitted the half-typed
    // draft as the answer and the teammate round proceeded on it.
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'ask_user_question',
      title: 'Question',
      questions: [
        {
          question: 'What is your favorite color?',
          header: 'Color',
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue', description: 'A cool color' },
            { label: 'Green', description: '' },
          ],
          multiSelect: false,
        },
      ],
      onConfirm,
    };

    const { stdin } = render(
      withProviders(
        <ContextMenuProvider>
          <ToolConfirmationMessage
            confirmationDetails={confirmationDetails}
            config={mockConfig}
            availableTerminalHeight={30}
            contentWidth={80}
          />
          <MenuProbe />
        </ContextMenuProvider>,
      ),
    );

    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });

    // Row 4 is the custom answer; typing into it mounts the nested input.
    await settle();
    await act(async () => {
      stdin.write('4');
    });
    await settle();
    await act(async () => {
      stdin.write('draft');
    });
    await settle();

    // Control: with no menu open, Enter submits exactly that draft — which is
    // also the proof the nested input is mounted and live.
    await act(async () => {
      stdin.write('\r');
    });
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { 0: 'draft' } },
      ),
    );
    onConfirm.mockClear();

    await act(async () => {
      menuApi?.openMenu(
        [{ id: 'open-link', label: 'Open Link', onSelect: () => {} }],
        { x: 4, y: 2 },
      );
    });
    expect(menuApi?.menu).not.toBeNull();

    await act(async () => {
      stdin.write('\r'); // aimed at "Open Link", not at the draft
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
