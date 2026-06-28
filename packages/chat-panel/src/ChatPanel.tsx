/**
 * `<ChatPanel>` — the composed conversation flow: the message stream, the
 * streaming/elapsed indicator, and a host-supplied composer slot, all wrapped in
 * `ChatPanelProviders` so the carved components get their seams (i18n, markdown,
 * customization) and injected context values from one place.
 *
 * Hosts map their own data onto `messages` + the seam props and pass their
 * composer via `composerSlot` (web-shell's `ChatEditor`, etc.). The composer
 * itself is not carved in WS1 — it stays host-side (see WS-C). The ref forwards
 * to the underlying `MessageList` handle.
 */
import {
  forwardRef,
  type ComponentProps,
  type ForwardedRef,
  type ReactNode,
} from 'react';
import {
  ChatPanelProviders,
  type ChatPanelProvidersProps,
} from './ChatPanelProviders';
import { MessageList, type MessageListHandle } from './components/MessageList';
import { StreamingStatus } from './components/StreamingStatus';

type MessageListProps = Omit<ComponentProps<typeof MessageList>, 'ref'>;
type ProviderSeams = Omit<ChatPanelProvidersProps, 'children'>;

export interface ChatPanelProps extends MessageListProps, ProviderSeams {
  /** Host composer (e.g. web-shell's `ChatEditor`), rendered below the stream. */
  composerSlot?: ReactNode;
  /** Render the streaming/elapsed indicator between the stream and composer. */
  showStreamingStatus?: boolean;
  /** Epoch ms the active turn started, for the streaming indicator. */
  streamingStartedAt?: number;
}

function ChatPanelRender(
  {
    compactMode,
    todoTimeline,
    todoDetails,
    isAgentTool,
    approvalModes,
    streaming,
    i18n,
    markdown,
    customization,
    composerSlot,
    showStreamingStatus = false,
    streamingStartedAt,
    ...messageListProps
  }: ChatPanelProps,
  ref: ForwardedRef<MessageListHandle>,
) {
  return (
    <ChatPanelProviders
      compactMode={compactMode}
      todoTimeline={todoTimeline}
      todoDetails={todoDetails}
      isAgentTool={isAgentTool}
      approvalModes={approvalModes}
      streaming={streaming}
      i18n={i18n}
      markdown={markdown}
      customization={customization}
    >
      <MessageList ref={ref} {...messageListProps} />
      {showStreamingStatus && (
        <StreamingStatus startedAt={streamingStartedAt} />
      )}
      {composerSlot}
    </ChatPanelProviders>
  );
}

export const ChatPanel = forwardRef(ChatPanelRender);
