/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyCatalogFilters,
  buildModelLabel,
  getNextEnabledTabSource,
  getNextFocusMode,
  type FilterMode,
} from './ManageModelsDialog.js';
import type { ManageModelsCatalogEntry } from '../manageModels/manageModels.js';

function makeEntry(
  id: string,
  options: {
    badges?: string[];
    supportsVision?: boolean;
    contextWindowSize?: number;
  } = {},
): ManageModelsCatalogEntry {
  return {
    id,
    label: id,
    searchText: `${id} ${(options.badges || []).join(' ')}`,
    supportsVision: options.supportsVision ?? false,
    contextWindowSize: options.contextWindowSize,
    badges: options.badges || [],
    model: {
      id,
      name: id,
      baseUrl: 'https://openrouter.ai/api/v1',
    },
  };
}

describe('ManageModelsDialog helpers', () => {
  it('buildModelLabel uses the short display label only', () => {
    expect(
      buildModelLabel(
        makeEntry('qwen/qwen3-coder:free', {
          badges: ['free', 'vision'],
          contextWindowSize: 1_000_000,
        }),
      ),
    ).toBe('qwen/qwen3-coder:free');
  });

  it.each<[FilterMode, string[]]>([
    ['all', ['qwen/qwen3-coder:free', 'openai/gpt-4o-mini']],
    ['enabled', ['openai/gpt-4o-mini']],
    ['free', ['qwen/qwen3-coder:free']],
    ['vision', ['qwen/qwen3-coder:free']],
  ])('applyCatalogFilters supports %s filter', (filterMode, expectedIds) => {
    const entries = [
      makeEntry('qwen/qwen3-coder:free', {
        badges: ['free', 'vision'],
        supportsVision: true,
      }),
      makeEntry('openai/gpt-4o-mini'),
    ];

    expect(
      applyCatalogFilters({
        entries,
        query: '',
        selectedIds: ['openai/gpt-4o-mini'],
        filterMode,
      }).map((entry) => entry.id),
    ).toEqual(expectedIds);
  });

  it('applyCatalogFilters combines query and filter mode', () => {
    const entries = [
      makeEntry('qwen/qwen3-coder:free', {
        badges: ['free'],
      }),
      makeEntry('glm/glm-4.5-air:free', {
        badges: ['free'],
      }),
    ];

    expect(
      applyCatalogFilters({
        entries,
        query: 'qwen',
        selectedIds: [],
        filterMode: 'free',
      }).map((entry) => entry.id),
    ).toEqual(['qwen/qwen3-coder:free']);
  });

  it('applyCatalogFilters supports enabled quick filter in search', () => {
    const entries = [
      makeEntry('qwen/qwen3-coder:free'),
      makeEntry('openai/gpt-4o-mini'),
    ];

    expect(
      applyCatalogFilters({
        entries,
        query: 'enabled',
        selectedIds: ['openai/gpt-4o-mini'],
        filterMode: 'all',
      }).map((entry) => entry.id),
    ).toEqual(['openai/gpt-4o-mini']);

    expect(
      applyCatalogFilters({
        entries,
        query: 'is:enabled gpt',
        selectedIds: ['openai/gpt-4o-mini'],
        filterMode: 'all',
      }).map((entry) => entry.id),
    ).toEqual(['openai/gpt-4o-mini']);
  });

  it('cycles focus across tabs, search, and list', () => {
    expect(getNextFocusMode('tabs', 'forward', true)).toBe('search');
    expect(getNextFocusMode('search', 'forward', true)).toBe('list');
    expect(getNextFocusMode('list', 'forward', true)).toBe('tabs');
    expect(getNextFocusMode('search', 'backward', false)).toBe('tabs');
  });

  it('keeps provider tab on the only enabled source', () => {
    expect(getNextEnabledTabSource('openrouter', 'left')).toBe('openrouter');
    expect(getNextEnabledTabSource('openrouter', 'right')).toBe('openrouter');
  });
});
