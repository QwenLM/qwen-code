/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import './AssistantMessage.css';
import './WaitingMessage.css';
import { WITTY_LOADING_PHRASES } from '../../../constants/loadingMessages.js';

interface WaitingMessageProps {
  loadingMessage: string;
}

// Rotate message every few seconds while waiting
const ROTATE_INTERVAL_MS = 3000; // rotate every 3s per request

export const WaitingMessage: React.FC<WaitingMessageProps> = ({
  loadingMessage,
}) => {
  // Build a phrase list that starts with the provided message (if any), then witty fallbacks
  const phrases = useMemo(() => {
    const set = new Set<string>();
    const list: string[] = [];
    if (loadingMessage && loadingMessage.trim()) {
      list.push(loadingMessage);
      set.add(loadingMessage);
    }
    for (const p of WITTY_LOADING_PHRASES) {
      if (!set.has(p)) {
        list.push(p);
      }
    }
    return list;
  }, [loadingMessage]);

  const [index, setIndex] = useState(0);

  // Reset to the first phrase whenever the incoming message changes
  useEffect(() => {
    setIndex(0);
  }, [phrases]);

  // Periodically rotate to a different phrase
  useEffect(() => {
    if (phrases.length <= 1) {
      return;
    }
    const id = setInterval(() => {
      setIndex((prev) => {
        // pick a different random index to avoid immediate repeats
        let next = Math.floor(Math.random() * phrases.length);
        if (phrases.length > 1) {
          let guard = 0;
          while (next === prev && guard < 5) {
            next = Math.floor(Math.random() * phrases.length);
            guard++;
          }
        }
        return next;
      });
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [phrases]);

  return (
    <div className="flex gap-0 items-start text-left py-2 flex-col opacity-85 animate-[fadeIn_0.2s_ease-in]">
      {/* Use the same left status icon (pseudo-element) style as assistant-message-container */}
      <div
        className="assistant-message-container assistant-message-loading"
        style={{
          width: '100%',
          alignItems: 'flex-start',
          paddingLeft: '30px', // reserve space for ::before bullet
          position: 'relative',
          paddingTop: '8px',
          paddingBottom: '8px',
        }}
      >
        <span className="opacity-70 italic loading-text-shimmer">
          {phrases[index]}
        </span>
      </div>
    </div>
  );
};
