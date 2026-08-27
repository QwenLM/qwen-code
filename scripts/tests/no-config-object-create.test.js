import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../../eslint-rules/no-config-object-create.js';

function verify(code) {
  const linter = new Linter({ configType: 'eslintrc' });
  linter.defineRule('qwen-code/no-config-object-create', rule);
  return linter.verify(code, {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'qwen-code/no-config-object-create': 'error' },
  });
}

describe('no-config-object-create', () => {
  it('rejects prototype derivation in a module that imports Config', () => {
    const messages = verify(`
      import { Config } from '../config/config.js';
      const child = Object.create(parent);
    `);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('useDeriveConfig');
  });

  it('allows deriveConfig and null-prototype dictionaries', () => {
    expect(
      verify(`
        import { Config, deriveConfig } from '../config/config.js';
        const child = deriveConfig(parent);
        const dictionary = Object.create(null);
      `),
    ).toEqual([]);
  });

  it('ignores unrelated Config imports', () => {
    expect(
      verify(`
        import { Config } from '../telemetry/config.js';
        const error = Object.create(Object.getPrototypeOf(source));
      `),
    ).toEqual([]);
  });
});
