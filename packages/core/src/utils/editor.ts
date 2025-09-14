/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync, spawn } from 'child_process';

/**
 * A type representing the supported editors.
 */
export type EditorType =
  | 'vscode'
  | 'vscodium'
  | 'windsurf'
  | 'cursor'
  | 'vim'
  | 'neovim'
  | 'zed'
  | 'emacs';

/**
 * Checks if a given string is a valid `EditorType`.
 * @param editor The string to check.
 * @returns `true` if the string is a valid `EditorType`, `false` otherwise.
 */
function isValidEditorType(editor: string): editor is EditorType {
  return [
    'vscode',
    'vscodium',
    'windsurf',
    'cursor',
    'vim',
    'neovim',
    'zed',
    'emacs',
  ].includes(editor);
}

/**
 * Represents the command and arguments needed to launch an editor for a diff operation.
 */
interface DiffCommand {
  /**
   * The command to execute.
   */
  command: string;
  /**
   * The arguments to pass to the command.
   */
  args: string[];
}

/**
 * Checks if a command exists on the system.
 * @param cmd The command to check.
 * @returns `true` if the command exists, `false` otherwise.
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(
      process.platform === 'win32' ? `where.exe ${cmd}` : `command -v ${cmd}`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Editor command configurations for different platforms.
 * Each editor can have multiple possible command names, listed in order of preference.
 */
const editorCommands: Record<
  EditorType,
  { win32: string[]; default: string[] }
> = {
  vscode: { win32: ['code.cmd'], default: ['code'] },
  vscodium: { win32: ['codium.cmd'], default: ['codium'] },
  windsurf: { win32: ['windsurf'], default: ['windsurf'] },
  cursor: { win32: ['cursor'], default: ['cursor'] },
  vim: { win32: ['vim'], default: ['vim'] },
  neovim: { win32: ['nvim'], default: ['nvim'] },
  zed: { win32: ['zed'], default: ['zed', 'zeditor'] },
  emacs: { win32: ['emacs.exe'], default: ['emacs'] },
};

/**
 * Checks if a specific editor is installed on the system.
 * @param editor The editor to check for.
 * @returns `true` if the editor is found, `false` otherwise.
 */
export function checkHasEditorType(editor: EditorType): boolean {
  const commandConfig = editorCommands[editor];
  const commands =
    process.platform === 'win32' ? commandConfig.win32 : commandConfig.default;
  return commands.some((cmd) => commandExists(cmd));
}

/**
 * Determines if a specific editor is allowed to be used within the sandbox environment.
 * @param editor The editor to check.
 * @returns `true` if the editor is allowed, `false` otherwise.
 */
export function allowEditorTypeInSandbox(editor: EditorType): boolean {
  const notUsingSandbox = !process.env['SANDBOX'];
  if (['vscode', 'vscodium', 'windsurf', 'cursor', 'zed'].includes(editor)) {
    return notUsingSandbox;
  }
  // For terminal-based editors like vim and emacs, allow in sandbox.
  return true;
}

/**
 * Checks if a preferred editor is set, valid, available, and allowed in the current environment.
 * @param editor The editor to check.
 * @returns `true` if the editor is available for use, `false` otherwise.
 */
export function isEditorAvailable(editor: string | undefined): boolean {
  if (editor && isValidEditorType(editor)) {
    return checkHasEditorType(editor) && allowEditorTypeInSandbox(editor);
  }
  return false;
}

/**
 * Gets the appropriate command and arguments to launch a diff view in a specific editor.
 * @param oldPath The path to the "before" file in the diff.
 * @param newPath The path to the "after" file in the diff.
 * @param editor The editor to get the diff command for.
 * @returns A `DiffCommand` object if the editor is supported, otherwise `null`.
 */
