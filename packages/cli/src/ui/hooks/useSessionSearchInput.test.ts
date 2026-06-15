/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  isPrintableSearchChar,
  useSessionSearchInput,
} from './useSessionSearchInput.js';
import type { Key } from './useKeypress.js';

function k(overrides: Partial<Key>): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...overrides,
  };
}

describe('isPrintableSearchChar', () => {
  it('accepts a single printable ASCII char', () => {
    expect(isPrintableSearchChar(k({ name: 'a', sequence: 'a' }))).toBe(true);
  });

  it('accepts SPACE — caller decides whether to seed it', () => {
    // The picker's outer handler suppresses leading-whitespace queries
    // separately. The predicate itself only filters by character class.
    expect(isPrintableSearchChar(k({ name: 'space', sequence: ' ' }))).toBe(
      true,
    );
  });

  it('rejects Ctrl-modified keys', () => {
    expect(
      isPrintableSearchChar(k({ name: 'a', sequence: 'a', ctrl: true })),
    ).toBe(false);
  });

  it('rejects Meta-modified keys', () => {
    expect(
      isPrintableSearchChar(k({ name: 'a', sequence: 'a', meta: true })),
    ).toBe(false);
  });

  it('rejects bracketed pastes (multi-line content must never seed a query)', () => {
    expect(
      isPrintableSearchChar(k({ name: 'paste', sequence: 'a', paste: true })),
    ).toBe(false);
  });

  it('rejects multi-character sequences (e.g. CSI escape sequences)', () => {
    expect(isPrintableSearchChar(k({ name: 'up', sequence: '[A' }))).toBe(
      false,
    );
  });

  it('rejects empty sequences (synthetic / structural keys)', () => {
    expect(isPrintableSearchChar(k({ name: 'return', sequence: '' }))).toBe(
      false,
    );
  });

  it('rejects control characters below 0x20 (Tab, Enter, Esc)', () => {
    expect(isPrintableSearchChar(k({ name: 'tab', sequence: '\t' }))).toBe(
      false,
    );
    expect(isPrintableSearchChar(k({ name: 'return', sequence: '\r' }))).toBe(
      false,
    );
    expect(isPrintableSearchChar(k({ name: 'escape', sequence: '' }))).toBe(
      false,
    );
  });

  it('rejects DEL (0x7F) — Backspace would otherwise slip through', () => {
    expect(isPrintableSearchChar(k({ name: 'backspace', sequence: '' }))).toBe(
      false,
    );
  });
});

