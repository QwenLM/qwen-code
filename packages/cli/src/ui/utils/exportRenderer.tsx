/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import stripAnsi from 'strip-ansi';
import { Box } from 'ink';
import { Config, type Message } from '@qwen-code/core';
import { StreamingState } from '../types.js';
import { renderToAnsiString } from './staticRender.js';
import { convertMessagesToHistoryFormats } from '../../utils/sessionUtils.js';
import { collapseReadOnlyGroups } from './collapseReadOnlyGroups.js';
import { HistoryItemDisplay } from '../components/HistoryItemDisplay.js';
import { getSpacingCategory, FoldLevel } from '../constants/messageLayout.js';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';

// -- Contexts needed by HistoryItemDisplay sub-components --
import { SettingsContext } from '../contexts/SettingsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { FoldStateProvider } from '../contexts/FoldStateContext.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import { ToolActionsProvider } from '../contexts/ToolActionsContext.js';
import { AppContext, type AppState } from '../contexts/AppContext.js';
import {
  createLoadedSettings,
  type LoadedSettings,
} from '../../config/settings.js';
import { MermaidRenderContext } from './MermaidBlock.js';

// Stable function refs to avoid infinite re-render in ToolActionsProvider
const ALWAYS_FALSE = (_callId: string): boolean => false;
const NOOP_ONE = (_callId: string): void => {};
const NOOP_MANY = (_callIds: string[]): void => {};

// ---------------------------------------------------------------------------
// Headless-safe provider stack
// ---------------------------------------------------------------------------

/**
 * A static, no-op Config for headless rendering. We only need methods that
 * HistoryItemDisplay sub-components call (getUseBackgroundColor,
 * getSessionId, getToolRegistry, etc.). Config's constructor gives sane defaults
 * for everything — the export path never triggers side effects.
 */
function createHeadlessConfig(): Config {
  const emptyFile = () => ({
    path: '',
    settings: {},
    originalSettings: {},
    readOnly: true,
  });
  return new Config({
    loadedSettings: createLoadedSettings(
      emptyFile(),
      emptyFile(),
      emptyFile(),
      false,
    ),
    debugMode: false,
    sessionId: 'export',
    proxy: undefined,
    model: '',
    targetDir: process.cwd(),
    cwd: process.cwd(),
  });
}

const defaultAppState: AppState = {
  version: '',
};

/**
 * Build a minimal UIState for headless rendering.
 * Only fields accessed by message sub-components are meaningful.
 */
function createHeadlessUIState(terminalWidth: number): UIState {
  return {
    history: [],
    historyManager: {} as UIState['historyManager'],
    isThemeDialogOpen: false,
    themeError: null,
    isConfigInitialized: true,
    editorError: null,
    isEditorDialogOpen: false,
    corgiMode: false,
    debugMessage: '',
    quittingMessages: null,
    isSettingsDialogOpen: false,
    isSessionBrowserOpen: false,
    isAgentConfigDialogOpen: false,
    isAgentBrowserOpen: false,
    isMcpBrowserOpen: false,
    isHookBrowserOpen: false,
    isHookConfigDialogOpen: false,
    isSkillBrowserOpen: false,
    isSkillDetailViewOpen: false,
    isConfigErrorDetailOpen: false,
    isPluginBrowserOpen: false,
    slashCommands: undefined,
    pendingSlashCommandHistoryItems: [],
    commandContext: {} as UIState['commandContext'],
    commandConfirmationRequest: null,
    authConsentRequest: null,
    confirmUpdateExtensionRequests: [],
    streamingState: StreamingState.Idle,
    isModelTurnActive: false,
    isCommandProgressActive: false,
    compressionProgress: null,
    renderMarkdown: true,
    constrainHeight: false,
    terminalWidth,
    terminalHeight: 24,
    mainAreaWidth: terminalWidth,
    currentModel: '',
    currentReasoningEffort: undefined,
    currentContextWindow: undefined,
    terminalBackgroundColor: 'black' as const,
    cleanUiDetailsVisible: false,
    allowPlanMode: false,
    activeShellId: undefined,
    hintMode: false,
    hintBuffer: '',
    nightly: false,
    updateInfo: null,
    pendingHistoryItems: [],
    mainControlsRef: (() => {}) as unknown as UIState['mainControlsRef'],
    rootUiRef: { current: null } as UIState['rootUiRef'],
    staticAreaMaxItemHeight: undefined,
    availableTerminalHeight: undefined,
  } as unknown as UIState;
}

interface HeadlessProvidersProps {
  children: React.ReactNode;
  terminalWidth: number;
  settings: LoadedSettings;
}

/**
 * Minimal provider stack for headless export rendering.
 * Provides only the contexts that HistoryItemDisplay sub-components consume.
 */
