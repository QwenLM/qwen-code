/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal window title for the OpenTUI entry (ink parity).
 *
 * The ink branch of `startInteractiveUI` sets the terminal window title
 * (`qwen — <dir>`) on startup and clears it again on exit
 * (`startInteractiveUI.tsx:104,400-417`). The OpenTUI branch never touched
 * the title, so the user's terminal kept whatever title it had before. This
 * module reuses the shared `windowTitle` helpers and mirrors that behaviour.
 */

import { basename } from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  computeWindowTitle,
  writeTerminalTitle,
} from '../utils/windowTitle.js';

const write = (value: string) => {
  try {
    process.stdout.write(value);
  } catch {
    // Best-effort: a broken stdout (e.g. EPIPE) must not throw here.
  }
};

/**
 * Sets the terminal window title for the session and registers an `exit`
 * handler that clears it again. Respects the same settings the ink path
 * honours (`ui.hideWindowTitle` / `ui.showStatusInTitle`). Returns the
 * installed exit listener so callers/tests can remove it.
 */
export function installOpenTuiWindowTitle(
  settings: LoadedSettings,
  config: Config | undefined,
): (() => void) | null {
  if (
    settings.merged.ui?.hideWindowTitle ||
    settings.merged.ui?.showStatusInTitle === false
  ) {
    return null;
  }

  const folderName = basename(config?.getTargetDir() ?? process.cwd());
  const title = computeWindowTitle(folderName);
  writeTerminalTitle(write, title);

  const clearOnExit = () => {
    try {
      writeTerminalTitle(write, '');
    } catch {
      // Clearing the title during exit must not produce a visible error.
    }
  };
  process.on('exit', clearOnExit);
  return () => {
    process.removeListener('exit', clearOnExit);
  };
}
