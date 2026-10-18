/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useKeyboard } from '@opentui/react';
import type { AnsiToken } from '@qwen-code/qwen-code-core';
import {
  AnsiRows,
  MAX_RESULT_DISPLAY_CHARACTERS,
  selectionProps,
} from './messages.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import { C } from './theme.js';

type Pager = { previous: () => void; next: () => void };
const Navigation = createContext<{
  register: (id: string, pager: Pager) => () => void;
  active: string | null;
  activate: (id: string) => void;
} | null>(null);

export function ToolOutputNavigation({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const pagers = useRef(new Map<string, Pager>());
  const [active, activate] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const register = useMemo(
    () => (id: string, pager: Pager) => {
      pagers.current.set(id, pager);
      setCount(pagers.current.size);
      return () => {
        pagers.current.delete(id);
        setCount(pagers.current.size);
      };
    },
    [],
  );
  useKeyboard((key) => {
    if (
      !enabled ||
      !key.ctrl ||
      !(key.meta || key.option) ||
      key.eventType === 'release' ||
      !['left', 'right', 'up', 'down'].includes(key.name)
    )
      return;
    const ids = [...pagers.current.keys()];
    if (!ids.length) return;
    const index =
      active && ids.includes(active) ? ids.indexOf(active) : ids.length - 1;
    key.preventDefault();
    if (key.name === 'left' || key.name === 'right') {
      activate(
        ids[(index + (key.name === 'left' ? -1 : 1) + ids.length) % ids.length],
      );
    } else {
      activate(ids[index]);
      const pager = pagers.current.get(ids[index]);
      if (key.name === 'up') pager?.previous();
      else pager?.next();
    }
  });
  return (
    <Navigation.Provider value={{ register, active, activate }}>
      {enabled && count > 0 && (
        <text fg={C.dim}>Ctrl+Alt+←/→ · Ctrl+Alt+↑/↓</text>
      )}
      {children}
    </Navigation.Provider>
  );
}

export function toolOutputPage(
  text: string,
  start: number,
  maxRows: number,
  width: number,
): { text: string; end: number } {
  const limit = Math.min(
    text.length,
    start +
      Math.min(
        MAX_RESULT_DISPLAY_CHARACTERS,
        Math.max(1, width) * Math.max(1, maxRows),
      ),
  );
  let end = start;
  for (let row = 0; row < Math.max(1, maxRows) && end < limit; row++) {
    const newline = text.indexOf('\n', end);
    end = newline < 0 || newline >= limit ? limit : newline + 1;
  }
  // Keep a surrogate pair together when the character budget splits a line.
  if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1]))
    end += end === start + 1 ? 1 : -1;
  return { text: text.slice(start, end), end };
}

export function PagedToolOutput({
  text = '',
  grid,
  maxRows,
  width,
  diff = false,
}: {
  text?: string;
  grid?: AnsiToken[][];
  maxRows: number;
  width: number;
  diff?: boolean;
}) {
  const [starts, setStarts] = useState([0]);
  const navigation = useContext(Navigation);
  const id = useId();
  const start = Math.min(
    starts[starts.length - 1],
    grid?.length ?? text.length,
  );
  const page = grid ? undefined : toolOutputPage(text, start, maxRows, width);
  const end = grid ? Math.min(start + maxRows, grid.length) : page!.end;
  const hasNext = end < (grid?.length ?? text.length);
  const previous = () => {
    if (starts.length > 1) setStarts((value) => value.slice(0, -1));
  };
  const next = () => {
    if (hasNext) setStarts((value) => [...value, end]);
  };
  const actions = useRef({ previous, next });
  actions.current = { previous, next };
  const register = navigation?.register;
  const paged = starts.length > 1 || hasNext;
  useEffect(() => {
    if (!paged) return;
    return register?.(id, {
      previous: () => actions.current.previous(),
      next: () => actions.current.next(),
    });
  }, [id, register, paged]);
  const rows = page
    ? sanitizeTerminalText(page.text).replace(/\n$/, '').split('\n')
    : [];
  return (
    <box flexDirection="column">
      {paged && (
        <box flexDirection="row">
          <text
            fg={starts.length > 1 ? C.text : C.dim}
            onMouseUp={() => {
              navigation?.activate(id);
              previous();
            }}
          >
            ←
          </text>
          <text
            fg={C.dim}
          >{` ${navigation?.active === id ? '>' : ''}${starts.length} `}</text>
          <text
            fg={hasNext ? C.text : C.dim}
            onMouseUp={() => {
              navigation?.activate(id);
              next();
            }}
          >
            →
          </text>
        </box>
      )}
      {grid ? (
        <AnsiRows grid={grid.slice(start, end)} maxWidth={width} fullDetail />
      ) : (
        rows.map((line, index) => (
          <text
            key={index}
            fg={
              diff && line.startsWith('+')
                ? C.green
                : diff && line.startsWith('-')
                  ? C.red
                  : C.text
            }
            {...selectionProps()}
          >
            {line}
          </text>
        ))
      )}
    </box>
  );
}
