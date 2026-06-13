/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createIdleSuggestionHandler,
  resolveIdleEnabled,
} from './idleSuggestions.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import type { ChatTransport } from './chatTransport.js';
import type { TurnText } from './suggester.js';
import type { AuditEntry } from '../auditLog.js';

const TURNS: TurnText[] = [
  { role: 'user', text: 'fix the login bug' },
  { role: 'assistant', text: 'done' },
];

/** Let the handler's fire-and-forget async body (readTurns → chat → publish) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function harness(
  over: Partial<Parameters<typeof createIdleSuggestionHandler>[0]> = {},
) {
  const events: OwnerEvent[] = [];
  const bus = new OwnerEventBus();
  bus.subscribe((e) => events.push(e));
  const audited: AuditEntry[] = [];
  const audit = { record: async (e: AuditEntry) => void audited.push(e) };
  const chat: ChatTransport = async () => '["Run the tests","Commit the fix"]';
  const handler = createIdleSuggestionHandler({
    chat,
    bus,
    audit,
    resolveDir: (cwd) => `/chats/${cwd}`,
    readTurns: async () => TURNS,
    ...over,
  });
  return { handler, events, audited };
}

describe('resolveIdleEnabled', () => {
  it('is OFF by default and for falsey/absent values', () => {
    expect(resolveIdleEnabled({})).toBe(false);
    expect(resolveIdleEnabled({ QWEN_RC_IDLE_SUGGESTIONS: '0' })).toBe(false);
    expect(resolveIdleEnabled({ QWEN_RC_IDLE_SUGGESTIONS: 'off' })).toBe(false);
  });
  it('is ON for 1/true/yes/on (case-insensitive)', () => {
    for (const v of ['1', 'true', 'YES', 'On']) {
      expect(resolveIdleEnabled({ QWEN_RC_IDLE_SUGGESTIONS: v })).toBe(true);
    }
  });
});

describe('createIdleSuggestionHandler', () => {
  it('publishes an idle_suggestions frame and a count-only audit row on the happy path', async () => {
    const { handler, events, audited } = harness();
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([
      {
        type: 'idle_suggestions',
        sessionId: 'sess-1',
        suggestions: ['Run the tests', 'Commit the fix'],
      },
    ]);
    // Audit carries only a count — never the suggestion text or transcript.
    expect(audited).toEqual([
      { action: 'idle_suggested', target: 'sess-1', detail: { count: 2 } },
    ]);
  });

  it('does nothing (no frame, no audit, no model call) when there are no turns', async () => {
    const chat = vi.fn(async () => '["x"]') as unknown as ChatTransport;
    const { handler, events, audited } = harness({
      chat,
      readTurns: async () => [],
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([]);
    expect(audited).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('emits no frame when the model reply parses to zero suggestions', async () => {
    const { handler, events, audited } = harness({
      chat: async () => 'sorry, I cannot help',
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([]);
    expect(audited).toEqual([]);
  });

  it('does nothing and never reads turns when workspaceCwd is empty', async () => {
    const readTurns = vi.fn(async () => TURNS);
    const { handler, events } = harness({ readTurns });
    handler('sess-1', '');
    await flush();
    expect(events).toEqual([]);
    expect(readTurns).not.toHaveBeenCalled();
  });

  it('degrades to silence (no throw, no frame) when the tail reader throws', async () => {
    const { handler, events } = harness({
      readTurns: async () => {
        throw new Error('disk error');
      },
    });
    expect(() => handler('sess-1', '/w')).not.toThrow();
    await flush();
    expect(events).toEqual([]);
  });

  it('degrades to silence when the model transport throws', async () => {
    const { handler, events } = harness({
      chat: async () => {
        throw new Error('model down');
      },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([]);
  });

  it('honors max (passed through to the suggester/parser)', async () => {
    const { handler, events } = harness({
      max: 1,
      chat: async () => '["a","b","c"]',
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([
      { type: 'idle_suggestions', sessionId: 'sess-1', suggestions: ['a'] },
    ]);
  });
});
