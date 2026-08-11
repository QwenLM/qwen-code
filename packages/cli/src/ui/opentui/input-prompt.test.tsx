/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component wiring tests for the OpenTUI input prompt's raw-input
 * Backspace handling. The native renderer (Bun/FFI) is exercised by the
 * separate PTY gate; here the OpenTUI hooks/jsx runtime are replaced with
 * fakes so the tests verify what the component itself guarantees:
 *
 *  - a renderer input handler is registered via useLayoutEffect before
 *    paint and removed on unmount;
 *  - legacy DEL/BS and the four valid kitty Backspace forms are consumed
 *    and call TextareaRenderable.deleteCharBackward exactly once each;
 *  - release/modified/invalid kitty forms are left unconsumed;
 *  - the printable fallback preserves ASCII/CJK/emoji (plain or
 *    Shift-produced) and rejects modifier/control/editing/navigation keys;
 *  - an unfocused prompt consumes nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render } from '@testing-library/react';
import { OpenTuiInputPrompt } from './input-prompt.js';

interface FakeEditor {
  plainText: string;
  deleteCharBackwardCalls: number;
  insertCalls: string[];
  deleteCharBackward(): boolean;
  insertText(text: string): void;
  setText(text: string): void;
  setCursor(row: number, col: number): void;
  clear(): void;
  gotoLineEnd(): void;
  newLine(): void;
}

const mocks = vi.hoisted(() => {
  const state = {
    inputHandlers: [] as Array<(sequence: string) => boolean>,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    editors: [] as unknown[],
  };

  function createFakeEditor() {
    let text = '';
    let col = 0;
    const editor = {
      get plainText() {
        return text;
      },
      get logicalCursor() {
        return { row: 0, col, offset: col };
      },
      get lineCount() {
        return text.split('\n').length;
      },
      get cursorOffset() {
        return col;
      },
      deleteCharBackwardCalls: 0,
      insertCalls: [] as string[],
      deleteCharBackward() {
        editor.deleteCharBackwardCalls += 1;
        if (col > 0) {
          text = text.slice(0, col - 1) + text.slice(col);
          col -= 1;
        }
        return true;
      },
      insertText(t: string) {
        editor.insertCalls.push(t);
        text = text.slice(0, col) + t + text.slice(col);
        col += t.length;
      },
      setText(t: string) {
        text = t;
        col = t.length;
      },
      setCursor(_row: number, c: number) {
        col = c;
      },
      clear() {
        text = '';
        col = 0;
      },
      gotoLineEnd() {
        col = text.length;
      },
      newLine() {},
    };
    return editor;
  }

  const renderer = {
    addInputHandler(handler: (sequence: string) => boolean) {
      state.inputHandlers.push(handler);
    },
    removeInputHandler(handler: (sequence: string) => boolean) {
      const index = state.inputHandlers.indexOf(handler);
      if (index >= 0) state.inputHandlers.splice(index, 1);
    },
  };

  async function buildJsxRuntime() {
    const React = await import('react');
    const FakeTextarea = React.forwardRef(
      (_props: unknown, ref: React.Ref<unknown>) => {
        const editor = React.useMemo(() => {
          const created = createFakeEditor();
          state.editors.push(created);
          return created;
        }, []);
        React.useImperativeHandle(ref, () => editor, [editor]);
        return null;
      },
    );
    FakeTextarea.displayName = 'FakeTextarea';
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'textarea') {
        return React.createElement(FakeTextarea, config);
      }
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }

  return { state, renderer, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useRenderer: () => mocks.renderer,
  useTerminalDimensions: () => ({ width: 80, height: 24 }),
}));

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
vi.mock('./slash-dispatch.js', () => ({
  loadInteractiveCommands: async () => [],
}));

function baseKeyEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a',
    sequence: 'a',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    eventType: 'press',
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  };
}

function lastKeyboardHandler(): (key: unknown) => void {
  const handler = mocks.state.keyboardHandlers.at(-1);
  if (!handler) throw new Error('no keyboard handler registered');
  return handler;
}

function currentEditor(): FakeEditor {
  const editor = mocks.state.editors.at(-1);
  if (!editor) throw new Error('no editor registered');
  return editor as FakeEditor;
}

async function typeText(text: string): Promise<void> {
  const handler = lastKeyboardHandler();
  await act(async () => {
    for (const char of text) {
      handler(baseKeyEvent({ name: char, sequence: char }));
    }
  });
}

