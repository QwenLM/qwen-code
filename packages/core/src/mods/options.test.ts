/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveModOptions, resolveModToolDialect } from './options.js';

const field = (type: string, extra = {}) => ({
  type,
  title: 'Option',
  description: 'Description',
  ...extra,
});
const resolve = (schema: unknown, options: unknown = {}) =>
  resolveModOptions(schema, [{ example: { options } }], 'example');

describe('Mod tool dialect settings', () => {
  it('defaults to native independently of userConfig and does not consume an option named toolDialect', () => {
    expect(resolveModToolDialect([], 'example')).toBe('native');
    expect(
      resolveModToolDialect(
        [{ example: { options: { toolDialect: 'claude' } } }],
        'example',
      ),
    ).toBe('native');
    expect(
      resolveModToolDialect(
        [{ example: { toolDialect: 'claude' } }],
        'example',
      ),
    ).toBe('claude');
  });

  it('uses the same inline aliases, marketplace identity and operator precedence as options', () => {
    const scopes = [
      { example: { toolDialect: 'native' } },
      {
        example: { toolDialect: 'native' },
        'example@inline': { toolDialect: 'claude' },
      },
      {
        example: { toolDialect: 'native' },
        'example@market': { toolDialect: 'claude' },
      },
    ];
    expect(resolveModToolDialect(scopes.slice(0, 2), 'example')).toBe('claude');
    expect(resolveModToolDialect(scopes, 'example')).toBe('native');
    expect(resolveModToolDialect(scopes, 'example', 'market')).toBe('claude');
    expect(resolveModToolDialect(scopes, 'example', 'other')).toBe('native');
  });

  it.each([null, '', 'Claude', true, [], { native: true }])(
    'rejects unsupported dialect %j without echoing it',
    (toolDialect) => {
      expect(() =>
        resolveModToolDialect([{ example: { toolDialect } }], 'example'),
      ).toThrow('Invalid Mod toolDialect: expected native or claude.');
    },
  );

  it.each([null, [], { example: null }, { example: 'claude' }])(
    'rejects malformed plugin settings %j even without declared options',
    (scope) => {
      expect(() => resolveModToolDialect([scope], 'example')).toThrow(
        /Invalid Mod pluginConfigs/,
      );
    },
  );
});

describe('Mod userConfig', () => {
  it('matches default, empty, enum fallback and unknown-key behavior', () => {
    const schema = {
      text: field('string', { default: 'default' }),
      count: field('number'),
      flag: field('boolean'),
      choice: field('string', { options: ['red', 'blue'], default: 'red' }),
    };
    expect(
      resolve(schema, { text: '', choice: 'invalid', extra: ['one'] }),
    ).toEqual({ text: '', count: '', flag: '', choice: 'red', extra: ['one'] });
    expect(resolve({}, { extra: 'ignored' })).toEqual({});
    expect(resolve(undefined, { extra: 'ignored' })).toEqual({});
  });

  it('validates all types and treats false, zero and multiple strings as present', () => {
    const schema = {
      flag: field('boolean', { required: true }),
      count: field('number', { required: true, min: 0, max: 2 }),
      tags: field('string', { multiple: true }),
      file: field('file'),
      dir: field('directory'),
    };
    expect(
      resolve(schema, {
        flag: false,
        count: 0,
        tags: [],
        file: '/absent',
        dir: '/absent',
      }),
    ).toEqual({
      flag: false,
      count: 0,
      tags: [],
      file: '/absent',
      dir: '/absent',
    });
    expect(
      resolve(schema, { flag: false, count: 2, tags: 'one' })['tags'],
    ).toBe('one');
    for (const [key, value] of [
      ['flag', 'secret-bad'],
      ['count', 3],
      ['file', 1],
      ['dir', true],
      ['tags', ['one', 2]],
    ]) {
      expect(() =>
        resolve(schema, { flag: false, count: 0, [key as string]: value }),
      ).toThrow(/Invalid Mod/);
    }
    expect(() => resolve(schema, { count: 0 })).toThrow(/required.*flag/);
    expect(() =>
      resolve({ name: field('string', { required: true }) }, { name: '' }),
    ).toThrow(/required.*name/);
  });

  it.each([
    null,
    [],
    { x: { type: 'string' } },
    { x: field('string', { surprise: true }) },
    { 'bad-key': field('string') },
    { x: field('string', { options: ['x', 'X'], default: 'x' }) },
    { x: field('string', { options: ['x'] }) },
  ])('rejects malformed schema %j', (schema) => {
    expect(() => resolve(schema)).toThrow(/userConfig declaration/);
  });

  it('refuses sensitive declarations even with a default, without echoing values', () => {
    expect(() =>
      resolve({
        token: field('string', { sensitive: true, default: 'PRIVATE_VALUE' }),
      }),
    ).toThrow('Sensitive Mod userConfig is not supported yet.');
    expect(() =>
      resolve({ count: field('number') }, { count: 'PRIVATE_VALUE' }),
    ).toThrow('Invalid Mod option: count.');
  });

  it('restricts extra option values and payload size', () => {
    for (const extra of [null, {}, ['one', 1], Infinity]) {
      expect(() => resolve({ name: field('string') }, { extra })).toThrow(
        /configured option: extra/,
      );
    }
    expect(() =>
      resolve({ name: field('string') }, { name: 'x'.repeat(262_145) }),
    ).toThrow(/256 KiB/);
  });

  it('merges aliases within each source before applying operator precedence', () => {
    const schema = {
      value: field('string'),
      kept: field('string'),
      higher: field('string'),
    };
    const scopes = [
      { example: { options: { value: 'default', kept: 'default' } } },
      {
        example: { options: { value: 'user' } },
        'example@inline': { options: { value: 'inline-user', higher: 'kept' } },
      },
      { example: { options: { value: 'system' } } },
    ];
    expect(
      resolveModOptions(schema, scopes.slice(0, 2), 'example')['value'],
    ).toBe('inline-user');
    expect(resolveModOptions(schema, scopes, 'example')).toEqual({
      value: 'system',
      kept: 'default',
      higher: 'kept',
    });
    expect(
      resolveModOptions(
        schema,
        [...scopes, { 'example@market': { options: { value: 'market' } } }],
        'example',
        'market',
      )['value'],
    ).toBe('market');
    expect(
      resolveModOptions(schema, scopes, 'example', 'market')['value'],
    ).toBe('');
  });

  it('does not let special option names mutate object prototypes', () => {
    const declaration = JSON.parse(
      '{"__proto__":{"type":"string","title":"x","description":"x","default":"value"}}',
    );
    const result = resolve(declaration);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['value']).toBeUndefined();
  });
});
