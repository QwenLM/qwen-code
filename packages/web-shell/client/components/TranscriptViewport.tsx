/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  forwardRef,
  useEffect,
  type ComponentType,
  type RefAttributes,
} from 'react';
import {
  MessageList,
  type MessageListHandle,
  type MessageListProps,
} from './MessageList';
import styles from './TranscriptViewport.module.css';
import { ModRowsProvider } from './messages/ModAssistantMessage';

export interface TurnFollowRange {
  start: number;
  end: number;
  current: number;
}

// Rows whose blocks carry no turn mapping (assistant output, tool cards)
// inherit the turn of the previous mapped row; rows above the first mapped row
// belong to the turn before it. This mirrors how the in-list timeline
// propagates a turn id across its rows.
export function followRangeFromRows(
  rows: readonly { top: number; bottom: number; ordinal?: number }[],
  viewportTop: number,
  viewportBottom: number,
): TurnFollowRange | undefined {
  const firstMapped = rows.find((row) => row.ordinal !== undefined)?.ordinal;
  if (firstMapped === undefined) return undefined;
  // The reading position is anchored a third of the way down the viewport so
  // the highlight reaches the first and last turns at the scroll extremes
  // instead of stalling on whichever turn sits in the middle.
  const line = viewportTop + (viewportBottom - viewportTop) / 3;
  let lastMapped: number | undefined;
  let start: number | undefined;
  let end: number | undefined;
  let firstVisible: number | undefined;
  let current: number | undefined;
  for (const row of rows) {
    if (row.ordinal !== undefined) lastMapped = row.ordinal;
    const effective = row.ordinal ?? lastMapped ?? Math.max(0, firstMapped - 1);
    if (row.bottom < viewportTop || row.top > viewportBottom) continue;
    start = start === undefined ? effective : Math.min(start, effective);
    end = end === undefined ? effective : Math.max(end, effective);
    firstVisible ??= effective;
    if (row.top <= line) current = effective;
  }
  if (start === undefined || end === undefined) return undefined;
  return { start, end, current: current ?? firstVisible! };
}

export interface TranscriptViewportProps extends MessageListProps {
  approvalOverlayActive?: boolean;
  /**
   * Enables session-context historical turn navigation and message deletion
   * when paired with an injected {@link sessionViewportComponent}. Defaults to
   * `true` for daemon callers; pass `false` for flat live hosts (including
   * non-daemon surfaces co-mounted inside a daemon provider tree).
   */
  sessionViewportEnabled?: boolean;
  /**
   * Session-aware viewport component injected by daemon hosts when historical
   * turn navigation and message deletion are supported. Required alongside
   * {@link sessionViewportEnabled} to activate the session viewport.
   */
  sessionViewportComponent?: ComponentType<
    TranscriptViewportProps & RefAttributes<MessageListHandle>
  >;
}

export const LiveTranscriptViewport = forwardRef<
  MessageListHandle,
  TranscriptViewportProps
>(function LiveTranscriptViewport(
  {
    approvalOverlayActive: _approvalOverlayActive,
    sessionViewportEnabled: _sessionViewportEnabled,
    sessionViewportComponent: _sessionViewportComponent,
    ...props
  },
  ref,
) {
  return (
    <div
      className={`${styles.root} relative flex min-h-0 flex-1`}
      data-history-viewport="live"
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ModRowsProvider messages={props.messages}>
          <MessageList
            {...props}
            ref={ref}
            hookStatisticsSessionId={props.sourceSessionId}
            mcpAppSessionId={props.mcpAppSessionId ?? props.sourceSessionId}
          />
        </ModRowsProvider>
      </div>
    </div>
  );
});

export const TranscriptViewport = forwardRef<
  MessageListHandle,
  TranscriptViewportProps
>(function TranscriptViewport(
  {
    sessionViewportEnabled = true,
    sessionViewportComponent: SessionViewportComponent,
    ...props
  },
  ref,
) {
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      sessionViewportEnabled &&
      !SessionViewportComponent
    ) {
      console.warn(
        '[web-shell] TranscriptViewport received sessionViewportEnabled without sessionViewportComponent; falling back to LiveTranscriptViewport.',
      );
    }
  }, [sessionViewportEnabled, SessionViewportComponent]);

  if (!sessionViewportEnabled || !SessionViewportComponent) {
    return <LiveTranscriptViewport ref={ref} {...props} />;
  }
  return <SessionViewportComponent ref={ref} {...props} />;
});
