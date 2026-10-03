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
  MANAGED_RUNTIME_PROVIDER_PROTOCOL,
  ManagedRuntimeProviderProtocolError,
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
  protocol: string;
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

  it('pins the shared corpus to this protocol and one case shape', () => {
    // Both languages read the corpus by these literal keys.
    expect(Object.keys(fixtures).sort()).toEqual(['cases', 'protocol']);
    expect(fixtures.protocol).toBe(MANAGED_RUNTIME_PROVIDER_PROTOCOL);
    expect(
      new Set(fixtures.cases.map((entry) => Object.keys(entry).sort().join())),
    ).toEqual(new Set(['name,request,valid']));
  });

  it('bounds the whole composed envelope, not only its operation', () => {
    const envelope = (content: string) => ({
      protocolVersion: 1,
      providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
      session,
      operation: {
        kind: 'prepare',
        identity,
        toolName: 'write_file',
        input: { file_path: '/workspace/note.txt', content },
      },
    });
    const limit = managedRuntimeProviderLimit('prepare');
    const base = Buffer.byteLength(JSON.stringify(envelope('')), 'utf8');
    const exact = envelope('x'.repeat(limit - base));
    expect(parseManagedRuntimeProviderRequest(exact)).toEqual(exact);
    expect(() =>
      parseManagedRuntimeProviderRequest(
        envelope('x'.repeat(limit - base + 1)),
      ),
    ).toThrow('Managed Tool JSON exceeds size limit.');
  });

  it('admits only path-safe ASCII envelope Session ids', () => {
    const request = (patch: Partial<ManagedRuntimeProviderSession>) => ({
      protocolVersion: 1,
      providerProtocol: MANAGED_RUNTIME_PROVIDER_PROTOCOL,
      session: { ...session, ...patch },
      operation: { kind: 'acquire' },
    });
    const refused = [
      '',
      '.',
      '..',
      'a..b',
      'a/b',
      'a\\b',
      'a b',
      'a:b',
      'a\u0000b',
      'a\u0001b',
      'a\u2028b',
      'a\u202eb',
      'a\u200bb',
      'a\uff0fb',
      // Letters and digits outside ASCII.
      'a\u00e9b',
      'a\u4e2db',
      'a\u0430b',
      'a\u0663b',
      'a\uff11b',
      'a\ud83d\ude00b',
      'a\ud800b',
      'x'.repeat(513),
    ].flatMap((id) =>
      (['harnessSessionId', 'runtimeSessionId'] as const).map((key) => {
        try {
          parseManagedRuntimeProviderRequest(request({ [key]: id }));
          return `${key} ${JSON.stringify(id)} was admitted`;
        } catch (error) {
          return (error as Error).message;
        }
      }),
    );
    expect(new Set(refused)).toEqual(
      new Set([
        "Managed Runtime provider Session identity must be 1-512 ASCII letters, digits, '.', '_' or '-', without '..'.",
      ]),
    );
    // Opaque ids stay admitted: the Broker's fault gates drive this route
    // with them, and every in-repo producer mints UUIDs or prefix_<hex>.
    for (const id of [
      'harness-1',
      'runtime-session-1',
      'turn_0123456789abcdef',
      'a.b',
      'x'.repeat(512),
      session.runtimeSessionId,
    ])
      expect(
        parseManagedRuntimeProviderRequest(request({ runtimeSessionId: id }))
          .session.runtimeSessionId,
      ).toBe(id);
    // Every ASCII character, inside an id: exactly the allow-list admits.
    const allowed =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';
    const admitted = [];
    for (let code = 0; code < 0x80; code++) {
      const character = String.fromCharCode(code);
      try {
        parseManagedRuntimeProviderRequest(
          request({ runtimeSessionId: `a${character}b` }),
        );
        admitted.push(character);
      } catch {
        // refused
      }
    }
    expect(admitted.join('')).toBe(
      [...allowed]
        .sort((left, right) => left.charCodeAt(0) - right.charCodeAt(0))
        .join(''),
    );
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

  it('rejects malformed status shapes and premature results', () => {
    const status: ManagedRuntimeProviderOperation = {
      kind: 'status',
      reference,
    };
    const base = {
      state: 'executing',
      cancelRequested: false,
      lastSeq: 1,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    expect(parseManagedRuntimeProviderResult(status, base, session)).toEqual(
      base,
    );
    for (const bad of [
      { ...base, lastSeq: -1 },
      { ...base, lastSeq: 1.5 },
      { ...base, firstAvailableSeq: -1 },
      { ...base, result: { executionStatus: 'success' } },
    ]) {
      expect(() =>
        parseManagedRuntimeProviderResult(status, bad, session),
      ).toThrow();
    }
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

  it('requires the fields of each confirmation variant', () => {
    const confirmation = { kind: 'confirmation', reference } as const;
    const complete = [
      { type: 'exec', title: 'Run', command: 'rm -rf /w', rootCommand: 'rm' },
      {
        type: 'edit',
        title: 'Edit',
        fileName: 'a.txt',
        filePath: '/w/a.txt',
        fileDiff: '',
        originalContent: null,
        newContent: 'x',
        isModifying: false,
      },
      {
        type: 'mcp',
        title: 'MCP',
        serverName: 'server',
        toolName: 'tool',
        toolDisplayName: 'Tool',
      },
      { type: 'info', title: 'Info', prompt: 'Fetch it?', urls: ['https://x'] },
    ];
    for (const value of complete)
      expect(
        parseManagedRuntimeProviderResult(confirmation, value, session),
      ).toEqual(value);
    const required: Record<string, string[]> = {
      exec: ['title', 'command', 'rootCommand'],
      edit: [
        'title',
        'fileName',
        'filePath',
        'fileDiff',
        'originalContent',
        'newContent',
      ],
      mcp: ['title', 'serverName', 'toolName', 'toolDisplayName'],
      info: ['title', 'prompt'],
    };
    // Each required field, missing or of the wrong type, is refused.
    const incomplete = complete.flatMap((value) =>
      required[value.type].flatMap((field) => [
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== field),
        ),
        { ...value, [field]: 7 },
      ]),
    );
    for (const value of incomplete)
      expect(() =>
        parseManagedRuntimeProviderResult(confirmation, value, session),
      ).toThrow();
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
    const NOTICE =
      /\n\[Managed Runtime provider omitted (\d+) characters here to fit the \d+-byte wire limit\.\]\n/;
    /** The characters a cut field kept, and the count its notice reports. */
    const cutOf = (text: string) => {
      const notice = text.match(NOTICE);
      expect(notice).not.toBeNull();
      return {
        kept: [...text.replace(notice![0], '')],
        omitted: Number(notice![1]),
      };
    };

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
      // The three fields share the cut instead of the first being emptied.
      for (const field of [
        result.result.llmContent,
        display.text,
        display.output,
      ])
        expect(field.length).toBeGreaterThan(budget * 0.3);
    });

    it('evicts oldest progress before cutting a settled result', () => {
      const status = {
        state: 'settled',
        cancelRequested: false,
        lastSeq: 6,
        firstAvailableSeq: 1,
        progressGap: false,
        // Distinct sizes, so the byte total cannot hide which end survived.
        progress: [1, 2, 3, 4, 5, 6].map((seq) => ({
          seq,
          output: 'p'.repeat(1024 + seq),
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
      expect(status.progress.map((event) => event.seq)).toEqual([6]);
      expect(status.firstAvailableSeq).toBe(6);
      expect(status.progress[0].seq).toBe(status.firstAvailableSeq);
      expect(status.result.result.llmContent).toBe('short');
    });

    it.each([
      ['three-byte text', '中', 444_444],
      ['two-byte text', 'é', 600_000],
      ['surrogate pairs', '\u{1F600}', 300_000],
      ['unpaired surrogates', '\uD800', 200_000],
      ['JSON-escaped controls', '\u0001', 200_000],
      ['short-escaped newlines', '\n', 600_000],
      ['escaped quotes', '"', 600_000],
      ['escaped backslashes', '\\', 600_000],
    ])(
      'cuts %s by its encoded bytes without splitting a code point',
      (_label, unit, count) => {
        const limit = 1024 * 1024;
        const result = {
          executionStatus: 'success',
          result: { llmContent: unit.repeat(count) },
        };
        fitManagedRuntimeProviderResult(execute, result, limit);
        const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        expect(bytes).toBeLessThanOrEqual(limit);
        expect(bytes).toBeGreaterThan(limit * 0.99);
        // Spreading yields whole code points: a split pair would leave a
        // half that differs from the unit.
        const { kept, omitted } = cutOf(result.result.llmContent);
        expect(kept.every((character) => character === unit)).toBe(true);
        expect(kept.length + omitted).toBe(count);
      },
    );

    it('shares one level between fields and counts each cut exactly', () => {
      const result = {
        executionStatus: 'success',
        result: {
          llmContent: 'a'.repeat(5000),
          returnDisplay: 'c'.repeat(5000),
        },
        error: { message: 'e'.repeat(80) },
      };
      fitManagedRuntimeProviderResult(execute, result, 400);
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThanOrEqual(400);
      expect(bytes).toBeGreaterThan(396);
      // Below the common level, the message is left whole.
      expect(result.error.message).toBe('e'.repeat(80));
      for (const [field, letter] of [
        [result.result.llmContent, 'a'],
        [result.result.returnDisplay, 'c'],
      ] as const) {
        const { kept, omitted } = cutOf(field);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.every((character) => character === letter)).toBe(true);
        expect(kept.length + omitted).toBe(5000);
      }
    });

    it('never grows a field too short to hold its notice', () => {
      const result = {
        executionStatus: 'success',
        result: { llmContent: 'a'.repeat(5000) },
        error: { message: 'e'.repeat(80) },
      };
      // The level falls below the message's notice: cutting it would add
      // bytes, so it stays, and the result is stubbed instead.
      fitManagedRuntimeProviderResult(execute, result, 200);
      expect(result.error.message).toBe('e'.repeat(80));
      expect(result.result.llmContent).not.toContain('aaa');
    });

    it('leaves a field below the common level whole', () => {
      const limit = 48 * 1024;
      const result = {
        executionStatus: 'success',
        result: {
          llmContent: 'a'.repeat(60_000),
          returnDisplay: 'c'.repeat(10_000),
        },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThanOrEqual(limit);
      expect(bytes).toBeGreaterThan(limit * 0.99);
      expect(result.result.returnDisplay).toBe('c'.repeat(10_000));
      const { kept, omitted } = cutOf(result.result.llmContent);
      expect(kept.length + omitted).toBe(60_000);
    });

    it.each([
      ['far larger than the budget', () => 1024 * 1024],
      // Fits alone, but not beside the notice a cut would leave.
      [
        'too large to sit beside a notice',
        (skeleton: number) => 1024 * 1024 - skeleton - 50,
      ],
    ])('drops hooks first when they are %s', (_label, hookSize) => {
      const limit = 1024 * 1024;
      const skeleton = Buffer.byteLength(
        JSON.stringify({
          executionStatus: 'success',
          result: { llmContent: '' },
          postHook: { note: '' },
        }),
        'utf8',
      );
      const result = {
        executionStatus: 'success',
        result: { llmContent: 'l'.repeat(1000) },
        postHook: { note: 'h'.repeat(hookSize(skeleton)) },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(result).not.toHaveProperty('postHook');
      expect(result.result.llmContent).toBe('l'.repeat(1000));
    });

    it('counts each notice when sharing the cut, so hooks stay whenever they fit', () => {
      const limit = 1024 * 1024;
      const noticeBytes = (count: number) =>
        Buffer.byteLength(
          JSON.stringify(
            `\n[Managed Runtime provider omitted ${count} characters here to fit the ${limit}-byte wire limit.]\n`,
          ),
          'utf8',
        ) - 2;
      const skeleton = Buffer.byteLength(
        JSON.stringify({
          executionStatus: 'success',
          result: { llmContent: '', returnDisplay: '' },
          postHook: { note: '' },
        }),
        'utf8',
      );
      // The long field's notice is larger than the short field's; the hook
      // leaves room for exactly that notice and 96 bytes of the short field,
      // one byte less than a level that ignored the notices would give it.
      const hook = limit - skeleton - noticeBytes(1_000_000) - 96;
      const result = {
        executionStatus: 'success',
        result: {
          llmContent: 'a'.repeat(1_000_000),
          returnDisplay: 'c'.repeat(500),
        },
        postHook: { note: 'h'.repeat(hook) },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(result.postHook.note).toHaveLength(hook);
      expect(cutOf(result.result.llmContent)).toEqual({
        kept: [],
        omitted: 1_000_000,
      });
      const display = cutOf(result.result.returnDisplay);
      expect(display.kept.length + display.omitted).toBe(500);
    });

    it('stubs a display the cut cannot reach before cutting the model content or dropping hooks', () => {
      const limit = 1024 * 1024;
      // An edit's answer is longer than any notice; its file diff is the
      // part that overflows.
      const llmContent = `The file /w/a.json has been updated.\n${'y'.repeat(2000)}`;
      const result = {
        executionStatus: 'success',
        result: {
          llmContent,
          returnDisplay: {
            fileDiff: 'x'.repeat(limit),
            fileName: 'a.json',
            originalContent: 'o'.repeat(1000),
            newContent: 'n'.repeat(1000),
          },
        },
        postHook: { note: 'kept' },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(result.result.llmContent).toBe(llmContent);
      expect(result.postHook).toEqual({ note: 'kept' });
      expect(typeof result.result.returnDisplay).toBe('string');
    });

    it('drops artifacts the cut cannot reach before cutting the model content or dropping hooks', () => {
      const limit = 1024 * 1024;
      const result = {
        executionStatus: 'success',
        result: {
          llmContent: 'l'.repeat(1000),
          artifacts: [{ title: 'report', description: 'd'.repeat(limit) }],
        },
        postHook: { note: 'kept' },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(result.result).not.toHaveProperty('artifacts');
      expect(result.result.llmContent).toBe('l'.repeat(1000));
      expect(result.postHook).toEqual({ note: 'kept' });
    });

    it('keeps artifacts that fit beside the cut text', () => {
      const limit = 1024 * 1024;
      const artifacts = [{ title: 'report', description: 'small' }];
      const result = {
        executionStatus: 'success',
        result: { llmContent: 'l'.repeat(2 * limit), artifacts },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(result.result.artifacts).toEqual(artifacts);
      expect(result.result.llmContent.length).toBeLessThan(limit);
    });

    it('re-measures the text after stubbing a display that alone overflows', () => {
      // A shell display's uncut part is bounded (8 KiB of directory and file
      // names), so only a small budget lets it overflow on its own.
      const limit = 6000;
      const result = {
        executionStatus: 'success',
        result: {
          llmContent: 'l'.repeat(20_000),
          returnDisplay: {
            type: 'shell_result',
            version: 1,
            text: 't'.repeat(20_000),
            output: 'o'.repeat(20_000),
            directory: 'd'.repeat(8000),
            exitCode: 0,
            signal: null,
            pid: null,
            error: null,
            outcome: 'completed',
            notices: [],
            truncated: false,
            outputFiles: [],
          } as unknown,
        },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(bytes).toBeLessThanOrEqual(limit);
      expect(bytes).toBeGreaterThan(limit * 0.99);
      expect(typeof result.result.returnDisplay).toBe('string');
      const { kept, omitted } = cutOf(result.result.llmContent);
      expect(kept.length + omitted).toBe(20_000);
    });

    it('stubs model content the cut cannot reach when nothing else is left', () => {
      const limit = 1024 * 1024;
      const result = {
        executionStatus: 'success',
        result: {
          llmContent: [
            { inlineData: { mimeType: 'image/png', data: 'A'.repeat(limit) } },
            { text: 'caption' },
          ] as unknown,
        },
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(typeof result.result.llmContent).toBe('string');
    });

    it('keeps hooks when cutting the text makes room', () => {
      const limit = 1024 * 1024;
      const postHook = { note: 'h'.repeat(1000) };
      const result = {
        executionStatus: 'success',
        result: { llmContent: 'l'.repeat(2 * limit) },
        postHook,
      };
      fitManagedRuntimeProviderResult(execute, result, limit);
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(limit);
      expect(result.postHook).toEqual({ note: 'h'.repeat(1000) });
      expect(result.result.llmContent).toContain(
        'Managed Runtime provider omitted',
      );
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
      expect(status.progress).toEqual([]);
      expect(status.firstAvailableSeq).toBe(status.lastSeq + 1);
    });
  });
});

it('validates raw file history ownership, paths and the closed operation shape', () => {
  const state = {
    ownerSessionId: session.harnessSessionId,
    snapshots: [],
    files: {},
  };
  expect(
    parseManagedRuntimeProviderOperation(
      { kind: 'raw-file-history', action: 'bind', state },
      session,
    ),
  ).toMatchObject({ state });
  const prepare = {
    kind: 'raw-file-history',
    action: 'prepare',
    promptId: 'original-prompt',
    paths: ['a'],
  };
  expect(parseManagedRuntimeProviderOperation(prepare, session)).toEqual(
    prepare,
  );
  for (const operation of [
    {
      kind: 'raw-file-history',
      action: 'bind',
      state: { ...state, ownerSessionId: session.runtimeSessionId },
    },
    {
      kind: 'raw-file-history',
      action: 'prepare',
      promptId: '',
      paths: ['a'],
    },
    {
      kind: 'raw-file-history',
      action: 'prepare',
      promptId: session.runtimeSessionId,
      paths: ['../a'],
    },
    {
      kind: 'raw-file-history',
      action: 'prepare',
      promptId: session.runtimeSessionId,
      paths: ['/a'],
    },
    { kind: 'raw-file-history', action: 'snapshot', unknown: true },
  ])
    expect(() =>
      parseManagedRuntimeProviderOperation(operation, session),
    ).toThrow();
  expect(() =>
    parseManagedRuntimeProviderResult(
      { kind: 'raw-file-history', action: 'snapshot' },
      { ...state, files: { a: null } },
      session,
    ),
  ).toThrow();
});

it('refuses rewind outcomes that cannot form a valid stored receipt', () => {
  const promptId = session.runtimeSessionId;
  const backup = {
    backupFileName: null,
    version: 1,
    backupTime: '2026-10-01T00:00:00.000Z',
  };
  const state = {
    ownerSessionId: session.harnessSessionId,
    snapshots: [
      {
        promptId,
        timestamp: backup.backupTime,
        trackedFileBackups: Object.fromEntries([
          ['a.txt', backup],
          ['__proto__', backup],
        ]),
      },
    ],
    files: Object.fromEntries([
      ['a.txt', null],
      ['__proto__', null],
    ]),
  };
  const operation = {
    kind: 'raw-file-history',
    action: 'rewind',
    promptId,
  } as const;
  const outcome = {
    state,
    filesChanged: ['a.txt', '__proto__'],
    filesFailed: [],
    conflict: false,
  };
  for (const valid of [
    outcome,
    { ...outcome, filesChanged: [], conflict: true },
  ])
    expect(
      parseManagedRuntimeProviderResult(operation, valid, session),
    ).toEqual(valid);
  for (const invalid of [
    { ...outcome, filesChanged: ['a.txt', 'a.txt'] },
    { ...outcome, filesChanged: ['missing.txt'] },
    { ...outcome, filesChanged: ['constructor'] },
    { ...outcome, conflict: true },
    {
      ...outcome,
      state: {
        ...state,
        snapshots: [
          { ...state.snapshots[0], promptId: session.harnessSessionId },
        ],
      },
    },
  ])
    expect(() =>
      parseManagedRuntimeProviderResult(operation, invalid, session),
    ).toThrow(ManagedRuntimeProviderProtocolError);
  for (const filesChanged of [['./a.txt'], [null]])
    expect(() =>
      parseManagedRuntimeProviderResult(
        operation,
        { ...outcome, filesChanged },
        session,
      ),
    ).toThrow('Invalid Hosted file history path.');
});
