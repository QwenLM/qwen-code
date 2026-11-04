/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  stringifyWorkflowResult,
  truncateWorkflowText,
} from './workflow-result-format.js';

describe('workflow result formatting', () => {
  it('retains the message of an Error created in a different VM realm', () => {
    const failure: unknown = runInContext(
      'new Error("disk full")',
      createContext({}),
    );
    expect(failure).not.toBeInstanceOf(Error);
    expect(Object.prototype.toString.call(failure)).toBe('[object Error]');
    expect(stringifyWorkflowResult(failure)).toBe('Error: disk full');
  });

  it('retains nested VM Error messages in compact and pretty results', () => {
    const failure: unknown = runInContext(
      'new Error("disk full")',
      createContext({}),
    );
    for (const pretty of [false, true]) {
      expect(
        JSON.parse(stringifyWorkflowResult({ errors: [failure] }, pretty)),
      ).toEqual({ errors: ['Error: disk full'] });
    }
  });

  it('renders a messageless Error without its runtime stack', () => {
    expect(stringifyWorkflowResult(new Error())).toBe('Error: ');
  });

  it('retains cross-VM aggregate and cause reasons in every result shape', () => {
    const failure: unknown = runInContext(
      `new AggregateError([
        new Error('sync failed', { cause: new TypeError('invalid locale') }),
        new Error('disk full'),
      ], 'All promises were rejected')`,
      createContext({}),
    );
    for (const pretty of [false, true]) {
      for (const result of [failure, { errors: [failure] }]) {
        const text = stringifyWorkflowResult(result, pretty);
        expect(text).toContain('AggregateError: All promises were rejected');
        expect(text).toContain('Error: sync failed');
        expect(text).toContain('TypeError: invalid locale');
        expect(text).toContain('Error: disk full');
        expect(text).not.toContain(' at ');
      }
    }
  });

  it('bounds cycles, deep causes, and wide aggregate errors', () => {
    const cyclic = new Error('cycle');
    cyclic.cause = cyclic;
    expect(stringifyWorkflowResult(cyclic)).toContain('[Circular error]');
    let deep = new Error('unreachable tail');
    for (let i = 0; i < 20; i++)
      deep = new Error(`level ${i}`, { cause: deep });
    const deepText = stringifyWorkflowResult(deep);
    expect(deepText).toContain('level 19');
    expect(deepText).toContain('level 15');
    expect(deepText).not.toContain('level 14');
    expect(deepText).toContain('truncated');
    expect(deepText).not.toContain('unreachable tail');
    const wide = new AggregateError(
      Array.from({ length: 100 }, (_, i) => new Error(`reason ${i}`)),
      'batch failed',
    );
    expect(stringifyWorkflowResult(wide)).toContain('reason 0');
    expect(stringifyWorkflowResult(wide)).toContain('reason 7');
    expect(stringifyWorkflowResult(wide)).not.toContain('reason 8');
    expect(stringifyWorkflowResult(wide)).toContain('truncated');
    expect(stringifyWorkflowResult(wide)).not.toContain('reason 99');
  });

  it('limits traversal to 32 values independently of depth and member bounds', () => {
    const error = new AggregateError(
      Array.from(
        { length: 8 },
        (_, group) =>
          new AggregateError(
            Array.from(
              { length: 8 },
              (_, member) => new Error(`reason-${group}-${member}`),
            ),
            `group-${group}`,
          ),
      ),
      'root',
    );
    const text = stringifyWorkflowResult(error);
    expect(text).toContain('Error: reason-3-2');
    expect(text).not.toContain('reason-3-3');
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(4_096);
  });

  it.each([
    ['null-prototype record', () => Object.create(null)],
    [
      'throwing toString',
      () => ({
        toString() {
          throw new Error('cannot convert');
        },
      }),
    ],
    [
      'throwing Symbol.toPrimitive',
      () => ({
        [Symbol.toPrimitive]() {
          throw new Error('cannot convert');
        },
      }),
    ],
    [
      'revoked proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
    ...['name', 'message'].map(
      (field) =>
        [
          `throwing ${field} getter`,
          () =>
            Object.defineProperty(new Error('unreadable'), field, {
              get() {
                throw new Error('cannot read');
              },
            }),
        ] as const,
    ),
  ] as const)(
    'preserves the surrounding result when a nested reason is a %s',
    (_label, makeReason) => {
      const reason = makeReason();
      const aggregate = new AggregateError(
        [new Error('before'), reason, new Error('after')],
        'batch failed',
      );
      const cause = new Error('sync failed', { cause: reason });
      for (const pretty of [false, true]) {
        for (const error of [aggregate, cause]) {
          const text = stringifyWorkflowResult(error, pretty);
          expect(text).toContain(error.message);
          expect(text).toContain('[unrenderable object]');
          expect(text).not.toContain('non-JSON-serializable');
          const result = JSON.parse(
            stringifyWorkflowResult(
              { marker: 'DONE', failed: ['fr'], error },
              pretty,
            ),
          );
          expect(result).toEqual({
            marker: 'DONE',
            failed: ['fr'],
            error: text,
          });
        }
        const text = stringifyWorkflowResult(aggregate, pretty);
        expect(text).toContain('Error: before');
        expect(text).toContain('Error: after');
      }
    },
  );

  it('isolates throwing aggregate member reads and retains later reasons', () => {
    const aggregate = new AggregateError(
      [new Error('before'), new Error('unreadable'), new Error('after')],
      'batch failed',
      { cause: new Error('root cause') },
    );
    Object.defineProperty(aggregate.errors, '1', {
      get() {
        throw new Error('cannot read member');
      },
    });
    const expected =
      'AggregateError: batch failed [errors: Error: before; [unrenderable object]; Error: after] [cause: Error: root cause]';
    for (const pretty of [false, true]) {
      expect(stringifyWorkflowResult(aggregate, pretty)).toBe(expected);
      expect(
        JSON.parse(
          stringifyWorkflowResult(
            { marker: 'DONE', failed: ['fr'], error: aggregate },
            pretty,
          ),
        ),
      ).toEqual({ marker: 'DONE', failed: ['fr'], error: expected });
    }
  });

  it.each(['throwing length', 'throwing length coercion', 'revoked array'])(
    'retains the cause and surrounding result with a %s errors container',
    (failure) => {
      const aggregate = new AggregateError([], 'batch failed', {
        cause: new Error('root cause'),
      });
      if (failure !== 'revoked array') {
        aggregate.errors = new Proxy([new Error('unreadable')], {
          get(target, key, receiver) {
            if (key === 'length') {
              if (failure === 'throwing length') {
                throw new Error('cannot read length');
              }
              return {
                [Symbol.toPrimitive]() {
                  throw new Error('cannot convert length');
                },
              };
            }
            return Reflect.get(target, key, receiver);
          },
        });
      } else {
        const { proxy, revoke } = Proxy.revocable([], {});
        aggregate.errors = proxy;
        revoke();
      }
      const expected =
        'AggregateError: batch failed [errors: [unrenderable object]] [cause: Error: root cause]';
      for (const pretty of [false, true]) {
        expect(stringifyWorkflowResult(aggregate, pretty)).toBe(expected);
        expect(
          JSON.parse(
            stringifyWorkflowResult(
              { marker: 'DONE', failed: ['fr'], error: aggregate },
              pretty,
            ),
          ),
        ).toEqual({ marker: 'DONE', failed: ['fr'], error: expected });
      }
    },
  );

  it('caps rendered errors without splitting Unicode and skips cause getters', () => {
    const error = new Error('🙂'.repeat(5_000));
    const text = stringifyWorkflowResult(error);
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).toContain('truncated');
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const withGetter = new Error('outer');
    const getter = vi.fn(() => {
      throw new Error('must not run');
    });
    Object.defineProperty(withGetter, 'cause', { get: getter });
    Object.defineProperty(withGetter, 'errors', { get: getter });
    expect(stringifyWorkflowResult(withGetter)).toBe('Error: outer');
    expect(getter).not.toHaveBeenCalled();
  });

  it('retains repeated reasons that are not cycles and primitive causes', () => {
    const shared = new Error('shared');
    const text = stringifyWorkflowResult(new AggregateError([shared, shared]));
    expect(text.match(/Error: shared/g)).toHaveLength(2);
    expect(text).not.toContain('Circular');
    expect(
      stringifyWorkflowResult(new Error('failed', { cause: 'offline' })),
    ).toContain('cause: offline');
  });

  it('preserves Map keys, Set values, and nested VM Errors', () => {
    const result: unknown = runInContext(
      `({ failed: new Map([[1, new Error('numeric key')], ['1', new Set(['string key'])]]) })`,
      createContext({}),
    );
    expect(JSON.parse(stringifyWorkflowResult(result))).toEqual({
      failed: [
        [1, 'Error: numeric key'],
        ['1', ['string key']],
      ],
    });
  });

  it('keeps the fallback for a circular result containing an Error', () => {
    const result: { error: Error; self?: unknown } = {
      error: new Error('disk full'),
    };
    result.self = result;
    expect(stringifyWorkflowResult(result)).toBe(
      '(workflow returned a non-JSON-serializable value of type object)',
    );
  });

  it('renders an Error without a stack using its name and message', () => {
    const error = new TypeError('invalid input');
    error.stack = undefined;
    expect(stringifyWorkflowResult(error)).toBe('TypeError: invalid input');
  });

  it('shares result semantics between compact notifications and pretty tool results', () => {
    for (const pretty of [false, true]) {
      expect(stringifyWorkflowResult(undefined, pretty)).toBe(
        '(workflow returned no value)',
      );
      expect(stringifyWorkflowResult('plain', pretty)).toBe('plain');
      expect(stringifyWorkflowResult(null, pretty)).toBe('null');
      expect(stringifyWorkflowResult(1n, pretty)).toContain(
        'non-JSON-serializable',
      );
    }
    expect(stringifyWorkflowResult({ ok: true })).toBe('{"ok":true}');
    expect(stringifyWorkflowResult({ ok: true }, true)).toBe(
      '{\n  "ok": true\n}',
    );
  });

  it('includes the marker in the cap and never splits a Unicode pair', () => {
    const text =
      'x'.repeat(399 - '… (truncated)'.length) + '🙂' + 'tail'.repeat(20);
    const preview = truncateWorkflowText(text, 400);
    expect(preview).toHaveLength(399);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(preview).toMatch(/… \(truncated\)$/);
    expect(truncateWorkflowText('hello', 400)).toBe('hello');
  });
});
