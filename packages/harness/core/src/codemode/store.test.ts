/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { CodeModeStore, storeWritesOf, storeWritesOnChain } from './store.js';
import { loadStore } from './session.js';
import { STORE_LIMITS, type StoreWrite } from './types.js';
import type { ActiveConversation } from '../config/config.js';
import type { TranscriptMessage } from '../protocol/transcript/entry.js';
import type {
  AssistantMessage,
  Message,
  SystemMessage,
} from '../protocol/transcript/message.js';
import {
  createToolResultMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { TranscriptRepository } from '../services/transcript/repository.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const resultMessage = (toolUseResult: unknown, results = 1) =>
  ({
    type: 'user',
    message: {
      role: 'user',
      content: Array.from({ length: results }, () => ({ type: 'tool_result' })),
    },
    toolUseResult,
  }) as unknown as TranscriptMessage;
const codeModeResult = (storeWrites: StoreWrite[]) => ({
  type: 'code_mode',
  storeWrites,
});

function persistence(deltas: StoreWrite[][]) {
  let revision = 0;
  const readChain = vi.fn(async () =>
    deltas.map((writes) => resultMessage(codeModeResult([...writes]))),
  );
  const source = {
    revision: () => revision,
    readChain,
  } satisfies ActiveConversation;
  return { source, bump: () => revision++ };
}

function assistantCalling(toolUseId: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      },
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'CodeMode',
          input: { code: 'store("k", 1);' },
        },
      ],
      container: null,
      context_management: null,
    },
  } as AssistantMessage;
}

