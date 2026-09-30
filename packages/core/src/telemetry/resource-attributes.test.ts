/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag } from '@opentelemetry/api';
import type { ResourceAttributeWarnings } from './resource-attributes.js';
import {
  RESERVED_RESOURCE_ATTRIBUTE_KEYS,
  coerceStringResourceAttributes,
  parseOtelResourceAttributes,
  stripReservedResourceAttributes,
} from './resource-attributes.js';

describe('parseOtelResourceAttributes', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each<[string | undefined, Record<string, string>]>([
    [undefined, {}],
    ['', {}],
    ['a=1', { a: '1' }],
    ['a=1,b=2', { a: '1', b: '2' }],
    ['team=platform,env=prod', { team: 'platform', env: 'prod' }],
    ['a=hello%20world', { a: 'hello world' }],
    ['a=val%25with%2Cspecial', { a: 'val%with,special' }],
    ['a=,b=2', { a: '', b: '2' }],
    ['a=1,a=2', { a: '2' }],
    [' a = 1 , b = 2 ', { a: '1', b: '2' }],
    ['a=1,,b=2', { a: '1', b: '2' }],
    // First-`=` split contract: values may legitimately contain `=` (base64
    // padding, JWTs, connection strings). Regression-guard against a future
    // refactor that switches indexOf('=') to split('=').
    ['a=val=ue', { a: 'val=ue' }],
    ['k=base64==,x=1', { k: 'base64==', x: '1' }],
    // Key percent-decoding: prevents `service%2Eversion=99` from sneaking
    // past the reserved-key filter as the literal key `service%2Eversion`.
    ['service%2Eversion=99', { 'service.version': '99' }],
    ['my%20key=val', { 'my key': 'val' }],
    // Invalid percent-encoding in key falls back to raw key with a warn
    // (mirrors the invalid-value behavior on `a=val%ZZbad`).
    ['key%ZZ=val', { 'key%ZZ': 'val' }],
  ])('parses %j → %j', (input, expected) => {
    expect(parseOtelResourceAttributes(input)).toEqual(expected);
  });

  it('warns on a malformed pair missing =', () => {
    expect(parseOtelResourceAttributes('a=1,bogus,c=3')).toEqual({
      a: '1',
      c: '3',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('bogus');
  });

  it('skips pairs with empty key without warning', () => {
    expect(parseOtelResourceAttributes('=value,a=1')).toEqual({ a: '1' });
    // Empty-key paths skip silently — not a malformed-pair warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps raw value and warns on invalid percent-encoding', () => {
    expect(parseOtelResourceAttributes('a=val%ZZbad')).toEqual({
      a: 'val%ZZbad',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('a');
  });
});

describe('stripReservedResourceAttributes', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('drops reserved keys and warns for env source', () => {
    const attrs = { team: 'x', 'service.version': '99.0' };
    const out = stripReservedResourceAttributes(
      attrs,
      'OTEL_RESOURCE_ATTRIBUTES',
    );
    expect(out).toEqual({ team: 'x' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('service.version');
    expect(warnSpy.mock.calls[0][0]).toContain('OTEL_RESOURCE_ATTRIBUTES');
  });

  it('drops reserved keys and warns for settings source', () => {
    const attrs = { 'service.version': 'x' };
    const out = stripReservedResourceAttributes(
      attrs,
      'settings.telemetry.resourceAttributes',
    );
    expect(out).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      'settings.telemetry.resourceAttributes',
    );
  });

  it('does not warn for service.name (not in reserved set)', () => {
    const attrs = { 'service.name': 'foo' };
    const out = stripReservedResourceAttributes(
      attrs,
      'OTEL_RESOURCE_ATTRIBUTES',
    );
    expect(out).toEqual({ 'service.name': 'foo' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('mutates the input object', () => {
    const attrs: Record<string, string> = { 'service.version': 'x', a: '1' };
    const out = stripReservedResourceAttributes(
      attrs,
      'OTEL_RESOURCE_ATTRIBUTES',
    );
    expect(out).toBe(attrs);
    expect(attrs).toEqual({ a: '1' });
  });
});

describe('RESERVED_RESOURCE_ATTRIBUTE_KEYS', () => {
  it('contains service.version and session.id but not service.name', () => {
    expect(RESERVED_RESOURCE_ATTRIBUTE_KEYS.has('service.version')).toBe(true);
    expect(RESERVED_RESOURCE_ATTRIBUTE_KEYS.has('session.id')).toBe(true);
    expect(RESERVED_RESOURCE_ATTRIBUTE_KEYS.has('service.name')).toBe(false);
  });
});

describe('stripReservedResourceAttributes — session.id', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('drops user-provided session.id from env with warning', () => {
    const attrs = { 'session.id': 'spoofed', team: 'x' };
    const out = stripReservedResourceAttributes(
      attrs,
      'OTEL_RESOURCE_ATTRIBUTES',
    );
    expect(out).toEqual({ team: 'x' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('session.id');
  });

  it('drops user-provided session.id from settings with warning', () => {
    const attrs = { 'session.id': 'spoofed' };
    const out = stripReservedResourceAttributes(
      attrs,
      'settings.telemetry.resourceAttributes',
    );
    expect(out).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('coerceStringResourceAttributes', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns empty object for undefined / null', () => {
    expect(coerceStringResourceAttributes(undefined)).toEqual({});
    expect(coerceStringResourceAttributes(null)).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through string-valued records unchanged', () => {
    const input = { team: 'platform', env: 'prod' };
    expect(coerceStringResourceAttributes(input)).toEqual(input);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops non-string values with warning, keeps strings', () => {
    const input = { team: 'platform', count: 42, flag: true, list: ['a'] };
    expect(coerceStringResourceAttributes(input)).toEqual({
      team: 'platform',
    });
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('warns and returns {} for non-object input', () => {
    expect(coerceStringResourceAttributes('not an object')).toEqual({});
    expect(coerceStringResourceAttributes(['a', 'b'])).toEqual({});
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('trims keys and skips empty/whitespace-only keys', () => {
    const input = { ' team ': 'platform', '': 'x', '  ': 'y', env: 'prod' };
    expect(coerceStringResourceAttributes(input)).toEqual({
      team: 'platform',
      env: 'prod',
    });
    // 2 warnings for the two empty/whitespace keys.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('warnings accumulator', () => {
  beforeEach(() => {
    vi.spyOn(diag, 'warn').mockImplementation(() => {});
  });

  it('parseOtelResourceAttributes pushes diagnostic strings into the accumulator', () => {
    const warnings: ResourceAttributeWarnings = [];
    parseOtelResourceAttributes('a=1,bogus,c=val%ZZ', warnings);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.includes('bogus'))).toBe(true);
    expect(warnings.some((w) => w.includes('Invalid percent-encoding'))).toBe(
      true,
    );
  });

  it('stripReservedResourceAttributes pushes diagnostic for each reserved drop', () => {
    const warnings: ResourceAttributeWarnings = [];
    stripReservedResourceAttributes(
      { 'service.version': 'x', 'session.id': 'y', team: 'z' },
      'OTEL_RESOURCE_ATTRIBUTES',
      warnings,
    );
    expect(warnings).toHaveLength(2);
  });

  it('coerceStringResourceAttributes pushes diagnostic for empty key + non-string value', () => {
    const warnings: ResourceAttributeWarnings = [];
    coerceStringResourceAttributes(
      { '': 'empty', team: 'ok', count: 42 },
      warnings,
    );
    expect(warnings).toHaveLength(2);
  });

  it('accumulator is opt-in (helpers work without one)', () => {
    expect(() => parseOtelResourceAttributes('a=1,bogus')).not.toThrow();
    expect(() =>
      stripReservedResourceAttributes(
        { 'service.version': 'x' },
        'OTEL_RESOURCE_ATTRIBUTES',
      ),
    ).not.toThrow();
    expect(() =>
      coerceStringResourceAttributes({ team: 'ok', count: 1 }),
    ).not.toThrow();
  });
});
