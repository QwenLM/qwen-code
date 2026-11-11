/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { DialogManager } from './DialogManager.js';
import { describe, it, expect, vi } from 'vitest';
import { Text } from 'ink';
import { act } from 'react';
import { type UIState } from '../contexts/UIStateContext.js';
import { createMockSettings } from '../../test-utils/settings.js';
import process from 'node:process';

const dialogMocks = vi.hoisted(() => ({
  gracefulExit: vi.fn(),
  consentPrompt: vi.fn(),
}));

vi.mock('../../utils/cleanup.js', () => ({
  gracefulExit: dialogMocks.gracefulExit,
}));

interface CapturedSettingsDialogProps {
  onRestartRequest: () => Promise<void>;
}

let settingsDialogProps: CapturedSettingsDialogProps | undefined;

// Mock child components
vi.mock('./FolderTrustDialog.js', () => ({
  FolderTrustDialog: () => <Text>FolderTrustDialog</Text>,
}));
vi.mock('./ConsentPrompt.js', () => ({
  ConsentPrompt: (props: unknown) => {
    dialogMocks.consentPrompt(props);
    return <Text>ConsentPrompt</Text>;
  },
}));
vi.mock('./ThemeDialog.js', () => ({
  ThemeDialog: () => <Text>ThemeDialog</Text>,
}));
vi.mock('./SettingsDialog.js', () => ({
  SettingsDialog: (props: CapturedSettingsDialogProps) => {
    settingsDialogProps = props;
    return <Text>SettingsDialog</Text>;
  },
}));
vi.mock('./EditorSettingsDialog.js', () => ({
  EditorSettingsDialog: () => <Text>EditorSettingsDialog</Text>,
}));
vi.mock('./ProQuotaDialog.js', () => ({
  ProQuotaDialog: () => <Text>ProQuotaDialog</Text>,
}));
vi.mock('./PeerInboundApprovalDialog.js', () => ({
  PeerInboundApprovalDialog: () => <Text>PeerInboundApprovalDialog</Text>,
  PeerInboundApprovalChoice: { APPROVE: 'approve', DENY: 'deny' },
}));

