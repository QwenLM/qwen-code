/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI extensions dialog shell reproduces the original ink
 * ExtensionsManagerDialog content: tab order/labels, the exact per-tab
 * footer hints, and the status message coloring.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { C } from './theme.js';
import {
  EXTENSIONS_TAB_ORDER,
  EXTENSIONS_TABS,
  extensionsFooterHint,
  extensionsStatusColor,
  extensionsTabLabel,
} from './dialogs-extensions.js';

describe('extensions tabs', () => {
  it('keeps the original tab ids and order', () => {
    expect(EXTENSIONS_TABS).toEqual({
      INSTALLED: 'installed',
      DISCOVER: 'discover',
      SOURCES: 'sources',
    });
    expect([...EXTENSIONS_TAB_ORDER]).toEqual([
      'installed',
      'discover',
      'sources',
    ]);
  });

  it('labels tabs like the original TabBar', () => {
    expect(extensionsTabLabel('installed')).toBe('Installed');
    expect(extensionsTabLabel('discover')).toBe('Discover');
    expect(extensionsTabLabel('sources')).toBe('Sources');
  });
});

describe('extensionsFooterHint', () => {
  it('keeps the exact original hints per tab', () => {
    expect(extensionsFooterHint('discover')).toBe(
      'Type to search · Space to toggle · Enter to view · Ctrl+R refresh · Esc to go back',
    );
    expect(extensionsFooterHint('installed')).toBe(
      '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close',
    );
    expect(extensionsFooterHint('sources')).toBe(
      '↑↓ navigate · Enter select · d remove marketplace · Esc close',
    );
  });
});

describe('extensionsStatusColor', () => {
  it('maps status types onto the shared palette', () => {
    expect(extensionsStatusColor({ type: 'error', text: '' })).toBe(C.red);
    expect(extensionsStatusColor({ type: 'warning', text: '' })).toBe(C.yellow);
    expect(extensionsStatusColor({ type: 'success', text: '' })).toBe(C.green);
    expect(extensionsStatusColor({ type: 'info', text: '' })).toBe(C.dim);
  });
});
