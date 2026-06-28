/**
 * @qwen-code/chat-panel — the shared chat panel (input composer + conversation
 * flow) reused by web-shell, the VSCode webview, and the desktop app.
 *
 * Scaffold (WS1 in progress). The `Message[]` contract, `ChatPanel`, message
 * renderers, `ChatEditor`, and the render seam land as their workstreams complete.
 */
export * from './todos-types';
export * from './setting-descriptor';
export * from './context';
export * from './i18n';
export * from './markdown';
export * from './customization';
export * from './adapters/messageTypes';
export * from './adapters/types';
export * from './adapters/toolClassification';
export * from './ChatPanelProviders';
export * from './useStreamingLoadingMetrics';

// Shared utilities the carved components depend on.
export * from './utils/format';
export * from './utils/formatTokenCount';
export * from './utils/todos';
export * from './utils/dom';
export * from './hooks/useSharedNow';
export * from './constants/loadingPhrases';
// Tool formatting — `formatTokenCount` is intentionally omitted (it names a
// different function than ./utils/formatTokenCount; barrelling both clashes).
export {
  TOOL_DISPLAY_NAMES,
  formatToolDisplayName,
  localizeToolDisplayName,
  isAskUserQuestionToolName,
  truncateText,
  getToolDescription,
  extractText,
  getToolResultSummary,
  isShellToolName,
  toolContainsCallId,
  getTaskExecutionRecord,
  getAgentCancellationReason,
  getAgentDisplayStatus,
  getAgentType,
  getAgentDescription,
  getAgentCurrentToolHint,
} from './components/messages/toolFormatting';

// Conversation-flow components (carved in WS1, leaf-first).
export * from './components/MessageTimestamp';
export * from './components/InsightProgress';
export * from './components/InsightReady';
export * from './components/StreamingStatus';
export * from './components/messages/UserMessage';
export * from './components/messages/AssistantMessage';
export * from './components/messages/BtwMessage';
export * from './components/messages/UserShellMessage';
export * from './components/messages/TodoView';
export * from './components/messages/PlanMessage';
export * from './components/messages/ToolApproval';
export * from './components/messages/AskUserQuestion';
export * from './components/messages/ToolGroup';
export * from './components/messages/SystemMessage';
export * from './components/messages/tools/ParallelAgentsGroup';
export * from './components/messages/tools/SubAgentPanel';
export * from './components/MessageItem';
export * from './components/MessageList';

// Composed panel (conversation flow + streaming indicator + composer slot).
export * from './ChatPanel';