export function getDiffCommand(
  oldPath: string,
  newPath: string,
  editor: EditorType,
): DiffCommand | null {
  if (!isValidEditorType(editor)) {
    return null;
  }
  const commandConfig = editorCommands[editor];
  const commands =
    process.platform === 'win32' ? commandConfig.win32 : commandConfig.default;
  const command =
    commands.slice(0, -1).find((cmd) => commandExists(cmd)) ||
    commands[commands.length - 1];

  switch (editor) {
    case 'vscode':
    case 'vscodium':
    case 'windsurf':
    case 'cursor':
    case 'zed':
      return { command, args: ['--wait', '--diff', oldPath, newPath] };
    case 'vim':
    case 'neovim':
      return {
        command,
        args: [
          '-d',
          // skip viminfo file to avoid E138 errors
          '-i',
          'NONE',
          // make the left window read-only and the right window editable
          '-c',
          'wincmd h | set readonly | wincmd l',
          // set up colors for diffs
          '-c',
          'highlight DiffAdd cterm=bold ctermbg=22 guibg=#005f00 | highlight DiffChange cterm=bold ctermbg=24 guibg=#005f87 | highlight DiffText ctermbg=21 guibg=#0000af | highlight DiffDelete ctermbg=52 guibg=#5f0000',
          // Show helpful messages
          '-c',
          'set showtabline=2 | set tabline=[Instructions]\\ :wqa(save\\ &\\ quit)\\ \\|\\ i/esc(toggle\\ edit\\ mode)',
          '-c',
          'wincmd h | setlocal statusline=OLD\\ FILE',
          '-c',
          'wincmd l | setlocal statusline=%#StatusBold#NEW\\ FILE\\ :wqa(save\\ &\\ quit)\\ \\|\\ i/esc(toggle\\ edit\\ mode)',
          // Auto close all windows when one is closed
          '-c',
          'autocmd WinClosed * wqa',
          oldPath,
          newPath,
        ],
      };
    case 'emacs':
      return {
        command: 'emacs',
        args: ['--eval', `(ediff "${oldPath}" "${newPath}")`],
      };
    default:
      return null;
  }
}

/**
 * Opens a diff tool to compare two files.
 * This function handles the specifics of launching different editors, including whether
 * to block the parent process (for terminal-based editors) or not (for GUI-based editors).
 *
 * @param oldPath The path to the "before" file in the diff.
 * @param newPath The path to the "after" file in the diff.
 * @param editor The editor to use for the diff.
 * @param onEditorClose A callback function to be executed after the editor is closed.
 */
export async function openDiff(
  oldPath: string,
  newPath: string,
  editor: EditorType,
  onEditorClose: () => void,
): Promise<void> {
  const diffCommand = getDiffCommand(oldPath, newPath, editor);
  if (!diffCommand) {
    console.error('No diff tool available. Install a supported editor.');
    return;
  }

  try {
    switch (editor) {
      case 'vscode':
      case 'vscodium':
      case 'windsurf':
      case 'cursor':
      case 'zed':
        // Use spawn for GUI-based editors to avoid blocking the entire process
        return new Promise((resolve, reject) => {
          const childProcess = spawn(diffCommand.command, diffCommand.args, {
            stdio: 'inherit',
            shell: true,
          });

          childProcess.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`${editor} exited with code ${code}`));
            }
          });

          childProcess.on('error', (error) => {
            reject(error);
          });
        });

      case 'vim':
      case 'emacs':
      case 'neovim': {
        // Use execSync for terminal-based editors
        const command =
          process.platform === 'win32'
            ? `${diffCommand.command} ${diffCommand.args.join(' ')}`
            : `${diffCommand.command} ${diffCommand.args.map((arg) => `"${arg}"`).join(' ')}`;
        try {
          execSync(command, {
            stdio: 'inherit',
            encoding: 'utf8',
          });
        } catch (e) {
          console.error('Error in onEditorClose callback:', e);
        } finally {
          onEditorClose();
        }
        break;
      }

      default:
        throw new Error(`Unsupported editor: ${editor}`);
    }
  } catch (error) {
    console.error(error);
  }
}
