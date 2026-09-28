/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  MANAGED_RUNTIME_PROVIDER_ROUTE,
  fitManagedRuntimeProviderResult,
  managedRuntimeProviderLimit,
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
) as {
  cases: Array<{
    name: string;
    valid: boolean;
    request: { operation?: { kind?: unknown; outcome?: unknown } };
  }>;
};
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

  it('pins every accepted confirm outcome in the shared corpus', () => {
    const pinned = new Set(
      fixtures.cases
        .filter(
          (entry) => entry.valid && entry.request.operation?.kind === 'confirm',
        )
        .map((entry) => entry.request.operation?.outcome),
    );
    expect(pinned).toEqual(
      new Set(
        Object.values(ToolConfirmationOutcome).filter(
          (outcome) => outcome !== ToolConfirmationOutcome.RestorePrevious,
        ),
      ),
    );
  });

  it('ties the declared response bound to the enforced per-kind limits', () => {
    const kinds = [
      'acquire',
      'release',
      'manifest',
      'history',
      'begin-turn',
      'prepare',
      'confirmation',
      'confirm',
      'preflight',
      'bind-history',
      'checkpoint',
      'execute',
      'status',
      'cancel',
    ];
    expect(MANAGED_RUNTIME_PROVIDER_ROUTE.responseBodyLimitBytes).toBe(
      Math.max(...kinds.map(managedRuntimeProviderLimit)),
    );
  });

  describe('fitManagedRuntimeProviderResult', () => {
    const budget = 64 * 1024;
    const execute = { kind: 'execute', reference } as const;

    it('leaves fitting results and non-observation kinds untouched', () => {
      const small = {
        executionStatus: 'success',
        result: { llmContent: 'ok' },
      };
      expect(fitManagedRuntimeProviderResult(execute, small, budget)).toBe(
        small,
      );
      const prepareResult = { description: 'x'.repeat(budget * 2) };
      expect(
        fitManagedRuntimeProviderResult(
          {
            kind: 'prepare',
            identity,
            toolName: 'read_file',
            input: {},
          },
          prepareResult,
          budget,
        ),
      ).toBe(prepareResult);
    });

    it('cuts bulk result text head-and-tail with a notice and a truncated flag', () => {
      const display = {
        type: 'shell_result',
        version: 1,
        text: 't'.repeat(budget),
        output: 'x'.repeat(budget),
        directory: '/w',
        exitCode: 0,
        signal: null,
        pid: null,
        error: null,
        outcome: 'completed',
        notices: [],
        truncated: false,
        outputFiles: [],
      };
      const result = {
        executionStatus: 'success',
        result: { llmContent: 'l'.repeat(budget), returnDisplay: display },
      };
      const fitted = fitManagedRuntimeProviderResult(execute, result, budget);
      expect(fitted).toBe(result);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(budget);
      expect(display.truncated).toBe(true);
      expect(display.output).toContain('Managed Runtime provider omitted');
      expect(display.output.startsWith('x')).toBe(true);
      expect(display.output.endsWith('x')).toBe(true);
      expect(result.result.llmContent).toContain(
        'Managed Runtime provider omitted',
      );
    });

    it('evicts oldest progress before cutting a settled result', () => {
      const status = {
        state: 'settled',
        cancelRequested: false,
        lastSeq: 6,
        firstAvailableSeq: 1,
        progressGap: false,
        progress: [1, 2, 3, 4, 5, 6].map((seq) => ({
          seq,
          output: 'p'.repeat(1024),
        })),
        result: {
          executionStatus: 'success',
          result: { llmContent: 'short' },
        },
      };
      const fitted = fitManagedRuntimeProviderResult(
        { kind: 'status', reference },
        status,
        2048,
      );
      expect(fitted).toBe(status);
      expect(
        Buffer.byteLength(JSON.stringify(status), 'utf8'),
      ).toBeLessThanOrEqual(2048);
      expect(status.progressGap).toBe(true);
      expect(status.progress.length).toBeGreaterThan(0);
      expect(status.progress[0].seq).toBe(status.firstAvailableSeq);
      expect(status.result.result.llmContent).toBe('short');
    });

    it('keeps the terminal observation representable when everything is oversized', () => {
      const status = {
        state: 'settled',
        cancelRequested: false,
        lastSeq: 1,
        firstAvailableSeq: 1,
        progressGap: false,
        progress: [{ seq: 1, output: 'p'.repeat(budget) }],
        result: {
          executionStatus: 'success',
          result: {
            llmContent: 'l'.repeat(budget),
            returnDisplay: { custom: 'd'.repeat(budget) },
          },
          postHook: { note: 'h'.repeat(budget) },
        },
      };
      fitManagedRuntimeProviderResult(
        { kind: 'status', reference },
        status,
        budget,
      );
      expect(
        Buffer.byteLength(JSON.stringify(status), 'utf8'),
      ).toBeLessThanOrEqual(budget);
      expect(status.state).toBe('settled');
      expect(status.result.executionStatus).toBe('success');
    });
  });
});
