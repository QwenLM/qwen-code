/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
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
import { render, screen } from '@testing-library/react';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { OpenTuiInputPrompt } from './input-prompt.js';
import { cpLen, cpSlice } from '../utils/textUtils.js';
import {
  codePointIndexToDisplayCol,
  displayColToCodePointIndex,
} from './input-prompt-model.js';

interface FakeEditor {
  plainText: string;
  cursorOffset: number;
  deleteCharBackwardCalls: number;
  deleteWordBackwardCalls: number;
  newLineCalls: number;
  insertCalls: string[];
  deleteCharBackward(): boolean;
  deleteWordBackward(): boolean;
  insertText(text: string): void;
  setText(text: string): void;
  setCursor(row: number, col: number): void;
  setCursorByOffset(offset: number): void;
  clear(): void;
  gotoLineEnd(): void;
  newLine(): void;
}

const mocks = vi.hoisted(() => {
  const state = {
    inputHandlers: [] as Array<(sequence: string) => boolean>,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    editors: [] as unknown[],
    pasteHandlers: [] as Array<(event: unknown) => void>,
    slashCommands: [] as unknown[],
    fileSearchResults: [] as string[],
    fileSearchDelay: Promise.resolve() as Promise<void>,
  };

  function createFakeEditor() {
    // The fake models the REAL editor contract: cursor coordinates are
    // display-width (terminal-cell) units, exactly like the pinned
    // @opentui/core's edit-buffer (row/col/offset in display width). The
    // cursor position is tracked internally as a code-point column and
    // converted with the production converters, so wide characters make
    // reads and writes diverge from string indices like they do natively.
    let text = '';
    let col = 0; // code-point column within row 0 (the fake is single-line)
    const displayCol = () => codePointIndexToDisplayCol(text, col);
    const setColFromDisplay = (display: number) => {
      col = displayColToCodePointIndex(text, display);
    };
    const editor = {
      get plainText() {
        return text;
      },
      get logicalCursor() {
        return { row: 0, col: displayCol(), offset: displayCol() };
      },
      get lineCount() {
        return text.split('\n').length;
      },
      get cursorOffset() {
        return displayCol();
      },
      set cursorOffset(offset: number) {
        setColFromDisplay(offset);
      },
      deleteCharBackwardCalls: 0,
      deleteWordBackwardCalls: 0,
      newLineCalls: 0,
      insertCalls: [] as string[],
      deleteCharBackward() {
        editor.deleteCharBackwardCalls += 1;
        if (col > 0) {
          text = cpSlice(text, 0, col - 1) + cpSlice(text, col);
          col -= 1;
        }
        return true;
      },
      deleteWordBackward() {
        // Coarse whitespace-word delete, enough to observe the wiring.
        editor.deleteWordBackwardCalls += 1;
        const before = cpSlice(text, 0, col);
        const match = /^(.*?)(\S+\s*)$/s.exec(before);
        if (match?.[1] !== undefined) {
          text = match[1] + cpSlice(text, col);
          col = cpLen(match[1]);
        }
        return true;
      },
      insertText(t: string) {
        editor.insertCalls.push(t);
        text = cpSlice(text, 0, col) + t + cpSlice(text, col);
        col += cpLen(t);
      },
      setText(t: string) {
        text = t;
        col = cpLen(t);
      },
      setCursor(_row: number, c: number) {
        setColFromDisplay(c);
      },
      setCursorByOffset(offset: number) {
        setColFromDisplay(offset);
      },
      clear() {
        text = '';
        col = 0;
      },
      gotoLineEnd() {
        col = cpLen(text);
      },
      newLine() {
        editor.newLineCalls += 1;
      },
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
    // Minimal keyInput emitter: the component registers its large-paste
    // interceptor via renderer.keyInput.on('paste', …).
    keyInput: {
      on(event: string, handler: (event: unknown) => void) {
        if (event === 'paste') state.pasteHandlers.push(handler);
      },
      off(event: string, handler: (event: unknown) => void) {
        if (event !== 'paste') return;
        const index = state.pasteHandlers.indexOf(handler);
        if (index >= 0) state.pasteHandlers.splice(index, 1);
      },
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

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    FileSearchFactory: {
      create: () => ({
        initialize: async () => {},
        search: async () => {
          await mocks.state.fileSearchDelay;
          return mocks.state.fileSearchResults;
        },
        dispose: async () => {},
      }),
    },
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
vi.mock('./slash-dispatch.js', () => ({
  loadInteractiveCommands: async () => mocks.state.slashCommands,
}));
vi.mock('../utils/clipboardUtils.js', () => ({
  clipboardHasImage: async () => true,
  saveClipboardImage: async () => '/tmp/clipboard-test.png',
  cleanupOldClipboardImages: async () => {},
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
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
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
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
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
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
    mocks.state.fileSearchResults = [];
    mocks.state.fileSearchDelay = Promise.resolve();
  });

  it('Esc invalidates in-flight @ searches: a late resolve must not reopen the dropdown (R2-2)', async () => {
    let releaseSearch!: () => void;
    mocks.state.fileSearchResults = ['hit-file.txt'];
    mocks.state.fileSearchDelay = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    const editor = currentEditor();
    await typeText('@x');
    // Give the async initialize+search chain a tick to start.
    await act(async () => {});
    // Esc dismisses the dropdown while the search is still pending.
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'escape', sequence: '\x1b' }));
    });
    // The late resolution must not re-populate the dismissed dropdown.
    releaseSearch();
    await act(async () => {});
    // Enter submits the typed text instead of accepting the stale hit.
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual(['@x']);
    expect(editor.plainText).toBe('');
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

  it('Shift/Ctrl/Meta+Enter insert a newline instead of submitting', async () => {
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    const editor = currentEditor();
    await typeText('ab');
    for (const overrides of [
      { name: 'return', sequence: '\r', shift: true },
      { name: 'return', sequence: '\r', ctrl: true },
      { name: 'return', sequence: '\r', meta: true },
      { name: 'kpenter', sequence: '\r', shift: true },
    ]) {
      await act(async () => {
        lastKeyboardHandler()(baseKeyEvent(overrides));
      });
    }
    expect(editor.newLineCalls).toBe(4);
    expect(submitted).toEqual([]);
    expect(editor.plainText).toBe('ab');
  });

  it('Ctrl+V attaches the clipboard image and submits it with the text', async () => {
    const submitted: Array<{ text: string; images?: string[] }> = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text, images) => submitted.push({ text, images })}
        userMessages={[]}
      />,
    );
    const editor = currentEditor();
    await act(async () => {
      lastKeyboardHandler()(
        baseKeyEvent({ name: 'v', sequence: '\x16', ctrl: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await typeText('hi');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([
      { text: 'hi', images: ['/tmp/clipboard-test.png'] },
    ]);
    expect(editor.plainText).toBe('');
  });

  it('Esc pops queued prompts into the composer before the clear window', async () => {
    render(
      <OpenTuiInputPrompt
        onSubmit={() => {}}
        userMessages={[]}
        queueLength={1}
        onPopQueue={() => 'queued text'}
      />,
    );
    const editor = currentEditor();
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'escape', sequence: '\x1b' }));
    });
    expect(editor.plainText).toBe('queued text');
  });

  it('Up at the top edge pops queued prompts into the composer', async () => {
    let queued: string | null = 'from queue';
    render(
      <OpenTuiInputPrompt
        onSubmit={() => {}}
        userMessages={[]}
        queueLength={1}
        onPopQueue={() => {
          const q = queued;
          queued = null;
          return q;
        }}
      />,
    );
    const editor = currentEditor();
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'up', sequence: '\x1b[A' }));
    });
    expect(editor.plainText).toBe('from queue');
  });
});

