/**
 * @qwen-code/chat-panel — the shared chat panel (input composer + conversation
 * flow) reused by web-shell, the VSCode webview, and the desktop app.
 *
 * Scaffold (WS1 in progress). The `Message[]` contract, `ChatPanel`, message
 * renderers, `ChatEditor`, and the render seam land as their workstreams complete.
 */
export * from './todos-types.js';
export * from './setting-descriptor.js';
export * from './context.js';
export * from './i18n.js';
export * from './markdown.js';
export * from './customization.js';
export * from './adapters/messageTypes.js';
export * from './adapters/types.js';
export * from './adapters/toolClassification.js';
export * from './ChatPanelProviders.js';
export * from './useStreamingLoadingMetrics.js';

// Shared utilities the carved components depend on.
export * from './utils/format.js';
export * from './utils/formatTokenCount.js';
export * from './utils/todos.js';
export * from './utils/dom.js';
export * from './hooks/useSharedNow.js';
export * from './constants/loadingPhrases.js';
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
} from './components/messages/toolFormatting.js';

// Conversation-flow components (carved in WS1, leaf-first).
export * from './components/MessageTimestamp.js';
export * from './components/InsightProgress.js';
export * from './components/InsightReady.js';
export * from './components/StreamingStatus.js';
export * from './components/messages/UserMessage.js';
export * from './components/messages/AssistantMessage.js';
export * from './components/messages/BtwMessage.js';
export * from './components/messages/UserShellMessage.js';
export * from './components/messages/TodoView.js';
export * from './components/messages/PlanMessage.js';
export * from './components/messages/ToolApproval.js';
export * from './components/messages/AskUserQuestion.js';
export * from './components/messages/ToolGroup.js';
export * from './components/messages/SystemMessage.js';
export * from './components/messages/tools/ParallelAgentsGroup.js';
export * from './components/messages/tools/SubAgentPanel.js';
export * from './components/MessageItem.js';
export * from './components/MessageList.js';

// Composed panel (conversation flow + streaming indicator + composer slot).
export * from './ChatPanel.js';
