/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExtensionPreferencesStore } from './extensionPreferences.js';

describe('ExtensionPreferencesStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: ExtensionPreferencesStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-prefs-'));
    filePath = path.join(tmpDir, 'nested', 'extension-preferences.json');
    store = new ExtensionPreferencesStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty defaults when the file does not exist', () => {
    expect(store.getFavorites()).toEqual([]);
    expect(store.getScopes()).toEqual({});
    expect(store.isFavorite('foo')).toBe(false);
    expect(store.getScope('foo')).toBeUndefined();
  });

  it('toggles favorites on and off and persists them', () => {
    expect(store.toggleFavorite('alpha')).toBe(true);
    expect(store.isFavorite('alpha')).toBe(true);
    expect(store.getFavorites()).toEqual(['alpha']);

    // A fresh store reading the same file sees the persisted state.
    const reopened = new ExtensionPreferencesStore(filePath);
    expect(reopened.isFavorite('alpha')).toBe(true);

    expect(store.toggleFavorite('alpha')).toBe(false);
    expect(store.isFavorite('alpha')).toBe(false);
    expect(store.getFavorites()).toEqual([]);
  });

  it('records and reads per-extension scope intent', () => {
    store.setScope('alpha', 'project');
    store.setScope('beta', 'local');
    expect(store.getScope('alpha')).toBe('project');
    expect(store.getScope('beta')).toBe('local');
    expect(store.getScopes()).toEqual({ alpha: 'project', beta: 'local' });
  });

  it('clears all preference state for an extension', () => {
    store.toggleFavorite('alpha');
    store.setScope('alpha', 'user');
    store.toggleFavorite('beta');

    store.clear('alpha');

    expect(store.isFavorite('alpha')).toBe(false);
    expect(store.getScope('alpha')).toBeUndefined();
    // Unrelated entries are untouched.
    expect(store.isFavorite('beta')).toBe(true);
  });

  it('does not leak favorites between fresh stores via a shared default array', () => {
    // Toggling a favorite on a store whose file does not exist must not
    // mutate a shared module-level default, polluting other instances.
    const otherFile = path.join(tmpDir, 'other', 'extension-preferences.json');
    const a = new ExtensionPreferencesStore(filePath);
    const b = new ExtensionPreferencesStore(otherFile);
    a.toggleFavorite('alpha');
    expect(b.getFavorites()).toEqual([]);
  });

  it('recovers from a corrupted preferences file', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not valid json');
    expect(store.getFavorites()).toEqual([]);
    expect(store.getScopes()).toEqual({});
    // And can still write afterwards.
    expect(store.toggleFavorite('alpha')).toBe(true);
    expect(store.isFavorite('alpha')).toBe(true);
  });
});
