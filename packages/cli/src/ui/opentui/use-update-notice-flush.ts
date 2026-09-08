/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Update-notice wiring (ink AppContainer parity): registers the shared
 * handler so notices deferred while a turn streams queue up, and drains the
 * queue the moment the turn returns to idle — flush is the only drain of
 * pendingNotifications, so a deferred notice would otherwise never reach the
 * transcript.
 */

import { useEffect, useRef } from 'react';
import { setUpdateHandler } from '../handleAutoUpdate.js';
import type { HistoryItemWithoutId } from '../types.js';
import type { UpdateObject } from '../utils/updateCheck.js';

export function useUpdateNoticeFlush(
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  setUpdateInfo: (info: UpdateObject | null) => void,
  isIdleRef: { current: boolean },
  streaming: boolean,
): void {
  const updateHandlerRef = useRef<ReturnType<typeof setUpdateHandler> | null>(
    null,
  );
  useEffect(() => {
    const handler = setUpdateHandler(addItem, setUpdateInfo, isIdleRef);
    updateHandlerRef.current = handler;
    return handler.cleanup;
  }, [addItem, setUpdateInfo, isIdleRef]);
  useEffect(() => {
    if (!streaming) updateHandlerRef.current?.flush();
  }, [streaming]);
}
