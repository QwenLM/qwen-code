/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  editorCommands,
  isTerminalEditor,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import type { EditorType } from '@qwen-code/qwen-code-core/utils/editor.js';
import { isTerminalEditorCommand } from './terminal-editor.js';

describe('isTerminalEditorCommand', () => {
  it.each(
    Object.entries(editorCommands).flatMap(([editor, commands]) =>
      [...commands.default, ...commands.win32].map(
        (command) => [editor, command] as const,
      ),
    ),
  )('matches configured editor %s executable %s', (editor, command) => {
    expect(isTerminalEditorCommand(command)).toBe(
      isTerminalEditor(editor as EditorType),
    );
  });

  it.each([
    'kak',
    'joe',
    'zile',
    'jed',
    'mle',
    'ne',
    'vim.tiny',
    '/usr/local/bin/hx',
    'vim.cmd',
    'nvim.cmd',
    'helix.bat',
    'C:\\Program Files\\Vim\\vim.exe',
  ])('hands the terminal to %s', (command) =>
    expect(isTerminalEditorCommand(command)).toBe(true),
  );
  it.each([
    'gvim',
    'subl',
    'neovide',
    'emacsclient',
    'unknown-editor',
    '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl',
    '',
    ' ',
    'code',
    'code.cmd',
    'codium.exe',
    'windsurf',
    'cursor',
    'trae',
    'zed',
    'zeditor',
    'notepad.exe',
    '/usr/bin/open',
    '/Applications/Zed.app/Contents/MacOS/cli',
    'C:\\Apps\\Code\\code.cmd',
  ])('keeps ownership for GUI or empty command %s', (command) =>
    expect(isTerminalEditorCommand(command)).toBe(false),
  );
});
