/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  createToolResultBoundaryObserver,
  toolResultBoundaryArtifact,
  toolResultArtifactState,
  toolResultPartDiagnosticValues,
  TOOL_RESULT_BOUNDARY_EVENT_NAME,
} from './tool-result-boundary-diagnostics.js';

function parseEvent(line: string): Record<string, unknown> {
  return JSON.parse(
    line.slice(`${TOOL_RESULT_BOUNDARY_EVENT_NAME} `.length),
  ) as Record<string, unknown>;
}

function eventValues(event: Record<string, unknown>) {
  return event['values'] as Array<Record<string, unknown>>;
}

describe('tool-result boundary diagnostics', () => {
  it('records exact sizes and process-local HMACs without raw values or identifiers', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 7),
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });
    const secret = 'secret "汉😀\ud800" output';

    expect(
      observe({
        stage: 'producer',
        values: [{ representation: 'display', value: secret }],
        artifacts: [{ state: 'reusable', kinds: ['file', 'image'] }],
        sessionId: 'secret-session-id',
        promptId: 'secret-prompt-id',
        toolCallId: 'secret-tool-call-id',
        toolCallIds: ['secret-tool-call-id-2'],
        toolName: 'secret-tool-name',
        wireUtf8Bytes: 12_345,
      }),
    ).toBe(true);

    const line = debug.mock.calls[0][0] as string;
    const event = parseEvent(line);
    expect(event).toMatchObject({
      eventName: TOOL_RESULT_BOUNDARY_EVENT_NAME,
      stage: 'producer',
      mutated: false,
      artifacts: [{ state: 'reusable', kinds: ['file', 'image'] }],
      sessionHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      promptHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      toolCallHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      toolCallHmacSha256s: [expect.stringMatching(/^[0-9a-f]{64}$/)],
      toolNameHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      wireUtf8Bytes: 12_345,
    });
    expect(eventValues(event)[0]).toMatchObject({
      representation: 'display',
      slot: 0,
      codeUnits: secret.length,
      rawUtf8Bytes: Buffer.byteLength(secret, 'utf8'),
      jsonUtf8Bytes: Buffer.byteLength(JSON.stringify(secret), 'utf8'),
      hmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    for (const raw of [
      secret,
      'secret-session-id',
      'secret-prompt-id',
      'secret-tool-call-id',
      'secret-tool-call-id-2',
      'secret-tool-name',
    ]) {
      expect(line).not.toContain(raw);
    }
    expect(line).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it('normalizes untrusted artifact summaries at the log sink', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 8),
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });

    observe({
      stage: 'producer',
      values: [{ representation: 'display', value: 'eligible' }],
      artifacts: [
        {
          state: '/private/secret-state',
          kinds: ['file', '/private/secret-kind'],
        },
      ] as unknown as Parameters<typeof observe>[0]['artifacts'],
    });

    const line = debug.mock.calls[0][0] as string;
    expect(parseEvent(line)).toMatchObject({
      artifacts: [{ state: 'undecided', kinds: ['file', 'unknown'] }],
    });
    expect(line).not.toContain('/private/secret');

    observe({
      stage: 'producer',
      values: [{ representation: 'display', value: 'eligible' }],
      artifacts: [{ state: 'none', kinds: [] }],
    });
    expect(parseEvent(debug.mock.calls[1][0] as string)).toMatchObject({
      artifacts: [{ state: 'none', kinds: [] }],
    });
  });

  it('keeps unchanged HMACs equal and changes the first mutated value', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 9),
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });

    observe({
      stage: 'finalizer_input',
      mutated: true,
      values: [{ representation: 'model_text', value: 'same-value' }],
    });
    observe({
      stage: 'finalizer_output',
      mutated: true,
      values: [{ representation: 'model_text', value: 'same-value' }],
    });
    observe({
      stage: 'headless_projection_output',
      mutated: true,
      values: [{ representation: 'headless_content', value: 'changed-value' }],
    });

    const hashes = debug.mock.calls.map(
      ([line]) =>
        eventValues(parseEvent(line as string))[0]['hmacSha256'] as string,
    );
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[1]);
    expect(parseEvent(debug.mock.calls[0][0] as string)['mutated']).toBe(true);
  });

  it('hashes equal values identically across representations', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 2),
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });

    observe({
      stage: 'producer',
      values: [
        { representation: 'model_text', value: 'same-value' },
        { representation: 'display', value: 'same-value' },
      ],
    });

    const values = eventValues(parseEvent(debug.mock.calls[0][0] as string));
    expect(values[0]['hmacSha256']).toBe(values[1]['hmacSha256']);
  });

  it('hashes legacy and canonical tool names identically', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 4),
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });

    for (const toolName of ['task', 'agent']) {
      observe({
        stage: 'producer',
        toolName,
        values: [{ representation: 'display', value: 'eligible' }],
      });
    }

    const hashes = debug.mock.calls.map(
      ([line]) => parseEvent(line as string)['toolNameHmacSha256'],
    );
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('hashes distinct lone-surrogate code units differently', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 3),
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });

    observe({
      stage: 'producer',
      values: [
        { representation: 'display', value: '\ud800' },
        { representation: 'display', value: '\udc00' },
      ],
    });

    const values = eventValues(parseEvent(debug.mock.calls[0][0] as string));
    expect(values[0]['hmacSha256']).not.toBe(values[1]['hmacSha256']);
    expect(values.map((value) => value['slot'])).toEqual([0, 1]);
  });

  it('reuses its lazily generated HMAC key across events', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });
    const observation = {
      stage: 'producer' as const,
      sessionId: 'same-session',
      values: [{ representation: 'display' as const, value: 'eligible' }],
    };

    observe(observation);
    observe(observation);

    expect(
      parseEvent(debug.mock.calls[0][0] as string)['sessionHmacSha256'],
    ).toBe(parseEvent(debug.mock.calls[1][0] as string)['sessionHmacSha256']);
  });

  it('executes enabled value and mutation thunks', () => {
    const debug = vi.fn();
    const values = vi.fn(() => [
      { representation: 'display' as const, value: 'small' },
    ]);
    const mutated = vi.fn(() => true);
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 6),
      logger: { debug, isEnabled: () => true },
    });

    expect(observe({ stage: 'producer', mutated, values })).toBe(true);
    expect(values).toHaveBeenCalledOnce();
    expect(mutated).toHaveBeenCalledOnce();
    expect(parseEvent(debug.mock.calls[0][0] as string)['mutated']).toBe(true);
  });

  it('matches native JSON byte accounting under fixed-seed fuzzing', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 1),
      logLimit: 500,
      logger: { debug, isEnabled: () => true },
      thresholdBytes: 0,
    });
    const atoms = [
      'a',
      '"',
      '\\',
      '\b',
      '\t',
      '\n',
      '\f',
      '\r',
      '\0',
      '\x1f',
      '\x7f',
      'é',
      '\u07ff',
      '汉',
      '😀',
      '\ud800',
      '\udc00',
    ];
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let sampleIndex = 0; sampleIndex < 250; sampleIndex++) {
      let value = '';
      const length = 1 + (random() % 100);
      for (let index = 0; index < length; index++) {
        value += atoms[random() % atoms.length];
      }
      observe({
        stage: 'producer',
        values: [{ representation: 'model_text', value }],
      });
      const summary = eventValues(
        parseEvent(debug.mock.calls.at(-1)?.[0] as string),
      )[0];
      expect(summary['jsonUtf8Bytes']).toBe(
        Buffer.byteLength(JSON.stringify(value), 'utf8'),
      );
    }
  });

  it('is lazy and silent while disabled or below the threshold', () => {
    const disabledValues = vi.fn(() => [
      { representation: 'display' as const, value: 'secret' },
    ]);
    const disabledMutation = vi.fn(() => true);
    const disabledDebug = vi.fn();
    const disabled = createToolResultBoundaryObserver({
      enabled: () => false,
      logger: { debug: disabledDebug, isEnabled: () => true },
    });
    expect(
      disabled({
        stage: 'producer',
        mutated: disabledMutation,
        values: disabledValues,
      }),
    ).toBe(false);
    expect(disabledValues).not.toHaveBeenCalled();
    expect(disabledMutation).not.toHaveBeenCalled();
    expect(disabledDebug).not.toHaveBeenCalled();

    const belowDebug = vi.fn();
    const below = createToolResultBoundaryObserver({
      enabled: () => true,
      logger: { debug: belowDebug, isEnabled: () => true },
      thresholdBytes: 100,
    });
    expect(
      below({
        stage: 'producer',
        values: [{ representation: 'display', value: 'small' }],
      }),
    ).toBe(false);
    expect(belowDebug).not.toHaveBeenCalled();
  });

  it('emits only above the 65,536-byte JSON-string threshold', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 4),
      logger: { debug, isEnabled: () => true },
    });

    for (const [valueLength, expected] of [
      [65_533, false],
      [65_534, false],
      [65_535, true],
    ] as const) {
      expect(
        observe({
          stage: 'producer',
          values: [
            { representation: 'display', value: 'a'.repeat(valueLength) },
          ],
        }),
      ).toBe(expected);
    }
    expect(debug).toHaveBeenCalledTimes(1);
    expect(
      eventValues(parseEvent(debug.mock.calls[0][0] as string))[0],
    ).toMatchObject({ jsonUtf8Bytes: 65_537 });
  });

  it('emits when any value exceeds the threshold', () => {
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 4),
      logger: { debug, isEnabled: () => true },
    });

    expect(
      observe({
        stage: 'producer',
        values: [
          { representation: 'display', value: 'a'.repeat(65_535) },
          { representation: 'display', value: 'small' },
        ],
      }),
    ).toBe(true);
    expect(debug).toHaveBeenCalledOnce();
  });

  it('rate-limits eligible events and reports the suppressed count', () => {
    let currentTime = 0;
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 5),
      logLimit: 1,
      logger: { debug, isEnabled: () => true },
      now: () => currentTime,
      thresholdBytes: 0,
      windowMs: 100,
    });
    const observation = {
      stage: 'producer' as const,
      values: [{ representation: 'display' as const, value: 'large' }],
    };

    expect(observe(observation)).toBe(true);
    expect(observe(observation)).toBe(true);
    expect(observe(observation)).toBe(true);
    expect(debug).toHaveBeenCalledTimes(1);
    currentTime = 100;
    expect(observe(observation)).toBe(true);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(parseEvent(debug.mock.calls[1][0] as string)).toMatchObject({
      suppressedCount: 2,
    });
    currentTime = 200;
    expect(observe(observation)).toBe(true);
    expect(parseEvent(debug.mock.calls[2][0] as string)).not.toHaveProperty(
      'suppressedCount',
    );
  });

  it('skips value measurement for rate-limited mutated events', () => {
    const values = vi.fn(() => [
      { representation: 'display' as const, value: 'secret' },
    ]);
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      logLimit: 0,
      logger: { debug: vi.fn(), isEnabled: () => true },
    });

    expect(observe({ stage: 'producer', mutated: true, values })).toBe(true);
    expect(values).not.toHaveBeenCalled();
  });

  it('starts a new rate-limit window when the clock moves backward', () => {
    let currentTime = 100;
    const debug = vi.fn();
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      hmacKey: Buffer.alloc(32, 5),
      logLimit: 1,
      logger: { debug, isEnabled: () => true },
      now: () => currentTime,
      thresholdBytes: 0,
      windowMs: 100,
    });
    const observation = {
      stage: 'producer' as const,
      values: [{ representation: 'display' as const, value: 'large' }],
    };

    expect(observe(observation)).toBe(true);
    expect(observe(observation)).toBe(true);
    currentTime = 50;
    expect(observe(observation)).toBe(true);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(parseEvent(debug.mock.calls[1][0] as string)).toMatchObject({
      suppressedCount: 1,
    });
  });

  it('swallows diagnostic failures', () => {
    const throwingLogger = {
      debug: () => {
        throw new Error('log failed');
      },
      isEnabled: () => true,
    };
    const observe = createToolResultBoundaryObserver({
      enabled: () => true,
      logger: throwingLogger,
      thresholdBytes: 0,
    });

    expect(() =>
      observe({
        stage: 'producer',
        values: () => {
          throw new Error('scan failed');
        },
      }),
    ).not.toThrow();
    expect(() =>
      observe({
        stage: 'producer',
        values: [{ representation: 'display', value: 'eligible' }],
      }),
    ).not.toThrow();
  });

  it('classifies artifact tri-state and kinds without paths', () => {
    expect(toolResultArtifactState(undefined)).toBe('undecided');
    expect(toolResultArtifactState([])).toBe('none');
    expect(toolResultArtifactState(['/private/result.txt'])).toBe('reusable');
    expect(
      toolResultBoundaryArtifact(
        ['/private/result.txt'],
        [
          { kind: 'image' },
          { kind: 'image' },
          {},
          { kind: '/private/secret-kind' },
        ],
      ),
    ).toEqual({
      state: 'reusable',
      kinds: ['file', 'image', 'unknown'],
    });
    expect(
      JSON.stringify(
        toolResultBoundaryArtifact(
          ['/private/result.txt'],
          [{ kind: '/private/secret-kind' }],
        ),
      ),
    ).not.toContain('/private/result.txt');
    expect(
      JSON.stringify(
        toolResultBoundaryArtifact(
          ['/private/result.txt'],
          [{ kind: '/private/secret-kind' }],
        ),
      ),
    ).not.toContain('/private/secret-kind');
    expect(
      toolResultBoundaryArtifact(
        undefined,
        new Proxy([], {
          get() {
            throw new Error('untrusted artifact metadata');
          },
        }),
      ),
    ).toEqual({ state: 'undecided', kinds: [] });
    expect(toolResultBoundaryArtifact(undefined, [{ kind: 'image' }])).toEqual({
      state: 'undecided',
      kinds: ['image'],
    });
    expect(toolResultBoundaryArtifact([], [{ kind: 'image' }])).toEqual({
      state: 'none',
      kinds: ['image'],
    });
  });

  it('extracts model text slots', () => {
    expect(
      toolResultPartDiagnosticValues([
        { text: 'top' },
        {
          functionResponse: {
            name: 'tool',
            response: { output: 'output', error: 'error' },
          },
        },
      ]),
    ).toEqual([
      { representation: 'model_text', value: 'top' },
      { representation: 'model_text', value: 'output' },
      { representation: 'model_text', value: 'error' },
    ]);
    expect(toolResultPartDiagnosticValues('plain')).toEqual([
      { representation: 'model_text', value: 'plain' },
    ]);
    expect(toolResultPartDiagnosticValues(['plain', { text: 'top' }])).toEqual([
      { representation: 'model_text', value: 'plain' },
      { representation: 'model_text', value: 'top' },
    ]);
    expect(toolResultPartDiagnosticValues(undefined)).toEqual([
      { representation: 'model_text', value: '' },
    ]);
    expect(toolResultPartDiagnosticValues(null)).toEqual([
      { representation: 'model_text', value: '' },
    ]);
  });
});
