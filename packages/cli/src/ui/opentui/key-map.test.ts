/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI keyboard layer resolves the ORIGINAL keybinding table
 * (packages/cli/src/config/keyBindings.ts via ui/keyMatchers) — same
 * shortcuts, same semantics as the ink TUI.
 */

import { describe, it, expect } from 'vitest';
import {
  Command,
  OPENTUI_COMMAND_PRIORITY,
  matchesCommand,
  resolveCommand,
  resolveCommands,
  toOriginalKey,
  type OpenTuiKeyInput,
} from './key-map.js';

const key = (input: Partial<OpenTuiKeyInput> & { name: string }) => input;

describe('opentui key-map: translation', () => {
  it('maps OpenTUI key events onto the original Key shape', () => {
    expect(toOriginalKey({ name: 'return', sequence: '\r' })).toEqual({
      name: 'return',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '\r',
    });
  });

  it('folds the macOS Option flag into meta like the original', () => {
    expect(toOriginalKey({ name: 't', option: true }).meta).toBe(true);
    expect(toOriginalKey({ name: 't', meta: true }).meta).toBe(true);
  });

  it("normalizes opentui's kitty 'kpenter' onto the original 'return' (R2-44)", () => {
    expect(
      toOriginalKey({ name: 'kpenter', sequence: '\x1b[57414u' }).name,
    ).toBe('return');
    expect(
      resolveCommand(key({ name: 'kpenter', sequence: '\x1b[57414u' })),
    ).toBe(Command.SUBMIT);
  });
});

describe('opentui key-map: submit / newline parity (InputPrompt)', () => {
  it('bare Enter is SUBMIT and not NEWLINE', () => {
    expect(matchesCommand(Command.SUBMIT, key({ name: 'return' }))).toBe(true);
    expect(matchesCommand(Command.NEWLINE, key({ name: 'return' }))).toBe(
      false,
    );
  });

  it('Shift/Ctrl/Meta+Enter and Ctrl+J are NEWLINE, not SUBMIT', () => {
    for (const newline of [
      key({ name: 'return', shift: true }),
      key({ name: 'return', ctrl: true }),
      key({ name: 'return', meta: true }),
      key({ name: 'j', ctrl: true }),
    ]) {
      expect(matchesCommand(Command.NEWLINE, newline)).toBe(true);
      expect(matchesCommand(Command.SUBMIT, newline)).toBe(false);
    }
  });
});

describe('opentui key-map: history navigation parity', () => {
  it('Ctrl+P / Ctrl+N are HISTORY_UP / HISTORY_DOWN', () => {
    expect(
      matchesCommand(Command.HISTORY_UP, key({ name: 'p', ctrl: true })),
    ).toBe(true);
    expect(
      matchesCommand(Command.HISTORY_DOWN, key({ name: 'n', ctrl: true })),
    ).toBe(true);
  });

  it('bare arrows are NAVIGATION_UP / NAVIGATION_DOWN', () => {
    expect(matchesCommand(Command.NAVIGATION_UP, key({ name: 'up' }))).toBe(
      true,
    );
    expect(matchesCommand(Command.NAVIGATION_DOWN, key({ name: 'down' }))).toBe(
      true,
    );
    expect(
      matchesCommand(Command.NAVIGATION_UP, key({ name: 'up', shift: true })),
    ).toBe(false);
  });
});

