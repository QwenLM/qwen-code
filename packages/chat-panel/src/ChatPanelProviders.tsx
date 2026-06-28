import type { ReactNode } from 'react';
import {
  CompactModeContext,
  TodoTimelineContext,
  TodoDetailContext,
  AgentToolContext,
  ApprovalModeContext,
  StreamingStateContext,
  type IsAgentTool,
  type StreamingRawInput,
} from './context';
import type { TodoSnapshotDiff, TodoDetail } from './todos-types';
import { I18nContext, type ChatPanelI18n } from './i18n';
import { MarkdownContext, type MarkdownSeam } from './markdown';
import {
  ChatPanelCustomizationContext,
  type ChatPanelCustomization,
} from './customization';

/**
 * Single injection point for everything the chat panel reads from context.
 * The host computes each value from its own data layer (web-shell's daemon
 * hooks, etc.) and wraps the whole panel — message stream AND composer — once,
 * so the panel never calls `daemon-react-sdk` itself.
 */
export interface ChatPanelProvidersProps {
  compactMode?: boolean;
  todoTimeline?: Map<string, TodoSnapshotDiff>;
  todoDetails?: Map<string, TodoDetail>;
  isAgentTool?: IsAgentTool;
  approvalModes?: readonly string[];
  streaming?: StreamingRawInput;
  /** Host translator + active language; defaults to identity (keys as text). */
  i18n?: ChatPanelI18n;
  /** Host markdown renderer + image-safety policy; defaults to plain text. */
  markdown?: MarkdownSeam;
  /** Narrow slice of host customization the conversation flow reads. */
  customization?: ChatPanelCustomization;
  children: ReactNode;
}

const EMPTY_TIMELINE: Map<string, TodoSnapshotDiff> = new Map();
const EMPTY_DETAILS: Map<string, TodoDetail> = new Map();
const NO_AGENT_TOOL: IsAgentTool = () => false;
const NO_APPROVAL_MODES: readonly string[] = [];
const IDLE_STREAMING: StreamingRawInput = {
  state: 'idle',
  chars: 0,
  agentTokens: 0,
  isReceiving: false,
};
const IDENTITY_I18N: ChatPanelI18n = { language: 'en', t: (key) => key };
const DEFAULT_MARKDOWN: MarkdownSeam = {
  renderMarkdown: ({ content }) => content,
  isSafeImageSrc: () => false,
};
const EMPTY_CUSTOMIZATION: ChatPanelCustomization = {};

export function ChatPanelProviders({
  compactMode = false,
  todoTimeline = EMPTY_TIMELINE,
  todoDetails = EMPTY_DETAILS,
  isAgentTool = NO_AGENT_TOOL,
  approvalModes = NO_APPROVAL_MODES,
  streaming = IDLE_STREAMING,
  i18n = IDENTITY_I18N,
  markdown = DEFAULT_MARKDOWN,
  customization = EMPTY_CUSTOMIZATION,
  children,
}: ChatPanelProvidersProps) {
  return (
    <I18nContext.Provider value={i18n}>
      <MarkdownContext.Provider value={markdown}>
        <ChatPanelCustomizationContext.Provider value={customization}>
          <CompactModeContext.Provider value={compactMode}>
            <TodoTimelineContext.Provider value={todoTimeline}>
              <TodoDetailContext.Provider value={todoDetails}>
                <AgentToolContext.Provider value={isAgentTool}>
                  <ApprovalModeContext.Provider value={approvalModes}>
                    <StreamingStateContext.Provider value={streaming}>
                      {children}
                    </StreamingStateContext.Provider>
                  </ApprovalModeContext.Provider>
                </AgentToolContext.Provider>
              </TodoDetailContext.Provider>
            </TodoTimelineContext.Provider>
          </CompactModeContext.Provider>
        </ChatPanelCustomizationContext.Provider>
      </MarkdownContext.Provider>
    </I18nContext.Provider>
  );
}
