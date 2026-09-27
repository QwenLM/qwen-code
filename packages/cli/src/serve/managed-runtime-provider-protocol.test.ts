/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  parseManagedRuntimeProviderOperation,
  parseManagedRuntimeProviderRequest,
  parseManagedRuntimeProviderResult,
  type ManagedRuntimeProviderOperation,
  type ManagedRuntimeProviderSession,
} from './managed-runtime-provider-protocol.js';

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-runtime-provider-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: Array<{ name: string; valid: boolean; request: unknown }> };
const session: ManagedRuntimeProviderSession = {
  harnessSessionId: '550e8400-e29b-41d4-a716-446655440301',
  runtimeSessionId: '550e8400-e29b-41d4-a716-446655440302',
  turnKind: 'bootstrap',
};
const identity = {
  sessionId: session.runtimeSessionId,
  promptId: 'turn-1',
  callId: 'call-1',
  capabilityDigest: 'a'.repeat(64),
  policyRevision: 'policy-1',
};
const reference = {
  ...identity,
  invocationId: 'invocation-1',
  argsDigest: managedToolDigest({ file_path: 'note.txt' }),
};

describe('managed-runtime-provider/1', () => {
  it.each(fixtures.cases)('$name', ({ valid, request }) => {
    if (valid)
      expect(parseManagedRuntimeProviderRequest(request)).toEqual(request);
    else expect(() => parseManagedRuntimeProviderRequest(request)).toThrow();
  });

  it('validates optional preparation values and their original Session', () => {
    const operation = {
      kind: 'prepare',
      identity,
      toolName: 'write_file',
      input: { content: 'next' },
      modification: { source: reference, newContent: 'next' },
      mediaContext: { inputModalities: { image: true } },
    };
    expect(parseManagedRuntimeProviderOperation(operation, session)).toEqual(
      operation,
    );
    expect(() =>
      parseManagedRuntimeProviderOperation(
        {
          ...operation,
          modification: {
            ...operation.modification,
            source: { ...reference, sessionId: session.harnessSessionId },
          },
        },
        session,
      ),
    ).toThrow('Session identity conflicts');
    expect(() =>
      parseManagedRuntimeProviderOperation(
        {
          ...operation,
          mediaContext: { inputModalities: { image: 'yes' } },
        },
        session,
      ),
    ).toThrow();
  });

  it.each([
    { kind: 'confirm', reference, outcome: 'restore_previous' },
    { kind: 'confirm', reference, outcome: 'proceed_once', phase: 'other' },
    {
      kind: 'confirm',
      reference,
      outcome: 'proceed_once',
      payload: { allow: true },
    },
    { kind: 'status', reference, afterSequence: -1 },
    { kind: 'status', reference, afterSequence: 1.5 },
    { kind: 'prepare', identity, toolName: 'read_file', input: [] },
    {
      kind: 'prepare',
      identity,
      toolName: 'read_file',
      input: { text: 'x'.repeat(1024 * 1024) },
    },
  ])('rejects malformed $kind before effects', (operation) => {
    expect(() =>
      parseManagedRuntimeProviderOperation(operation, session),
    ).toThrow();
  });

  it('copies admitted values so callers cannot change an in-flight request', () => {
    const input = { content: 'first' };
    const parsed = parseManagedRuntimeProviderOperation(
      {
        kind: 'prepare',
        identity,
        toolName: 'write_file',
        input,
      },
      session,
    );
    input.content = 'second';
    expect(parsed).toMatchObject({ input: { content: 'first' } });
  });

  it('pins manifest contents to its capability digest', () => {
    const manifest = {
      tools: [],
      capabilityDigest: managedToolDigest([]),
      policyRevision: 'policy-1',
    };
    expect(
      parseManagedRuntimeProviderResult(
        { kind: 'manifest' },
        manifest,
        session,
      ),
    ).toEqual(manifest);
    expect(() =>
      parseManagedRuntimeProviderResult(
        { kind: 'manifest' },
        {
          ...manifest,
          capabilityDigest: 'a'.repeat(64),
        },
        session,
      ),
    ).toThrow('digest changed');
  });

  it('pins prepared references and normalized arguments to the original request', () => {
    const operation: ManagedRuntimeProviderOperation = {
      kind: 'prepare',
      identity,
      toolName: 'read_file',
      input: { file_path: 'note.txt' },
    };
    const prepared = {
      ...reference,
      params: operation.input,
      description: 'Read file',
      locations: [],
      defaultPermission: 'allow',
      requiresUserInteraction: false,
      toolUseId: 'toolu_1',
    };
    expect(
      parseManagedRuntimeProviderResult(operation, prepared, session),
    ).toEqual(prepared);
    for (const changed of [
      { sessionId: session.harnessSessionId },
      { promptId: 'another-turn' },
      { policyRevision: 'another-policy' },
      { params: { file_path: 'another.txt' } },
    ])
      expect(() =>
        parseManagedRuntimeProviderResult(
          operation,
          { ...prepared, ...changed },
          session,
        ),
      ).toThrow();
  });

  it('rejects foreign history owners and raw Tool v2 success results', () => {
    expect(() =>
      parseManagedRuntimeProviderResult(
        { kind: 'history' },
        {
          ownerSessionId: session.runtimeSessionId,
          revision: 0,
          snapshots: [],
        },
        session,
      ),
    ).toThrow('owner changed');
    expect(() =>
      parseManagedRuntimeProviderResult(
        { kind: 'execute', reference },
        {
          executionStatus: 'success',
          responseParts: [],
        },
        session,
      ),
    ).toThrow();
  });

  it('distinguishes void acknowledgements, terminal proof and unknown lookup', () => {
    expect(
      parseManagedRuntimeProviderResult(
        { kind: 'begin-turn', identity },
        null,
        session,
      ),
    ).toBeNull();
    expect(() =>
      parseManagedRuntimeProviderResult(
        { kind: 'begin-turn', identity },
        {},
        session,
      ),
    ).toThrow();
    expect(() =>
      parseManagedRuntimeProviderResult({ kind: 'release' }, false, session),
    ).toThrow();
    expect(
      parseManagedRuntimeProviderResult(
        { kind: 'status', reference },
        { state: 'unknown' },
        session,
      ),
    ).toEqual({ state: 'unknown' });
    expect(() =>
      parseManagedRuntimeProviderResult(
        { kind: 'status', reference },
        {
          state: 'unknown',
          result: { executionStatus: 'not_started' },
        },
        session,
      ),
    ).toThrow();
  });
});
