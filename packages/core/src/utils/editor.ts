/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, execSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { runLogger } from './runLogger.js';
import { coreEvents, CoreEvent, type EditorSelectedPayload } from './events.js';

const GUI_EDITORS = [
  'vscode',
  'vscodium',
  'windsurf',
  'cursor',
  'zed',
  'antigravity',
] as const;
const TERMINAL_EDITORS = ['vim', 'neovim', 'emacs', 'hx'] as const;
const EDITORS = [...GUI_EDITORS, ...TERMINAL_EDITORS] as const;

const GUI_EDITORS_SET = new Set<string>(GUI_EDITORS);
const TERMINAL_EDITORS_SET = new Set<string>(TERMINAL_EDITORS);
const EDITORS_SET = new Set<string>(EDITORS);

export const NO_EDITOR_AVAILABLE_ERROR =
  'No external editor is available. Please run /editor to configure one.';

/** Upper bound on stderr captured from a GUI editor, for the run log. */
const MAX_CAPTURED_STDERR = 4096;

export const DEFAULT_GUI_EDITOR: GuiEditorType = 'vscode';

export type GuiEditorType = (typeof GUI_EDITORS)[number];
export type TerminalEditorType = (typeof TERMINAL_EDITORS)[number];
export type EditorType = (typeof EDITORS)[number];

export function isGuiEditor(editor: EditorType): editor is GuiEditorType {
  return GUI_EDITORS_SET.has(editor);
}

export function isTerminalEditor(
  editor: EditorType,
): editor is TerminalEditorType {
  return TERMINAL_EDITORS_SET.has(editor);
}

export const EDITOR_DISPLAY_NAMES: Record<EditorType, string> = {
  vscode: 'VS Code',
  vscodium: 'VSCodium',
  windsurf: 'Windsurf',
  cursor: 'Cursor',
  vim: 'Vim',
  neovim: 'Neovim',
  zed: 'Zed',
  emacs: 'Emacs',
  antigravity: 'Antigravity',
  hx: 'Helix',
};

export function getEditorDisplayName(editor: EditorType): string {
  return EDITOR_DISPLAY_NAMES[editor] || editor;
}

function isValidEditorType(editor: string): editor is EditorType {
  return EDITORS_SET.has(editor);
}

/**
 * Escapes a string for use in an Emacs Lisp string literal.
 * Wraps in double quotes and escapes backslashes and double quotes.
 */