describe('OpenTuiInputPrompt `\\`+Enter continuation (G3)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
  });

  it('turns a trailing backslash into a newline instead of submitting', async () => {
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    const editor = currentEditor();
    await typeText('ab\\');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([]);
    expect(editor.newLineCalls).toBe(1);
    expect(editor.plainText).toBe('ab'); // backslash removed
  });

  it('submits once the backslash is no longer right before the caret', async () => {
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    await typeText('ab\\cd');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual(['ab\\cd']);
  });

  it('keeps whitespace-only input a no-op', async () => {
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    await typeText('   ');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([]);
  });
});

describe('OpenTuiInputPrompt DELETE_WORD_BACKWARD (G9)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
  });

  it('consumes the MinTTY/legacy \\x1f byte raw and deletes one word', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('foo bar');
    expect(await pressRaw('\x1f')).toBe(true);
    expect(editor.deleteWordBackwardCalls).toBe(1);
    expect(editor.plainText).toBe('foo ');
  });

  it('handles parsed ctrl+backspace (kitty CSI 127;5u shape)', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('foo bar');
    await act(async () => {
      lastKeyboardHandler()(
        baseKeyEvent({
          name: 'backspace',
          sequence: '\x1b[127;5u',
          ctrl: true,
        }),
      );
    });
    expect(editor.deleteWordBackwardCalls).toBe(1);
    expect(editor.plainText).toBe('foo ');
  });

  it('handles command/super+backspace', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('foo bar');
    await act(async () => {
      lastKeyboardHandler()(
        baseKeyEvent({ name: 'backspace', sequence: '\x7f', super: true }),
      );
    });
    expect(editor.deleteWordBackwardCalls).toBe(1);
  });

  it('ignores backspace release events', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const editor = currentEditor();
    await typeText('foo');
    await act(async () => {
      lastKeyboardHandler()(
        baseKeyEvent({
          name: 'backspace',
          sequence: '\x1b[127;5:3u',
          ctrl: true,
          eventType: 'release',
        }),
      );
    });
    expect(editor.deleteWordBackwardCalls).toBe(0);
  });
});

