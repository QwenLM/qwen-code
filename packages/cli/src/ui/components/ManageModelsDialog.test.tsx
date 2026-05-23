/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import {
  applyCatalogFilters,
  buildModelLabel,
  getNextEnabledTabSource,
  getNextFocusMode,
  ManageModelsDialog,
  type FilterMode,
} from './ManageModelsDialog.js';
import type { ManageModelsCatalogEntry } from '../manageModels/manageModels.js';
import {
  fetchManageModelsCatalog,
  getEnabledModelIdsForSource,
  saveManageModelsSelection,
} from '../manageModels/manageModels.js';
import { renderWithProviders } from '../../test-utils/render.js';
import type { Key, KeypressHandler } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';

vi.mock('../manageModels/manageModels.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../manageModels/manageModels.js')>();
  return {
    ...actual,
    fetchManageModelsCatalog: vi.fn(),
    getEnabledModelIdsForSource: vi.fn(),
    saveManageModelsSelection: vi.fn(),
  };
});

vi.mock('./shared/TextInput.js', async () => {
  const { Text } = await import('ink');
  return {
    TextInput: ({
      value,
      placeholder,
    }: {
      value?: string;
      placeholder?: string;
    }) => <Text>{value ? `> ${value}` : `> ${placeholder}`}</Text>,
  };
});

vi.mock('../hooks/useKeypress.js');

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

const catalogEntries = [
  makeEntry('qwen/qwen3-coder:free', {
    badges: ['free'],
  }),
  makeEntry('openai/gpt-4o-mini'),
  makeEntry('anthropic/claude-haiku'),
];

let dialogKeypressHandler: KeypressHandler | null = null;

const createKey = (overrides: Partial<Key>): Key => ({
  name: '',
  sequence: '',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
  ...overrides,
});

const pressDialogKey = async (overrides: Partial<Key>) => {
  if (!dialogKeypressHandler) {
    throw new Error('ManageModelsDialog keypress handler was not registered.');
  }
  const handler = dialogKeypressHandler;

  await act(async () => {
    handler(createKey(overrides));
  });
};

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

describe('ManageModelsDialog keyboard navigation', () => {
  beforeEach(() => {
    dialogKeypressHandler = null;
    vi.mocked(useKeypress).mockImplementation((handler, { isActive }) => {
      if (isActive) {
        dialogKeypressHandler = handler;
      }
    });
    vi.mocked(fetchManageModelsCatalog).mockResolvedValue({
      source: 'openrouter',
      title: 'OpenRouter',
      description:
        'Browse the latest OpenRouter model catalog and choose which models are enabled locally.',
      authType: AuthType.USE_OPENAI,
      entries: catalogEntries,
    });
    vi.mocked(getEnabledModelIdsForSource).mockReturnValue([]);
    vi.mocked(saveManageModelsSelection).mockResolvedValue({
      updatedConfigs: [],
      selectedIds: [],
      activeModelId: undefined,
    });
  });

  const renderDialog = () =>
    renderWithProviders(
      <ManageModelsDialog config={{} as Config} onClose={vi.fn()} />,
    );

  it('keeps bare j in search mode instead of entering the list', async () => {
    const { lastFrame, unmount } = renderDialog();

    await waitFor(() => {
      expect(lastFrame()).toContain('qwen/qwen3-coder:free');
    });

    await pressDialogKey({ name: 'n', sequence: '\u000E', ctrl: true });
    await pressDialogKey({ name: 'j', sequence: 'j' });

    expect(lastFrame()).not.toContain('› [ ] qwen/qwen3-coder:free');
    unmount();
  });

  it('uses selection shortcuts across tabs, search, and list', async () => {
    const { lastFrame, unmount } = renderDialog();

    await waitFor(() => {
      expect(lastFrame()).toContain('qwen/qwen3-coder:free');
    });

    await pressDialogKey({ name: 'j', sequence: 'j' }); // tabs -> search
    await pressDialogKey({ name: 'n', sequence: '\u000E', ctrl: true }); // search -> list
    expect(lastFrame()).toContain('› [ ] qwen/qwen3-coder:free');

    await pressDialogKey({ name: 'n', sequence: '\u000E', ctrl: true }); // list highlight down
    expect(lastFrame()).toContain('› [ ] openai/gpt-4o-mini');

    await pressDialogKey({ name: 'p', sequence: '\u0010', ctrl: true }); // list highlight up
    expect(lastFrame()).toContain('› [ ] qwen/qwen3-coder:free');
    unmount();
  });
});
