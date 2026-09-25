/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCallConfirmationDetails } from './tools.js';
import {
  managedToolDigest,
  parseManagedToolContentModification,
  parseManagedToolMediaContext,
  ManagedToolProtocolError,
  parseManagedToolCallIdentity,
  parseManagedToolConfirmationPayload,
  parseManagedToolInvocationReference,
  serializeManagedToolConfirmation,
} from './managed-tool-protocol.js';

const identity = {
  sessionId: '01a05708-a79d-4a02-8b79-02c4120eb054',
  promptId: 'prompt-1',
  callId: 'call-1',
  capabilityDigest: 'a'.repeat(64),
  policyRevision: 'policy-1',
};
const reference = {
  ...identity,
  invocationId: 'invocation-1',
  argsDigest: 'b'.repeat(64),
};

describe('managed media context', () => {
  it('copies only explicit resolved input capabilities', () => {
    const input = {
      inputModalities: { image: true, pdf: false, audio: true, video: false },
    };
    const parsed = parseManagedToolMediaContext(input);
    expect(parsed).toEqual(input);
    input.inputModalities.image = false;
    expect(parsed.inputModalities.image).toBe(true);
    expect(parseManagedToolMediaContext({ inputModalities: {} })).toEqual({
      inputModalities: {},
    });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { inputModalities: null },
    { inputModalities: [] },
    { inputModalities: { image: 'true' } },
    { inputModalities: { pdf: 1 } },
    { inputModalities: { image: undefined } },
    { inputModalities: { text: true } },
    { inputModalities: {}, model: 'worker-model' },
    { inputModalities: {}, prompt: 'worker-prompt' },
    { inputModalities: {}, apiKey: 'credential' },
  ])('rejects malformed or expanded context %#', (input) => {
    expect(() => parseManagedToolMediaContext(input)).toThrow(
      ManagedToolProtocolError,
    );
  });
});

describe('managed tool identities', () => {
  it('normalizes session UUIDs and preserves the complete invocation binding', () => {
    expect(
      parseManagedToolCallIdentity({
        ...identity,
        sessionId: identity.sessionId.toUpperCase(),
      }),
    ).toEqual(identity);
    expect(parseManagedToolInvocationReference(reference)).toEqual(reference);
    expect(
      parseManagedToolInvocationReference({
        ...reference,
        promptId: 'p'.repeat(128),
        callId: 'c'.repeat(512),
        policyRevision: 'r'.repeat(256),
        invocationId: 'i'.repeat(128),
      }),
    ).toMatchObject({ invocationId: 'i'.repeat(128) });
  });

  it.each([
    null,
    [],
    {},
    { ...identity, sessionId: 'session-1' },
    { ...identity, sessionId: `${identity.sessionId}-agent-1` },
    { ...identity, promptId: '' },
    { ...identity, promptId: 'p'.repeat(129) },
    { ...identity, callId: 'c'.repeat(513) },
    { ...identity, callId: 'call\0suffix' },
    { ...identity, capabilityDigest: 'A'.repeat(64) },
    { ...identity, capabilityDigest: 'a'.repeat(63) },
    { ...identity, policyRevision: 1 },
    { ...identity, policyRevision: 'r'.repeat(257) },
    { ...identity, extra: true },
    reference,
  ])('rejects invalid or extended standalone identity %#', (value) => {
    expect(() => parseManagedToolCallIdentity(value)).toThrow(
      ManagedToolProtocolError,
    );
  });

  it.each([
    identity,
    { ...reference, invocationId: '' },
    { ...reference, invocationId: 'i'.repeat(129) },
    { ...reference, argsDigest: 'not-a-digest' },
    { ...reference, params: {} },
  ])('rejects incomplete or extended references %#', (value) => {
    expect(() => parseManagedToolInvocationReference(value)).toThrow(
      ManagedToolProtocolError,
    );
  });
});