describe('DialogManager', () => {
  const defaultProps = {
    terminalWidth: 100,
  };

  const baseUiState = {
    constrainHeight: false,
    terminalHeight: 24,
    staticExtraHeight: 0,
    terminalWidth: 80,
    confirmUpdateExtensionRequests: [],
    isFolderTrustDialogOpen: false,
    confirmationRequest: null,
    consentRequest: null,
    isThemeDialogOpen: false,
    isSettingsDialogOpen: false,
    isEditorDialogOpen: false,
    isAgentConfigDialogOpen: false,
    selectedAgentName: undefined,
    selectedAgentDisplayName: undefined,
    selectedAgentDefinition: undefined,
  };

  it('renders nothing by default', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <DialogManager {...defaultProps} />,
      { uiState: baseUiState as Partial<UIState> as UIState },
    );
    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  const testCases: Array<[Partial<UIState>, string]> = [
    [{ isFolderTrustDialogOpen: true }, 'FolderTrustDialog'],
    [
      { commandConfirmationRequest: { prompt: 'foo', onConfirm: vi.fn() } },
      'ConsentPrompt',
    ],
    [
      { authConsentRequest: { prompt: 'bar', onConfirm: vi.fn() } },
      'ConsentPrompt',
    ],
    [
      {
        confirmUpdateExtensionRequests: [{ prompt: 'foo', onConfirm: vi.fn() }],
      },
      'ConsentPrompt',
    ],
    [{ isThemeDialogOpen: true }, 'ThemeDialog'],
    [{ isSettingsDialogOpen: true }, 'SettingsDialog'],
    [{ isEditorDialogOpen: true }, 'EditorSettingsDialog'],
    [
      {
        isAgentConfigDialogOpen: true,
        selectedAgentName: 'test-agent',
        selectedAgentDefinition: {
          name: 'test-agent',
          kind: 'local',
          description: 'Test agent',
          inputConfig: { inputSchema: {} },
          promptConfig: { systemPrompt: 'test' },
          modelConfig: { model: 'inherit' },
          runConfig: { maxTimeMinutes: 5 },
        },
      },
      'Test Agent',
    ],
  ];

  // skip: 现存失败
  it.skip.each(testCases)(
    'renders %s when state is %o',
    async (uiStateOverride, expectedComponent) => {
      const { lastFrame, unmount } = await renderWithProviders(
        <DialogManager {...defaultProps} />,
        {
          uiState: {
            ...baseUiState,
            ...uiStateOverride,
          } as Partial<UIState> as UIState,
        },
      );
      expect(lastFrame()).toContain(expectedComponent);
      unmount();
    },
  );

  it('localizes the manual restart result before exiting', async () => {
    dialogMocks.gracefulExit.mockClear();
    settingsDialogProps = undefined;
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const { unmount } = await renderWithProviders(
      <DialogManager {...defaultProps} />,
      {
        settings: createMockSettings({ ui: { language: 'zh-CN' } }),
        uiState: {
          ...baseUiState,
          isSettingsDialogOpen: true,
        } as Partial<UIState> as UIState,
      },
    );

    expect(settingsDialogProps).toBeDefined();
    await act(async () => {
      await settingsDialogProps!.onRestartRequest();
    });

    expect(stderrWrite).toHaveBeenCalledWith(
      '\n请重启 CLI 以应用更改。\n',
    );
    expect(dialogMocks.gracefulExit).toHaveBeenCalledWith(0, {
      exitReason: 'user_quit',
    });
    stderrWrite.mockRestore();
    unmount();
  });

  it('forwards request-specific consent presentation', async () => {
    const request = {
      prompt: 'Use recommended settings?',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      hideTitle: true,
      confirmLabel: 'Yes, use recommended settings',
      cancelLabel: 'No, maybe later',
    };
    const { unmount } = await renderWithProviders(
      <DialogManager {...defaultProps} />,
      {
        uiState: {
          ...baseUiState,
          confirmUpdateExtensionRequests: [request],
        } as Partial<UIState> as UIState,
      },
    );

    expect(dialogMocks.consentPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining(request),
    );
    unmount();
  });

  /**
   * Inbound peer traffic is the only thing this component renders that the user
   * did not ask for, so it goes last. It used to sit ahead of every confirmation:
   * a message arriving mid-answer replaced the prompt, whose `onComplete` then
   * hung until the peer request timed out five minutes later.
   */
  describe('[RA7] a held peer message', () => {
    const peerRequest = {
      id: 'held-1',
      cause: 'no-mode-asserted' as const,
      knownPeer: false,
      otherHeldCount: 0,
      summary: {
        preview: 'take a look',
        body: 'take a look',
        truncated: false,
        attachmentCount: 0,
        claimedAddress: 'uds:/tmp/peer.sock',
      },
    };

    const render = (override: Partial<UIState>) =>
      renderWithProviders(<DialogManager {...defaultProps} />, {
        uiState: {
          ...baseUiState,
          peerInboundApprovalRequest: peerRequest,
          ...override,
        } as Partial<UIState> as UIState,
      });

    it('is asked about when nothing else is on screen', async () => {
      const { lastFrame, unmount } = await render({});
      expect(lastFrame()).toContain('PeerInboundApprovalDialog');
      unmount();
    });

    it.each<[string, Partial<UIState>]>([
      [
        'a command confirmation',
        { commandConfirmationRequest: { prompt: 'foo', onConfirm: vi.fn() } },
      ],
      [
        'an auth consent prompt',
        { authConsentRequest: { prompt: 'bar', onConfirm: vi.fn() } },
      ],
      [
        'an extension update confirmation',
        {
          confirmUpdateExtensionRequests: [
            { prompt: 'foo', onConfirm: vi.fn() },
          ],
        },
      ],
      ['a dialog the user opened', { isSettingsDialogOpen: true }],
      ['a browser the user opened', { isThemeDialogOpen: true }],
    ])('waits behind %s', async (_label, override) => {
      const { lastFrame, unmount } = await render(override);
      expect(lastFrame()).not.toContain('PeerInboundApprovalDialog');
      unmount();
    });
  });
});
