/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { capabilityStage, validateModDeclarations } from './mod-contract.js';

const field = { type: 'string', title: 'Title', description: 'Description' };

describe('Mod declarations', () => {
  it('accepts the declared option types without changing literal defaults', () => {
    const userConfig = {
      text: { ...field, default: '${HOME}', sensitive: true },
      list: { ...field, multiple: true, default: ['${workspacePath}'] },
      count: { ...field, type: 'number', default: 2, min: 1, max: 3 },
      enabled: { ...field, type: 'boolean', default: false },
      directory: { ...field, type: 'directory', default: '/not/read' },
      file: { ...field, type: 'file', default: '/not/read' },
      pick: { ...field, options: ['one', 'two'], default: 'two' },
      required: { ...field, options: ['one'], required: true },
    };
    expect(validateModDeclarations({ userConfig }, 'manifest.json')).toEqual(
      [],
    );
    expect(userConfig.text.default).toBe('${HOME}');
  });

  it.each([
    { '1bad': field },
    { 'bad-key': field },
    { test: { ...field, extra: true } },
    { test: { type: 'string', description: 'Description' } },
    { test: { ...field, default: 1 } },
    { test: { ...field, required: 'yes' } },
    { test: { ...field, multiple: true, default: 'one' } },
    { test: { ...field, type: 'boolean', multiple: true } },
    { test: { ...field, min: 0 } },
    { test: { ...field, type: 'number', min: 2, max: 1 } },
    { test: { ...field, type: 'number', min: 2, default: 1 } },
    { test: { ...field, options: [] } },
    { test: { ...field, options: ['one'] } },
    { test: { ...field, options: ['one'], default: 'two' } },
    { test: { ...field, options: ['one'], default: 'one', sensitive: true } },
    { test: { ...field, options: ['one'], required: true, multiple: true } },
    { test: { ...field, options: ['x'.repeat(65)], required: true } },
  ])('rejects malformed option declarations %#', (userConfig) => {
    expect(
      validateModDeclarations({ userConfig }, 'manifest.json'),
    ).toContainEqual(
      expect.objectContaining({
        code: 'MOD_USER_CONFIG_INVALID',
        severity: 'error',
      }),
    );
  });

  it('does not include option values or invalid identifiers in diagnostics', () => {
    const diagnostics = validateModDeclarations(
      {
        userConfig: {
          SECRET_IDENTIFIER: {
            ...field,
            sensitive: true,
            default: { SECRET_VALUE: true },
          },
        },
      },
      'manifest.json',
    );
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET');
  });

  it('preserves supported type/dependency shapes and defers external resolution', () => {
    const declarations = {
      types: './types/index.d.ts',
      dependencies: [
        'plugin',
        'other@market',
        { name: 'third', marketplace: 'market', version: '^1' },
      ],
    };
    expect(validateModDeclarations(declarations, 'manifest.json')).toEqual([
      expect.objectContaining({
        code: 'MOD_DEPENDENCY_DEFERRED',
        severity: 'warning',
      }),
    ]);
    expect(
      validateModDeclarations(
        { types: ['./types/index.d.ts'], dependencies: { name: 'test' } },
        'manifest.json',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_TYPES_INVALID' }),
        expect.objectContaining({ code: 'MOD_DEPENDENCIES_INVALID' }),
      ]),
    );
  });

  it('bounds declaration diagnostics', () => {
    const userConfig = Object.fromEntries(
      Array.from({ length: 110 }, (_, index) => [`field${index}`, null]),
    );
    const diagnostics = validateModDeclarations(
      { userConfig },
      'manifest.json',
    );
    expect(diagnostics).toHaveLength(100);
    expect(diagnostics.at(-1)?.code).toBe('MOD_ANALYSIS_LIMIT');
  });

  it.each([
    'https://SECRET:password@example.com/types.d.ts',
    '/tmp/SECRET.d.ts',
    '../SECRET.d.ts',
    'C:/SECRET.d.ts',
    'C:\\SECRET.d.ts',
  ])('does not expose unsafe type declaration paths %#', (types) => {
    const diagnostics = validateModDeclarations(
      { types },
      'qwen-extension.json',
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'MOD_TYPES_INVALID',
        file: 'qwen-extension.json',
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET');
  });

  it('classifies only the initial known catalog', () => {
    expect(capabilityStage('event', 'session.start')).toBe('M3');
    expect(capabilityStage('api', 'session.usage')).toBe('M5');
    expect(capabilityStage('element', 'Box')).toBe('M6');
    expect(capabilityStage('api', 'future.new')).toBe('unclassified');
    expect(capabilityStage('event', '__proto__')).toBe('unclassified');
    expect(capabilityStage('api', 'constructor')).toBe('unclassified');
  });
});
