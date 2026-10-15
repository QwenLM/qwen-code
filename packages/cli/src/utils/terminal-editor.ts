/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename, win32 } from 'node:path';

export function isTerminalEditorCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/[/\\]Zed\.app[/\\]Contents[/\\]MacOS[/\\]cli$/i.test(command))
    return false;
  const executable = win32.basename(basename(command));
  return !/^(code|codium|windsurf|cursor|trae|zed|zeditor|notepad|open)(\.(exe|cmd|bat))?$/i.test(
    executable,
  );
}
