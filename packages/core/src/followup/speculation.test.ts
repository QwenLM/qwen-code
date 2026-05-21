/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEventListeners } from 'node:events';
import { ensureToolResultPairing, startSpeculation } from './speculation.js';
import type { Content, GenerateContentConfig } from '@google/genai';
import {
  saveCacheSafeParams,
  clearCacheSafeParams,
} from '../utils/forkedAgent.js';

// Stub the forked-agent + overlay infrastructure so startSpeculation's
// fire-and-forget background loop is a no-op. The tests below only assert
// the synchronous abort-controller wiring set up by startSpeculation; the
// loop's actual execution is covered elsewhere.
vi.mock('../utils/forkedAgent.js', async () => {
  const actual = await vi.importActual<
    typeof import('../utils/forkedAgent.js')
  >('../utils/forkedAgent.js');
  return {
    ...actual,
    runWithForkedChatModel: vi.fn(async () => ({ messages: [] })),
  };
});

vi.mock('./overlayFs.js', () => ({
  OverlayFs: vi.fn().mockImplementation(() => ({
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('ensureToolResultPairing', () => {
  it('returns empty array unchanged', () => {
    expect(ensureToolResultPairing([])).toEqual([]);
  });

  it('preserves complete messages (no function calls)', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('preserves paired functionCall + functionResponse', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'edit file' }] },
      {
        role: 'model',
        parts: [
          { text: 'editing...' },
          { functionCall: { name: 'edit', args: { file: 'a.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'edit',
              response: { output: 'done' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'file edited' }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('strips unpaired functionCalls from last model message (keeps text)', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'model',
        parts: [
          { text: 'I will edit the file' },
          { functionCall: { name: 'edit', args: {} } },
        ],
      },
      // No functionResponse follows — boundary truncation
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toHaveLength(2);
    expect(result[1].parts).toEqual([{ text: 'I will edit the file' }]);
  });

  it('removes last model message entirely if only functionCalls', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'edit', args: {} } },
          { functionCall: { name: 'shell', args: {} } },
        ],
      },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('does not modify messages when last message is user role', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'response' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool',
              response: { output: 'result' },
            },
          },
        ],
      },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('handles model message with no parts', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });
});

describe('startSpeculation — abort-controller wiring', () => {
  // Minimal Config stub — startSpeculation only calls config.getCwd() in the
  // synchronous path (OverlayFs ctor), and that's already mocked above.
  const fakeConfig = {
    getCwd: () => '/tmp/test-speculation-cwd',
    getApprovalMode: () => 'default',
    getFastModel: () => undefined,
  } as unknown as import('../config/config.js').Config;

  beforeEach(() => {
    // startSpeculation throws if cache-safe params aren't set; install a stub.
    // saveCacheSafeParams takes 3 positional args: (generationConfig, history, model).
    saveCacheSafeParams(
      { systemInstruction: '' } as unknown as GenerateContentConfig,
      [],
      'fake-model',
    );
  });

  afterEach(() => {
    clearCacheSafeParams();
  });

  it('parent abort propagates to the speculation controller (lifetime contract)', async () => {
    const parent = new AbortController();
    const state = await startSpeculation(
      fakeConfig,
      'do a thing',
      parent.signal,
    );
    // The mocked runWithForkedChatModel resolves immediately, but the fire-
    // and-forget .then().finally() chain runs async. The abortController in
    // the returned state is wired before the background loop starts.
    expect(state.abortController).toBeTruthy();
    expect(state.abortController!.signal.aborted).toBe(false);
    parent.abort('parent reason');
    expect(state.abortController!.signal.aborted).toBe(true);
    expect(state.abortController!.signal.reason).toBe('parent reason');
  });

  it('fast-path: parent already aborted returns aborted state without entering the loop', async () => {
    const parent = new AbortController();
    parent.abort('pre');
    const state = await startSpeculation(
      fakeConfig,
      'do a thing',
      parent.signal,
    );
    expect(state.status).toBe('aborted');
    expect(state.abortController!.signal.aborted).toBe(true);
    expect(state.abortController!.signal.reason).toBe('pre');
  });

  it('child controller never strong-pins the parent listener after settling', async () => {
    const parent = new AbortController();
    const before = getEventListeners(parent.signal, 'abort').length;
    const state = await startSpeculation(
      fakeConfig,
      'do a thing',
      parent.signal,
    );
    // While the loop is running, child has a listener on parent.
    expect(getEventListeners(parent.signal, 'abort').length).toBe(before + 1);
    // Let the background promise settle (mocked loop resolves immediately, then
    // the .finally() calls abortController.abort() which triggers reverse cleanup).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(state.abortController!.signal.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort').length).toBe(before);
  });
});
