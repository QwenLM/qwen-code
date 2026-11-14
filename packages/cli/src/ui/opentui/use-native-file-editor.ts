/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { useRenderer } from '@opentui/react';
import { spawnSync } from 'node:child_process';
import {
  getEditorExecutable,
  type EditorType,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  releaseProgramStatus,
  restoreProgramStatus,
} from '../../utils/program-status.js';

export function useNativeFileEditor(
  settings: LoadedSettings,
  assertOwner: () => void,
) {
  const renderer = useRenderer();
  return (file: string) => {
    const preferred = settings.merged.general?.preferredEditor as
      | EditorType
      | undefined;
    const editor = preferred
      ? getEditorExecutable(preferred)
      : process.platform === 'darwin'
        ? 'open -t'
        : process.platform === 'win32'
          ? 'notepad'
          : process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
    if (!editor)
      throw new Error(
        `No available editor found for ${preferred}. Please install a supported editor or set a different preferredEditor in settings.`,
      );
    assertOwner();
    let suspended = false;
    try {
      suspended = true;
      renderer.suspend();
      releaseProgramStatus();
      const command = editor === 'open -t' ? 'open' : editor;
      const result = spawnSync(
        command,
        editor === 'open -t' ? ['-t', file] : [file],
        {
          stdio: 'inherit',
          shell: process.platform === 'win32' && /\.(cmd|bat)$/.test(command),
        },
      );
      if (result.error) throw result.error;
      if (result.signal)
        throw new Error(`Editor was killed by signal ${result.signal}`);
      if (typeof result.status === 'number' && result.status !== 0)
        throw new Error(`Editor exited with status ${result.status}`);
    } finally {
      try {
        restoreProgramStatus();
      } finally {
        if (suspended) renderer.resume();
      }
    }
  };
}
