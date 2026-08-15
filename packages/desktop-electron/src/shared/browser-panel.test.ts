/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BROWSER_PANEL_PARTITION,
  normalizeBrowserPanelBounds,
  normalizeBrowserPanelUrl,
  normalizeDesktopLinkOpenPreference,
  normalizeExternalOpenUrl,
  shouldOpenDesktopLinkExternally,
} from './browser-panel';

describe('browser panel input validation', () => {
  it('uses an in-memory browser session partition', () => {
    expect(BROWSER_PANEL_PARTITION.startsWith('persist:')).toBe(false);
  });

  it('accepts and normalizes HTTP(S) URLs', () => {
    expect(normalizeBrowserPanelUrl(' https://example.com ')).toBe(
      'https://example.com/',
    );
    expect(normalizeBrowserPanelUrl('http://127.0.0.1:4170/page')).toBe(
      'http://127.0.0.1:4170/page',
    );
  });

  it('rejects privileged and malformed URLs', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,test',
      'mailto:test@example.com',
      'not a url',
      '',
    ]) {
      expect(normalizeBrowserPanelUrl(url)).toBeUndefined();
    }
  });

  it('allows mailto only through the system opener', () => {
    expect(normalizeExternalOpenUrl('mailto:test@example.com')).toBe(
      'mailto:test@example.com',
    );
    expect(normalizeExternalOpenUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeBrowserPanelUrl('mailto:test@example.com')).toBeUndefined();
    expect(
      shouldOpenDesktopLinkExternally(
        'mailto:test@example.com',
        'in-app',
        false,
      ),
    ).toBe(true);
  });

  it('resolves explicit and preferred system-browser behavior', () => {
    expect(
      shouldOpenDesktopLinkExternally('https://example.com/', 'in-app', false),
    ).toBe(false);
    expect(
      shouldOpenDesktopLinkExternally('https://example.com/', 'in-app', true),
    ).toBe(true);
    expect(
      shouldOpenDesktopLinkExternally(
        'https://example.com/',
        'external',
        false,
      ),
    ).toBe(true);
  });

  it('accepts only supported persisted link preferences', () => {
    expect(normalizeDesktopLinkOpenPreference('in-app')).toBe('in-app');
    expect(normalizeDesktopLinkOpenPreference('external')).toBe('external');
    expect(normalizeDesktopLinkOpenPreference('browser')).toBeUndefined();
  });

  it('rounds positive view bounds', () => {
    expect(
      normalizeBrowserPanelBounds({
        x: 501.4,
        y: 42.6,
        width: 619.8,
        height: 700.2,
      }),
    ).toEqual({ x: 501, y: 43, width: 620, height: 700 });
  });

  it('rejects incomplete and non-positive bounds', () => {
    expect(
      normalizeBrowserPanelBounds({ x: 0, y: 0, width: 0, height: 10 }),
    ).toBeUndefined();
    expect(
      normalizeBrowserPanelBounds({ x: -1, y: 0, width: 10, height: 10 }),
    ).toBeUndefined();
    expect(
      normalizeBrowserPanelBounds({ x: 0, y: 0, width: 10 }),
    ).toBeUndefined();
  });
});
