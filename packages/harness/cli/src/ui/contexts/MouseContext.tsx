/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions derived from vybestack/llxprt-code (Apache-2.0),
 * Copyright 2025 Vybestack LLC. See NOTICE for attribution details.
 */

import { InternalStdinContext } from 'ink';
import type { InputEvent } from '../../ink/events/input-event.js';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  parseMouseEvent,
  type MouseEvent,
  type MouseEventName,
  type MouseHandler,
} from '../utils/mouse.js';

export type { MouseEvent, MouseEventName, MouseHandler };

interface MouseContextValue {
  subscribe: (handler: MouseHandler) => void;
  unsubscribe: (handler: MouseHandler) => void;
}

const MouseContext = createContext<MouseContextValue | undefined>(undefined);

export function useMouseContext() {
  const context = useContext(MouseContext);
  if (!context) {
    throw new Error('useMouseContext must be used within a MouseProvider');
  }
  return context;
}

export function useMouse(handler: MouseHandler, { isActive = true } = {}) {
  const { subscribe, unsubscribe } = useMouseContext();

  useEffect(() => {
    if (!isActive) {
      return;
    }

    subscribe(handler);
    return () => unsubscribe(handler);
  }, [isActive, handler, subscribe, unsubscribe]);
}

export function MouseProvider({
  children,
  mouseEventsEnabled,
}: {
  children: React.ReactNode;
  mouseEventsEnabled?: boolean;
}) {
  const { internal_eventEmitter } = useContext(InternalStdinContext);
  const subscribers = useRef<Set<MouseHandler>>(new Set()).current;

  const subscribe = useCallback(
    (handler: MouseHandler) => {
      subscribers.add(handler);
    },
    [subscribers],
  );

  const unsubscribe = useCallback(
    (handler: MouseHandler) => {
      subscribers.delete(handler);
    },
    [subscribers],
  );

  useEffect(() => {
    if (!mouseEventsEnabled) {
      return;
    }

    // Ink emits wheel reports as input events after joining split sequences.
    // A separate stdin reader would compete with Ink's readable handler.
    const handleInput = (input: InputEvent) => {
      const event = parseMouseEvent(input.keypress.sequence ?? '')?.event;
      if (!event) return;
      for (const handler of subscribers) {
        if (handler(event) || event.handled) break;
      }
    };
    internal_eventEmitter.on('input', handleInput);
    return () => {
      internal_eventEmitter.removeListener('input', handleInput);
    };
  }, [internal_eventEmitter, mouseEventsEnabled, subscribers]);

  const contextValue = useMemo(
    () => ({ subscribe, unsubscribe }),
    [subscribe, unsubscribe],
  );

  return (
    <MouseContext.Provider value={contextValue}>
      {children}
    </MouseContext.Provider>
  );
}
