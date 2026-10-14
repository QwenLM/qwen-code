/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { basename } from 'node:path';

export function isTerminalEditorCommand(command: string): boolean {
  return /^(vi|vim|nvim|neovim|emacs|nano|pico|micro|hx|helix)(\.exe)?$/i.test(
    basename(command),
  );
}
