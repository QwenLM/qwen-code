/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Experimental OpenTUI renderer entry, loaded only when
 * `QWEN_TUI_RENDERER=opentui` (see `dispatch.ts`) — the default ink path
 * never imports this module. Migration skeleton: mounts a minimal App
 * whose history is driven by the framework-neutral streaming model
 * (`../model/streamingModel`), proving the model can be consumed by a
 * non-ink renderer binding. The real agent-loop event source replaces the
 * scripted demo events in a later phase.
 */

import { useEffect, useReducer } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import {
  initialStreamingState,
  reduceStreamEvent,
  selectIsDone,
  selectItems,
  type HistoryItem,
  type StreamEvent,
} from '../model/streamingModel.js';

// Stands in for the agent-loop stream until a later phase wires the real
// event source into the neutral model.
const SCRIPTED_EVENTS: readonly StreamEvent[] = [
  { type: 'thinking', delta: 'Planning the answer…' },
  { type: 'thinking-end' },
  { type: 'text', delta: 'Hello from the experimental OpenTUI renderer.' },
  { type: 'tool-start', id: 'tool-1', tool: 'shell', title: 'ls' },
  { type: 'tool-output', id: 'tool-1', delta: 'packages\nsrc\n' },
  { type: 'tool-end', id: 'tool-1', success: true, summary: '2 entries' },
  { type: 'done' },
];

function itemLabel(item: HistoryItem): string {
  switch (item.kind) {
    case 'thinking':
      return `${item.done ? '∴' : '∵'} thinking: ${item.text}`;
    case 'assistant':
      return item.text;
    case 'tool': {
      const status = !item.done
        ? 'running'
        : item.success
          ? 'ok'
          : 'failed';
      return `tool ${item.tool} · ${item.title} · ${status}`;
    }
    case 'task':
      return `task ${item.name}${item.stats ? ` · ${item.stats}` : ''}`;
  }
}

function App() {
  const [state, dispatch] = useReducer(
    reduceStreamEvent,
    initialStreamingState,
  );

  useEffect(() => {
    for (const event of SCRIPTED_EVENTS) {
      dispatch(event);
    }
  }, []);

  return (
    <box flexDirection="column">
      <span>qwen-code · experimental OpenTUI skeleton</span>
      {selectItems(state).map((item) => (
        <span key={item.id}>{itemLabel(item)}</span>
      ))}
      <span>{selectIsDone(state) ? 'done' : 'streaming…'}</span>
    </box>
  );
}

export async function startOpenTuiUI(): Promise<void> {
  const renderer = await createCliRenderer({
    targetFps: 60,
    useMouse: true,
    exitOnCtrlC: false,
  });
  createRoot(renderer).render(<App />);
}