function escapeELispString(str: string): string {
  return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface DiffCommand {
  command: string;
  args: string[];
}

const execAsync = promisify(exec);

function getCommandExistsCmd(cmd: string): string {
  return process.platform === 'win32'
    ? `where.exe ${cmd}`
    : `command -v ${cmd}`;
}

export function commandExists(cmd: string): boolean {
  try {
    execSync(getCommandExistsCmd(cmd), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function commandExistsAsync(cmd: string): Promise<boolean> {
  try {
    await execAsync(getCommandExistsCmd(cmd));
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
  antigravity: {
    win32: ['agy.cmd', 'antigravity.cmd', 'antigravity'],
    default: ['agy', 'antigravity'],
  },
  hx: { win32: ['hx'], default: ['hx'] },
};

function getEditorCommands(editor: EditorType): string[] {
  const commandConfig = editorCommands[editor];
  return process.platform === 'win32'
    ? commandConfig.win32
    : commandConfig.default;
}

export function hasValidEditorCommand(editor: EditorType): boolean {
  return getEditorCommands(editor).some((cmd) => commandExists(cmd));
}

export async function hasValidEditorCommandAsync(
  editor: EditorType,
): Promise<boolean> {
  return Promise.any(
    getEditorCommands(editor).map((cmd) =>
      commandExistsAsync(cmd).then((exists) => exists || Promise.reject()),
    ),
  ).catch(() => false);
}

export function getEditorCommand(editor: EditorType): string {
  const commands = getEditorCommands(editor);
  return (
    commands.slice(0, -1).find((cmd) => commandExists(cmd)) ||
    commands[commands.length - 1]
  );
}

function isEditorTypeAvailable(
  editor: string | undefined,
): editor is EditorType {
  return !!editor && isValidEditorType(editor);
}

/**
 * Check if the editor is valid and can be used.
 * Returns false if preferred editor is not set / invalid / not available.
 */
export function isEditorAvailable(editor: string | undefined): boolean {
  return isEditorTypeAvailable(editor) && hasValidEditorCommand(editor);
}

/**
 * Check if the editor is valid and can be used.
 * Returns false if preferred editor is not set / invalid / not available.
 */
export async function isEditorAvailableAsync(
  editor: string | undefined,
): Promise<boolean> {
  return (
    isEditorTypeAvailable(editor) && (await hasValidEditorCommandAsync(editor))
  );
}

/**
 * Resolves an editor to use for external editing without blocking the event loop.
 * 1. If a preferred editor is set and available, uses it.
 * 2. If no preferred editor is set (or preferred is unavailable), requests selection from user and waits for it.
 */
export async function resolveEditorAsync(
  preferredEditor: EditorType | undefined,
  signal?: AbortSignal,
): Promise<EditorType | undefined> {
  if (preferredEditor && (await isEditorAvailableAsync(preferredEditor))) {
    return preferredEditor;
  }

  coreEvents.emit(CoreEvent.RequestEditorSelection);

  return once(coreEvents, CoreEvent.EditorSelected, { signal })
    .then(([payload]) => (payload as EditorSelectedPayload).editor)
    .catch(() => undefined);
}

/**
 * Get the diff command for a specific editor.
 */
export function getDiffCommand(
  oldPath: string,
  newPath: string,
  editor: EditorType,
): DiffCommand | null {
  if (!isValidEditorType(editor)) {
    return null;
  }
  const command = getEditorCommand(editor);

  switch (editor) {
    case 'vscode':
    case 'vscodium':
    case 'windsurf':
    case 'cursor':
    case 'zed':
    case 'antigravity':
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
          'autocmd BufWritePost * wqa',
          oldPath,
          newPath,
        ],
      };
    case 'emacs':
      return {
        command: 'emacs',
        args: [
          '--eval',
          `(ediff ${escapeELispString(oldPath)} ${escapeELispString(newPath)})`,
        ],
      };
    case 'hx':
      return {
        command: 'hx',
        args: ['--vsplit', '--', oldPath, newPath],
      };
    default:
      return null;
  }
}

/**
 * Opens a diff tool to compare two files.
 * Terminal-based editors by default blocks parent process until the editor exits.
 * GUI-based editors require args such as "--wait" to block parent process.
 */
export async function openDiff(
  oldPath: string,
  newPath: string,
  editor: EditorType,
): Promise<void> {
  const diffCommand = getDiffCommand(oldPath, newPath, editor);
  if (!diffCommand) {
    runLogger.error('No diff tool available. Install a supported editor.');
    return;
  }

  if (isTerminalEditor(editor)) {
    try {
      if (!commandExists(diffCommand.command)) {
        throw new Error(`Editor command not found: ${diffCommand.command}`);
      }

      coreEvents.emit(CoreEvent.ExternalEditorOpening, { isTerminal: true });
      const result = spawnSync(diffCommand.command, diffCommand.args, {
        stdio: 'inherit',
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`${editor} exited with code ${result.status}`);
      }
    } finally {
      coreEvents.emit(CoreEvent.ExternalEditorClosed, { isTerminal: true });
    }
    return;
  }

  coreEvents.emit(CoreEvent.ExternalEditorOpening, { isTerminal: false });
  return new Promise<void>((resolve, reject) => {
    const childProcess = spawn(diffCommand.command, diffCommand.args, {
      // Not 'inherit': a GUI diff tool needs no terminal, and this path no
      // longer enters the alt screen, so whatever its launcher script writes
      // would land in the live frame and corrupt the UI. stderr is piped
      // rather than dropped so the reason for a non-zero exit still reaches
      // the run log — 'inherit' used to put it on a scratch alt buffer that
      // was discarded, so it was never diagnosable either way.
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });

    // Must be drained, or a chatty wrapper filling the pipe buffer would block
    // the child forever. Capped so it cannot grow without bound.
    let stderr = '';
    childProcess.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_CAPTURED_STDERR) {
        stderr += chunk.toString();
      }
    });

    // Guard against both 'error' and 'close' firing for a single failure,
    // which would emit ExternalEditorClosed twice and attempt to settle
    // the promise twice.
    let isSettled = false;

    childProcess.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;

      if (code !== 0) {
        // GUI editors (VS Code, Zed, etc.) can exit with non-zero codes
        // under normal circumstances (e.g., window closed while loading).
        // Log a warning instead of crashing the CLI process.
        const detail = stderr.trim().slice(0, MAX_CAPTURED_STDERR);
        runLogger.warn(
          `${editor} exited with code ${code}${detail ? `: ${detail}` : ''}`,
        );
      }
      coreEvents.emit(CoreEvent.ExternalEditorClosed, { isTerminal: false });
      resolve();
    });

    childProcess.on('error', (error) => {
      if (isSettled) return;
      isSettled = true;

      coreEvents.emit(CoreEvent.ExternalEditorClosed, { isTerminal: false });
      reject(error);
    });
  });
}
