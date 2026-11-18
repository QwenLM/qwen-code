/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Message } from '../../adapters/types';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import {
  AssistantMessage,
  type AssistantMessageProps,
} from './AssistantMessage';
import { AssistantMessageComponentContext } from './AssistantMessageRow';
import { Markdown } from './Markdown';
import {
  modReplyRows,
  ModRowAskerContext,
  useModRow,
  useOnScreen,
} from './mod-rows';

const FirstOfReplyContext = createContext<
  ReadonlyMap<string, boolean> | undefined
>(undefined);

export function ModReplyRowsProvider({
  messages,
  children,
}: {
  messages: readonly Message[];
  children: ReactNode;
}) {
  const asker = useContext(ModRowAskerContext);
  const rows = useMemo(
    () => (asker ? modReplyRows(messages) : undefined),
    [asker, messages],
  );
  return (
    <FirstOfReplyContext.Provider value={rows}>
      <AssistantMessageComponentContext.Provider
        value={asker ? ModAssistantMessage : undefined}
      >
        {children}
      </AssistantMessageComponentContext.Provider>
    </FirstOfReplyContext.Provider>
  );
}

export function ModAssistantMessage({
  messageId,
  ...props
}: AssistantMessageProps & { messageId: string }) {
  const asker = useContext(ModRowAskerContext);
  const isFirstOfReply = useContext(FirstOfReplyContext)?.get(messageId);
  const rowRef = useRef<HTMLDivElement>(null);
  const copySource = useRef<HTMLDivElement>(null);
  const row =
    isFirstOfReply !== undefined && !props.isStreaming && props.content
      ? {
          component: 'AssistantMessage',
          props: { text: props.content, isFirstOfReply },
        }
      : undefined;
  const rewrite = useModRow(asker, row, useOnScreen(rowRef, row !== undefined));
  const text = rewrite?.['text'];
  const rewritten = typeof text === 'string' && text !== props.content;
  const copyOriginal = rewritten && props.showFooterActions;
  if (isFirstOfReply === undefined) return <AssistantMessage {...props} />;
  return (
    <div ref={rowRef}>
      <AssistantMessage
        {...props}
        displayContent={rewritten ? text : undefined}
        copySource={copyOriginal ? copySource : undefined}
      />
      {copyOriginal && (
        <div hidden>
          <div ref={copySource}>
            <TranscriptRenderModeProvider value="document">
              <Markdown content={props.content} tableMode="basic" />
            </TranscriptRenderModeProvider>
          </div>
        </div>
      )}
    </div>
  );
}
