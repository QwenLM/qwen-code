/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTestI18nService } from '../../test-utils/i18n.js';

import { describe, it, expect } from 'vitest';
import type { ActiveHook } from '../types.js';
import { getHookStatusText } from './hookStatusText.js';

const ESC = String.fromCharCode(27);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const hook = (overrides: Partial<ActiveHook> = {}): ActiveHook => ({
  eventName: 'PreToolUse',
  index: 1,
  total: 1,
  settled: false,
  ...overrides,
});

describe('getHookStatusText', () => {
  it('returns undefined when no hooks are active', () => {
    expect(
      getHookStatusText([], createTestI18nService('en').get),
    ).toBeUndefined();
  });

  it('names the event for a single hook without progress', () => {
    expect(getHookStatusText([hook()], createTestI18nService('en').get)).toBe(
      'Running PreToolUse hook…',
    );
  });

  it('counts completed hooks for a parallel batch', () => {
    const hooks = [
      hook({ index: 1, total: 3, settled: true }),
      hook({ index: 2, total: 3 }),
      hook({ index: 3, total: 3 }),
    ];
    expect(getHookStatusText(hooks, createTestI18nService('en').get)).toBe(
      'Running PreToolUse hooks… 1/3',
    );
  });

  it('shows 0/n while the first hook of a sequential batch runs', () => {
    expect(
      getHookStatusText(
        [hook({ total: 3, statusMessage: 'Checking' })],
        createTestI18nService('en').get,
      ),
    ).toBe('Checking… 0/3');
  });

  it('uses the first unfinished hook statusMessage', () => {
    const hooks = [
      hook({ index: 1, total: 2, settled: true, statusMessage: 'Linting' }),
      hook({ index: 2, total: 2, statusMessage: 'Formatting' }),
    ];
    expect(getHookStatusText(hooks, createTestI18nService('en').get)).toBe(
      'Formatting… 1/2',
    );
  });

  it('shows a single hook statusMessage without progress', () => {
    expect(
      getHookStatusText(
        [hook({ statusMessage: 'Checking' })],
        createTestI18nService('en').get,
      ),
    ).toBe('Checking…');
  });

  it('falls back to the event name once every hook has finished', () => {
    const hooks = [
      hook({ eventName: 'Stop', index: 1, total: 2, settled: true }),
      hook({
        eventName: 'Stop',
        index: 2,
        total: 2,
        settled: true,
        statusMessage: 'Saving',
      }),
    ];
    expect(getHookStatusText(hooks, createTestI18nService('en').get)).toBe(
      'Running Stop hooks… 2/2',
    );
  });

  it('collapses ANSI codes and line breaks in statusMessage onto one line', () => {
    const message = `${ESC}[31mLint${ESC}[0m\r\nphase${LINE_SEPARATOR}2\n`;
    expect(
      getHookStatusText(
        [hook({ statusMessage: message })],
        createTestI18nService('en').get,
      ),
    ).toBe('Lint phase 2…');
  });

  it('ignores a whitespace-only statusMessage', () => {
    expect(
      getHookStatusText(
        [hook({ statusMessage: ' \n ' })],
        createTestI18nService('en').get,
      ),
    ).toBe('Running PreToolUse hook…');
  });

  it('labels batch elapsed separately while preserving custom messages and counts', () => {
    expect(
      getHookStatusText(
        [
          hook({ total: 3, settled: true }),
          hook({ index: 2, total: 3, statusMessage: 'Checking' }),
        ],
        createTestI18nService('en').get,
        12,
      ),
    ).toBe('Checking… 1/3 · Hook batch 12s');
    expect(
      getHookStatusText([hook()], createTestI18nService('en').get, 0),
    ).toBe('Running PreToolUse hook… · Hook batch 0s');
    expect(
      getHookStatusText(
        [hook({ statusMessage: '检查中' })],
        createTestI18nService('zh-CN').get,
        2,
      ),
    ).toBe('检查中… · Hook 批次 2秒');
  });

  it('renders zh-CN copy', () => {
    expect(
      getHookStatusText(
        [
          hook({ index: 1, total: 2, settled: true }),
          hook({ index: 2, total: 2 }),
        ],
        createTestI18nService('zh-CN').get,
      ),
    ).toBe('正在运行 PreToolUse hooks… 1/2');
    expect(
      getHookStatusText(
        [hook({ statusMessage: '检查中' })],
        createTestI18nService('zh-CN').get,
      ),
    ).toBe('检查中…');
  });
});
