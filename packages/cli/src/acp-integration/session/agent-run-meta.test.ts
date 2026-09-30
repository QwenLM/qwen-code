/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DAEMON_AGENT_RUN_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';

import { parsePromptAgentRun } from './agent-run-meta.js';

const VALID = {
  workspaceId: 'ws_1',
  agentId: 'ag_alice',
  runId: 'run_1',
  threadId: 'th_1',
  rootThreadId: 'th_root',
  attempt: 2,
  contextThroughSequence: 7,
};

const withMeta = (value: unknown) => ({
  _meta: { [DAEMON_AGENT_RUN_META_KEY]: value },
});

describe('parsePromptAgentRun', () => {
  it('reads a complete frame', () => {
    expect(parsePromptAgentRun(withMeta(VALID))).toEqual(VALID);
  });

  it('treats a prompt with no metadata as not an agent turn', () => {
    // A person typing into an agent's session is not taking that agent's
    // turn, and must establish no frame at all.
    expect(parsePromptAgentRun({})).toBeUndefined();
    expect(parsePromptAgentRun({ _meta: {} })).toBeUndefined();
  });

  it('keeps an absent contextThroughSequence absent', () => {
    const { contextThroughSequence: _omitted, ...rest } = VALID;
    expect(parsePromptAgentRun(withMeta(rest))).toStrictEqual(rest);
  });

  it.each([
    'workspaceId',
    'agentId',
    'runId',
    'threadId',
    'rootThreadId',
  ] as const)('refuses a frame missing %s', (field) => {
    // Refusing is the safe answer: a half-formed frame would name a thread
    // that may not be the one the envelope describes, and the thread tools
    // would act on it.
    const { [field]: _dropped, ...rest } = VALID;
    expect(parsePromptAgentRun(withMeta(rest))).toBeUndefined();
  });

  it.each([
    ['an empty string id', { ...VALID, threadId: '' }],
    ['a non-string id', { ...VALID, agentId: 42 }],
    ['a missing attempt', { ...VALID, attempt: undefined }],
    ['a fractional attempt', { ...VALID, attempt: 1.5 }],
    ['a zero attempt', { ...VALID, attempt: 0 }],
    ['a negative attempt', { ...VALID, attempt: -1 }],
  ])('refuses %s', (_name, value) => {
    expect(parsePromptAgentRun(withMeta(value))).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['an array', [VALID]],
    ['a string', 'run_1'],
    ['a number', 1],
  ])('refuses %s in place of the frame', (_name, value) => {
    expect(parsePromptAgentRun(withMeta(value))).toBeUndefined();
  });

  it('drops a fractional contextThroughSequence but keeps the frame', () => {
    // The sequence only bounds what the turn was shown. A bad one is worth
    // discarding; it is not worth refusing the whole turn over.
    const parsed = parsePromptAgentRun(
      withMeta({ ...VALID, contextThroughSequence: 1.5 }),
    );
    const { contextThroughSequence: _omitted, ...rest } = VALID;
    expect(parsed).toStrictEqual(rest);
  });
});
