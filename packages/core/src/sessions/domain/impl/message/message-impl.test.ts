/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildMessage } from '../../../factory/message-factory.js';

describe('MessageImpl', () => {
  it('exposes structural fields', () => {
    const message = buildMessage({
      uuid: 'm1',
      sessionId: 's1',
      turnId: 't1',
      parent: 'p1',
      logicalParent: 'lp1',
      sidechainOf: 'agent-a',
      timestamp: '2026-01-01T00:00:00.000Z',
      role: 'assistant',
      promptId: 'prompt-1',
      requestSetId: 'rs1',
      agentId: 'agent-a',
      payload: { content: 'hello' },
    });

    expect(message.getUuid()).toBe('m1');
    expect(message.getSessionId()).toBe('s1');
    expect(message.getTurnId()).toBe('t1');
    expect(message.getParent()).toBe('p1');
    expect(message.getLogicalParent()).toBe('lp1');
    expect(message.getSidechainOf()).toBe('agent-a');
    expect(message.getTimestamp()).toBe('2026-01-01T00:00:00.000Z');
    expect(message.getRole()).toBe('assistant');
    expect(message.getPromptId()).toBe('prompt-1');
    expect(message.getRequestSetId()).toBe('rs1');
    expect(message.getAgentId()).toBe('agent-a');
    expect(message.getPayload()).toEqual({ content: 'hello' });
  });

  it('extracts plain text from string payload', () => {
    const message = buildMessage({
      role: 'user',
      payload: { content: 'run tests' },
    });

    expect(message.getSearchText()).toBe('run tests');
    expect(message.getRealUserPromptText()).toBe('run tests');
    expect(message.getDisplayableUserText()).toBe('run tests');
  });

  it('extracts text from content blocks', () => {
    const message = buildMessage({
      role: 'assistant',
      payload: {
        content: [{ text: 'hello' }, { text: ' world' }],
      },
    });

    expect(message.getSearchText()).toBe('hello world');
  });

  it('returns undefined for displayable user text on assistant messages', () => {
    const message = buildMessage({ role: 'assistant' });
    expect(message.getDisplayableUserText()).toBeUndefined();
    expect(message.getRealUserPromptText()).toBeNull();
  });

  it('defaults role to user', () => {
    const message = buildMessage({});
    expect(message.getRole()).toBe('user');
  });

  it('exposes isMeta from stamp', () => {
    expect(buildMessage({ isMeta: true }).isMeta()).toBe(true);
    expect(buildMessage({ isMeta: false }).isMeta()).toBe(false);
    expect(buildMessage({}).isMeta()).toBe(false);
  });

  it('exposes isSidechain from stamp', () => {
    expect(buildMessage({ isSidechain: true }).isSidechain()).toBe(true);
    expect(buildMessage({ isSidechain: false }).isSidechain()).toBe(false);
    expect(buildMessage({}).isSidechain()).toBe(false);
  });

  it('isLocallySourced returns true for non-user messages', () => {
    expect(buildMessage({ role: 'assistant' }).isLocallySourced()).toBe(true);
    expect(buildMessage({ role: 'system' }).isLocallySourced()).toBe(true);
  });

  it('isLocallySourced returns true for user messages with human/auto-continuation origin', () => {
    expect(buildMessage({ role: 'user' }).isLocallySourced()).toBe(true);
    expect(
      buildMessage({ role: 'user', origin: { kind: 'human' } }).isLocallySourced(),
    ).toBe(true);
    expect(
      buildMessage({ role: 'user', origin: { kind: 'auto-continuation' } }).isLocallySourced(),
    ).toBe(true);
  });

  it('isLocallySourced returns false for externally-sourced user messages', () => {
    expect(
      buildMessage({ role: 'user', origin: { kind: 'api' } }).isLocallySourced(),
    ).toBe(false);
    expect(
      buildMessage({ role: 'user', origin: { kind: 'webhook' } }).isLocallySourced(),
    ).toBe(false);
  });
});