function HeadlessProviders({
  children,
  terminalWidth,
  settings,
}: HeadlessProvidersProps) {
  const config = useMemo(() => createHeadlessConfig(), []);
  const uiState = useMemo(
    () => createHeadlessUIState(terminalWidth),
    [terminalWidth],
  );

  return (
    <AppContext.Provider value={defaultAppState}>
      <ConfigContext.Provider value={config}>
        <SettingsContext.Provider value={settings}>
          <UIStateContext.Provider value={uiState}>
            <StreamingContext.Provider value={StreamingState.Idle}>
              <FoldStateProvider initialFoldLevel={FoldLevel.FullyExpanded}>
                <OverflowProvider>
                  <ToolActionsProvider
                    toolCalls={[]}
                    isExpanded={ALWAYS_FALSE}
                    toggleExpansion={NOOP_ONE}
                    toggleAllExpansion={NOOP_MANY}
                  >
                    {/* Exported text keeps mermaid source, not diagrams. */}
                    <MermaidRenderContext.Provider value={false}>
                      <Box width={terminalWidth} flexDirection="column">
                        {children}
                      </Box>
                    </MermaidRenderContext.Provider>
                  </ToolActionsProvider>
                </OverflowProvider>
              </FoldStateProvider>
            </StreamingContext.Provider>
          </UIStateContext.Provider>
        </SettingsContext.Provider>
      </ConfigContext.Provider>
    </AppContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Message rendering component
// ---------------------------------------------------------------------------

function assignIds(items: HistoryItemWithoutId[]): HistoryItem[] {
  return items.map((item, i) => ({ ...item, id: i + 1 }));
}

interface ExportMessagesProps {
  historyItems: HistoryItem[];
  renderRange?: readonly [number, number];
  terminalWidth: number;
}

/**
 * Renders a slice of HistoryItem[] through HistoryItemDisplay,
 * replicating the augmentation logic from MainContent.
 */
function ExportMessages({
  historyItems,
  renderRange,
  terminalWidth,
}: ExportMessagesProps) {
  const collapsed = useMemo(
    () => collapseReadOnlyGroups(historyItems),
    [historyItems],
  );

  // Augment with computed flags (mirrors MainContent logic)
  const augmented = useMemo(() => {
    // We need the full collapsed list context for prevType calculation
    // when renderRange is used, so we compute on the full list then slice.
    const fullAugmented = collapsed.map((item, i) => {
      const prevType = i > 0 ? collapsed[i - 1]?.type : undefined;
      const isFirstThinking =
        item.type === 'thinking' && prevType !== 'thinking';
      // Track tool group adjacency for internal tool chrome. External spacing
      // is handled by MessageSlot/getSpacingGap.
      const isToolGroupBoundary =
        item.type === 'tool_group' || prevType === 'tool_group';
      const category = getSpacingCategory(item.type);
      const prevCategory =
        i > 0 ? getSpacingCategory(collapsed[i - 1].type) : undefined;
      return {
        item,
        isFirstThinking,
        isToolGroupBoundary,
        category,
        prevCategory,
      };
    });

    if (renderRange) {
      return fullAugmented.slice(renderRange[0], renderRange[1]);
    }
    return fullAugmented;
  }, [collapsed, renderRange]);

  return (
    <>
      {augmented.map(
        ({
          item,
          isFirstThinking,
          isToolGroupBoundary,
          category,
          prevCategory,
        }) => (
          <HistoryItemDisplay
            key={item.id}
            item={item}
            terminalWidth={terminalWidth}
            isPending={false}
            isExpandable={true}
            isFirstThinking={isFirstThinking}
            isToolGroupBoundary={isToolGroupBoundary}
            suppressNarration={false}
            category={category}
            prevCategory={prevCategory}
          />
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 40;
const DEFAULT_COLUMNS = 80;

/**
 * Streams rendered messages in chunks. Each chunk is a fresh
 * renderToAnsiString call — keeps the yoga layout tree small.
 */
export async function streamRenderedMessages(
  messages: Message[],
  settings: LoadedSettings,
  sink: (ansiChunk: string) => void | Promise<void>,
  opts: {
    columns?: number;
    chunkSize?: number;
  } = {},
): Promise<void> {
  const columns = opts.columns ?? DEFAULT_COLUMNS;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;

  // Convert Message[] → HistoryItem[]
  const { uiHistory } = convertMessagesToHistoryFormats(messages);
  const historyItems = assignIds(uiHistory);

  // Collapse for accurate count
  const collapsed = collapseReadOnlyGroups(historyItems);
  const total = collapsed.length;

  for (let offset = 0; offset < total; offset += chunkSize) {
    const range = [offset, Math.min(offset + chunkSize, total)] as const;
    const ansi = await renderToAnsiString(
      <HeadlessProviders terminalWidth={columns} settings={settings}>
        <ExportMessages
          historyItems={historyItems}
          renderRange={range}
          terminalWidth={columns}
        />
      </HeadlessProviders>,
      columns,
    );

    const text = stripAnsi(ansi).trim();
    if (text === '') break;
    await sink(ansi);
  }
}

/**
 * Renders messages to a plain text string suitable for export.
 * Uses the same React rendering pipeline as the interactive UI.
 */
export async function renderMessagesToPlainText(
  messages: readonly Message[],
  settings: LoadedSettings,
  columns?: number,
): Promise<string> {
  const parts: string[] = [];
  await streamRenderedMessages(
    messages as Message[],
    settings,
    (chunk) => void parts.push(stripAnsi(chunk)),
    { columns },
  );
  return parts.join('');
}