describe('isDeletionKey', () => {
  it('recognises DEL byte (0x7F) as a deletion key', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    expect(result.current.searchQuery).toBe('a');
    // Raw DEL byte with no name — the Windows Backspace path
    act(() => {
      result.current.handleSearchKey(k({ name: '', sequence: '\x7f' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('recognises BS byte (0x08) as a deletion key', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'x', sequence: 'x' }));
    });
    expect(result.current.searchQuery).toBe('x');
    // Raw BS byte with no name — alternate Windows Backspace path
    act(() => {
      result.current.handleSearchKey(k({ name: '', sequence: '\b' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('does not treat DEL/BS byte as a printable char', () => {
    expect(isPrintableSearchChar(k({ name: '', sequence: '\x7f' }))).toBe(
      false,
    );
    expect(isPrintableSearchChar(k({ name: '', sequence: '\b' }))).toBe(false);
  });

  it('does not treat Ctrl+H (BS byte with ctrl) as a deletion key', () => {
    // Ctrl+H delivers name:'h', ctrl:true, sequence:'\b' on many terminals.
    // The byte fallback must not fire when a modifier is active.
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    expect(result.current.searchQuery).toBe('a');
    // Ctrl+H must be swallowed, not treated as Backspace
    act(() => {
      result.current.handleSearchKey(
        k({ name: 'h', sequence: '\b', ctrl: true }),
      );
    });
    expect(result.current.searchQuery).toBe('a');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('does not treat Meta+BS byte as a deletion key', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    expect(result.current.searchQuery).toBe('a');
    act(() => {
      result.current.handleSearchKey(
        k({ name: '', sequence: '\x7f', meta: true }),
      );
    });
    expect(result.current.searchQuery).toBe('a');
    expect(onExitToList).not.toHaveBeenCalled();
  });
});

describe('useSessionSearchInput', () => {
  // Each keystroke gets its own act() — terminal events arrive in
  // separate render cycles, and the ref-backed setter fires
  // onExitToList synchronously within the state updater when it
  // detects a non-empty → empty transition. Batching multiple keys
  // into one act() collapses the intermediate states the setter
  // needs to observe.

  it('starts with an empty query', () => {
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList: vi.fn() }),
    );
    expect(result.current.searchQuery).toBe('');
  });

  it('does not fire onExitToList on initial mount with the default empty query', () => {
    // Pin the prev-ref guard: the setter must distinguish "started
    // empty" from "transitioned to empty". Without the guard, every
    // mount with a default-empty query would falsely call the parent
    // out of search mode before search ever started.
    const onExitToList = vi.fn();
    renderHook(() => useSessionSearchInput({ onExitToList }));
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('appends a printable char to the query', () => {
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList: vi.fn() }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    expect(result.current.searchQuery).toBe('a');
  });

  it('accumulates printable chars across separate keystrokes', () => {
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList: vi.fn() }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'b', sequence: 'b' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'c', sequence: 'c' }));
    });
    expect(result.current.searchQuery).toBe('abc');
  });

  it('Backspace pops one char without exiting while query stays non-empty', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'b', sequence: 'b' }));
    });
    expect(result.current.searchQuery).toBe('ab');

    act(() => {
      result.current.handleSearchKey(k({ name: 'backspace', sequence: '' }));
    });
    expect(result.current.searchQuery).toBe('a');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('Backspace through the last char clears the query AND exits to list', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'backspace', sequence: '' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('Delete behaves like Backspace (pop + exit on empty)', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'delete' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('Esc clears any current query and exits to list', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'b', sequence: 'b' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'escape', sequence: '' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+U wipes the query and exits — single-stroke equivalent of full Backspace', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'b', sequence: 'b' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'c', sequence: 'c' }));
    });
    act(() => {
      result.current.handleSearchKey(
        k({ name: 'u', sequence: '', ctrl: true }),
      );
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+L wipes the query and exits (alias of Ctrl+U for muscle-memory parity)', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    act(() => {
      result.current.handleSearchKey(
        k({ name: 'l', sequence: '', ctrl: true }),
      );
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('silently swallows unrecognized keys (search owns the keyboard)', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'a', sequence: 'a' }));
    });
    // Tab, Page-Up, and Ctrl+B all hit search while focused — they
    // must neither mutate the query nor leak through as exits.
    act(() => {
      result.current.handleSearchKey(k({ name: 'tab', sequence: '\t' }));
    });
    act(() => {
      result.current.handleSearchKey(k({ name: 'pageup' }));
    });
    act(() => {
      result.current.handleSearchKey(
        k({ name: 'b', sequence: '', ctrl: true }),
      );
    });
    expect(result.current.searchQuery).toBe('a');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it("exposes setSearchQuery for the parent's implicit-entry path", () => {
    // The picker uses this to seed the query when a printable char
    // arrives in list mode — covered here as a smoke test that the
    // setter (functional and direct) round-trips through the hook
    // independently of handleSearchKey.
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.setSearchQuery('seed');
    });
    expect(result.current.searchQuery).toBe('seed');
    // Seeding the query (empty → non-empty) must NOT trigger exit.
    expect(onExitToList).not.toHaveBeenCalled();

    act(() => {
      result.current.setSearchQuery((q) => `${q}-more`);
    });
    expect(result.current.searchQuery).toBe('seed-more');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('fires onExitToList when setSearchQuery direct-empty is called on a non-empty query', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.setSearchQuery('seed');
    });
    expect(result.current.searchQuery).toBe('seed');
    expect(onExitToList).not.toHaveBeenCalled();
    act(() => {
      result.current.setSearchQuery('');
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).toHaveBeenCalledTimes(1);
  });

  it('does not fire onExitToList when setSearchQuery direct-empty is called on an already-empty query', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.setSearchQuery('');
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('does not fire onExitToList when Backspace is pressed on an already-empty query', () => {
    // The prev !== '' guard must prevent a false exit when the user
    // presses Backspace (or Delete) while the query is already empty.
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'backspace', sequence: '' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('does not fire onExitToList when Esc is pressed on an already-empty query', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(k({ name: 'escape', sequence: '' }));
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('does not fire onExitToList when Ctrl+U is pressed on an already-empty query', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(
        k({ name: 'u', sequence: '', ctrl: true }),
      );
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).not.toHaveBeenCalled();
  });

  it('does not fire onExitToList when Ctrl+L is pressed on an already-empty query', () => {
    const onExitToList = vi.fn();
    const { result } = renderHook(() =>
      useSessionSearchInput({ onExitToList }),
    );
    act(() => {
      result.current.handleSearchKey(
        k({ name: 'l', sequence: '', ctrl: true }),
      );
    });
    expect(result.current.searchQuery).toBe('');
    expect(onExitToList).not.toHaveBeenCalled();
  });
});
