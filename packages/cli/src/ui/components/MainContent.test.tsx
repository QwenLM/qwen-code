/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { MainContent } from './MainContent.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { AppContext } from '../contexts/AppContext.js';
import { CompactModeProvider } from '../contexts/CompactModeContext.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';

const staticPropsSpy = vi.fn();
const staticItemsSpy = vi.fn();
const historyItemDisplayPropsSpy = vi.fn();
const appHeaderSpy = vi.fn();

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');

  return {
    ...actual,
    Static: ({
      children,
      items,
      ...props
    }: React.ComponentProps<typeof actual.Static>) => {
      staticPropsSpy(props);
      staticItemsSpy(items);
      return <>{items.map((item, index) => children(item, index))}</>;
    },
  };
});

vi.mock('./AppHeader.js', () => ({
  AppHeader: ({ version }: { version: string }) => {
    appHeaderSpy(version);
    return <Text>{`APP_HEADER:${version}`}</Text>;
  },
}));

vi.mock('./HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: (props: { item: { id: number } }) => {
    historyItemDisplayPropsSpy(props);
    return <Text>{`HISTORY:${props.item.id}`}</Text>;
  },
}));

vi.mock('./ShowMoreLines.js', () => ({
  ShowMoreLines: () => <Text>SHOW_MORE</Text>,
}));

vi.mock('./Notifications.js', () => ({
  Notifications: () => <Text>NOTIFICATIONS</Text>,
}));

vi.mock('./DebugModeNotification.js', () => ({
  DebugModeNotification: () => <Text>DEBUG_NOTIFICATION</Text>,
}));

const createUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    history: [],
    historyManager: {} as UIState['historyManager'],
    isThemeDialogOpen: false,
    themeError: null,
    auth: {
      authError: null,
      isAuthDialogOpen: false,
      isAuthenticating: false,
      pendingAuthType: undefined,
      externalAuthState: null,
      qwenAuthState: {
        deviceAuth: null,
        authStatus: 'idle',
        authMessage: null,
      },
    },
    isConfigInitialized: true,
    editorError: null,
    isEditorDialogOpen: false,
    debugMessage: '',
    quittingMessages: null,
    isSettingsDialogOpen: false,
    isMemoryDialogOpen: false,
    isModelDialogOpen: false,
    isFastModelMode: false,
    isManageModelsDialogOpen: false,
    isTrustDialogOpen: false,
    activeArenaDialog: null,
    isPermissionsDialogOpen: false,
    isApprovalModeDialogOpen: false,
    isResumeDialogOpen: false,
    resumeMatchedSessions: undefined,
    isDeleteDialogOpen: false,
    slashCommands: [],
    pendingSlashCommandHistoryItems: [],
    commandContext: {} as UIState['commandContext'],
    shellConfirmationRequest: null,
    confirmationRequest: null,
    confirmUpdateExtensionRequests: [],
    providerUpdateRequest: undefined,
    settingInputRequests: [],
    pluginChoiceRequests: [],
    loopDetectionConfirmationRequest: null,
    geminiMdFileCount: 0,
    streamingState: {} as UIState['streamingState'],
    initError: null,
    pendingGeminiHistoryItems: [],
    thought: null,
    shellModeActive: false,
    userMessages: [],
    buffer: {} as UIState['buffer'],
    inputWidth: 80,
    suggestionsWidth: 80,
    isInputActive: true,
    shouldShowIdePrompt: false,
    shouldShowCommandMigrationNudge: false,
    commandMigrationTomlFiles: [],
    isFolderTrustDialogOpen: false,
    isTrustedFolder: true,
    constrainHeight: false,
    ideContextState: undefined,
    showToolDescriptions: false,
    ctrlCPressedOnce: false,
    ctrlDPressedOnce: false,
    showEscapePrompt: false,
    elapsedTime: 0,
    currentLoadingPhrase: '',
    historyRemountKey: 1,
    messageQueue: [],
    showAutoAcceptIndicator: {} as UIState['showAutoAcceptIndicator'],
    currentModel: 'gpt-5.5',
    contextFileNames: [],
    availableTerminalHeight: undefined,
    mainAreaWidth: 100,
    staticAreaMaxItemHeight: 100,
    staticExtraHeight: 0,
    dialogsVisible: false,
    pendingHistoryItems: [],
    stickyTodos: null,
    btwItem: null,
    setBtwItem: vi.fn(),
    cancelBtw: vi.fn(),
    nightly: false,
    branchName: 'main',
    sessionStats: { lastPromptTokenCount: 0 } as UIState['sessionStats'],
    terminalWidth: 120,
    terminalHeight: 40,
    mainControlsRef: { current: null },
    currentIDE: null,
    updateInfo: null,
    showIdeRestartPrompt: false,
    ideTrustRestartReason: {} as UIState['ideTrustRestartReason'],
    isRestarting: false,
    extensionsUpdateState: new Map(),
    activePtyId: undefined,
    embeddedShellFocused: false,
    showWelcomeBackDialog: false,
    welcomeBackInfo: null,
    welcomeBackChoice: null,
    isSubagentCreateDialogOpen: false,
    isAgentsManagerDialogOpen: false,
    isExtensionsManagerDialogOpen: false,
    isMcpDialogOpen: false,
    isHooksDialogOpen: false,
    isFeedbackDialogOpen: false,
    taskStartTokens: 0,
    streamingResponseLengthRef: { current: 0 },
    isReceivingContent: false,
    sessionName: null,
    setSessionName: vi.fn(),
    promptSuggestion: null,
    dismissPromptSuggestion: vi.fn(),
    isRewindSelectorOpen: false,
    rewindEscPending: false,
    ...overrides,
  }) as UIState;