describe('managed tool JSON digests', () => {
  it('hashes canonical JSON with sorted nested and numeric object keys', () => {
    const expected = createHash('sha256')
      .update('{"10":"ten","2":"two","a":{"x":[true,null,1],"z":2}}')
      .digest('hex');
    expect(
      managedToolDigest({
        a: { z: 2, x: [true, null, 1] },
        2: 'two',
        10: 'ten',
      }),
    ).toBe(expected);
    expect(
      managedToolDigest({
        10: 'ten',
        a: { x: [true, null, 1], z: 2 },
        2: 'two',
      }),
    ).toBe(expected);
    expect(managedToolDigest([1, 2])).not.toBe(managedToolDigest([2, 1]));
    expect(managedToolDigest({ a: 1 })).not.toBe(managedToolDigest({ a: '1' }));
  });

  it('allows shared JSON subtrees and null-prototype records', () => {
    const shared = { value: 1 };
    expect(managedToolDigest([shared, shared])).toBe(
      managedToolDigest([{ value: 1 }, { value: 1 }]),
    );
    expect(managedToolDigest(Object.assign(Object.create(null), shared))).toBe(
      managedToolDigest(shared),
    );
    expect(managedToolDigest(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(
      managedToolDigest({}),
    );
  });

  it.each([
    undefined,
    () => {},
    Symbol('value'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    { missing: undefined },
    [undefined],
    new Array(1),
    new Date(0),
    new Map(),
    { [Symbol('hidden')]: 1 },
    Object.defineProperty({}, 'hidden', { value: 1 }),
    Object.assign([], { extra: 1 }),
  ])('rejects values that JSON would omit or coerce %#', (value) => {
    expect(() => managedToolDigest(value)).toThrow(ManagedToolProtocolError);
  });

  it('rejects accessors, toJSON methods and cycles without invoking them', () => {
    const getter = vi.fn(() => 'secret');
    const toJSON = vi.fn(() => ({}));
    expect(() =>
      managedToolDigest(
        Object.defineProperty({}, 'value', { get: getter, enumerable: true }),
      ),
    ).toThrow(ManagedToolProtocolError);
    expect(() => managedToolDigest({ toJSON })).toThrow(
      ManagedToolProtocolError,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => managedToolDigest(cycle)).toThrow(ManagedToolProtocolError);
  });

  it('bounds canonical UTF-8 bytes, escaping, nesting and explicit limits', () => {
    expect(managedToolDigest('é', 4)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => managedToolDigest('é', 3)).toThrow(ManagedToolProtocolError);
    expect(() => managedToolDigest('\n', 3)).toThrow(ManagedToolProtocolError);
    expect(() => managedToolDigest('x'.repeat(256 * 1024))).toThrow(
      ManagedToolProtocolError,
    );
    expect(managedToolDigest('x'.repeat(256 * 1024), 1024 * 1024)).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const limit of [0, -1, 1.5, Infinity]) {
      expect(() => managedToolDigest({}, limit)).toThrow(
        ManagedToolProtocolError,
      );
    }
    let nested: unknown = null;
    for (let depth = 0; depth < 64; depth++) nested = [nested];
    expect(managedToolDigest(nested)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => managedToolDigest([nested])).toThrow(ManagedToolProtocolError);
  });
});

describe('managed tool confirmation DTOs', () => {
  const onConfirm = vi.fn(async () => {});
  const details: ToolCallConfirmationDetails[] = [
    {
      type: 'edit',
      title: 'Edit',
      onConfirm,
      hideAlwaysAllow: false,
      fileName: 'file.ts',
      filePath: '/workspace/file.ts',
      fileDiff: '-old\n+new',
      originalContent: null,
      newContent: 'new',
      isModifying: true,
      hideModify: true,
      skipIdeDiff: true,
      warnings: ['warning'],
      autoModeFallback: {
        reason: 'classifier_unavailable',
        message: 'Unavailable',
      },
    },
    {
      type: 'exec',
      title: 'Run',
      onConfirm,
      command: 'echo ok',
      rootCommand: 'echo',
      permissionRules: ['Shell(echo *)'],
      warnings: [],
    },
    {
      type: 'mcp',
      title: 'MCP',
      onConfirm,
      serverName: 'server',
      toolName: 'tool',
      toolDisplayName: 'Tool',
      permissionRules: ['mcp__server__tool'],
    },
    {
      type: 'info',
      title: 'Info',
      onConfirm,
      prompt: 'Continue?',
      renderPromptAsPlainText: true,
      urls: ['https://example.com'],
      permissionRules: [],
    },
  ];

  it.each(details)(
    'preserves $type fields and excludes callbacks and extensions',
    (detail) => {
      const { onConfirm: _callback, ...expected } = detail;
      const extended = { ...detail, secret: 'do not serialize' };
      expect(serializeManagedToolConfirmation(extended)).toEqual(expected);
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it('clones nested metadata and strips unknown fields within AUTO metadata', () => {
    const detail = details[0];
    const wire = serializeManagedToolConfirmation({
      ...detail,
      autoModeFallback: Object.assign(
        { reason: 'classifier_unavailable' as const, message: 'Unavailable' },
        { secret: 'do not serialize' },
      ),
    });
    expect(wire.autoModeFallback).toEqual({
      reason: 'classifier_unavailable',
      message: 'Unavailable',
    });
    expect(wire.autoModeFallback).not.toBe(detail.autoModeFallback);
    if (wire.type === 'edit' && detail.type === 'edit') {
      expect(wire.warnings).not.toBe(detail.warnings);
    }
  });

  it.each<ToolCallConfirmationDetails>([
    { type: 'plan', title: 'Plan', plan: 'plan', onConfirm },
    { type: 'ask_user_question', title: 'Question', questions: [], onConfirm },
  ])('rejects Gateway-only $type confirmations', (detail) => {
    expect(() => serializeManagedToolConfirmation(detail)).toThrow(
      ManagedToolProtocolError,
    );
  });
});

describe('managed tool confirmation payloads', () => {
  it('preserves and clones all existing payload fields', () => {
    const payload = {
      newContent: '',
      cancelMessage: 'cancel',
      permissionRules: ['Edit(*)'],
      answers: { question: 'answer' },
      updatedInput: { nested: [true, null, 1] },
    };
    const parsed = parseManagedToolConfirmationPayload(payload);
    expect(parsed).toEqual(payload);
    expect(parsed?.updatedInput).not.toBe(payload.updatedInput);
    expect(parsed?.answers).not.toBe(payload.answers);
    expect(parseManagedToolConfirmationPayload(undefined)).toBeUndefined();
    expect(parseManagedToolConfirmationPayload({})).toEqual({});
  });

  it.each([
    null,
    [],
    'payload',
    { newContent: 1 },
    { cancelMessage: null },
    { permissionRules: 'rule' },
    { permissionRules: [1] },
    { answers: [] },
    { answers: { q: false } },
    { updatedInput: [] },
    { updatedInput: { value: undefined } },
    { unknown: true },
    { newContent: 'x'.repeat(256 * 1024) },
  ])('rejects malformed, extended or oversized payload %#', (value) => {
    expect(() => parseManagedToolConfirmationPayload(value)).toThrow(
      ManagedToolProtocolError,
    );
  });
});

describe('managed notebook modification metadata', () => {
  it('copies the full reference and accepts empty content for native validation', () => {
    const input = { source: { ...reference }, newContent: '' };
    const parsed = parseManagedToolContentModification(input);
    input.source.callId = 'mutated';
    expect(parsed).toEqual({ source: reference, newContent: '' });
  });
  it.each([
    {},
    { source: reference },
    { source: reference, newContent: null },
    { source: reference, newContent: '{}', approved: true },
    { source: { ...reference, argsDigest: 'wrong' }, newContent: '{}' },
    { source: reference, newContent: 'x'.repeat(256 * 1024) },
  ])('rejects malformed or oversized metadata %#', (input) => {
    expect(() => parseManagedToolContentModification(input)).toThrow(
      ManagedToolProtocolError,
    );
  });
});