describe('CodeMode store', () => {
  it('replays writes made before a Compact boundary from the historical chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codemode-store-'));
    try {
      const file = join(dir, 'session.jsonl');
      const prompt = createUserMessage('remember k');
      const call = assistantCalling('toolu_store');
      const result = createToolResultMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_store',
            content: '[completed]',
            is_error: false,
            toolUseResult: codeModeResult([{ key: 'k', value: 1 }]),
          },
        ],
        call.uuid,
      );
      const boundary: SystemMessage = {
        type: 'system',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isCompactSummary: true,
      };
      const summary = createUserMessage('summary');
      summary.isCompactSummary = true;
      const entry = (
        message: Message,
        parentUuid: string | null,
        extra: Partial<TranscriptMessage> = {},
      ) =>
        JSON.stringify({
          ...message,
          parentUuid,
          isSidechain: false,
          cwd: dir,
          sessionId: 'session-1',
          userType: 'external',
          version: '1.0.0',
          ...extra,
        });
      await writeFile(
        file,
        [
          entry(prompt, null),
          entry(call, prompt.uuid),
          entry(result, call.uuid),
          entry(boundary, null, { logicalParentUuid: result.uuid }),
          entry(summary, boundary.uuid),
        ].join('\n') + '\n',
      );
      const repository = new TranscriptRepository();
      const runtime = await repository.resolveSession(file);
      const historical = await repository.resolveSession(file, {
        view: 'historical',
      });
      // The model-facing view loses the old result; the store reads the historical one.
      expect(storeWritesOnChain(runtime?.chain ?? [])).toEqual([]);
      expect(storeWritesOnChain(historical?.chain ?? [])).toEqual([
        [{ key: 'k', value: 1 }],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('commits JSON copies and merges changed keys without overwriting unrelated state', () => {
    const store = new CodeModeStore();
    const value = { files: ['a'] };
    store.commit([{ key: 'first', value }]);
    value.files.push('b');
    const snapshot = store.snapshot();
    store.commit([{ key: 'other', value: 2 }]);
    store.commit([{ key: 'first', value: null }]);
    expect(snapshot).toEqual({ first: { files: ['a'] } });
    expect(store.snapshot()).toEqual({ first: null, other: 2 });
    store.commit([{ key: 'first' }]);
    expect(store.snapshot()).toEqual({ other: 2 });
    store.commit([{ key: '__proto__', value: 'safe' }]);
    expect(Object.hasOwn(store.snapshot(), '__proto__')).toBe(true);
  });

  it('validates an entire transaction before changing state', () => {
    const store = new CodeModeStore();
    store.commit([{ key: 'k', value: 1 }]);
    expect(() =>
      store.commit([
        { key: 'k', value: 2 },
        { key: '', value: 0 },
      ]),
    ).toThrow(/key/);
    expect(() =>
      store.commit([{ key: 'x'.repeat(STORE_LIMITS.keyChars + 1), value: 0 }]),
    ).toThrow(/key/);
    expect(() =>
      store.commit([
        { key: 'large', value: '中'.repeat(STORE_LIMITS.totalBytes / 2) },
      ]),
    ).toThrow(/size/);
    expect(() =>
      store.commit(
        Array.from({ length: STORE_LIMITS.keys }, (_, i) => ({
          key: `k${i}`,
          value: i,
        })),
      ),
    ).toThrow(/keys/);
    expect(store.snapshot()).toEqual({ k: 1 });
  });

  it('isolates owners, sessions and agents including an old script finishing after reset', async () => {
    const owner = {};
    const old = await loadStore(owner, 's1');
    expect(await loadStore(owner, 's1')).toBe(old);
    expect(await loadStore(owner, 's1', 'agent-1')).not.toBe(old);
    const current = await loadStore(owner, 's2');
    old.commit([{ key: 'old', value: true }]);
    expect(current.snapshot()).toEqual({});
    expect(await loadStore({}, 's2')).not.toBe(current);
  });

  it('restores the main agent from persisted deltas and reloads on a new revision', async () => {
    const owner = {};
    const { source, bump } = persistence([
      [{ key: 'a', value: 1 }, { key: 'b', value: 2 }],
      [{ key: 'a' }, { key: 'bad', value: 'x'.repeat(STORE_LIMITS.totalBytes) }],
      [{ key: 'b', value: 3 }],
    ]);
    const store = await loadStore(owner, 's', undefined, source);
    // An invalid delta is skipped as a whole; later deltas still apply.
    expect(store.snapshot()).toEqual({ a: 1, b: 3 });
    expect(await loadStore(owner, 's', undefined, source)).toBe(store);
    expect(source.readChain).toHaveBeenCalledTimes(1);

    bump();
    expect(await loadStore(owner, 's', undefined, source)).not.toBe(store);
    expect(source.readChain).toHaveBeenCalledTimes(2);
  });

  it('collects deltas from CodeMode results, including positional multi-result messages', () => {
    const later = [{ key: 'later', value: 2 }];
    expect(
      storeWritesOnChain([
        resultMessage(codeModeResult([{ key: 'k', value: 1 }])),
        resultMessage([{ type: 'text' }, codeModeResult(later)], 2),
        resultMessage({ type: 'text' }),
      ]),
    ).toEqual([[{ key: 'k', value: 1 }], later]);
  });

  it('reads committed writes only from CodeMode results', () => {
    const writes = [{ key: 'k', value: 1 }];
    expect(storeWritesOf({ type: 'code_mode', storeWrites: writes })).toBe(
      writes,
    );
    expect(storeWritesOf({ type: 'code_mode', status: 'error' })).toBeUndefined();
    expect(storeWritesOf({ type: 'other', storeWrites: writes })).toBeUndefined();
    expect(storeWritesOf('text')).toBeUndefined();
  });

  it('keeps subagent state process-local', async () => {
    const { source } = persistence([[{ key: 'main', value: 1 }]]);
    const store = await loadStore({}, 's', 'agent-1', source);
    expect(store.snapshot()).toEqual({});
    expect(source.readChain).not.toHaveBeenCalled();
  });

  it('rejects unreadable persisted state and retries on the next script', async () => {
    const owner = {};
    const { source } = persistence([[{ key: 'k', value: 1 }]]);
    source.readChain.mockRejectedValueOnce(new Error('unreadable'));
    await expect(loadStore(owner, 's', undefined, source)).rejects.toThrow(
      'Unable to restore the persisted CodeMode store',
    );
    expect((await loadStore(owner, 's', undefined, source)).snapshot()).toEqual(
      {
        k: 1,
      },
    );
  });

  it('retries cancelled restoration without accepting its late result', async () => {
    const owner = {};
    const { source } = persistence([[{ key: 'k', value: 5 }]]);
    let release!: (chain: TranscriptMessage[]) => void;
    const oldRead = new Promise<TranscriptMessage[]>((resolve) => {
      release = resolve;
    });
    source.readChain.mockReturnValueOnce(oldRead);
    const controller = new AbortController();
    const pending = loadStore(owner, 's', undefined, source, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    const current = await loadStore(owner, 's', undefined, source);
    expect(current.snapshot()).toEqual({ k: 5 });
    current.commit([{ key: 'k', value: 6 }]);
    release([resultMessage(codeModeResult([{ key: 'k', value: 99 }]))]);
    await oldRead;
    expect((await loadStore(owner, 's', undefined, source)).snapshot()).toEqual(
      { k: 6 },
    );
    expect(source.readChain).toHaveBeenCalledTimes(2);
  });
});
