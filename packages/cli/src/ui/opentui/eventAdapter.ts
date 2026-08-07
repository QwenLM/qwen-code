/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * P1d integration seam: maps qwen-code's real agent-loop stream events
 * (`ServerGeminiStreamEvent`, packages/core) onto the framework-neutral
 * `StreamEvent` consumed by the OpenTUI backend / `ui/model/streamingModel`.
 *
 * Pure + framework-agnostic (type-only imports); unit-testable without a
 * renderer. The OpenTUI backend drains these into the neutral model; the ink
 * path keeps using `useGeminiStream` unchanged.
 */

import type { ServerGeminiStreamEvent } from '../../../core/src/core/turn.js';
import type { StreamEvent } from '../model/streamingModel.js';

/**
 * Stateful mapper: one server event may yield 0..n neutral events. Tracks the
 * thinking→content transition so the model collapses the thought block before
 * the answer starts streaming.
 */
export function createEventMapper(): (
  ev: ServerGeminiStreamEvent,
) => StreamEvent[] {
  let sawThought = false;
  let thoughtClosed = false;
  let toolSeq = 0;

  return (ev: ServerGeminiStreamEvent): StreamEvent[] => {
    const out: StreamEvent[] = [];
    const closeThought = () => {
      if (sawThought && !thoughtClosed) {
        out.push({ type: 'thinking-end' });
        thoughtClosed = true;
      }
    };

    switch (ev.type) {
      case 'thought': {
        const v = ev.value as { subject?: string; description?: string };
        const delta = v.description ?? '';
        if (delta) {
          sawThought = true;
          thoughtClosed = false;
          out.push({ type: 'thinking', delta });
        }
        break;
      }
      case 'content': {
        closeThought();
        const parts = (ev as { parts?: Array<{ text?: string }> }).parts;
        if (parts) {
          for (const p of parts) {
            if (p.text && p.text.length > 0) {
              out.push({ type: 'text', delta: p.text });
            }
          }
        } else {
          const value = ev.value as string;
          if (value) out.push({ type: 'text', delta: value });
        }
        break;
      }
      case 'tool_call_request': {
        closeThought();
        const v = ev.value as { callId: string; name: string };
        out.push({
          type: 'tool-start',
          id: v.callId ?? `tool-${++toolSeq}`,
          tool: v.name,
          title: v.name,
        });
        break;
      }
      case 'tool_call_response': {
        const v = ev.value as { callId: string; error?: unknown };
        out.push({
          type: 'tool-end',
          id: v.callId,
          success: v.error === undefined,
          summary: v.error === undefined ? 'ok' : 'error',
        });
        break;
      }
      case 'error': {
        const v = ev.value as { error?: { message?: string } };
        out.push({ type: 'text', delta: `\n[error] ${v.error?.message ?? ''}` });
        break;
      }
      case 'finished':
        closeThought();
        out.push({ type: 'done' });
        break;
      default:
        break;
    }
    return out;
  };
}

/** Drains a real agent stream into a neutral-event sink. */
export async function pumpServerStream(
  stream: AsyncIterable<ServerGeminiStreamEvent>,
  sink: (ev: StreamEvent) => void,
): Promise<void> {
  const map = createEventMapper();
  for await (const ev of stream) {
    for (const neutral of map(ev)) sink(neutral);
  }
}
