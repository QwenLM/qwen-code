/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
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
import {
  ThinkingBodyComponentContext,
  type ThinkingBodyProps,
} from './ThinkingBody';

const FirstOfReplyContext = createContext<
  ReadonlyMap<string, boolean> | undefined
>(undefined);

/** Draws the Mods' rewrites of this transcript's reply and thinking rows. */
export function ModRowsProvider({
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
  // The renderer identity scopes remembered rewrites to this connection.
  const thinkingRenderer = useMemo(
    () => (asker ? { Body: ModThinkingBody } : undefined),
    [asker],
  );
  return (
    <FirstOfReplyContext.Provider value={rows}>
      <AssistantMessageComponentContext.Provider
        value={asker ? ModAssistantMessage : undefined}
      >
        <ThinkingBodyComponentContext.Provider value={thinkingRenderer}>
          {children}
        </ThinkingBodyComponentContext.Provider>
      </AssistantMessageComponentContext.Provider>
    </FirstOfReplyContext.Provider>
  );
}

/**
 * An expanded thought's body: once complete and on screen, a thought of the
 * session's own model is asked for, and drawn with the text its hooks wrote.
 */
export function ModThinkingBody({
  content,
  isStreaming,
  fromSubagent,
  onRewrittenChange,
}: ThinkingBodyProps) {
  const asker = useContext(ModRowAskerContext);
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = content.trimEnd();
  const row =
    !fromSubagent && !isStreaming && text.trim()
      ? { component: 'Thinking', props: { text } }
      : undefined;
  const answer = useModRow(
    asker,
    row,
    useOnScreen(bodyRef, row !== undefined),
  )?.['text'];
  const rewrite =
    typeof answer === 'string' && answer !== text ? answer : undefined;
  const rewrittenSource = rewrite === undefined ? undefined : content;
  useLayoutEffect(() => {
    onRewrittenChange?.(rewrittenSource);
  }, [rewrittenSource, onRewrittenChange]);
  return (
    <div ref={bodyRef}>
      <Markdown
        content={rewrite ?? content}
        source="thinking"
        isStreaming={isStreaming}
      />
    </div>
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
