/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  defaultContextBindings,
  parseContextBindings,
  defaultParsedBindings,
  indexBindingsByContext,
  findMatchingBinding,
} from './contextBindings.js';
import type { Key } from '../contexts/KeypressContext.js';
import { KEYBOARD_CONTEXTS } from '../contexts/KeyboardContextRegistry.js';

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

describe('defaultContextBindings', () => {
  it('has a block for every context that needs default bindings', () => {
    const contexts = defaultContextBindings.map((b) => b.context);
    // Global, Chat, Autocomplete, etc.
    expect(contexts).toContain('Global');
    expect(contexts).toContain('Chat');
    expect(contexts).toContain('Dialog');
  });

  it('all context names are valid', () => {
    const validContexts = new Set(KEYBOARD_CONTEXTS);
    for (const block of defaultContextBindings) {
      expect(validContexts.has(block.context)).toBe(true);
    }
  });

  it('Global has penetrate=true', () => {
    const globalBlock = defaultContextBindings.find(
      (b) => b.context === 'Global',
    );
    expect(globalBlock?.penetrate).toBe(true);
  });

  it('omits application text paste defaults on native Windows', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );

    try {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32',
      });
      vi.resetModules();

      const windowsBindings = await import('./contextBindings.js');
      for (const context of ['Chat', 'Dialog'] as const) {
        const block = windowsBindings.defaultContextBindings.find(
          (candidate) => candidate.context === context,
        );
        expect(block?.bindings['ctrl+v']).toBeUndefined();
        expect(block?.bindings['cmd+v']).toBeUndefined();
        expect(block?.bindings['alt+v']).toBe('input:pasteImage');
      }
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      vi.resetModules();
    }
  });
});

describe('parseContextBindings', () => {
  it('produces ParsedContextBinding objects', () => {
    const parsed = parseContextBindings([
      {
        context: 'Global',
        penetrate: true,
        bindings: {
          'ctrl+c': 'app:interrupt',
        },
      },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].context).toBe('Global');
    expect(parsed[0].action).toBe('app:interrupt');
    expect(parsed[0].penetrate).toBe(true);
    expect(
      parsed[0].keyBinding.matches(makeKey({ name: 'c', ctrl: true })),
    ).toBe(true);
  });

  it('skips null action values', () => {
    const parsed = parseContextBindings([
      {
        context: 'Chat',
        bindings: {
          enter: null, // Explicit unbind
          tab: 'input:queueMessage',
        },
      },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].action).toBe('input:queueMessage');
  });
});

describe('defaultParsedBindings', () => {
  it('is a non-empty array', () => {
    expect(defaultParsedBindings.length).toBeGreaterThan(0);
  });

  it('includes Global app:interrupt for ctrl+c', () => {
    const match = defaultParsedBindings.find(
      (b) => b.context === 'Global' && b.action === 'app:interrupt',
    );
    expect(match).toBeDefined();
    expect(match!.keyBinding.matches(makeKey({ name: 'c', ctrl: true }))).toBe(
      true,
    );
  });

  it('includes Chat input:submit for enter', () => {
    const match = defaultParsedBindings.find(
      (b) => b.context === 'Chat' && b.action === 'input:submit',
    );
    expect(match).toBeDefined();
    expect(match!.keyBinding.matches(makeKey({ name: 'enter' }))).toBe(true);
  });

  it('includes Chat input:pasteImage for Alt+V', () => {
    const match = defaultParsedBindings.find(
      (b) => b.context === 'Chat' && b.action === 'input:pasteImage',
    );
    expect(match).toBeDefined();
    expect(
      match!.keyBinding.matches(makeKey({ name: 'v', alt: true })),
    ).toBe(true);
  });

  it('maps Ctrl+R to model refresh in the Dialog context', () => {
    const match = defaultParsedBindings.find(
      (binding) =>
        binding.context === 'Dialog' && binding.action === 'model:refresh',
    );
    expect(match).toBeDefined();
    expect(match!.keyBinding.matches(makeKey({ name: 'r', ctrl: true }))).toBe(
      true,
    );
  });
});

describe('indexBindingsByContext', () => {
  it('groups bindings by context', () => {
    const index = indexBindingsByContext(defaultParsedBindings);
    expect(index.has('Global')).toBe(true);
    expect(index.has('Chat')).toBe(true);

    const globalBindings = index.get('Global')!;
    expect(globalBindings.length).toBeGreaterThan(0);
    expect(globalBindings.every((b) => b.context === 'Global')).toBe(true);
  });
});

describe('findMatchingBinding', () => {
  it('finds a matching binding for a key event', () => {
    const bindings = parseContextBindings([
      {
        context: 'Chat',
        bindings: {
          enter: 'input:submit',
          tab: 'input:queueMessage',
        },
      },
    ]);

    const match = findMatchingBinding(bindings, makeKey({ name: 'enter' }));
    expect(match?.action).toBe('input:submit');
  });

  it('returns undefined when no binding matches', () => {
    const bindings = parseContextBindings([
      {
        context: 'Chat',
        bindings: {
          enter: 'input:submit',
        },
      },
    ]);

    const match = findMatchingBinding(
      bindings,
      makeKey({ name: 'a', insertable: true }),
    );
    expect(match).toBeUndefined();
  });
});
