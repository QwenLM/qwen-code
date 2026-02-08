/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getNestedValue,
  setNestedValue,
  deleteNestedProperty,
  moveField,
  renameField,
  invertBoolean,
  consolidateFields,
  preserveUnknownFields,
  deepClone,
} from '../utils.js';

describe('getNestedValue', () => {
  it('should get value at simple path', () => {
    const obj = { a: 1 };
    expect(getNestedValue(obj, 'a')).toBe(1);
  });

  it('should get value at nested path', () => {
    const obj = { a: { b: { c: 2 } } };
    expect(getNestedValue(obj, 'a.b.c')).toBe(2);
  });

  it('should return undefined for non-existent path', () => {
    const obj = { a: { b: 1 } };
    expect(getNestedValue(obj, 'a.c')).toBeUndefined();
    expect(getNestedValue(obj, 'x.y.z')).toBeUndefined();
  });

  it('should return undefined for non-object input', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
    expect(getNestedValue('string', 'a')).toBeUndefined();
  });
});

describe('setNestedValue', () => {
  it('should set value at simple path', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a', 1);
    expect(obj['a']).toBe(1);
  });

  it('should create nested objects as needed', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b.c', 1);
    expect(obj).toEqual({ a: { b: { c: 1 } } });
  });

  it('should set value in existing nested object', () => {
    const obj: Record<string, unknown> = { a: { b: {} } };
    setNestedValue(obj, 'a.b.c', 1);
    expect((obj['a'] as Record<string, unknown>)['b']).toEqual({ c: 1 });
  });

  it('should overwrite existing value', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    setNestedValue(obj, 'a.b', 2);
    expect((obj['a'] as Record<string, unknown>)['b']).toBe(2);
  });

  it('should handle empty path gracefully', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, '', 'value');
    expect(obj).toEqual({});
  });

  it('should not overwrite if path is blocked by non-object', () => {
    const obj: Record<string, unknown> = { a: 'string' };
    setNestedValue(obj, 'a.b', 1);
    expect(obj['a']).toBe('string');
  });
});

describe('deleteNestedProperty', () => {
  it('should delete property at simple path', () => {
    const obj: Record<string, unknown> = { a: 1 };
    deleteNestedProperty(obj, 'a');
    expect(obj['a']).toBeUndefined();
  });

  it('should delete property at nested path', () => {
    const obj: Record<string, unknown> = { a: { b: { c: 1 } } };
    deleteNestedProperty(obj, 'a.b.c');
    expect((obj['a'] as Record<string, unknown>)['b']).toEqual({});
  });

  it('should handle non-existent path gracefully', () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    deleteNestedProperty(obj, 'a.c');
    expect(obj).toEqual({ a: { b: 1 } });
  });

  it('should handle blocked path gracefully', () => {
    const obj: Record<string, unknown> = { a: 'string' };
    deleteNestedProperty(obj, 'a.b');
    expect(obj['a']).toBe('string');
  });
});

describe('moveField', () => {
  it('should move field from one path to another', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const change = moveField(obj, 'a', 'b.c');
    expect(obj['a']).toBeUndefined();
    expect((obj['b'] as Record<string, unknown>)['c']).toBe(1);
    expect(change).toEqual({
      type: 'move',
      path: 'b.c',
      oldValue: 1,
      newValue: 1,
      reason: 'Moved from a to b.c',
    });
  });

  it('should return null if source does not exist', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const change = moveField(obj, 'x', 'y');
    expect(change).toBeNull();
    expect(obj).toEqual({ a: 1 });
  });
});

describe('renameField', () => {
  it('should rename field without transform', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const change = renameField(obj, 'a', 'b');
    expect(obj['a']).toBeUndefined();
    expect(obj['b']).toBe(1);
    expect(change?.type).toBe('rename');
  });

  it('should rename field with transform', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const change = renameField(obj, 'a', 'b', (v) => (v as number) * 2);
    expect(obj['b']).toBe(2);
    expect(change?.type).toBe('transform');
  });

  it('should return null if source does not exist', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const change = renameField(obj, 'x', 'y');
    expect(change).toBeNull();
  });
});

