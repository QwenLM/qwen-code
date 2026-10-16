/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename, win32 } from 'node:path';
import {
  editorCommands,
  isTerminalEditor,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import type { EditorType } from '@qwen-code/qwen-code-core/utils/editor.js';

export function isTerminalEditorCommand(command: string): boolean {
  const executable = win32
    .basename(basename(command))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');
  for (const [editor, commands] of Object.entries(editorCommands)) {
    if (
      [...commands.default, ...commands.win32].some(
        (name) => name.replace(/\.(exe|cmd|bat)$/, '') === executable,
      )
    ) {
      return isTerminalEditor(editor as EditorType);
    }
  }
  return /^(vi|nano|pico|micro|hx|helix|kak|joe|zile|jed|mle|ne|vim\.tiny)$/.test(
    executable,
  );
}
