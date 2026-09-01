/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI settings dialog reproduces the original ink
 * SettingsDialog data logic: tab labels, the schema-sourced settings list,
 * the search filter, the toggle/cycle value transitions, and the inline
 * edit buffer operations.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  buildSettingsListItems,
  editBackspace,
  editDelete,
  editInsert,
  editMoveCursor,
  filterSettingsItems,
  isSubDialogSetting,
  nextToggleValue,
  parseEditCommit,
  SETTINGS_LIST_MAX_ITEMS,
  settingsTabLabel,
  SETTINGS_TAB_ORDER,
  SUB_DIALOG_SETTING_KEYS,
} from './dialogs-settings.js';

describe('settingsTabLabel', () => {
  it('labels the three original tabs', () => {
    expect(settingsTabLabel('settings')).toBe('Settings');
    expect(settingsTabLabel('status')).toBe('Status');
    expect(settingsTabLabel('stats')).toBe('Stats');
  });

  it('keeps the original tab order', () => {
    expect([...SETTINGS_TAB_ORDER]).toEqual(['settings', 'status', 'stats']);
  });

  it('keeps the original list window height', () => {
    expect(SETTINGS_LIST_MAX_ITEMS).toBe(8);
  });
});

describe('sub-dialog settings', () => {
  it('matches the four rows that open a picker', () => {
    expect([...SUB_DIALOG_SETTING_KEYS]).toEqual([
      'ui.theme',
      'general.preferredEditor',
      'fastModel',
      'visionModel',
    ]);
    expect(isSubDialogSetting('ui.theme')).toBe(true);
    expect(isSubDialogSetting('general.vimMode')).toBe(false);
  });
});

describe('buildSettingsListItems', () => {
  it('sources rows from the settings schema, in dialog order', () => {
    const items = buildSettingsListItems();
    expect(items.length).toBeGreaterThan(0);
    const keys = items.map((item) => item.key);
    expect(keys).toContain('ui.theme');
    // Labels are resolved from the schema definitions.
    const themeItem = items.find((item) => item.key === 'ui.theme');
    expect(themeItem?.label).toBeTruthy();
    expect(themeItem?.type).toBeDefined();
  });
});

describe('filterSettingsItems', () => {
  const items = [
    {
      key: 'general.vimMode',
      label: 'Vim Mode',
      description: 'Configure vim mode',
      type: 'boolean' as const,
    },
    { key: 'ui.theme', label: 'Theme', description: undefined },
  ];

  it('returns everything for an empty query', () => {
    expect(filterSettingsItems(items, '', () => '')).toHaveLength(2);
  });

  it('matches key, label, description, and scope message', () => {
    expect(filterSettingsItems(items, 'vimmode', () => '')).toHaveLength(1);
    expect(filterSettingsItems(items, 'VIM', () => '')).toHaveLength(1);
    expect(filterSettingsItems(items, 'configure', () => '')).toHaveLength(1);
    expect(
      filterSettingsItems(items, 'workspace', () => 'workspace only'),
    ).toHaveLength(2);
    expect(filterSettingsItems(items, 'zzz', () => '')).toHaveLength(0);
  });
});

describe('nextToggleValue', () => {
  it('flips booleans', () => {
    expect(nextToggleValue({ type: 'boolean' }, true)).toBe(false);
    expect(nextToggleValue({ type: 'boolean' }, false)).toBe(true);
  });

  it('cycles enums and loops back to the first option', () => {
    const def = {
      type: 'enum' as const,
      options: [
        { value: 'a' as const },
        { value: 'b' as const },
        { value: 'c' as const },
      ],
    };
    expect(nextToggleValue(def, 'a')).toBe('b');
    expect(nextToggleValue(def, 'c')).toBe('a');
  });

  it('returns undefined for non-toggle types', () => {
    expect(nextToggleValue({ type: 'string' }, 'x')).toBeUndefined();
    expect(nextToggleValue(undefined, true)).toBeUndefined();
  });
});

describe('inline edit buffer', () => {
  it('inserts at the cursor', () => {
    const state = { buffer: 'ac', cursor: 1 };
    expect(editInsert(state, 'b')).toEqual({ buffer: 'abc', cursor: 2 });
  });

  it('backspaces behind the cursor only', () => {
    expect(editBackspace({ buffer: 'ab', cursor: 1 })).toEqual({
      buffer: 'b',
      cursor: 0,
    });
    expect(editBackspace({ buffer: 'ab', cursor: 0 })).toEqual({
      buffer: 'ab',
      cursor: 0,
    });
  });

  it('deletes at the cursor only', () => {
    expect(editDelete({ buffer: 'ab', cursor: 0 })).toEqual({
      buffer: 'b',
      cursor: 0,
    });
    expect(editDelete({ buffer: 'ab', cursor: 2 })).toEqual({
      buffer: 'ab',
      cursor: 2,
    });
  });

  it('moves the cursor with bounds and counts graphemes', () => {
    const emoji = { buffer: '😀x', cursor: 1 };
    expect(editMoveCursor(emoji, 'left')).toEqual({
      buffer: '😀x',
      cursor: 0,
    });
    expect(editMoveCursor(emoji, 'right')).toEqual({
      buffer: '😀x',
      cursor: 2,
    });
    expect(editMoveCursor(emoji, 'home').cursor).toBe(0);
    expect(editMoveCursor(emoji, 'end').cursor).toBe(2);
    expect(editMoveCursor({ buffer: 'a', cursor: 0 }, 'left').cursor).toBe(0);
  });
});

describe('parseEditCommit', () => {
  it('commits outputLanguage trimmed, with empty meaning auto', () => {
    expect(parseEditCommit('general.outputLanguage', 'string', '  zh  ')).toBe(
      'zh',
    );
    expect(parseEditCommit('general.outputLanguage', 'string', '   ')).toBe(
      'auto',
    );
  });

  it('keeps the raw buffer for other string keys (ink parity)', () => {
    expect(parseEditCommit('general.telemetry', 'string', ' a ')).toBe(' a ');
  });

  it('parses numbers and cancels empty or NaN input', () => {
    expect(parseEditCommit('general.maxInitEvents', 'number', ' 12 ')).toBe(12);
    expect(parseEditCommit('general.maxInitEvents', 'number', '')).toBeNull();
    expect(parseEditCommit('general.maxInitEvents', 'number', 'x')).toBeNull();
  });
});
