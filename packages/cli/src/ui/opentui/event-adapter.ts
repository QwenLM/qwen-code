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
 *
 * Lossless tool mapping: tool args, result content (resultDisplay) and
 * confirmation requests are carried through as the `tool-args` / `tool-result`
 * / `confirm` events (the neutral model's union is extended locally because
 * this slice may only touch opentui/**).
 */

import type { ServerGeminiStreamEvent } from '@qwen-code/qwen-code-core';
import type { StreamEvent } from '../model/streamingModel.js';

/**
 * Neutral-model union extension: tool detail events the backend folds into
 * tool cards (args preview, result content, approval state).
 */
export type OpenTuiStreamEvent =
  | StreamEvent
  | { type: 'tool-args'; id: string; args: string }
  | { type: 'tool-result'; id: string; display: string }
  | { type: 'confirm'; id: string; tool: string; title: string };

/** One-line compact JSON for tool-call args (empty object → undefined). */
export function formatToolArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  return JSON.stringify(args);
}

/** Stringifies a ToolResultDisplay (string | FileDiff | structured) losslessly. */
export function renderResultDisplay(display: unknown): string {
  if (display == null) return '';
  if (typeof display === 'string') return display;
  if (typeof display === 'object') {
    const o = display as Record<string, unknown>;
    if (typeof o['fileDiff'] === 'string') {
      const name =
        typeof o['fileName'] === 'string' && o['fileName']
          ? `${o['fileName']}\n`
          : '';
      return name + o['fileDiff'];
    }
    if (typeof o['summary'] === 'string') return o['summary'];
    if (typeof o['message'] === 'string') return o['message'];
  }
  return JSON.stringify(display, null, 2);
}

/**
 * Stateful mapper: one server event may yield 0..n neutral events. Tracks the
 * thinking→content transition so the model collapses the thought block before
 * the answer starts streaming.
 */
export function createEventMapper(): (
  ev: ServerGeminiStreamEvent,
) => OpenTuiStreamEvent[] {
  let sawThought = false;
  let thoughtClosed = false;
  let toolSeq = 0;

  return (ev: ServerGeminiStreamEvent): OpenTuiStreamEvent[] => {
    const out: OpenTuiStreamEvent[] = [];
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
        const v = ev.value as {
          callId: string;
          name: string;
          args?: Record<string, unknown>;
        };
        const id = v.callId ?? `tool-${++toolSeq}`;
        out.push({ type: 'tool-start', id, tool: v.name, title: v.name });
        const args = formatToolArgs(v.args);
        if (args) out.push({ type: 'tool-args', id, args });
        break;
      }
      case 'tool_call_confirmation': {
        closeThought();
        const v = ev.value as {
          request: {
            callId: string;
            name: string;
            args?: Record<string, unknown>;
          };
          details: { title?: string };
        };
        const id = v.request.callId ?? `tool-${++toolSeq}`;
        out.push({
          type: 'confirm',
          id,
          tool: v.request.name,
          title: v.details.title ?? v.request.name,
        });
        const args = formatToolArgs(v.request.args);
        if (args) out.push({ type: 'tool-args', id, args });
        break;
      }
      case 'tool_call_response': {
        const v = ev.value as {
          callId: string;
          error?: unknown;
          resultDisplay?: unknown;
          executionStatus?: string;
        };
        const display = renderResultDisplay(v.resultDisplay);
        if (display) out.push({ type: 'tool-result', id: v.callId, display });
        const cancelled = v.executionStatus === 'cancelled';
        const failed = v.error !== undefined || v.executionStatus === 'error';
        out.push({
          type: 'tool-end',
          id: v.callId,
          success: !failed && !cancelled,
          summary: failed ? 'error' : cancelled ? 'cancelled' : 'ok',
        });
        break;
      }
      case 'error': {
        const v = ev.value as { error?: { message?: string } };
        out.push({
          type: 'text',
          delta: `\n[error] ${v.error?.message ?? ''}`,
        });
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
  sink: (ev: OpenTuiStreamEvent) => void,
): Promise<void> {
  const map = createEventMapper();
  for await (const ev of stream) {
    for (const neutral of map(ev)) sink(neutral);
  }
}
