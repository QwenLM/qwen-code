/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { enCatalog, zhCNCatalog } from './catalog.js';
import { getPlaceholderNames } from './formatMessage.js';
import { BUILTIN_COMMAND_DESCRIPTION_KEYS } from './commandText.js';

describe('UI message catalogs', () => {
  it('contains no command descriptions outside the CLI command key set', () => {
    const commandKeys = new Set<string>(Object.values(BUILTIN_COMMAND_DESCRIPTION_KEYS));
    const unused = Object.keys(enCatalog).filter(
      key => key.startsWith('commands.builtin.') && key.endsWith('.description') && !commandKeys.has(key),
    );
    expect(unused).toEqual([]);
  });
  it('keeps Chinese keys complete and free of extras', () => {
    expect(Object.keys(zhCNCatalog).sort()).toEqual(
      Object.keys(enCatalog).sort(),
    );
  });

  it('keeps values non-empty and placeholder names aligned', () => {
    for (const key of Object.keys(enCatalog) as Array<keyof typeof enCatalog>) {
      expect(enCatalog[key].trim(), key).not.toBe('');
      expect(zhCNCatalog[key].trim(), key).not.toBe('');
      expect([...getPlaceholderNames(zhCNCatalog[key])].sort(), key).toEqual(
        [...getPlaceholderNames(enCatalog[key])].sort(),
      );
    }
  });
});
