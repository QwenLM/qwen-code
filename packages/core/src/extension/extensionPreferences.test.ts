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
    store.setScope('beta', 'user');
    expect(store.getScope('alpha')).toBe('project');
    expect(store.getScope('beta')).toBe('user');
    expect(store.getScopes()).toEqual({ alpha: 'project', beta: 'user' });
  });

  it('drops unknown scope values when reading persisted preferences', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        favorites: [],
        scopes: { alpha: 'project', beta: 'user', gamma: 'bogus' },
      }),
    );
    expect(store.getScope('alpha')).toBe('project');
    expect(store.getScope('beta')).toBe('user');
    expect(store.getScope('gamma')).toBeUndefined();
    expect(store.getScopes()).toEqual({ alpha: 'project', beta: 'user' });
  });

  it('clears all preference state for an extension', () => {
    store.toggleFavorite('alpha');
    store.setScope('alpha', 'user');
    store.setMcpServerDisabled('alpha', 'srv', true);
    store.toggleFavorite('beta');

    store.clear('alpha');

    expect(store.isFavorite('alpha')).toBe(false);
    expect(store.getScope('alpha')).toBeUndefined();
    expect(store.getDisabledMcpServers('alpha')).toEqual([]);
    // Unrelated entries are untouched.
    expect(store.isFavorite('beta')).toBe(true);
  });

  it('records per-extension disabled MCP servers and persists them', () => {
    store.setMcpServerDisabled('alpha', 'srv-a', true);
    store.setMcpServerDisabled('alpha', 'srv-b', true);
    store.setMcpServerDisabled('beta', 'srv-a', true);

    expect(store.getDisabledMcpServers('alpha')).toEqual(['srv-a', 'srv-b']);
    // Namespaced: beta's same-named entry is independent of alpha's.
    expect(store.getDisabledMcpServers('beta')).toEqual(['srv-a']);

    const reopened = new ExtensionPreferencesStore(filePath);
    expect(reopened.getDisabledMcpServers('alpha')).toEqual(['srv-a', 'srv-b']);

    store.setMcpServerDisabled('alpha', 'srv-a', false);
    expect(store.getDisabledMcpServers('alpha')).toEqual(['srv-b']);
    // Removing the last entry drops the extension key entirely.
    store.setMcpServerDisabled('alpha', 'srv-b', false);
    expect(store.getDisabledMcpServers('alpha')).toEqual([]);
    expect(store.read().disabledMcpServers['alpha']).toBeUndefined();
  });

  it('drops malformed disabledMcpServers values when reading', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        favorites: [],
        scopes: {},
        disabledMcpServers: { alpha: ['ok', 42], beta: 'oops' },
      }),
    );
    expect(store.getDisabledMcpServers('alpha')).toEqual(['ok']);
    expect(store.getDisabledMcpServers('beta')).toEqual([]);
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
