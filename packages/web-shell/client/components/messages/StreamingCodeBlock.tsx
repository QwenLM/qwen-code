/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { CodeToTokenTransformStream } from '@shikijs/stream';
import { ShikiStreamRenderer } from '@shikijs/stream/react';
import { getCodeHighlighter } from './codeHighlighter';
import styles from './Markdown.module.css';

interface StreamingCodeBlockProps {
  /** The full code accumulated so far (grows as the turn streams). */
  code: string;
  /** Resolved Shiki language id (already alias-normalized, never 'text'). */
  lang: string;
  /** Shiki theme id. */
  theme: string;
}

/**
 * Pushes the part of `next` that hasn't been sent yet into the stream.
 *
 * Returns the updated "already sent" string and whether the stream diverged:
 * when `next` is a prefix-extension of `sent` the new suffix is enqueued; if
 * `next` shrank or was replaced (react-markdown re-segmenting a fence), or the
 * controller is already closed/errored, it reports `diverged` so the caller can
 * rebuild the stream instead of feeding it inconsistent chunks.
 */
function enqueueSuffix(
  controller: ReadableStreamDefaultController<string>,
  sent: string,
  next: string,
): { sent: string; diverged: boolean } {
  if (next === sent) return { sent, diverged: false };
  if (next.startsWith(sent)) {
    try {
      controller.enqueue(next.slice(sent.length));
    } catch {
      return { sent, diverged: true };
    }
    return { sent: next, diverged: false };
  }
  return { sent, diverged: true };
}

/**
 * Highlights a code fence *as it streams in* using @shikijs/stream.
 *
 * react-markdown re-parses the whole message on every token and hands us the
 * cumulative code string, so we bridge that to the package's incremental model:
 * a `ReadableStream<string>` whose controller we feed only the newly-appended
 * suffix on each render. The transform stream tokenizes just that suffix
 * (no whole-document re-tokenization) and `ShikiStreamRenderer` paints it.
 */
export function StreamingCodeBlock({
  code,
  lang,
  theme,
}: StreamingCodeBlockProps) {
  const controllerRef = useRef<ReadableStreamDefaultController<string> | null>(
    null,
  );
  // The exact code already pushed into the text stream.
  const sentRef = useRef('');
  // Latest code, so the async setup flush is never stale.
  const codeRef = useRef(code);
  codeRef.current = code;

  const [tokenStream, setTokenStream] =
    useState<ReadableStream<unknown> | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped to rebuild the stream from scratch when the content diverges from
  // what we've already sent (shrink/replace) or the controller is torn down.
  const [resetKey, setResetKey] = useState(0);

  // Build the text → token stream per (lang, theme, resetKey).
  useEffect(() => {
    let cancelled = false;
    sentRef.current = '';
    setTokenStream(null);
    setFailed(false);

    getCodeHighlighter(lang)
      .then((highlighter) => {
        if (cancelled) return;
        const textStream = new ReadableStream<string>({
          start(controller) {
            controllerRef.current = controller;
          },
        });
        const tokens = textStream.pipeThrough(
          new CodeToTokenTransformStream({
            highlighter,
            lang,
            theme,
            allowRecalls: true,
          }),
        );
        setTokenStream(tokens);
        // Flush everything that has already arrived during the async load.
        if (controllerRef.current) {
          const result = enqueueSuffix(
            controllerRef.current,
            sentRef.current,
            codeRef.current,
          );
          sentRef.current = result.sent;
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      try {
        controllerRef.current?.close();
      } catch {
        // Stream already closed.
      }
      controllerRef.current = null;
    };
  }, [lang, theme, resetKey]);

  // Push the newly-streamed suffix into the text stream as code grows; if the
  // content diverged or the controller is gone, rebuild the stream.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const result = enqueueSuffix(controller, sentRef.current, code);
    sentRef.current = result.sent;
    if (result.diverged) setResetKey((key) => key + 1);
  }, [code]);

  if (failed || !tokenStream) {
    // Highlighter still loading or unavailable — show plain text so the
    // streamed content stays visible.
    return (
      <pre className={`${styles.codeBlockContent} ${styles.codeBlockPlain}`}>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div className={styles.codeBlockContent}>
      <ShikiStreamRenderer
        stream={
          tokenStream as React.ComponentProps<
            typeof ShikiStreamRenderer
          >['stream']
        }
      />
    </div>
  );
}
