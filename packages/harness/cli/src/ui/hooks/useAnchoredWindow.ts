/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  anchoredWindow,
  type AnchoredWindowAnchor,
  type AnchoredWindowResult,
} from '../utils/anchoredWindow.js';

export type HistoryConversationKey = string | number;

export interface UseAnchoredWindowOptions<Item, Key> {
  capacity: number;
  step: number;
  keyOf: (item: Item) => Key;
  enabled?: boolean;
}

interface AnchoredWindowState<Key> {
  conversationKey: HistoryConversationKey;
  anchor: AnchoredWindowAnchor<Key>;
}

/**
 * Keeps an anchored render window stable across appends and resets it when the
 * active conversation or projection identity changes.
 */
export function useAnchoredWindow<Item, Key>(
  items: readonly Item[],
  conversationKey: HistoryConversationKey,
  options: UseAnchoredWindowOptions<Item, Key>,
): AnchoredWindowResult<Item, Key> {
  const { capacity, step, keyOf, enabled = true } = options;
  const stateRef = useRef<AnchoredWindowState<Key>>({
    conversationKey,
    anchor: null,
  });

  const result = useMemo(() => {
    const previous = stateRef.current;
    const sameProjection = Object.is(previous.conversationKey, conversationKey);

    if (!enabled) {
      return { items, startIndex: 0, anchor: null };
    }

    return anchoredWindow(
      items,
      sameProjection ? previous.anchor : null,
      { capacity, step, keyOf },
    );
  }, [
    items,
    conversationKey,
    enabled,
    capacity,
    step,
    keyOf,
  ]);

  // Publish the anchor only after React commits this render. A concurrent
  // render may be abandoned and must not become the next frame's baseline.
  useLayoutEffect(() => {
    stateRef.current = {
      conversationKey,
      anchor: enabled ? result.anchor : null,
    };
  }, [conversationKey, enabled, result.anchor]);

  return result;
}