describe('opentui key-map: global shortcuts (AppContainer)', () => {
  it('Ctrl+O and Alt+T toggle thinking expansion', () => {
    expect(
      matchesCommand(
        Command.TOGGLE_THINKING_EXPANDED,
        key({ name: 'o', ctrl: true }),
      ),
    ).toBe(true);
    expect(
      matchesCommand(
        Command.TOGGLE_THINKING_EXPANDED,
        key({ name: 't', option: true }),
      ),
    ).toBe(true);
  });

  it('Ctrl+T toggles tool descriptions', () => {
    expect(
      matchesCommand(
        Command.TOGGLE_TOOL_DESCRIPTIONS,
        key({ name: 't', ctrl: true }),
      ),
    ).toBe(true);
  });

  it('Ctrl+S shows more lines', () => {
    expect(
      matchesCommand(Command.SHOW_MORE_LINES, key({ name: 's', ctrl: true })),
    ).toBe(true);
  });

  it('Escape, Ctrl+C and Ctrl+D resolve to ESCAPE / QUIT / EXIT', () => {
    expect(matchesCommand(Command.ESCAPE, key({ name: 'escape' }))).toBe(true);
    expect(matchesCommand(Command.QUIT, key({ name: 'c', ctrl: true }))).toBe(
      true,
    );
    expect(matchesCommand(Command.EXIT, key({ name: 'd', ctrl: true }))).toBe(
      true,
    );
  });

  it('Ctrl+Q queues and Ctrl+L clears the screen', () => {
    expect(
      matchesCommand(Command.QUEUE_MESSAGE, key({ name: 'q', ctrl: true })),
    ).toBe(true);
    expect(
      matchesCommand(Command.CLEAR_SCREEN, key({ name: 'l', ctrl: true })),
    ).toBe(true);
  });
});

describe('opentui key-map: priority resolution', () => {
  it('Ctrl+C resolves to QUIT ahead of CLEAR_INPUT', () => {
    expect(resolveCommand(key({ name: 'c', ctrl: true }))).toBe(Command.QUIT);
    expect(OPENTUI_COMMAND_PRIORITY).toContain(Command.QUIT);
    expect(OPENTUI_COMMAND_PRIORITY.indexOf(Command.QUIT)).toBeLessThan(
      OPENTUI_COMMAND_PRIORITY.indexOf(Command.CLEAR_INPUT),
    );
  });

  it('Escape resolves to ESCAPE', () => {
    expect(resolveCommand(key({ name: 'escape' }))).toBe(Command.ESCAPE);
  });

  it('bare Enter resolves to SUBMIT', () => {
    expect(resolveCommand(key({ name: 'return' }))).toBe(Command.SUBMIT);
  });

  it('Shift+Enter resolves to NEWLINE', () => {
    expect(resolveCommand(key({ name: 'return', shift: true }))).toBe(
      Command.NEWLINE,
    );
  });

  it('Ctrl+O / Ctrl+T / Ctrl+S resolve to their toggles', () => {
    expect(resolveCommand(key({ name: 'o', ctrl: true }))).toBe(
      Command.TOGGLE_THINKING_EXPANDED,
    );
    expect(resolveCommand(key({ name: 't', ctrl: true }))).toBe(
      Command.TOGGLE_TOOL_DESCRIPTIONS,
    );
    expect(resolveCommand(key({ name: 's', ctrl: true }))).toBe(
      Command.SHOW_MORE_LINES,
    );
  });

  it('plain printable characters resolve to nothing', () => {
    expect(resolveCommand(key({ name: 'x', sequence: 'x' }))).toBeUndefined();
    expect(resolveCommand(key({ name: '/', sequence: '/' }))).toBeUndefined();
  });

  it('resolveCommands exposes ink’s Ctrl+C fan-out: QUIT and CLEAR_INPUT (R2-45)', () => {
    // ink broadcasts every keypress to all subscribers, so Ctrl+C fires
    // both AppContainer’s QUIT handler and BaseTextInput’s CLEAR_INPUT.
    const commands = resolveCommands(key({ name: 'c', ctrl: true }));
    expect(commands).toContain(Command.QUIT);
    expect(commands).toContain(Command.CLEAR_INPUT);
    expect(commands[0]).toBe(Command.QUIT);
  });

  it('resolveCommands returns all matches in priority order for plain keys', () => {
    expect(resolveCommands(key({ name: 'return' }))).toEqual([Command.SUBMIT]);
    expect(resolveCommands(key({ name: 'x', sequence: 'x' }))).toEqual([]);
  });
});