describe('OpenTuiInputPrompt large-paste collapsing (G10)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
  });

  function registerPasteListener() {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const handler = mocks.state.pasteHandlers.at(-1);
    if (!handler) throw new Error('no paste handler registered');
    return handler;
  }

  async function emitPaste(
    handler: (event: unknown) => void,
    text: string,
  ): Promise<ReturnType<typeof vi.fn>> {
    const preventDefault = vi.fn();
    const event = {
      bytes: new TextEncoder().encode(text),
      preventDefault,
    };
    await act(async () => {
      handler(event);
    });
    return preventDefault;
  }

  it('registers and unregisters the paste interceptor', () => {
    const view = render(
      <OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />,
    );
    expect(mocks.state.pasteHandlers).toHaveLength(1);
    view.unmount();
    expect(mocks.state.pasteHandlers).toHaveLength(0);
  });

  it('leaves small pastes to the editor (no preventDefault)', async () => {
    const handler = registerPasteListener();
    const preventDefault = await emitPaste(handler, 'small paste');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(currentEditor().plainText).toBe('');
  });

  it('collapses a char-threshold paste into a placeholder', async () => {
    const handler = registerPasteListener();
    const big = 'x'.repeat(1001);
    const preventDefault = await emitPaste(handler, big);
    expect(preventDefault).toHaveBeenCalled();
    expect(currentEditor().plainText).toBe('[Pasted Content 1001 chars]');
  });

  it('collapses a line-threshold paste into a placeholder', async () => {
    const handler = registerPasteListener();
    const lines = Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n');
    await emitPaste(handler, lines);
    const editor = currentEditor();
    expect(editor.plainText).toMatch(/^\[Pasted Content \d+ chars\]$/);
  });

  it('expands placeholders back to the pasted content on submit', async () => {
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    const handler = mocks.state.pasteHandlers.at(-1);
    if (!handler) throw new Error('no paste handler registered');
    const big = 'pasted\ncontent';
    await emitPaste(handler, big.padEnd(1200, ' '));
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([big.padEnd(1200, ' ')]);
  });

  it('backspace at the placeholder end removes the whole placeholder', async () => {
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const handler = mocks.state.pasteHandlers.at(-1);
    if (!handler) throw new Error('no paste handler registered');
    await emitPaste(handler, 'y'.repeat(1500));
    const editor = currentEditor();
    expect(editor.plainText).toBe('[Pasted Content 1500 chars]');
    expect(await pressRaw('\x7f')).toBe(true);
    expect(editor.plainText).toBe('');
    // The freed id is reused by the next same-size paste.
    await emitPaste(handler, 'z'.repeat(1500));
    expect(editor.plainText).toBe('[Pasted Content 1500 chars]');
  });

  it('backspace removes the placeholder whole after wide characters (R2-1)', async () => {
    // 你好 occupies 4 display cells but 2 code points: the cursor's
    // display offset (4 + placeholder width) is NOT its code-point index
    // (2 + placeholder length). Placeholder deletion must convert first —
    // the old code sliced with the display offset and never matched.
    render(<OpenTuiInputPrompt onSubmit={() => {}} userMessages={[]} />);
    const handler = mocks.state.pasteHandlers.at(-1);
    if (!handler) throw new Error('no paste handler registered');
    const editor = currentEditor();
    await typeText('你好');
    await emitPaste(handler, 'y'.repeat(1500));
    expect(editor.plainText).toBe('你好[Pasted Content 1500 chars]');
    const placeholder = editor.plainText.slice('你好'.length);
    expect(editor.cursorOffset).toBe(4 + placeholder.length);
    expect(await pressRaw('\x7f')).toBe(true);
    expect(editor.plainText).toBe('你好');
    expect(editor.cursorOffset).toBe(4);
    expect(editor.deleteCharBackwardCalls).toBe(0);
  });

  it('Enter after 你好 + backslash continues the line instead of submitting (R2-1)', async () => {
    // The trailing-backslash check reads the char before the caret; with
    // wide characters the display offset (5) must convert to the code-point
    // index (3) before the lookup, or Enter submits instead of continuing.
    const submitted: string[] = [];
    render(
      <OpenTuiInputPrompt
        onSubmit={(text) => submitted.push(text)}
        userMessages={[]}
      />,
    );
    const editor = currentEditor();
    await typeText('你好\\');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([]);
    expect(editor.newLineCalls).toBe(1);
    expect(editor.deleteCharBackwardCalls).toBe(1);
  });
});

