/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolve, mergeBindingIndex } from './contextResolver.js';
import {
  parseContextBindings,
  indexBindingsByContext,
  defaultParsedBindings,
} from './contextBindings.js';
import type { Key } from '../contexts/KeypressContext.js';
import type { KeyboardContextName } from '../contexts/KeyboardContextRegistry.js';

function makeKey(overrides: Partial<Key>): Key {
  return {
    name: '',
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: false,
    sequence: '',
    ...overrides,
  };
}

function activeSet(
  ...names: KeyboardContextName[]
): ReadonlySet<KeyboardContextName> {
  return new Set(names);
}

const defaultIndex = indexBindingsByContext(defaultParsedBindings);

describe('resolve', () => {
  describe('Global penetration', () => {
    it('Ctrl+C resolves to app:interrupt when only Fullscreen is active (no Chat)', () => {
      // With ctrl+c as non-penetrating Global, it resolves to Global:app:interrupt
      // only when no higher-priority context has a ctrl+c binding.
      // Fullscreen has no ctrl+c binding, so Global's non-penetrating binding matches.
      const result = resolve(
        makeKey({ name: 'c', ctrl: true }),
        activeSet('Global', 'Fullscreen'),
        defaultIndex,
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe('app:interrupt');
      expect(result!.context).toBe('Global');
      // Non-penetrating now — not checked in step 1
      expect(result!.penetrated).toBe(false);
    });

    it('Ctrl+C resolves to Chat:edit:clear when Chat is active', () => {
      // With ctrl+c moved to non-penetrating Global, Chat:edit:clear takes priority
      // because Chat (priority 10) is checked before Global non-penetrating (step 4).
      // This allows InputPrompt to clear the buffer + reset completion state.
      const result = resolve(
        makeKey({ name: 'c', ctrl: true }),
        activeSet('Global', 'Chat', 'Dialog'),
        defaultIndex,
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe('edit:clear');
      expect(result!.context).toBe('Chat');
      expect(result!.penetrated).toBe(false);
    });
  });

  describe('Layer priority', () => {
    it('Autocomplete captures Up before Chat when both active', () => {
      const result = resolve(
        makeKey({ name: 'up' }),
        activeSet('Global', 'Chat', 'Autocomplete'),
        defaultIndex,
      );
      expect(result).not.toBeNull();
      expect(result!.context).toBe('Autocomplete');
      expect(result!.action).toBe('suggest:focusPrevious');
    });

    it('Dialog captures Escape before Chat', () => {
      const result = resolve(
        makeKey({ name: 'escape' }),
        activeSet('Global', 'Chat', 'Dialog'),
        defaultIndex,
      );
      expect(result).not.toBeNull();
      expect(result!.context).toBe('Dialog');
      expect(result!.action).toBe('dialog:escape');
    });

    it('Dialog captures Ctrl+R before Vim redo and chat history search', () => {
      const result = resolve(
        makeKey({ name: 'r', ctrl: true }),
        activeSet('Global', 'Chat', 'HistorySearch', 'VimNormal', 'Dialog'),
        defaultIndex,
      );
      expect(result).not.toBeNull();
      expect(result!.context).toBe('Dialog');
      expect(result!.action).toBe('model:refresh');
    });

  });

  describe('Single context', () => {
    it('Chat resolves enter to input:submit', () => {
      const result = resolve(
        makeKey({ name: 'enter' }),
        activeSet('Global', 'Chat'),
        defaultIndex,
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe('input:submit');
      expect(result!.context).toBe('Chat');
    });
  });

  describe('No match', () => {
    it('returns null for unbound key', () => {
      const result = resolve(
        makeKey({ name: 'f20' }),
        activeSet('Global', 'Chat'),
        defaultIndex,
      );
      expect(result).toBeNull();
    });

    it('returns null with no active contexts', () => {
      const result = resolve(
        makeKey({ name: 'enter' }),
        activeSet(),
        defaultIndex,
      );
      expect(result).toBeNull();
    });
  });

});

describe('mergeBindingIndex', () => {
  it('adds user bindings to existing context', () => {
    const userBindings = parseContextBindings([
      {
        context: 'Chat',
        bindings: {
          f3: 'custom:action',
        },
      },
    ]);

    const merged = mergeBindingIndex(userBindings);
    const chatBindings = merged.get('Chat')!;
    const customBinding = chatBindings.find(
      (b) => b.action === 'custom:action',
    );
    expect(customBinding).toBeDefined();
  });

  it('overrides existing binding with same key', () => {
    const userBindings = parseContextBindings([
      {
        context: 'Chat',
        bindings: {
          enter: 'custom:overrideSubmit',
        },
      },
    ]);

    const merged = mergeBindingIndex(userBindings);
    const chatBindings = merged.get('Chat')!;
    // The enter binding should now map to the override
    const enterBinding = chatBindings.find((b) =>
      b.keyBinding.matches(makeKey({ name: 'enter' })),
    );
    expect(enterBinding?.action).toBe('custom:overrideSubmit');
  });
});
