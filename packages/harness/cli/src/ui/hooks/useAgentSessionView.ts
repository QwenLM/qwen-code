/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useCallback } from 'react';

export type AgentRailMode = 'compact' | 'expanded';

export interface AgentSessionViewState {
  railMode: AgentRailMode;
  selectedIndex: number;
  focused: boolean;
}

type AgentSessionViewAction =
  | { type: 'MOVE_SELECTION'; delta: number; itemCount: number }
  | { type: 'FOCUS_AT'; index: number; itemCount: number }
  | { type: 'EXPAND' }
  | { type: 'FOCUS' }
  | { type: 'BLUR' }
  | { type: 'CLAMP'; itemCount: number };

const initialState: AgentSessionViewState = {
  railMode: 'compact',
  selectedIndex: 0,
  focused: false,
};

function agentSessionViewReducer(
  state: AgentSessionViewState,
  action: AgentSessionViewAction,
): AgentSessionViewState {
  switch (action.type) {
    case 'MOVE_SELECTION': {
      const next = Math.max(
        0,
        Math.min(action.itemCount - 1, state.selectedIndex + action.delta),
      );
      if (next === state.selectedIndex) return state;
      return { ...state, selectedIndex: next, railMode: 'expanded' };
    }
    case 'FOCUS_AT': {
      const selectedIndex = Math.max(
        0,
        Math.min(action.itemCount - 1, action.index),
      );
      if (
        state.focused &&
        state.railMode === 'expanded' &&
        state.selectedIndex === selectedIndex
      ) {
        return state;
      }
      return {
        ...state,
        selectedIndex,
        focused: true,
        railMode: 'expanded',
      };
    }
    case 'EXPAND':
      return state.railMode === 'expanded'
        ? state
        : { ...state, railMode: 'expanded' };
    case 'FOCUS':
      return state.focused
        ? state
        : { ...state, focused: true, railMode: 'expanded' };
    case 'BLUR':
      return state.focused
        ? { ...state, focused: false, railMode: 'compact' }
        : state.railMode === 'compact'
          ? state
          : { ...state, railMode: 'compact' };
    case 'CLAMP': {
      if (action.itemCount === 0) return state;
      const clamped = Math.min(state.selectedIndex, action.itemCount - 1);
      return clamped === state.selectedIndex
        ? state
        : { ...state, selectedIndex: clamped };
    }
    default:
      return state;
  }
}

export function useAgentSessionView() {
  const [state, dispatch] = useReducer(agentSessionViewReducer, initialState);

  const moveSelection = useCallback(
    (delta: number, itemCount: number) =>
      dispatch({ type: 'MOVE_SELECTION', delta, itemCount }),
    [],
  );

  const focusAt = useCallback(
    (index: number, itemCount: number) =>
      dispatch({ type: 'FOCUS_AT', index, itemCount }),
    [],
  );

  const expand = useCallback(() => dispatch({ type: 'EXPAND' }), []);
  const focus = useCallback(() => dispatch({ type: 'FOCUS' }), []);
  const blur = useCallback(() => dispatch({ type: 'BLUR' }), []);

  const clamp = useCallback(
    (itemCount: number) => dispatch({ type: 'CLAMP', itemCount }),
    [],
  );

  return {
    state,
    moveSelection,
    focusAt,
    expand,
    focus,
    blur,
    clamp,
  };
}