describe('OpenTuiInputPrompt Enter accepts completions (G-13)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.editors.length = 0;
    mocks.state.pasteHandlers.length = 0;
    mocks.state.slashCommands = [];
  });

  async function renderWithCommands(
    commands: unknown[],
    onSubmit: (text: string) => void = () => {},
  ) {
    mocks.state.slashCommands = commands;
    render(<OpenTuiInputPrompt onSubmit={onSubmit} userMessages={[]} />);
    // Let loadInteractiveCommands resolve into commandsRef.
    await act(async () => {});
  }

  it('Enter fills the highlighted candidate instead of submitting `/he`', async () => {
    const submitted: string[] = [];
    await renderWithCommands(
      [{ name: 'help', description: 'Show help', kind: 'built-in' }],
      (text) => submitted.push(text),
    );
    const editor = currentEditor();
    await typeText('/he');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([]);
    expect(editor.plainText).toBe('/help ');
  });

  it('Tab also accepts without submitting', async () => {
    const submitted: string[] = [];
    await renderWithCommands(
      [{ name: 'help', description: 'Show help', kind: 'built-in' }],
      (text) => submitted.push(text),
    );
    const editor = currentEditor();
    await typeText('/he');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'tab', sequence: '\t' }));
    });
    expect(submitted).toEqual([]);
    expect(editor.plainText).toBe('/help ');
  });

  it('a perfect match submits directly on Enter', async () => {
    const submitted: string[] = [];
    await renderWithCommands(
      [
        {
          name: 'help',
          description: 'Show help',
          kind: 'built-in',
          action: () => undefined,
        },
      ],
      (text) => submitted.push(text),
    );
    await typeText('/help');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual(['/help']);
  });

  it('after navigating, Enter fills the highlighted sub-command', async () => {
    const submitted: string[] = [];
    await renderWithCommands(
      [
        {
          name: 'directory',
          description: 'Manage directories',
          kind: 'built-in',
          action: () => undefined,
          subCommands: [
            { name: 'add', description: 'Add', kind: 'built-in' },
            { name: 'list', description: 'List', kind: 'built-in' },
          ],
        },
      ],
      (text) => submitted.push(text),
    );
    const editor = currentEditor();
    await typeText('/directory');
    // Dropdown shows [add, list]; navigate to `list`.
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'down', sequence: '\x1b[B' }));
    });
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual([]);
    expect(editor.plainText).toBe('/directory list ');
  });

  it('sub-command candidates appear after `<cmd> ` and accept via Enter', async () => {
    await renderWithCommands([
      {
        name: 'directory',
        description: 'Manage directories',
        kind: 'built-in',
        subCommands: [
          { name: 'add', description: 'Add', kind: 'built-in' },
          { name: 'list', description: 'List', kind: 'built-in' },
        ],
      },
    ]);
    const editor = currentEditor();
    await typeText('/directory ad');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(editor.plainText).toBe('/directory add ');
  });

  it('argument completion feeds the leaf command completion()', async () => {
    const completion = vi.fn(async (_ctx: unknown, partialArg: string) =>
      ['/tmp/a', '/tmp/b'].filter((p) => p.startsWith(partialArg || '/')),
    );
    await renderWithCommands([
      {
        name: 'cd',
        description: 'Change directory',
        kind: 'built-in',
        completion,
      },
    ]);
    const editor = currentEditor();
    await typeText('/cd ');
    // Async completion settles.
    await act(async () => {});
    expect(completion).toHaveBeenCalled();
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(editor.plainText).toBe('/cd /tmp/a ');
  });

  it('submitOnAccept suggestions submit `/<value>` on Enter', async () => {
    const submitted: string[] = [];
    await renderWithCommands(
      [
        {
          name: 'skills',
          description: 'Manage skills',
          kind: 'built-in',
          submitOnAccept: true,
        },
      ],
      (text) => submitted.push(text),
    );
    const editor = currentEditor();
    await typeText('/skil');
    await act(async () => {
      lastKeyboardHandler()(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    expect(submitted).toEqual(['/skills']);
    expect(editor.plainText).toBe('');
  });
});

describe('OpenTuiInputPrompt approval-mode indicator', () => {
  // The mode text is the only on-screen proof an auto-accept mode took
  // effect, and the OpenTUI interactive e2e leg's readiness poll greps the
  // terminal for it. Asserted through the same translation call the component
  // makes, so a non-English locale cannot flip the pin.
  const renderWithMode = (approvalMode: ApprovalMode) =>
    render(
      <OpenTuiInputPrompt
        onSubmit={() => {}}
        userMessages={[]}
        approvalMode={approvalMode}
      />,
    );

  it.each<[ApprovalMode, string]>([
    [ApprovalMode.YOLO, 'YOLO mode'],
    [ApprovalMode.AUTO_EDIT, 'Accepting edits'],
    [ApprovalMode.AUTO, 'Auto mode'],
  ])('draws the %s status text', (approvalMode, key) => {
    renderWithMode(approvalMode);
    expect(screen.getByText(t(key))).toBeTruthy();
  });

  it.each<ApprovalMode>([ApprovalMode.PLAN, ApprovalMode.DEFAULT])(
    'draws no status text for %s, matching ink',
    (approvalMode) => {
      renderWithMode(approvalMode);
      for (const key of ['YOLO mode', 'Accepting edits', 'Auto mode']) {
        expect(screen.queryByText(t(key))).toBeNull();
      }
    },
  );
});
