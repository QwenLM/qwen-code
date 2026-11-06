/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getExternalEditorCommand,
  type EditorType,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';

const debugLogger = createDebugLogger('EXTERNAL_EDITOR');

export function editTextInExternalEditor(
  text: string,
  options: {
    editor?: string;
    preferredEditor?: EditorType;
    beforeLaunch: () => void;
  },
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-edit-'));
  const file = path.join(directory, 'buffer.txt');
  try {
    const resolved =
      !options.editor && options.preferredEditor
        ? getExternalEditorCommand(options.preferredEditor, file)
        : null;
    if (!options.editor && options.preferredEditor && !resolved) {
      debugLogger.warn(
        `Preferred editor "${options.preferredEditor}" not found, falling back to env/default`,
      );
    }
    let command =
      (options.editor || resolved?.command) ??
      process.env['VISUAL'] ??
      process.env['EDITOR'] ??
      (process.platform === 'win32' ? 'notepad' : 'vi');
    let args = resolved?.args ?? [file];
    const shell = resolved
      ? resolved.needsShell
      : process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    if (shell) {
      if (!resolved && /["|%!]/.test(command)) {
        throw new Error(
          `Editor command contains unsafe characters: ${command}`,
        );
      }
      // These are generated paths, not shell input from the draft.
      command = `"${command}"`;
      args = args.map((arg) => `"${arg}"`);
    }
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    options.beforeLaunch();
    debugLogger.warn(
      `Launching external editor (cmd=${command}, shell=${shell})`,
    );
    const { status, error, signal } = spawnSync(command, args, {
      stdio: 'inherit',
      shell,
      timeout: 30 * 60 * 1000,
    });
    if (error) throw error;
    if (signal)
      throw new Error(`External editor was killed by signal ${signal}`);
    if (typeof status === 'number' && status !== 0) {
      throw new Error(`External editor exited with status ${status}`);
    }
    return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  } finally {
    try {
      // Include swap files left by editors; locked files remain best effort.
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
