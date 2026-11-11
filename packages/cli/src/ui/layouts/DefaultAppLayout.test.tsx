/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, vi, beforeEach, it, expect } from 'vitest';
import { useInputState } from '../contexts/InputContext.js';

vi.mock('../contexts/InputContext.js');
import { StreamingState } from '../types.js';
import { Box, Text } from 'ink';
import type { UIState } from '../contexts/UIStateContext.js';
import { renderWithI18n as render } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';

const keyboardContextMocks = vi.hoisted(() => ({
  useRegisterKeyboardContext: vi.fn(),
}));
const inkAppMocks = vi.hoisted(() => ({
  requestViewportReset: vi.fn(),
}));
const permissionQueueMocks = vi.hoisted(() => ({
  items: [] as unknown[],
}));
const dialogManagerMocks = vi.hoisted(() => ({
  hasOwnTopSpacing: false,
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => inkAppMocks,
  };
});

vi.mock('../contexts/KeyboardContextRegistry.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../contexts/KeyboardContextRegistry.js')
    >();
  return {
    ...actual,
    useRegisterKeyboardContext: keyboardContextMocks.useRegisterKeyboardContext,
  };
});

// Mock dependencies
const createMockUIState = (): UIState =>
  ({
    rootUiRef: { current: null },
    terminalHeight: 24,
    terminalWidth: 80,
    mainAreaWidth: 80,
    dialogsVisible: false,
    streamingState: StreamingState.Idle,
    mainControlsRef: vi.fn(),
    customDialog: null,
    fullScreenDialog: null,
    historyManager: { addItem: vi.fn() },
    history: [],
    pendingHistoryItems: [],
    slashCommands: [],
    constrainHeight: false,
    conversationScreen: 'prompt',
    availableTerminalHeight: 20,
    activeShellId: null,
  }) as unknown as UIState;

let mockUIState = createMockUIState();

vi.mock('../contexts/UIStateContext.js', () => ({
  useUIState: () => mockUIState,
}));

vi.mock('../hooks/useFlickerDetector.js', () => ({
  useFlickerDetector: vi.fn(),
}));

vi.mock('../hooks/useAlternateBuffer.js', () => ({
  useAlternateBuffer: vi.fn(() => false),
}));

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => ({}),
}));

// Mock child components to simplify output
vi.mock('../components/LoadingIndicator.js', () => ({
  LoadingIndicator: () => <Text>LoadingIndicator</Text>,
}));
vi.mock('../components/MainContent.js', () => ({
  MainContent: () => <Text>MainContent</Text>,
}));
vi.mock('../components/DialogManager.js', () => ({
  DialogManager: () => (
    <Box marginTop={dialogManagerMocks.hasOwnTopSpacing ? 1 : 0}>
      <Text>DialogManager</Text>
    </Box>
  ),
}));
vi.mock('../components/Composer.js', () => ({
  Composer: () => <Text>Composer</Text>,
}));
vi.mock('../components/ExitWarning.js', () => ({
  ExitWarning: () => null,
}));
vi.mock('../components/QuittingDisplay.js', () => ({
  QuittingDisplay: () => <Text>QuittingDisplay</Text>,
}));
vi.mock('../permissions/usePermissionQueue.js', () => ({
  usePermissionQueueItems: () => permissionQueueMocks.items,
}));
vi.mock('../permissions/PermissionQueue.js', () => ({
  PermissionQueue: () => null,
}));

import { DefaultAppLayout } from './DefaultAppLayout.js';

describe('<DefaultAppLayout />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useInputState).mockReturnValue(
      {} as unknown as ReturnType<typeof useInputState>,
    );
    // Reset mock state defaults
    mockUIState = createMockUIState();
    permissionQueueMocks.items = [];
    dialogManagerMocks.hasOwnTopSpacing = false;
  });

  it('activates Dialog keyboard context for full-screen dialogs', async () => {
    mockUIState.fullScreenDialog = <Text>Fullscreen panel</Text>;

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('Fullscreen panel');
    expect(
      keyboardContextMocks.useRegisterKeyboardContext,
    ).toHaveBeenCalledWith('Dialog', true);
    unmount();
  });

  it('requests a viewport rebuild when permission controls collapse to composer', async () => {
    mockUIState.dialogsVisible = true;
    permissionQueueMocks.items = [{ id: 'permission' }];

    const { rerender, unmount } = await render(<DefaultAppLayout />);

    expect(inkAppMocks.requestViewportReset).not.toHaveBeenCalled();

    mockUIState = {
      ...mockUIState,
      dialogsVisible: false,
    } as UIState;
    permissionQueueMocks.items = [];
    rerender(<DefaultAppLayout />);

    expect(inkAppMocks.requestViewportReset).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not request a viewport rebuild for steady composer renders', async () => {
    const { rerender, unmount } = await render(<DefaultAppLayout />);

    rerender(<DefaultAppLayout />);

    expect(inkAppMocks.requestViewportReset).not.toHaveBeenCalled();
    unmount();
  });

  it('separates custom dialogs from main content by one blank line', async () => {
    mockUIState.customDialog = <Text>CustomDialog</Text>;

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('MainContent\n\nCustomDialog');
    unmount();
  });

  it('separates managed dialogs from main content by one blank line', async () => {
    mockUIState.dialogsVisible = true;

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('MainContent\n\nDialogManager');
    unmount();
  });

  it('does not double-space managed dialogs that own their top margin', async () => {
    mockUIState.dialogsVisible = true;
    mockUIState.isFolderTrustDialogOpen = true;
    dialogManagerMocks.hasOwnTopSpacing = true;

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('MainContent\n\nDialogManager');
    expect(lastFrame()).not.toContain('MainContent\n\n\nDialogManager');
    unmount();
  });

  it('keeps main content mounted while replacing controls with the quitting display', async () => {
    mockUIState.quittingMessages = [{ id: 1, type: 'user', text: '/quit' }];

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('MainContent');
    expect(lastFrame()).toContain('QuittingDisplay');
    expect(lastFrame()).not.toContain('Composer');
    unmount();
  });

  it('replaces the composer with a return hint in detailed transcript mode', async () => {
    mockUIState.conversationScreen = 'transcript';

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('MainContent');
    expect(lastFrame()).toContain(
      'Showing detailed transcript · Ctrl+O to return',
    );
    expect(lastFrame()).not.toContain('Composer');
    unmount();
  });

  it('keeps full-screen dialogs above detailed transcript mode', async () => {
    mockUIState.conversationScreen = 'transcript';
    mockUIState.fullScreenDialog = <Text>Fullscreen panel</Text>;

    const { lastFrame, unmount } = await render(<DefaultAppLayout />);

    expect(lastFrame()).toContain('Fullscreen panel');
    expect(lastFrame()).not.toContain('Showing detailed transcript');
    expect(lastFrame()).not.toContain('MainContent');
    unmount();
  });

  it('localizes the detailed transcript return hint', async () => {
    mockUIState.conversationScreen = 'transcript';
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });

    const { lastFrame, unmount } = await render(
      <DefaultAppLayout />,
      undefined,
      1000,
      settings,
    );

    expect(lastFrame()).toContain('正在显示详细记录 · 按 Ctrl+O 返回');
    unmount();
  });
});
