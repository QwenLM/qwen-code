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
  shouldOpenLinkInApp,
} from './browser-panel';

describe('Electron browser panel input validation', () => {
  it('uses an in-memory browser session partition', () => {
    expect(BROWSER_PANEL_PARTITION.startsWith('persist:')).toBe(false);
  });

  it('accepts only HTTP(S) panel URLs', () => {
    expect(normalizeBrowserPanelUrl(' https://example.com/path ')).toBe(
      'https://example.com/path',
    );
    expect(normalizeBrowserPanelUrl('http://127.0.0.1:4170/page')).toBe(
      'http://127.0.0.1:4170/page',
    );
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

  it('opens only modified external HTTP(S) clicks in app', () => {
    expect(
      shouldOpenLinkInApp({
        button: 0,
        ctrlKey: false,
        metaKey: false,
        pageUrl: 'http://127.0.0.1:4170/session/1',
        platform: 'darwin',
        url: 'https://example.com/',
      }),
    ).toBe(false);
    expect(
      shouldOpenLinkInApp({
        button: 0,
        ctrlKey: false,
        metaKey: true,
        pageUrl: 'http://127.0.0.1:4170/session/1',
        platform: 'darwin',
        url: 'https://example.com/',
      }),
    ).toBe(true);
    expect(
      shouldOpenLinkInApp({
        button: 0,
        ctrlKey: true,
        metaKey: false,
        pageUrl: 'http://127.0.0.1:4170/session/1',
        platform: 'win32',
        url: 'https://example.com/',
      }),
    ).toBe(true);
    expect(
      shouldOpenLinkInApp({
        button: 0,
        ctrlKey: false,
        metaKey: true,
        pageUrl: 'http://127.0.0.1:4170/session/1',
        platform: 'darwin',
        url: 'http://127.0.0.1:4170/settings',
      }),
    ).toBe(false);
    expect(
      shouldOpenLinkInApp({
        button: 0,
        ctrlKey: false,
        metaKey: true,
        pageUrl: 'http://127.0.0.1:4170/session/1',
        platform: 'darwin',
        url: 'mailto:test@example.com',
      }),
    ).toBe(false);
    expect(
      shouldOpenLinkInApp({
        button: 0,
        ctrlKey: true,
        metaKey: false,
        pageUrl: 'http://127.0.0.1:4170/session/1',
        platform: 'darwin',
        url: 'https://example.com/',
      }),
    ).toBe(false);
  });

  it('accepts only positive panel bounds', () => {
    expect(
      normalizeBrowserPanelBounds({
        x: 501.4,
        y: 42.6,
        width: 619.8,
        height: 700.2,
      }),
    ).toEqual({ x: 501, y: 43, width: 620, height: 700 });
    expect(
      normalizeBrowserPanelBounds({ x: 0, y: 0, width: 0, height: 10 }),
    ).toBeUndefined();
    expect(
      normalizeBrowserPanelBounds({ x: -1, y: 0, width: 10, height: 10 }),
    ).toBeUndefined();
  });
});
