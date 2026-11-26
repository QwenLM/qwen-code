/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { snapshotCallArgs } from './call-args.js';
import { SCRIPT_LIMITS } from './types.js';

describe('snapshotCallArgs', () => {
  it('preserves small JSON arguments and detaches nested values', () => {
    const input = {
      file_path: '/repo/a.ts',
      offset: 2,
      limit: 10,
      options: { enabled: false, values: [null, 0, 'text'] },
    };
    const snapshot = snapshotCallArgs(input);
    expect(snapshot).toEqual({ args: input });
    input.options.values.push('later');
    expect(snapshot.args['options']).toEqual({
      enabled: false,
      values: [null, 0, 'text'],
    });
  });

  it('bounds large content while retaining later file parameters', () => {
    const content = 'x'.repeat(100_000);
    const input = { content, file_path: '/repo/a.ts' };
    const snapshot = snapshotCallArgs(input);
    expect(snapshot.argsTruncated).toBe(true);
    expect(snapshot.args['file_path']).toBe('/repo/a.ts');
    expect(snapshot.args['content']).not.toBe(content);
    expect(
      Buffer.byteLength(JSON.stringify(snapshot.args)),
    ).toBeLessThanOrEqual(SCRIPT_LIMITS.summaryArgumentBytes);
    expect(input.content).toBe(content);
  });

  it.each(['😀', '\u0000', '"\\', '汉字', 'e\u0301'])(
    'bounds serialized bytes including JSON escapes and preserves Unicode (%s)',
    (text) => {
      const snapshot = snapshotCallArgs({
        items: Array.from({ length: 40 }, () => ({ text: text.repeat(2_000) })),
      });
      const serialized = JSON.stringify(snapshot.args);
      expect(snapshot.argsTruncated).toBe(true);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(
        SCRIPT_LIMITS.summaryArgumentBytes,
      );
      expect(JSON.parse(serialized)).toEqual(snapshot.args);
      expect(serialized).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
    },
  );

  it('limits collection lengths and recursive objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const snapshot = snapshotCallArgs({
      items: Array.from({ length: 100 }, (_, i) => i),
      nested: cyclic,
    });
    expect(snapshot.argsTruncated).toBe(true);
    const items = snapshot.args['items'] as number[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(100);
    expect(items).toEqual(Array.from({ length: items.length }, (_, i) => i));
    expect(
      Buffer.byteLength(JSON.stringify(snapshot.args)),
    ).toBeLessThanOrEqual(SCRIPT_LIMITS.summaryArgumentBytes);
  });

  it('preserves literal object keys and omits keys that exceed the byte budget', () => {
    const input = JSON.parse(
      '{"__proto__":{"value":"kept"},"constructor":"plain"}',
    );
    input['x'.repeat(10_000)] = 'too long';
    input['file_path'] = '/repo/a.ts';
    const snapshot = snapshotCallArgs(input);
    expect(Object.hasOwn(snapshot.args, '__proto__')).toBe(true);
    expect(snapshot.args['__proto__']).toEqual({ value: 'kept' });
    expect(snapshot.args['constructor']).toBe('plain');
    expect(snapshot.args['file_path']).toBe('/repo/a.ts');
    expect(Object.keys(snapshot.args)).toHaveLength(3);
    expect(snapshot.argsTruncated).toBe(true);
  });
});
