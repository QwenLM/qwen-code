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
  type ToolResultBoundaryObserverOptions,
  type ToolResultBoundaryValue,
} from './tool-result-boundary-diagnostics.js';
import { fnResponse } from '../test-utils/model-fixtures.js';

function parseEvent(line: string): Record<string, unknown> {
  return JSON.parse(
    line.slice(`${TOOL_RESULT_BOUNDARY_EVENT_NAME} `.length),
  ) as Record<string, unknown>;
}

function eventValues(event: Record<string, unknown>) {
  return event['values'] as Array<Record<string, unknown>>;
}

/** Enabled observer with a spied debug logger; `options` override defaults. */
function setup(options: ToolResultBoundaryObserverOptions = {}) {
  const debug = vi.fn();
  const observe = createToolResultBoundaryObserver({
    enabled: () => true,
    logger: { debug, isEnabled: () => true },
    ...options,
  });
  const event = (index: number) =>
    parseEvent(debug.mock.calls[index][0] as string);
  return { debug, observe, event };
}

const display = (value: string): ToolResultBoundaryValue => ({
  representation: 'display',
  value,
});
const modelText = (value: string): ToolResultBoundaryValue => ({
  representation: 'model_text',
  value,
});

describe('tool-result boundary diagnostics', () => {
  it('records exact sizes and process-local HMACs without raw values or identifiers', () => {
    const { debug, observe } = setup({
      hmacKey: Buffer.alloc(32, 7),
      thresholdBytes: 0,
    });
    const secret = 'secret "汉😀\ud800" output';

    expect(
      observe({
        stage: 'producer',
        values: [display(secret)],
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
    const { debug, observe, event } = setup({
      hmacKey: Buffer.alloc(32, 8),
      thresholdBytes: 0,
    });

    observe({
      stage: 'producer',
      values: [display('eligible')],
      artifacts: [
        {
          state: '/private/secret-state',
          kinds: ['file', '/private/secret-kind'],
        },
      ] as unknown as Parameters<typeof observe>[0]['artifacts'],
    });

    expect(event(0)).toMatchObject({
      artifacts: [{ state: 'undecided', kinds: ['file', 'unknown'] }],
    });
    expect(debug.mock.calls[0][0] as string).not.toContain('/private/secret');

    observe({
      stage: 'producer',
      values: [display('eligible')],
      artifacts: [{ state: 'none', kinds: [] }],
    });
    expect(event(1)).toMatchObject({
      artifacts: [{ state: 'none', kinds: [] }],
    });
  });

  it('keeps unchanged HMACs equal and changes the first mutated value', () => {
    const { debug, observe, event } = setup({
      hmacKey: Buffer.alloc(32, 9),
      thresholdBytes: 0,
    });

    observe({
      stage: 'finalizer_input',
      mutated: true,
      values: [modelText('same-value')],
    });
    observe({
      stage: 'finalizer_output',
      mutated: true,
      values: [modelText('same-value')],
    });
    observe({
      stage: 'headless_projection_output',
      mutated: true,
      values: [{ representation: 'headless_content', value: 'changed-value' }],
    });

    const hashes = debug.mock.calls.map(
      (_, index) => eventValues(event(index))[0]['hmacSha256'] as string,
    );
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[1]);
    expect(event(0)['mutated']).toBe(true);
  });

  it('hashes equal values identically across representations', () => {
    const { observe, event } = setup({
      hmacKey: Buffer.alloc(32, 2),
      thresholdBytes: 0,
    });

    observe({
      stage: 'producer',
      values: [modelText('same-value'), display('same-value')],
    });

    const values = eventValues(event(0));
    expect(values[0]['hmacSha256']).toBe(values[1]['hmacSha256']);
  });

  it('hashes legacy and canonical tool names identically', () => {
    const { observe, event } = setup({
      hmacKey: Buffer.alloc(32, 4),
      thresholdBytes: 0,
    });

    for (const toolName of ['task', 'agent']) {
      observe({ stage: 'producer', toolName, values: [display('eligible')] });
    }

    expect(event(0)['toolNameHmacSha256']).toBe(event(1)['toolNameHmacSha256']);
  });

  it('hashes distinct lone-surrogate code units differently', () => {
    const { observe, event } = setup({
      hmacKey: Buffer.alloc(32, 3),
      thresholdBytes: 0,
    });

    observe({
      stage: 'producer',
      values: [display('\ud800'), display('\udc00')],
    });

    const values = eventValues(event(0));
    expect(values[0]['hmacSha256']).not.toBe(values[1]['hmacSha256']);
    expect(values.map((value) => value['slot'])).toEqual([0, 1]);
  });

  it('reuses its lazily generated HMAC key across events', () => {
    const { observe, event } = setup({ thresholdBytes: 0 });
    const observation = {
      stage: 'producer' as const,
      sessionId: 'same-session',
      values: [display('eligible')],
    };

    observe(observation);
    observe(observation);

    expect(event(0)['sessionHmacSha256']).toBe(event(1)['sessionHmacSha256']);
  });

  it('executes enabled value and mutation thunks', () => {
    const values = vi.fn(() => [display('small')]);
    const mutated = vi.fn(() => true);
    const { observe, event } = setup({ hmacKey: Buffer.alloc(32, 6) });

    expect(observe({ stage: 'producer', mutated, values })).toBe(true);
    expect(values).toHaveBeenCalledOnce();
    expect(mutated).toHaveBeenCalledOnce();
    expect(event(0)['mutated']).toBe(true);
  });

  it('matches native JSON byte accounting under fixed-seed fuzzing', () => {
    const { observe, event } = setup({
      hmacKey: Buffer.alloc(32, 1),
      logLimit: 500,
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
      '߿',
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
      observe({ stage: 'producer', values: [modelText(value)] });
      expect(eventValues(event(sampleIndex))[0]['jsonUtf8Bytes']).toBe(
        Buffer.byteLength(JSON.stringify(value), 'utf8'),
      );
    }
  });

  it('is lazy and silent while disabled or below the threshold', () => {
    const disabledValues = vi.fn(() => [display('secret')]);
    const disabledMutation = vi.fn(() => true);
    const disabled = setup({ enabled: () => false });
    expect(
      disabled.observe({
        stage: 'producer',
        mutated: disabledMutation,
        values: disabledValues,
      }),
    ).toBe(false);
    expect(disabledValues).not.toHaveBeenCalled();
    expect(disabledMutation).not.toHaveBeenCalled();
    expect(disabled.debug).not.toHaveBeenCalled();

    const below = setup({ thresholdBytes: 100 });
    expect(
      below.observe({ stage: 'producer', values: [display('small')] }),
    ).toBe(false);
    expect(below.debug).not.toHaveBeenCalled();
  });

  it('emits only above the 65,536-byte JSON-string threshold', () => {
    const { debug, observe, event } = setup({ hmacKey: Buffer.alloc(32, 4) });

    for (const [valueLength, expected] of [
      [65_533, false],
      [65_534, false],
      [65_535, true],
    ] as const) {
      expect(
        observe({
          stage: 'producer',
          values: [display('a'.repeat(valueLength))],
        }),
      ).toBe(expected);
    }
    expect(debug).toHaveBeenCalledTimes(1);
    expect(eventValues(event(0))[0]).toMatchObject({ jsonUtf8Bytes: 65_537 });
  });

  it('emits when any value exceeds the threshold', () => {
    const { debug, observe } = setup({ hmacKey: Buffer.alloc(32, 4) });

    expect(
      observe({
        stage: 'producer',
        values: [display('a'.repeat(65_535)), display('small')],
      }),
    ).toBe(true);
    expect(debug).toHaveBeenCalledOnce();
  });

  /** One-event-per-100ms limiter whose clock the test moves with `setTime`. */
  function rateLimited(startTime: number) {
    let currentTime = startTime;
    const { debug, observe, event } = setup({
      hmacKey: Buffer.alloc(32, 5),
      logLimit: 1,
      now: () => currentTime,
      thresholdBytes: 0,
      windowMs: 100,
    });
    const emit = () =>
      observe({ stage: 'producer', values: [display('large')] });
    const setTime = (time: number) => {
      currentTime = time;
    };
    return { debug, event, emit, setTime };
  }

  it('rate-limits eligible events and reports the suppressed count', () => {
    const { debug, event, emit, setTime } = rateLimited(0);

    expect(emit()).toBe(true);
    expect(emit()).toBe(true);
    expect(emit()).toBe(true);
    expect(debug).toHaveBeenCalledTimes(1);
    setTime(100);
    expect(emit()).toBe(true);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(event(1)).toMatchObject({ suppressedCount: 2 });
    setTime(200);
    expect(emit()).toBe(true);
    expect(event(2)).not.toHaveProperty('suppressedCount');
  });

  it('skips value measurement for rate-limited mutated events', () => {
    const values = vi.fn(() => [display('secret')]);
    const { observe } = setup({ logLimit: 0 });

    expect(observe({ stage: 'producer', mutated: true, values })).toBe(true);
    expect(values).not.toHaveBeenCalled();
  });

  it('starts a new rate-limit window when the clock moves backward', () => {
    const { debug, event, emit, setTime } = rateLimited(100);

    expect(emit()).toBe(true);
    expect(emit()).toBe(true);
    setTime(50);
    expect(emit()).toBe(true);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(event(1)).toMatchObject({ suppressedCount: 1 });
  });

  it('swallows diagnostic failures', () => {
    const { observe } = setup({
      logger: {
        debug: () => {
          throw new Error('log failed');
        },
        isEnabled: () => true,
      },
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
      observe({ stage: 'producer', values: [display('eligible')] }),
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
    const serialized = JSON.stringify(
      toolResultBoundaryArtifact(
        ['/private/result.txt'],
        [{ kind: '/private/secret-kind' }],
      ),
    );
    expect(serialized).not.toContain('/private/result.txt');
    expect(serialized).not.toContain('/private/secret-kind');
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
        fnResponse('tool', { output: 'output', error: 'error' }),
      ]),
    ).toEqual([modelText('top'), modelText('output'), modelText('error')]);
    expect(toolResultPartDiagnosticValues('plain')).toEqual([
      modelText('plain'),
    ]);
    expect(toolResultPartDiagnosticValues(['plain', { text: 'top' }])).toEqual([
      modelText('plain'),
      modelText('top'),
    ]);
    expect(toolResultPartDiagnosticValues(undefined)).toEqual([modelText('')]);
    expect(toolResultPartDiagnosticValues(null)).toEqual([modelText('')]);
  });
});
