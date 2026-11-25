/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type SerializableConfirmationDetails,
  type Config,
  ToolConfirmationOutcome,
} from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';
import { useToolActions } from '../../contexts/ToolActionsContext.js';
import { act } from 'react';
import { openFileInEditor } from '../../utils/editorUtils.js';
import { useRegisterKeyboardContext } from '../../contexts/KeyboardContextRegistry.js';

vi.mock('../../contexts/ToolActionsContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../contexts/ToolActionsContext.js')
    >();
  return {
    ...actual,
    useToolActions: vi.fn(),
  };
});

vi.mock('../../utils/editorUtils.js', () => ({
  openFileInEditor: vi.fn(),
}));

const DialogContextHarness = ({ children }: { children: React.ReactNode }) => {
  useRegisterKeyboardContext('Dialog', true);
  return <>{children}</>;
};

describe('ToolConfirmationMessage', () => {
  const mockConfirm = vi.fn();
  beforeEach(() => {
    vi.mocked(useToolActions).mockReturnValue({
      confirm: mockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });
  });

  const mockConfig = {
    isTrustedFolder: () => true,
    getPermissionMode: () => 'default',
  } as unknown as Config;

  it('should not display urls if prompt and url are the same', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt: 'https://example.com',
      urls: ['https://example.com'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should display urls if prompt and url are different', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt:
        'fetch https://github.com/google/gemini-react/blob/main/README.md',
      urls: [
        'https://raw.githubusercontent.com/google/gemini-react/main/README.md',
      ],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('should display WarningMessage for deceptive URLs in info type', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt: 'https://täst.com',
      urls: ['https://täst.com'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Deceptive URL(s) detected');
    expect(output).toContain('Original: https://täst.com');
    expect(output).toContain(
      'Actual Host (Punycode): https://xn--tst-qla.com/',
    );
    unmount();
  });

  it('should display WarningMessage for deceptive URLs in exec type commands', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'curl https://еxample.com',
      rootCommand: 'curl',
      rootCommands: ['curl'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Deceptive URL(s) detected');
    expect(output).toContain('Original: https://еxample.com/');
    expect(output).toContain(
      'Actual Host (Punycode): https://xn--xample-2of.com/',
    );
    unmount();
  });

  it('should exclude shell delimiters from extracted URLs in exec type commands', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'curl https://еxample.com;ls',
      rootCommand: 'curl',
      rootCommands: ['curl'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Deceptive URL(s) detected');
    // It should extract "https://еxample.com" and NOT "https://еxample.com;ls"
    expect(output).toContain('Original: https://еxample.com/');
    // The command itself still contains 'ls', so we check specifically that 'ls' is not part of the URL line.
    expect(output).not.toContain('Original: https://еxample.com/;ls');
    unmount();
  });

  it('renders workflow confirmation details with script, phases, args, and risk warning', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'workflow',
      title: 'Run a dynamic workflow?',
      workflowName: 'audit',
      description: 'Audit repository',
      source: 'inline',
      args: { scope: 'src' },
      meta: {
        name: 'audit',
        description: 'Audit repository',
        phases: [{ title: 'Inspect', detail: 'Read files' }],
        inputSchema: {
          type: 'object',
          properties: { scope: { type: 'string' } },
          required: ['scope'],
        },
      },
      script: `
export const meta = {
  name: "audit",
  description: "Audit repository",
  phases: [{ title: "Inspect", detail: "Read files" }],
  inputSchema: {
    type: "object",
    properties: { scope: { type: "string" } },
    required: ["scope"],
  },
};
return args.scope;
`,
    };

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ToolConfirmationMessage
          callId="workflow-call-id"
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          getPreferredEditor={vi.fn()}
          availableTerminalHeight={40}
          terminalWidth={100}
          toolName="Workflow"
        />,
      );
    await waitUntilReady();

    let output = lastFrame();
    expect(output).toContain('Dynamic workflows can run multiple subagents');
    expect(output).toContain('Name: audit');
    expect(output).toContain('Description: Audit repository');
    expect(output).toContain('Args:');
    expect(output).toContain('{"scope":"src"}');
    expect(output).toContain('Input schema:');
    expect(output).toContain('required: scope');
    expect(output).toContain('properties: scope:string');
    expect(output).toContain('Inspect');
    expect(output).toContain('Read files');
    expect(output).not.toContain('return args.scope');
    expect(output).toContain('Run');
    expect(output).toContain('View raw script');
    expect(output).toContain('Reject and type something');
    expect(output).toContain('No');

    stdin.write('2');
    await waitFor(() => {
      expect(lastFrame()).toContain('return args.scope');
    });
    output = lastFrame();
    expect(output).toContain('Press Ctrl+X to edit script before running.');
    expect(output).toMatch(
      /No[\s\S]*Press Ctrl\+X to edit script before running\./,
    );
    expect(output).toContain('Close raw script');
    expect(output).not.toContain('View raw script');

    stdin.write('2');
    await waitFor(() => {
      expect(lastFrame()).not.toContain('return args.scope');
    });
    output = lastFrame();
    expect(output).toContain('View raw script');
    expect(output).not.toContain('Close raw script');
    unmount();
  });

  it('edits workflow script with Ctrl+X after viewing raw script and submits edited payload', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });
    vi.mocked(openFileInEditor).mockImplementationOnce(async (filePath) => {
      await fsp.writeFile(filePath, 'return { edited: true };', 'utf8');
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'workflow',
      title: 'Run a dynamic workflow?',
      workflowName: 'audit',
      source: 'inline',
      script: 'return { edited: false };',
    };

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ToolConfirmationMessage
          callId="workflow-edit-call-id"
          confirmationDetails={confirmationDetails}
          config={mockConfig}
          getPreferredEditor={vi.fn()}
          availableTerminalHeight={40}
          terminalWidth={100}
          toolName="Workflow"
        />,
      );
    await waitUntilReady();

    act(() => {
      stdin.write('2');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('return { edited: false };');
    });

    act(() => {
      stdin.write('\x18');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('return { edited: true };');
    });
    const editorFilePath = vi.mocked(openFileInEditor).mock.lastCall?.[0] ?? '';
    const slug = process.env['BRAND_CLI_SLUG'] || 'qwen-code';
    expect(path.dirname(editorFilePath)).toContain(
      `${path.sep}${slug}-workflow-edit-`,
    );

    act(() => {
      stdin.write('1');
    });
    await waitFor(() => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'workflow-edit-call-id',
        ToolConfirmationOutcome.ProceedOnce,
        {
          script: 'return { edited: true };',
          scriptPath: undefined,
          name: undefined,
        },
      );
    });
    unmount();
  });

  it('should aggregate multiple deceptive URLs into a single WarningMessage', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt: 'Fetch both',
      urls: ['https://еxample.com', 'https://täst.com'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Deceptive URL(s) detected');
    expect(output).toContain('Original: https://еxample.com/');
    expect(output).toContain('Original: https://täst.com/');
    unmount();
  });

  it('should render simplified prompt for compound commands without listing roots', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Multiple Commands',
      command: 'echo "hello"',
      rootCommand: 'echo, ls, whoami',
      rootCommands: ['echo', 'ls', 'whoami'],
      commands: ['echo "hello"', 'ls -la', 'whoami'],
      isCompound: true,
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Allow this command to run?');
    expect(output).not.toContain('Allow execution of [');
    expect(output).toMatchSnapshot();
    unmount();
  });

  it('should preserve redirection warnings for redirected compound commands', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'echo hi > out && ls',
      rootCommand: 'echo, ls',
      rootCommands: ['echo', 'ls'],
      commands: ['echo hi > out && ls'],
      isCompound: true,
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Allow this command to run?');
    expect(output).not.toContain('Allow execution of [');
    expect(output).toContain('Redirection detected.');
    unmount();
  });

  it('should keep single command prompt simple', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'ls -la',
      rootCommand: 'ls',
      rootCommands: ['ls'],
      commands: ['ls -la'],
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Allow this command to run?');
    expect(output).not.toContain('Allow execution of [');
    unmount();
  });

  it('should not duplicate multiline shell scripts in the confirmation body', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Multiline Script',
      command: 'echo "hello"\nfor i in 1 2 3; do\n  echo $i\ndone',
      rootCommand: 'echo',
      rootCommands: ['echo'],
    };

    const result = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );
    await result.waitUntilReady();

    const output = result.lastFrame();
    expect(output).toContain('Allow this command to run?');
    expect(output).not.toContain('echo "hello"');
    expect(output).not.toContain('for i in 1 2 3; do');

    expect(output).toMatchSnapshot();
    result.unmount();
  });

  describe('with folder trust', () => {
    const editConfirmationDetails: SerializableConfirmationDetails = {
      type: 'edit',
      title: 'Confirm Edit',
      fileName: 'test.txt',
      filePath: '/test.txt',
      fileDiff: '...diff...',
      originalContent: 'a',
      newContent: 'b',
    };

    const execConfirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Execution',
      command: 'echo "hello"',
      rootCommand: 'echo',
      rootCommands: ['echo'],
    };

    const infoConfirmationDetails: SerializableConfirmationDetails = {
      type: 'info',
      title: 'Confirm Web Fetch',
      prompt: 'https://example.com',
      urls: ['https://example.com'],
    };

    const mcpConfirmationDetails: SerializableConfirmationDetails = {
      type: 'mcp',
      title: 'Confirm MCP Tool',
      serverName: 'test-server',
      toolName: 'test-tool',
      toolDisplayName: 'Test Tool',
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
      it('should show per-tool options when folder is trusted', async () => {
        const mockConfig = {
          isTrustedFolder: () => true,
          getPermissionMode: () => 'default',
        } as unknown as Config;
        const { lastFrame, unmount } = await renderWithProviders(
          <ToolConfirmationMessage
            callId="test-call-id"
            confirmationDetails={details}
            config={mockConfig}
            getPreferredEditor={vi.fn()}
            availableTerminalHeight={30}
            terminalWidth={80}
            toolName="shell"
          />,
        );

        expect(lastFrame()).toMatchSnapshot();
        unmount();
      });

      it('should show per-tool options when folder is untrusted', async () => {
        const mockConfig = {
          isTrustedFolder: () => false,
          getPermissionMode: () => 'default',
        } as unknown as Config;

        const { lastFrame, unmount } = await renderWithProviders(
          <ToolConfirmationMessage
            callId="test-call-id"
            confirmationDetails={details}
            config={mockConfig}
            getPreferredEditor={vi.fn()}
            availableTerminalHeight={30}
            terminalWidth={80}
            toolName="shell"
          />,
        );

        expect(lastFrame()).toMatchSnapshot();
        unmount();
      });
    });
  });

  describe('persistent permission options', () => {
    const execConfirmationDetails: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Command',
      command: 'npm test',
      rootCommand: 'npm',
      rootCommands: ['npm'],
    };

    it('should show persistent option with settings path for exec type', async () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getPermissionMode: () => 'default',
        storage: {
          getWorkspaceLocalSettingsPath: () =>
            '/test-workspace/.qwen/settings.local.json',
        },
      } as unknown as Config;

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolConfirmationMessage
          callId="test-call-id"
          confirmationDetails={execConfirmationDetails}
          config={mockConfig}
          getPreferredEditor={vi.fn()}
          availableTerminalHeight={30}
          terminalWidth={80}
          toolName="shell"
        />,
      );

      const output = lastFrame();
      // Exec type shows persistent "Always allow" option for the root command
      expect(output).toContain('Always allow "npm"');
      expect(output).toMatchSnapshot();
      unmount();
    });
  });

  describe('Modify with external editor option', () => {
    const editConfirmationDetails: SerializableConfirmationDetails = {
      type: 'edit',
      title: 'Confirm Edit',
      fileName: 'test.txt',
      filePath: '/test.txt',
      fileDiff: '...diff...',
      originalContent: 'a',
      newContent: 'b',
    };

    it('should show "Modify with external editor" when NOT in IDE mode', async () => {
      const mockConfig = {
        isTrustedFolder: () => true,
        getPermissionMode: () => 'default',
      } as unknown as Config;
      vi.mocked(useToolActions).mockReturnValue({
        confirm: vi.fn(),
        cancel: vi.fn(),
        isExpanded: vi.fn().mockReturnValue(false),
        toggleExpansion: vi.fn(),
        toggleAllExpansion: vi.fn(),
      });

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolConfirmationMessage
          callId="test-call-id"
          confirmationDetails={editConfirmationDetails}
          config={mockConfig}
          getPreferredEditor={vi.fn()}
          availableTerminalHeight={30}
          terminalWidth={80}
          toolName="shell"
        />,
      );

      expect(lastFrame()).toContain('Modify with external editor');
      unmount();
    });
  });

  it('should strip BiDi characters from MCP tool and server names', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'mcp',
      title: 'Confirm MCP Tool',
      serverName: 'test\u202Eserver',
      toolName: 'test\u202Dtool',
      toolDisplayName: 'Test Tool',
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    // BiDi characters \u202E and \u202D should be stripped
    expect(output).not.toContain('\u202E');
    expect(output).not.toContain('\u202D');
    expect(output).toContain('Allow execution of MCP tool "testtool"');
    expect(output).toContain('from server "testserver"?');
    expect(output).toMatchSnapshot();
    unmount();
  });

  it('should show MCP tool details expand hint for MCP confirmations', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'mcp',
      title: 'Confirm MCP Tool',
      serverName: 'test-server',
      toolName: 'test-tool',
      toolDisplayName: 'Test Tool',
      toolArgs: {
        url: 'https://www.google.co.jp',
      },
      toolDescription: 'Navigates browser to a URL.',
      toolParameterSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Destination URL',
          },
        },
        required: ['url'],
      },
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('MCP Tool Details:');
    expect(output).toContain('(press Ctrl+O to expand MCP tool details)');
    expect(output).toContain('https://www.google.co.jp');
    expect(output).not.toContain('Navigates browser to a URL.');
    unmount();
  });

  it('should omit empty MCP invocation arguments from details', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'mcp',
      title: 'Confirm MCP Tool',
      serverName: 'test-server',
      toolName: 'test-tool',
      toolDisplayName: 'Test Tool',
      toolArgs: {},
      toolDescription: 'No arguments required.',
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="shell"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('MCP Tool Details:');
    expect(output).toContain('(press Ctrl+O to expand MCP tool details)');
    expect(output).not.toContain('Invocation Arguments:');
    unmount();
  });

  describe('height allocation and layout', () => {
    it('should keep exec confirmation compact for large commands', async () => {
      let largeCommand = '';
      for (let i = 1; i <= 50; i++) {
        largeCommand += `echo "Line ${i}"\n`;
      }

      const confirmationDetails: SerializableConfirmationDetails = {
        type: 'exec',
        title: 'Confirm Execution',
        command: largeCommand.trimEnd(),
        rootCommand: 'echo',
        rootCommands: ['echo'],
      };

      const { waitUntilReady, lastFrame, unmount } =
        await renderWithProviders(
          <ToolConfirmationMessage
            callId="test-call-id"
            confirmationDetails={confirmationDetails}
            config={mockConfig}
            getPreferredEditor={vi.fn()}
            availableTerminalHeight={40}
            terminalWidth={80}
            toolName="shell"
          />,
        );
      await waitUntilReady();

      const outputLines = lastFrame().split('\n');
      expect(outputLines.length).toBeLessThanOrEqual(40);
      expect(lastFrame()).toContain('Allow this command to run?');

      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('should not pad edit confirmations to the available height', async () => {
      const fileDiff = [
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,2 +1,2 @@',
        '-const oldLine1 = true;',
        '-const oldLine2 = true;',
        '+const newLine1 = true;',
        '+const newLine2 = true;',
      ].join('\n');

      const confirmationDetails: SerializableConfirmationDetails = {
        type: 'edit',
        title: 'Confirm Edit',
        fileName: 'file.ts',
        filePath: '/file.ts',
        fileDiff,
        originalContent: 'old',
        newContent: 'new',
        isModifying: false,
      };

      const { waitUntilReady, lastFrame, unmount } =
        await renderWithProviders(
          <ToolConfirmationMessage
            callId="test-call-id"
            confirmationDetails={confirmationDetails}
            config={mockConfig}
            getPreferredEditor={vi.fn()}
            availableTerminalHeight={40}
            terminalWidth={80}
            toolName="shell"
          />,
        );
      await waitUntilReady();

      const outputLines = lastFrame().split('\n');
      expect(outputLines.length).toBeLessThanOrEqual(40);
      expect(lastFrame()).toContain('Apply this change?');

      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });
  });

  describe('ESCAPE key behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('clears rejection feedback before ESC cancels the dialog', async () => {
      vi.useRealTimers();
      const localMockConfirm = vi.fn().mockResolvedValue(undefined);
      const onDismiss = vi.fn();
      vi.mocked(useToolActions).mockReturnValue({
        confirm: localMockConfirm,
        cancel: vi.fn(),
        isExpanded: vi.fn().mockReturnValue(false),
        toggleExpansion: vi.fn(),
        toggleAllExpansion: vi.fn(),
      });
      const confirmationDetails: SerializableConfirmationDetails = {
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt: 'https://example.com',
        urls: ['https://example.com'],
      };

      const { stdin, lastFrame, waitUntilReady, unmount } =
        await renderWithProviders(
          <DialogContextHarness>
            <ToolConfirmationMessage
              callId="test-call-id"
              confirmationDetails={confirmationDetails}
              config={mockConfig}
              getPreferredEditor={vi.fn()}
              availableTerminalHeight={30}
              terminalWidth={80}
              toolName="shell"
              onDismiss={onDismiss}
            />
          </DialogContextHarness>,
        );
      await waitUntilReady();

      act(() => {
        stdin.write('3');
      });
      await waitFor(() => {
        expect(lastFrame()).toContain('Write the exact feedback');
      });
      act(() => {
        stdin.write('keep editing');
      });
      await waitFor(() => {
        expect(lastFrame()).toContain('keep editing');
      });

      stdin.write('\x1b');
      await waitFor(() => {
        expect(lastFrame()).not.toContain('keep editing');
      });

      expect(localMockConfirm).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();

      stdin.write('\x1b');
      await waitFor(() => {
        expect(onDismiss).toHaveBeenCalledOnce();
      });

      expect(localMockConfirm).toHaveBeenCalledWith(
        'test-call-id',
        ToolConfirmationOutcome.Cancel,
        undefined,
      );

      unmount();
    });

    it('calls confirm(Cancel) when ESC is pressed with empty input', async () => {
      const mockConfirm = vi.fn().mockResolvedValue(undefined);

      vi.mocked(useToolActions).mockReturnValue({
        confirm: mockConfirm,
        cancel: vi.fn(),
        isExpanded: vi.fn().mockReturnValue(false),
        toggleExpansion: vi.fn(),
        toggleAllExpansion: vi.fn(),
      });
      const confirmationDetails: SerializableConfirmationDetails = {
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt: 'https://example.com',
        urls: ['https://example.com'],
      };

      const { stdin, unmount } = await renderWithProviders(
        <DialogContextHarness>
          <ToolConfirmationMessage
            callId="test-call-id"
            confirmationDetails={confirmationDetails}
            config={mockConfig}
            getPreferredEditor={vi.fn()}
            availableTerminalHeight={30}
            terminalWidth={80}
            toolName="shell"
          />
        </DialogContextHarness>,
      );

      stdin.write('\x1b');

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(mockConfirm).toHaveBeenCalledWith(
        'test-call-id',
        ToolConfirmationOutcome.Cancel,
        undefined,
      );

      unmount();
    });
  });

  it('submits ask_user answers through ToolActionsContext', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Years of experience?',
          header: 'Experience',
          options: [
            { label: '1-3 years', description: '' },
            { label: '3-5 years', description: '' },
            { label: '5+ years', description: '' },
          ],
        },
        {
          question: 'Most used language?',
          header: 'Language',
          options: [
            { label: 'TypeScript', description: '' },
            { label: 'Python', description: '' },
          ],
        },
        {
          question: 'Preferred reply language?',
          header: 'Reply',
          options: [
            { label: 'Chinese', description: '' },
            { label: 'English', description: '' },
          ],
        },
      ],
    };

    const { stdin, waitUntilReady } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="AskUserQuestion"
      />,
    );

    await waitUntilReady();

    // Q1: select 3-5 years (2nd option)
    act(() => {
      stdin.write('\x1b[B');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    act(() => {
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q2: select Python (2nd option)
    act(() => {
      stdin.write('\x1b[B');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    act(() => {
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q3: select Chinese (1st option, default)
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      await waitUntilReady();
    });

    // Review: submit
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'test-call-id',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: {
            'Years of experience?': '3-5 years',
            'Most used language?': 'Python',
            'Preferred reply language?': 'Chinese',
          },
        },
      );
    });
  });

  it('submits ask_user preview annotations through ToolActionsContext', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Which layout?',
          header: 'Layout',
          options: [
            {
              label: 'Comfortable',
              description: 'More whitespace',
              preview: '## Comfortable\n\nMore whitespace',
            },
            {
              label: 'Compact',
              description: 'More content',
              preview: '## Compact\n\nMore content',
            },
          ],
          multiSelect: false,
        },
      ],
    };

    const { stdin, waitUntilReady } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="preview-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={100}
        toolName="AskUserQuestion"
      />,
    );

    await waitUntilReady();
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'preview-call-id',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: { 'Which layout?': 'Comfortable' },
          annotations: {
            'Which layout?': {
              preview: '## Comfortable\n\nMore whitespace',
            },
          },
        },
      );
    });
  });

  it('returns Chat about this feedback through ToolActionsContext', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Which layout?',
          header: 'Layout',
          options: [
            {
              label: 'Comfortable',
              description: 'More whitespace',
              preview: '## Comfortable\n\nMore whitespace',
            },
            {
              label: 'Compact',
              description: 'More content',
              preview: '## Compact\n\nMore content',
            },
          ],
          multiSelect: false,
        },
      ],
    };

    const { stdin, waitUntilReady } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="preview-call-id"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={100}
        toolName="AskUserQuestion"
      />,
    );

    await waitUntilReady();
    for (const key of ['\x1b[B', '\x1b[B', '\r']) {
      act(() => stdin.write(key));
      await waitUntilReady();
    }
    await waitFor(() => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'preview-call-id',
        ToolConfirmationOutcome.Cancel,
        { cancelFeedback: expect.stringContaining('Which layout?') },
      );
    });
  });

  it('does not reuse submitted ask_user answers when the call id changes', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const weekdayDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Favorite weekday?',
          header: 'Weekday',
          options: [
            { label: 'Monday', description: '' },
            { label: 'Tuesday', description: '' },
          ],
        },
      ],
    };
    const seasonDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Favorite season?',
          header: 'Season',
          options: [
            { label: 'Spring', description: '' },
            { label: 'Summer', description: '' },
          ],
        },
      ],
    };
    const renderMessage = (
      callId: string,
      confirmationDetails: SerializableConfirmationDetails,
    ) => (
      <ToolConfirmationMessage
        callId={callId}
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="AskUserQuestion"
      />
    );

    const { stdin, rerender, waitUntilReady } = await renderWithProviders(
      renderMessage('weekday-call-id', weekdayDetails),
    );

    await waitUntilReady();
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'weekday-call-id',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: {
            'Favorite weekday?': 'Monday',
          },
        },
      );
    });

    localMockConfirm.mockClear();
    rerender(renderMessage('season-call-id', seasonDetails));
    await waitUntilReady();

    expect(localMockConfirm).not.toHaveBeenCalled();

    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'season-call-id',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: {
            'Favorite season?': 'Spring',
          },
        },
      );
    });
  });

  it('submits ask_user answers through ToolActionsContext for multi-question choice flow', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Project type?',
          header: 'Project',
          options: [
            { label: 'Web app', description: '' },
            { label: 'CLI tool', description: '' },
            { label: 'Backend service', description: '' },
          ],
        },
        {
          question: 'Favorite language?',
          header: 'Language',
          options: [
            { label: 'TypeScript', description: '' },
            { label: 'Python', description: '' },
          ],
        },
        {
          question: 'Use Chinese by default?',
          header: 'Locale',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        },
        {
          question: 'Energy level?',
          header: 'Energy',
          options: [
            { label: 'High', description: '' },
            { label: 'Medium', description: '' },
            { label: 'Low', description: '' },
          ],
        },
      ],
    };

    const { stdin, waitUntilReady } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id-2"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="AskUserQuestion"
      />,
    );

    await waitUntilReady();

    // Q1: select CLI tool (2nd option)
    act(() => {
      stdin.write('\x1b[B');
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q2: select Python (2nd option)
    act(() => {
      stdin.write('\x1b[B');
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q3: select Yes (1st option, default)
    act(() => {
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q4: select High (1st option, default)
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      await waitUntilReady();
    });

    // Review: submit
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'test-call-id-2',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: {
            'Project type?': 'CLI tool',
            'Favorite language?': 'Python',
            'Use Chinese by default?': 'Yes',
            'Energy level?': 'High',
          },
        },
      );
    });
  });

  it('submits ask_user answers through ToolActionsContext when the final choice uses Enter on the default option', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'Task?',
          header: 'Task',
          options: [
            { label: 'Fix bugs', description: '' },
            { label: 'Add feature', description: '' },
          ],
        },
        {
          question: 'Dir?',
          header: 'Dir',
          options: [
            { label: 'src', description: '' },
            { label: 'lib', description: '' },
          ],
        },
        {
          question: 'Prefs?',
          header: 'Prefs',
          options: [
            { label: 'Verbose', description: '' },
            { label: 'Quiet', description: '' },
          ],
        },
        {
          question: 'Language?',
          header: 'Lang',
          options: [
            { label: '中文', description: '使用中文进行交流' },
            { label: 'English', description: 'Communicate in English' },
          ],
        },
      ],
    };

    const { stdin, waitUntilReady } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id-3"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="AskUserQuestion"
      />,
    );

    await waitUntilReady();

    // Q1: select Fix bugs (default)
    act(() => {
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q2: select src (default)
    act(() => {
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q3: select Verbose (default)
    act(() => {
      stdin.write('\r');
    });
    await waitFor(async () => {
      await waitUntilReady();
    });

    // Q4: select 中文 (default)
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      await waitUntilReady();
    });

    // Review: submit
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'test-call-id-3',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: {
            'Task?': 'Fix bugs',
            'Dir?': 'src',
            'Prefs?': 'Verbose',
            'Language?': '中文',
          },
        },
      );
    });
  });

  it('submits ask_user answers through ToolActionsContext for a single-question choice', async () => {
    const localMockConfirm = vi.fn().mockResolvedValue(undefined);

    vi.mocked(useToolActions).mockReturnValue({
      confirm: localMockConfirm,
      cancel: vi.fn(),
      isExpanded: vi.fn().mockReturnValue(false),
      toggleExpansion: vi.fn(),
      toggleAllExpansion: vi.fn(),
    });

    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'AskUserQuestion',
      title: 'AskUserQuestion',
      questions: [
        {
          question: 'What do you want to do?',
          header: 'Task',
          options: [
            { label: 'Fix bugs', description: 'Fix existing issues' },
            { label: 'Add feature', description: 'Build something new' },
          ],
        },
      ],
    };

    const { stdin, waitUntilReady } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-call-id-4"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="AskUserQuestion"
      />,
    );

    await waitUntilReady();

    // Select default (Fix bugs)
    act(() => {
      stdin.write('\r');
    });

    await waitFor(async () => {
      expect(localMockConfirm).toHaveBeenCalledWith(
        'test-call-id-4',
        ToolConfirmationOutcome.ProceedOnce,
        {
          answers: {
            'What do you want to do?': 'Fix bugs',
          },
        },
      );
    });
  });

  it('should render file_read type with static question (no path duplication)', async () => {
    const confirmationDetails: SerializableConfirmationDetails = {
      type: 'file_read',
      title: 'Read src/app.ts',
      filePath: '/workspace/src/app.ts',
      displayPath: 'src/app.ts',
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <ToolConfirmationMessage
        callId="test-file-read"
        confirmationDetails={confirmationDetails}
        config={mockConfig}
        getPreferredEditor={vi.fn()}
        availableTerminalHeight={30}
        terminalWidth={80}
        toolName="Read"
      />,
    );

    const output = lastFrame();
    // Should show the static question without duplicating displayPath
    expect(output).toContain('Allow reading this file?');
    // The displayPath should NOT appear in the question/body text
    expect(output).not.toContain('Allow reading src/app.ts');
    // Should show session-allow option
    expect(output).toContain('Allow for this session');
    unmount();
  });
});
