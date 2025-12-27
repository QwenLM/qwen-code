/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useStdin } from 'ink';
import type { EditorType } from '@qwen-code/qwen-code-core';
import { editorCommands } from '@qwen-code/qwen-code-core';
import { spawnSync, execSync } from 'child_process';
import { useSettings } from '../contexts/SettingsContext.js';

/**
 * Cache for command existence checks to avoid repeated execSync calls.
 */
const commandExistsCache = new Map<string, boolean>();

/**
 * Check if a command exists in the system.
 * Results are cached to improve performance in test environments.
 */
function commandExists(cmd: string): boolean {
  if (commandExistsCache.has(cmd)) {
    return commandExistsCache.get(cmd)!;
  }

  try {
    execSync(
      process.platform === 'win32' ? `where.exe ${cmd}` : `command -v ${cmd}`,
      { stdio: 'ignore' },
    );
    commandExistsCache.set(cmd, true);
    return true;
  } catch {
    commandExistsCache.set(cmd, false);
    return false;
  }
}

/**
 * Get the actual executable command for an editor type.
 */
function getExecutableCommand(editorType: EditorType): string {
  const commandConfig = editorCommands[editorType];
  const commands =
    process.platform === 'win32' ? commandConfig.win32 : commandConfig.default;

  // Try to find the first available command
  const availableCommand = commands.find((cmd) => commandExists(cmd));

  // Return the first available command, or fall back to the last one in the list
  return availableCommand || commands[commands.length - 1];
}

/**
 * Determines the editor command to use based on user preferences and platform.
 */
function getEditorCommand(preferredEditor?: EditorType): string {
  if (preferredEditor) {
    return getExecutableCommand(preferredEditor);
  }

  // Platform-specific defaults with UI preference for macOS
  switch (process.platform) {
    case 'darwin':
      return 'open -t'; // TextEdit in plain text mode
    case 'win32':
      return 'notepad';
    default:
      return process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
  }
}

/**
 * React hook that provides an editor launcher function.
 * Uses settings context and stdin management internally.
 */
export function useLaunchEditor() {
  const settings = useSettings();
  const { stdin, setRawMode } = useStdin();

  const launchEditor = useCallback(
    async (filePath: string): Promise<void> => {
      const preferredEditor = settings.merged.general?.preferredEditor as
        | EditorType
        | undefined;
      const editor = getEditorCommand(preferredEditor);

      // Handle different editor command formats
      let editorCommand: string;
      let editorArgs: string[];

      if (editor === 'open -t') {
        // macOS TextEdit in plain text mode
        editorCommand = 'open';
        editorArgs = ['-t', filePath];
      } else {
        // Standard editor command
        editorCommand = editor;
        editorArgs = [filePath];
      }

      // Temporarily disable raw mode for editor
      const wasRaw = stdin?.isRaw ?? false;
      try {
        setRawMode?.(false);

        // On Windows, .cmd and .bat files need shell: true
        const needsShell =
          process.platform === 'win32' &&
          (editorCommand.endsWith('.cmd') || editorCommand.endsWith('.bat'));

        const { status, error } = spawnSync(editorCommand, editorArgs, {
          stdio: 'inherit',
          shell: needsShell,
        });

        if (error) throw error;
        if (typeof status === 'number' && status !== 0) {
          throw new Error(`Editor exited with status ${status}`);
        }
      } finally {
        if (wasRaw) setRawMode?.(true);
      }
    },
    [settings.merged.general?.preferredEditor, setRawMode, stdin],
  );

  return launchEditor;
}