async function pressRaw(sequence: string): Promise<boolean> {
  const handler = mocks.state.inputHandlers.at(-1);
  if (!handler) throw new Error('no raw input handler registered');
  let consumed = false;
  await act(async () => {
    consumed = handler(sequence);
  });
  return consumed;
}

describe('OpenTuiInputPrompt raw Backspace wiring', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
  });

  it('registers the raw input handler via useLayoutEffect before paint', () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    expect(mocks.state.inputHandlers).toHaveLength(1);
  });

  it('removes the raw input handler on unmount', () => {
    const view = render(
      <OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />,
    );
    view.unmount();
    expect(mocks.state.inputHandlers).toHaveLength(0);
  });

  it('consumes legacy DEL/BS and each valid kitty form, deleting one char each', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('abcdef');
    expect(editor.plainText).toBe('abcdef');
    for (const sequence of [
      '\x7f',
      '\x08',
      '\x1b[127u',
      '\x1b[127;1u',
      '\x1b[127;1:1u',
      '\x1b[127;1:2u',
    ]) {
      expect(await pressRaw(sequence)).toBe(true);
    }
    expect(editor.plainText).toBe('');
    expect(editor.deleteCharBackwardCalls).toBe(6);
  });

  it('calls deleteCharBackward exactly once per consumed sequence', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('xy');
    await pressRaw('\x1b[127u');
    expect(editor.deleteCharBackwardCalls).toBe(1);
    expect(editor.plainText).toBe('x');
  });

  it('rejects kitty release, modified and invalid forms', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('xy');
    for (const sequence of [
      '\x1b[127;1:3u', // release
      '\x1b[127;2u', // shift
      '\x1b[127;5u', // ctrl
      '\x1b[127;33u', // meta
      '\x1b[127:1;1u', // invalid ordering
      '\x1b[127;1:1;127u', // trailing text parameter
      '\x1b[97u', // 'a'
    ]) {
      expect(await pressRaw(sequence)).toBe(false);
    }
    expect(editor.deleteCharBackwardCalls).toBe(0);
    expect(editor.plainText).toBe('xy');
  });

  it('consumes nothing while unfocused', async () => {
    render(
      <OpenTuiInputPrompt
        onSubmit={() => {}}
        userMessages={[]}
        focus={false}
      />,
    );
    expect(await pressRaw('\x7f')).toBe(false);
    expect(await pressRaw('\x1b[127u')).toBe(false);
    const editor = currentEditor();
    expect(editor.deleteCharBackwardCalls).toBe(0);
  });
});

describe('OpenTuiInputPrompt printable fallback', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
  });

  it('preserves ASCII, CJK and emoji, inserting each exactly once', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('a中😀');
    expect(editor.plainText).toBe('a中😀');
    expect([...editor.insertCalls]).toEqual(['a', '中', '😀']);
  });

  it('accepts Shift-produced printable input', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await act(async () => {
      lastKeyboardHandler()(
        baseKeyEvent({ name: 'a', sequence: 'A', shift: true }),
      );
    });
    expect(editor.plainText).toBe('A');
  });

  it('rejects ctrl/meta/option/super/hyper combinations', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    for (const overrides of [
      { sequence: 'w', ctrl: true },
      { sequence: 'w', meta: true },
      { sequence: 'ø', option: true },
      { sequence: 'w', super: true },
      { sequence: 'w', hyper: true },
      { sequence: 'W', shift: true, ctrl: true },
    ]) {
      await act(async () => {
        lastKeyboardHandler()(baseKeyEvent(overrides));
      });
    }
    expect(editor.insertCalls).toEqual([]);
    expect(editor.plainText).toBe('');
  });

  it('rejects release events', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ eventType: 'release' }));
    });
    expect(editor.insertCalls).toEqual([]);
  });

  it('rejects controls, tabs and escape-coded editing/navigation keys', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    for (const overrides of [
      { name: 'tab', sequence: '\t' },
      { name: 'return', sequence: '\r' },
      { name: 'left', sequence: '\x1b[D' },
      { name: 'delete', sequence: '\x1b[3~' },
      { name: 'backspace', sequence: '\x1b[127u' },
      { name: 'c', sequence: '\x03', ctrl: true },
    ]) {
      await act(async () => {
        lastKeyboardHandler()(baseKeyEvent(overrides));
      });
    }
    expect(editor.insertCalls).toEqual([]);
  });
});

describe('OpenTuiInputPrompt submit guard', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
  });

  it('Enter still submits the typed text', async () => {
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    const editor = currentEditor();
    await typeText('vw');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual(['vw']);
    expect(editor.plainText).toBe('');
  });
});
