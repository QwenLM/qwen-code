/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsFileSource } from '@qwen-code/resource';
import { expect, it, vi } from 'vitest';
import { loadSettings } from '../test-utils/resolveSettings.js';

it.each(['project', 'local'] as const)('rejects unsupported %s test sources instead of reading disk', (scope) => {
  const read = vi.fn();
  const sources = { [scope]: { path: '/unused/settings.json', read } };
  expect(() => loadSettings('/unused', [], sources as never)).toThrow(
    'loadSettings test helper only supports a user file source',
  );
  expect(read).not.toHaveBeenCalled();
});


it('reads and reloads a custom user source before binding the factory root', () => {
  const source = new SettingsFileSource(join(tmpdir(), 'qwen-custom-test-source', 'custom.json'));
  let text = JSON.stringify({ model: { name: 'first' } });
  const read = vi.spyOn(source, 'read').mockImplementation(() => text);
  const invalidate = vi.spyOn(source, 'invalidate');
  try {
    const settings = loadSettings(tmpdir(), ['user'], { user: source });
    expect(settings.user.path).toBe(source.path);
    expect(settings.merged.model.name).toBe('first');
    text = JSON.stringify({ model: { name: 'second' } });
    settings.reload();
    expect(settings.merged.model.name).toBe('second');
    expect(read).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
