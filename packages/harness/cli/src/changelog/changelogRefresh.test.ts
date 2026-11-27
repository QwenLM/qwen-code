/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiLocale } from '@qwen-code/core';
import { startChangelogRefresh } from './changelogRefresh.js';

const mocks = vi.hoisted(() => ({
  getChangelogUrl: (locale: UiLocale) =>
    `https://default.example/${locale}/changelog`,
  fetchChangelogForLocale: vi.fn(),
  uiLocale: undefined as UiLocale | undefined,
  localeListeners: new Set<(locale: UiLocale) => void>(),
  updateListeners: new Set<() => void>(),
}));

vi.mock('./changelogFetch.js', () => ({
  getChangelogUrl: mocks.getChangelogUrl,
  fetchChangelogForLocale: mocks.fetchChangelogForLocale,
}));

vi.mock('../ui/i18n/uiLocaleState.js', () => ({
  getUiLocale: () => mocks.uiLocale,
  onUiLocaleChange: (listener: (locale: UiLocale) => void) => {
    mocks.localeListeners.add(listener);
    return () => mocks.localeListeners.delete(listener);
  },
}));

vi.mock('../utils/updateEventEmitter.js', () => ({
  onUpdateSuccess: (listener: () => void) => {
    mocks.updateListeners.add(listener);
    return () => mocks.updateListeners.delete(listener);
  },
}));

function publishLocale(locale: UiLocale): void {
  mocks.uiLocale = locale;
  for (const listener of [...mocks.localeListeners]) listener(locale);
}

function emitUpdateSuccess(): void {
  for (const listener of [...mocks.updateListeners]) listener();
}

beforeEach(() => {
  mocks.fetchChangelogForLocale.mockReset().mockResolvedValue(undefined);
  mocks.uiLocale = undefined;
  mocks.localeListeners.clear();
  mocks.updateListeners.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startChangelogRefresh', () => {
  it('routes language and update events through the language dispatcher', () => {
    const getUrl = (locale: UiLocale) =>
      `https://custom.example/${locale}/changelog`;
    const stop = startChangelogRefresh(getUrl);
    publishLocale('zh-CN');
    expect(mocks.fetchChangelogForLocale).toHaveBeenLastCalledWith(
      'zh-CN',
      getUrl,
    );
    emitUpdateSuccess();
    expect(mocks.fetchChangelogForLocale).toHaveBeenLastCalledWith(
      'zh-CN',
      getUrl,
      true,
    );
    stop();
  });

  it('follows language changes and removes its event listeners', () => {
    const stop = startChangelogRefresh();
    expect(mocks.fetchChangelogForLocale).not.toHaveBeenCalled();
    publishLocale('en');
    expect(mocks.fetchChangelogForLocale).toHaveBeenLastCalledWith(
      'en',
      mocks.getChangelogUrl,
    );
    publishLocale('zh-CN');
    expect(mocks.fetchChangelogForLocale).toHaveBeenLastCalledWith(
      'zh-CN',
      mocks.getChangelogUrl,
    );
    expect(mocks.updateListeners.size).toBe(1);
    emitUpdateSuccess();
    expect(mocks.fetchChangelogForLocale).toHaveBeenLastCalledWith(
      'zh-CN',
      mocks.getChangelogUrl,
      true,
    );
    stop();
    expect(mocks.localeListeners.size).toBe(0);
    expect(mocks.updateListeners.size).toBe(0);
  });

  it('starts from a locale already resolved by the UI', () => {
    mocks.uiLocale = 'en';
    const stop = startChangelogRefresh();
    expect(mocks.fetchChangelogForLocale).toHaveBeenCalledWith(
      'en',
      mocks.getChangelogUrl,
    );
    stop();
  });

  it('keeps following after a failed request', async () => {
    mocks.fetchChangelogForLocale.mockRejectedValue(new Error('offline'));
    const stop = startChangelogRefresh();
    publishLocale('en');
    emitUpdateSuccess();
    await Promise.resolve();
    publishLocale('zh-CN');
    expect(mocks.fetchChangelogForLocale).toHaveBeenLastCalledWith(
      'zh-CN',
      mocks.getChangelogUrl,
    );
    stop();
  });
});