const createUIActions = (): UIActions =>
  ({
    refreshStatic: vi.fn(),
  }) as unknown as UIActions;

const renderMainContent = (uiState: UIState) =>
  render(
    <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
      <CompactModeProvider value={{ compactMode: false }}>
        <UIActionsContext.Provider value={createUIActions()}>
          <UIStateContext.Provider value={uiState}>
            <OverflowProvider>
              <MainContent />
            </OverflowProvider>
          </UIStateContext.Provider>
        </UIActionsContext.Provider>
      </CompactModeProvider>
    </AppContext.Provider>,
  );

describe('<MainContent />', () => {
  it('renders AppHeader inside Static at the top of the static content', () => {
    staticPropsSpy.mockClear();
    staticItemsSpy.mockClear();
    historyItemDisplayPropsSpy.mockClear();
    appHeaderSpy.mockClear();

    const { lastFrame, rerender } = renderMainContent(
      createUIState({ currentModel: 'gpt-5.5', historyRemountKey: 7 }),
    );

    expect(lastFrame()).toContain('APP_HEADER:1.2.3');
    expect(lastFrame()).toContain('DEBUG_NOTIFICATION');
    expect(lastFrame()).toContain('NOTIFICATIONS');
    expect(staticPropsSpy).toHaveBeenCalled();
    expect(staticItemsSpy).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'app-header' }),
        expect.objectContaining({ key: 'debug-notification' }),
        expect.objectContaining({ key: 'notifications' }),
      ]),
    );
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(3);
    expect(appHeaderSpy).toHaveBeenCalledTimes(1);

    rerender(
      <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
        <CompactModeProvider value={{ compactMode: false }}>
          <UIActionsContext.Provider value={createUIActions()}>
            <UIStateContext.Provider
              value={createUIState({
                currentModel: 'gpt-5.4',
                historyRemountKey: 7,
              })}
            >
              <OverflowProvider>
                <MainContent />
              </OverflowProvider>
            </UIStateContext.Provider>
          </UIActionsContext.Provider>
        </CompactModeProvider>
      </AppContext.Provider>,
    );

    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(3);
    expect(appHeaderSpy).toHaveBeenCalledTimes(2);
  });

  it('continues source copy numbering from static history into pending chunks', () => {
    historyItemDisplayPropsSpy.mockClear();

    renderMainContent(
      createUIState({
        history: [
          {
            id: 1,
            type: 'gemini_content',
            text: [
              '```mermaid',
              'flowchart TD',
              '  A --> B',
              '```',
              '$$',
              '\\alpha',
              '$$',
            ].join('\n'),
          },
        ],
        pendingHistoryItems: [
          {
            type: 'gemini_content',
            text: [
              '```mermaid',
              'sequenceDiagram',
              '  A->>B: hi',
              '```',
              '$$',
              '\\beta',
              '$$',
            ].join('\n'),
          },
        ],
      }),
    );

    const pendingProps = historyItemDisplayPropsSpy.mock.calls
      .map((call) => call[0])
      .find((props) => props.isPending);

    expect(pendingProps?.sourceCopyIndexOffsets).toMatchObject({
      mathBlockCount: 1,
    });
    expect(
      pendingProps?.sourceCopyIndexOffsets?.codeBlockLanguageCounts.get(
        'mermaid',
      ),
    ).toBe(1);
  });
});
