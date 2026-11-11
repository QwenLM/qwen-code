/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  AgentDetailView,
  type AgentDetailViewProps,
} from './src/ui/components/AgentDetailView.js';
export { AgentDetailEditor } from './src/ui/components/AgentDetailEditor.js';
export type {
  AgentDetailPageProps,
  AgentDetailEditorProps,
  AgentDetailField,
} from './src/ui/components/AgentDetailTypes.js';
export {
  createAgentEnabledField,
  createAgentModelField,
  createAgentExecutionFields,
} from './src/ui/components/agentDetailFields.js';

// UI surface for product code that renders inside the CLI's TUI providers.
// Kept separate from the package root so importing `@qwen-code/qwen-code` never
// loads Ink or React.
export { Box, Newline, Text, useInput, useStdin, useStdout } from 'ink';
export {
  BaseTabDialog,
  type TabItem,
} from './src/ui/components/shared/BaseTabDialog.js';
export { SettingsDialogPanel } from './src/ui/components/SettingsDialogPanel.js';
export type { SettingChangeGuard } from './src/ui/components/SettingsDialog.js';
export { InputField } from './src/ui/components/shared/InputField.js';
export { InputFrame } from './src/ui/components/shared/InputFrame.js';
export { CliSpinner } from './src/ui/components/CliSpinner.js';
export { Link } from './src/ui/components/shared/Link.js';
export {
  AboutBox,
  AboutRow,
  type AboutBoxProps,
} from './src/ui/components/AboutBox.js';
export {
  RadioButtonSelect,
  type RadioSelectItem,
} from './src/ui/components/shared/RadioButtonSelect.js';
export {
  useTextBuffer,
  expandPastePlaceholders,
  imagePathRegex,
  type TextBuffer,
} from './src/ui/components/shared/text-buffer.js';
export { theme } from './src/ui/semantic-colors.js';
export {
  SHORTCUT_HINTS,
  formatShortcutHint,
} from './src/ui/constants/shortcuts.js';
export type { ShortcutHint } from './src/ui/hooks/useContainerKeyboard.js';
export {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from './src/ui/contexts/ActionHandlerRegistry.js';
export {
  useKeypressContext,
  type Key,
} from './src/ui/contexts/KeypressContext.js';
export { useRegisterKeyboardContext } from './src/ui/contexts/KeyboardContextRegistry.js';
export { useRegisterHints } from './src/ui/contexts/HintRegistryContext.js';
export { isSingleLineTextInput } from './src/ui/key/textInput.js';
export { useKeypress } from './src/ui/hooks/useKeypress.js';
export { useTerminalSize } from './src/ui/hooks/useTerminalSize.js';
export {
  useSelectionList,
  type SelectionListItem,
} from './src/ui/hooks/useSelectionList.js';
export { figures } from './src/ui/utils/figures.js';
export {
  getCachedStringWidth,
  sanitizeForDisplay,
} from './src/ui/utils/textUtils.js';
export { MarkdownDisplay } from './src/ui/utils/MarkdownDisplay.js';
export { stringWidth } from './src/ink/stringWidth.js';
export { useUIState } from './src/ui/contexts/UIStateContext.js';
export type { UseHistoryManagerReturn } from './src/ui/hooks/useHistoryManager.js';
export { usePendingHistory } from './src/ui/contexts/PendingHistoryContext.js';
export { buildTuiTextSnapshot } from './src/ui/utils/tuiSnapshot.js';
export {
  clipboardHasImage,
  saveClipboardImage,
  readClipboardText,
  splitDragAndDropPaths,
} from './src/ui/utils/clipboardUtils.js';

export {
  UsageStatusRows,
  buildSessionStatusRows,
  buildSessionUsageRows,
  type UsageStatusRow,
} from './src/ui/components/UsageStatusPanel.js';
export {
  appEvents,
  AppEvent,
  LONG_TRANSIENT_MESSAGE_DURATION_MS,
  TransientMessageType,
} from './src/utils/events.js';
export {
  ModelSelector,
  type EffortCapableModel,
} from './src/ui/components/ModelSelector.js';
export { MessageType } from './src/ui/types.js';
export {
  compactCommand,
  createCompactCommand,
  type CompactCommandHooks,
} from './src/ui/commands/compressCommand.js';
export {
  createLocalCommandResultItem,
  type LocalCommandResultSeverity,
} from './src/ui/utils/localCommandResult.js';
export {
  formatEffortCommandSuffix,
  getModelEfforts,
} from './src/ui/utils/reasoningEffort.js';
export {
  formatContextWindowCommandSuffix,
  formatContextWindowValueLabel,
  getEffectiveDefaultContextWindow,
  getModelContextWindows,
  type ContextWindowCapableModel,
} from './src/ui/utils/contextWindow.js';
export {
  ORDERED_EFFORT_LEVELS,
  formatEffortLabel,
  formatEffortMeter,
  getDefaultReasoningEffort,
  getOrderedModelEfforts,
  supportsCurrentReasoningEffort,
} from './src/ui/utils/reasoningEffort.js';
export {
  SettingsListPanel,
  type SettingsDialogItem,
  type SettingsSuffixSegment,
} from './src/ui/components/shared/SettingsListPanel.js';
export { getLocalModelEdit } from './src/ui/utils/localCustomModels.js';
export { LocalCustomModelForm } from './src/ui/components/shared/LocalCustomModelForm.js';
export { CustomModelDeleteDialog } from './src/ui/components/shared/CustomModelDeleteDialog.js';
export {
  CustomModelWizard,
  type CustomModelWizardEntry,
} from './src/ui/components/shared/CustomModelWizard.js';
export { ProviderSelectionList } from './src/ui/components/shared/ProviderSelectionList.js';
export { formatCommand } from './src/ui/key/keybindingUtils.js';
export { Command } from './src/ui/key/keyBindings.js';
export {
  useKeyMatchers,
  useKeyBindingConfig,
} from './src/ui/hooks/useKeyMatchers.js';
export type { ActionHandler } from './src/ui/contexts/ActionHandlerRegistry.js';
export { formatLocalizedShortcutHint, T } from './src/ui/i18n/index.js';
export type { MessageParams, UiMessageKey } from './src/ui/i18n/types.js';
export type { SessionModelInfo } from './src/session/sessionModels.js';
export { GIT_COMMIT_INFO } from './src/generated/git-commit.js';
export { useConfig, useModel } from './src/ui/contexts/ConfigContext.js';
export { useSessionStats } from './src/ui/contexts/SessionContext.js';
export { useSettings } from './src/ui/contexts/SettingsContext.js';
export { SettingScope } from './src/config/settings.js';
export type {
  LoadableSettingScope,
  LoadedSettings,
} from './src/config/settings.js';
export {
  gracefulExit,
  runExitCleanupWithTimeout,
} from './src/utils/cleanup.js';
// Startup operations available to product-owned sessions.
export {
  runAfterAuthAttemptStartup,
  runAfterConfigInitializedStartup,
} from './src/startup/startupCoordinator.js';

export { StreamingContext } from './src/ui/contexts/StreamingContext.js';
export { useConversationContent } from './src/ui/hooks/useConversationContent.js';
export { useAppContext } from './src/ui/contexts/AppContext.js';
export { ScrollableList } from './src/ui/components/shared/ScrollableList.js';
export { SCROLL_TO_ITEM_END } from './src/ui/components/shared/VirtualizedList.js';
export { AgentTranscriptView } from './src/ui/components/AgentTranscriptView.js';
export { FoldStateProvider } from './src/ui/contexts/FoldStateContext.js';
export { FoldLevel } from './src/ui/constants/messageLayout.js';
export { McpAuthHeaderNotice } from './src/ui/components/McpAuthHeaderNotice.js';
export { DefaultWelcomeHeader } from './src/ui/components/DefaultWelcomeHeader.js';
export { OffscreenFreeze } from './src/ui/components/OffscreenFreeze.js';
export { useTips } from './src/ui/hooks/useTips.js';
export {
  MainControls,
  MainControlsBody,
  MainControlsDialogs,
  useMainControlsMode,
} from './src/ui/components/MainControls.js';
export { QuittingDisplay } from './src/ui/components/QuittingDisplay.js';
export { DialogContextBridge } from './src/ui/components/MainControls.js';
export { ExitWarning } from './src/ui/components/ExitWarning.js';
export { useFlickerDetector } from './src/ui/hooks/useFlickerDetector.js';
export { useAlternateBuffer } from './src/ui/hooks/useAlternateBuffer.js';
export { useUIActions } from './src/ui/contexts/UIActionsContext.js';
export { usePermissionQueueItems } from './src/ui/permissions/usePermissionQueue.js';
export type { UIState } from './src/ui/contexts/UIStateContext.js';

export {
  StatsSection,
  StatsIdentityRows,
  StatsInteractionMetrics,
  StatsPerformanceSection,
  type StatsDisplayProps,
} from './src/ui/components/StatsDisplay.js';
export type { StatusLineData } from './src/ui/contexts/StatusLineDataContext.js';
export { StatusLineDataContext } from './src/ui/contexts/StatusLineDataContext.js';

export {
  HistoryItemDisplay,
  HistoryItemFrame,
  type HistoryItemDisplayProps,
} from './src/ui/components/HistoryItemDisplay.js';
export { useSessionSummaryProps } from './src/ui/hooks/useSessionSummaryProps.js';
export { ThemedGradient } from './src/ui/components/ThemedGradient.js';
export type { UseFeedbackEventsParams } from './src/ui/hooks/useFeedbackEvents.js';

export { CommandDescriptionContext } from './src/ui/contexts/CommandDescriptionContext.js';
export { BUILTIN_COMMAND_DESCRIPTION_KEYS } from './src/ui/i18n/commandText.js';
export { useChangelog } from './src/changelog/useChangelog.js';
export {
  ReleaseNotesDialog,
  ConnectedReleaseNotesDialog,
} from './src/changelog/releaseNotesDialog.js';

// Shared plugin pages and data-driven views for product-owned browser composition.
export {
  usePluginBrowserState,
  PluginBrowserHelp,
  type PluginBrowserProps,
} from './src/ui/components/PluginBrowser/PluginSettings.js';
export { DiscoverPlugins } from './src/ui/components/PluginBrowser/DiscoverPlugins.js';
export { ManageMarketplaces } from './src/ui/components/PluginBrowser/ManageMarketplaces.js';
export { ValidatePlugin } from './src/ui/components/PluginBrowser/ValidatePlugin.js';
export { BrowseMarketplace } from './src/ui/components/PluginBrowser/BrowseMarketplace.js';
export { useInstalledPluginItems } from './src/ui/components/PluginBrowser/useInstalledPluginItems.js';
export { useInstalledPluginsController } from './src/ui/components/PluginBrowser/useInstalledPluginsController.js';
export { InstalledPluginsView } from './src/ui/components/PluginBrowser/InstalledPluginsView.js';
export {
  buildInstalledPluginPresentation,
  getInstalledItemScope,
  type InstalledPluginPresentation,
} from './src/ui/components/PluginBrowser/installedPluginPresentation.js';
export {
  PluginErrorList,
  buildPluginErrorDisplay,
  type PluginErrorDisplay,
} from './src/ui/components/PluginBrowser/ErrorsTab.js';
export type { UnifiedInstalledItem } from './src/ui/components/PluginBrowser/unifiedTypes.js';
export type { ManagePluginsProps } from './src/ui/components/PluginBrowser/ManagePlugins.js';
export { SHIFT_TAB_DISPLAY } from './src/ui/constants/shortcuts.js';
export {
  I18nServiceProvider,
  useI18nService,
  registerCliUiMessages,
  cliUiCatalog,
} from './src/ui/i18n/index.js';