describe('invertBoolean', () => {
  it('should invert true to false', () => {
    expect(invertBoolean(true)).toBe(false);
  });

  it('should invert false to true', () => {
    expect(invertBoolean(false)).toBe(true);
  });

  it('should return non-boolean values unchanged', () => {
    expect(invertBoolean('string')).toBe('string');
    expect(invertBoolean(123)).toBe(123);
    expect(invertBoolean(null)).toBe(null);
    expect(invertBoolean(undefined)).toBe(undefined);
  });
});

describe('consolidateFields', () => {
  it('should consolidate multiple fields with OR logic', () => {
    const obj: Record<string, unknown> = { a: false, b: true };
    const change = consolidateFields(
      obj,
      ['a', 'b'],
      'c',
      (values) => !values.some((v) => v === true),
    );
    expect(obj['c']).toBe(false); // any true -> false
    expect(change?.type).toBe('transform');
  });

  it('should consolidate with single field', () => {
    const obj: Record<string, unknown> = { a: true };
    consolidateFields(
      obj,
      ['a'],
      'b',
      (values) => !values.some((v) => v === true),
    );
    expect(obj['b']).toBe(false);
  });

  it('should delete source fields after consolidation', () => {
    const obj: Record<string, unknown> = { a: true, b: false };
    consolidateFields(
      obj,
      ['a', 'b'],
      'c',
      (values) => !values.some((v) => v === true),
    );
    expect(obj['a']).toBeUndefined();
    expect(obj['b']).toBeUndefined();
  });

  it('should return null if no source fields exist', () => {
    const obj: Record<string, unknown> = { a: 1 };
    const change = consolidateFields(obj, ['x', 'y'], 'z', (values) => values);
    expect(change).toBeNull();
  });

  it('should handle partial source fields', () => {
    const obj: Record<string, unknown> = { a: true, c: 'other' };
    consolidateFields(obj, ['a', 'b'], 'd', (values) => values);
    expect(obj['a']).toBeUndefined();
    expect(obj['b']).toBeUndefined();
    expect(obj['c']).toBe('other');
  });
});

describe('preserveUnknownFields', () => {
  it('should preserve unknown fields', () => {
    const source: Record<string, unknown> = { a: 1, b: 2 };
    const target: Record<string, unknown> = {};
    const warnings = preserveUnknownFields(source, target, new Set(['a']));
    expect(target['b']).toBe(2);
    expect(warnings).toContain('Unknown field preserved: b');
  });

  it('should not preserve known fields', () => {
    const source: Record<string, unknown> = { a: 1, b: 2 };
    const target: Record<string, unknown> = {};
    preserveUnknownFields(source, target, new Set(['a', 'b']));
    expect(Object.keys(target)).toHaveLength(0);
  });

  it('should preserve all fields when known set is empty', () => {
    const source: Record<string, unknown> = { a: 1, b: 2 };
    const target: Record<string, unknown> = {};
    const warnings = preserveUnknownFields(source, target, new Set());
    expect(target).toEqual({ a: 1, b: 2 });
    expect(warnings).toHaveLength(2);
  });
});

describe('deepClone', () => {
  it('should clone simple object', () => {
    const obj = { a: 1, b: 'string' };
    const clone = deepClone(obj);
    expect(clone).toEqual(obj);
    expect(clone).not.toBe(obj);
  });

  it('should clone nested object', () => {
    const obj = { a: { b: { c: 1 } } };
    const clone = deepClone(obj);
    expect(clone).toEqual(obj);
    expect(clone['a']).not.toBe(obj['a']);
    expect((clone['a'] as Record<string, unknown>)['b']).not.toBe(
      (obj['a'] as Record<string, unknown>)['b'],
    );
  });

  it('should clone arrays', () => {
    const obj = { a: [1, 2, 3] };
    const clone = deepClone(obj);
    expect(clone['a']).toEqual([1, 2, 3]);
    expect(clone['a']).not.toBe(obj['a']);
  });

  it('should handle null', () => {
    expect(deepClone(null)).toBeNull();
  });
});
