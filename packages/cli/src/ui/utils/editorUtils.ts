/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import type { ReadStream } from 'node:tty';
import {
  commandExists,
  coreEvents,
  CoreEvent,
  type EditorType,
  getEditorCommand,
  getEditorDisplayName,
  isEditorAvailable,
  isGuiEditor,
  NO_EDITOR_AVAILABLE_ERROR,
  runLogger,
} from '@qwen-code/core';

/** Upper bound on stderr captured from a GUI editor, for the run log. */
const MAX_CAPTURED_STDERR = 4096;

/** Everything needed to reopen the file a GUI editor session is holding. */
interface ActiveGuiEditorSession {
  filePath: string;
  executable: string;
  args: string[];
  displayName: string;
}

/**
 * The GUI editor session the input gate is currently locked for, if any.
 *
 * Module-level for the same reason `coreEvents` is: the gate lives in
 * KeypressContext and is global, so the state it acts on has to be reachable
 * from there without threading a ref through all eight `openFileInEditor`
 * call sites. Only the GUI branch records here — the terminal branch suspends
 * stdin outright, so no key can reach the gate to ask for a relaunch.
 */
let activeGuiSession: ActiveGuiEditorSession | null = null;

/** A fully resolved external editor invocation. */
export interface ResolvedExternalEditor {
  /** Executable to spawn. */
  executable: string;
  /** Arguments that precede the file path. */
  args: string[];
  /**
   * True when the editor takes over the terminal (vim, nano, ...) and therefore
   * needs a full terminal handoff. GUI editors open in their own window.
   */
  isTerminal: boolean;
  /** Human-readable name used in error messages, e.g. "Cursor" or "nvim". */
  displayName: string;
}

/**
 * Editors that open in their own window, mapped to the flag that makes them
 * block until the file is closed. Matched by basename, never by substring:
 * `EDITOR=/home/alice/code/bin/nvim` contains "code" but is a terminal editor,
 * and handing it `--wait` makes it exit immediately.
 *
 * Only editors known to support a wait flag belong here. Anything else (gedit,
 * notepad, ...) is left to the terminal branch, where spawnSync blocks on its
 * own — injecting an unsupported flag is how a launch turns into an instant
 * non-zero exit.
 */
const GUI_EDITOR_WAIT_FLAGS = new Map<string, string>([
  ['code', '--wait'],
  ['code-insiders', '--wait'],
  ['codium', '--wait'],
  ['vscodium', '--wait'],
  ['cursor', '--wait'],
  ['windsurf', '--wait'],
  ['zed', '--wait'],
  ['zeditor', '--wait'],
  ['atom', '--wait'],
  ['agy', '--wait'],
  ['antigravity', '--wait'],
  ['subl', '-w'],
  ['sublime_text', '-w'],
]);

/**
 * Editors that understand `-i NONE` (skip the viminfo file, avoiding E138 in
 * restricted environments). Matched by basename so `/home/vi/bin/nano` does not
 * get `-i NONE`, where `-i` means autoindent and `NONE` becomes a second file.
 */
const VIMLIKE_BASENAMES = new Set(['vi', 'vim', 'nvim']);

/** Probe order when nothing is configured. GUI first — see resolveExternalEditor. */
const FALLBACK_EDITORS: readonly EditorType[] = [
  'vscode',
  'cursor',
  'windsurf',
  'vim',
];

/**
 * Last-resort probes that have no `EditorType`. `editorCommands.vim` only lists
 * `vim`, so a bare-bones box (busybox, minimal SSH target) that ships `vi` but
 * not `vim` would otherwise report "no editor available" while a perfectly good
 * one sits on PATH.
 */
const RAW_TERMINAL_FALLBACKS = ['vi', 'nano'];

function commandBasename(executable: string): string {
  return basename(executable)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');
}

function argsForEditorType(editor: EditorType): string[] {
  if (isGuiEditor(editor)) {
    return ['--wait'];
  }
  return editor === 'vim' || editor === 'neovim' ? ['-i', 'NONE'] : [];
}

function fromEditorType(editor: EditorType): ResolvedExternalEditor {
  return {
    executable: getEditorCommand(editor),
    args: argsForEditorType(editor),
    isTerminal: !isGuiEditor(editor),
    displayName: getEditorDisplayName(editor),
  };
}

function fromEnvCommand(command: string): ResolvedExternalEditor {
  const [executable = '', ...args] = command.split(/\s+/);
  const name = commandBasename(executable);
  const waitFlag = GUI_EDITOR_WAIT_FLAGS.get(name);
  const isGui = waitFlag !== undefined;

  if (isGui) {
    // Exact-token check, not substring: the user may already have supplied the
    // flag, and a substring test would also match e.g. `--waitfor`.
    if (!args.includes('-w') && !args.includes('--wait')) {
      args.push(waitFlag);
    }
  } else if (VIMLIKE_BASENAMES.has(name)) {
    args.push('-i', 'NONE');
  }

  return {
    executable,
    args,
    // Anything outside the GUI whitelist is assumed to be a terminal editor.
    // Guessing wrong in that direction costs nothing; guessing GUI adds
    // `--wait`, which most terminal editors reject outright.
    isTerminal: !isGui,
    displayName: name || executable,
  };
}

/**
 * The GUI editor hosting this terminal, if any.
 *
 * Relies on the askpass paths rather than terminal env vars: `TERM_PROGRAM` is
 * 'vscode' for VS Code *and* every fork of it, and `CURSOR_TRACE_ID` is not
 * always set (verified absent in Cursor 3.12.17), so terminal env vars report
 * vscode while running inside Cursor. The askpass paths name the actual app
 * bundle.
 */
function guiEditorForHostIde(): EditorType | undefined {
  const host =
    process.env['VSCODE_GIT_ASKPASS_NODE'] ??
    process.env['VSCODE_GIT_ASKPASS_MAIN'] ??
    '';
  if (!host) {
    return undefined;
  }
  if (/cursor/i.test(host)) {
    return 'cursor';
  }
  if (/windsurf/i.test(host)) {
    return 'windsurf';
  }
  if (/vscodium/i.test(host)) {
    return 'vscodium';
  }
  if (/antigravity/i.test(host)) {
    return 'antigravity';
  }
  return 'vscode';
}

/**
 * Resolves which editor to launch: preferred setting, then $VISUAL / $EDITOR,
 * then a probe of editors that are actually installed. Returns undefined when
 * nothing usable is available — callers should surface that rather than
 * guessing, since spawning an editor that isn't there just fails opaquely.
 */
export function resolveExternalEditor(
  preferredEditorType?: EditorType,
): ResolvedExternalEditor | undefined {
  // isEditorAvailable() rather than a raw command lookup: getEditorCommand()
  // returns its last candidate even when nothing is installed.
  // A configured-but-missing editor falls through instead of failing outright.
  if (preferredEditorType && isEditorAvailable(preferredEditorType)) {
    return fromEditorType(preferredEditorType);
  }

  const envCommand = (process.env['VISUAL'] || process.env['EDITOR'])?.trim();
  if (envCommand) {
    return fromEnvCommand(envCommand);
  }

  // Nothing configured. Probe for an editor that actually exists, GUI first: a
  // GUI editor opens in its own window and needs no terminal handoff — and the
  // terminal handoff is the path that breaks, with vi exiting 1 the moment it
  // cannot take over the terminal.
  const hostGui = guiEditorForHostIde();
  const order = hostGui ? [hostGui, ...FALLBACK_EDITORS] : FALLBACK_EDITORS;
  const probed = order.find(
    (editor, index) =>
      order.indexOf(editor) === index && isEditorAvailable(editor),
  );
  if (probed) {
    return fromEditorType(probed);
  }

  for (const cmd of RAW_TERMINAL_FALLBACKS) {
    if (commandExists(cmd)) {
      return {
        executable: cmd,
        args: VIMLIKE_BASENAMES.has(cmd) ? ['-i', 'NONE'] : [],
        isTerminal: true,
        displayName: cmd,
      };
    }
  }

  if (process.platform === 'win32') {
    return {
      executable: 'notepad',
      args: [],
      isTerminal: false,
      displayName: 'Notepad',
    };
  }

  return undefined;
}

/**
 * Opens a file in an external editor and waits for it to close.
 * Emits CoreEvent.ExternalEditorOpening before launching the editor and
 * CoreEvent.ExternalEditorClosed after, so the Ink layer can suspend/resume
 * stdin and — for terminal editors only — hand over the whole terminal.
 *
 * Surfaces failures to the user itself, exactly once, then rethrows so callers
 * can skip their success path. Most of the eight call sites swallow the
 * rejection (some with a comment saying errors are reported here), so this has
 * to be the single reporting point — pushing it onto callers makes those paths
 * fail silently.
 *
 * @param filePath Path to the file to open
 * @param stdin The stdin stream from Ink/Node (unused, kept for API compat)
 * @param setRawMode Function to toggle raw mode (unused, kept for API compat)
 * @param preferredEditorType The user's preferred editor from config
 */
export async function openFileInEditor(
  filePath: string,
  stdin: ReadStream | null | undefined,
  setRawMode: ((mode: boolean) => void) | undefined,
  preferredEditorType?: EditorType,
): Promise<void> {
  const editor = resolveExternalEditor(preferredEditorType);
  if (!editor) {
    const err = new Error(NO_EDITOR_AVAILABLE_ERROR);
    coreEvents.emitFeedback('warning', err.message, err);
    throw err;
  }

  const { executable, args, isTerminal, displayName } = editor;
  const spawnArgs = [...args, filePath];
  const hint = 'Run /editor to pick a different editor.';
  const fail = (message: string): Error => {
    const err = new Error(message);
    coreEvents.emitFeedback('warning', message, err);
    return err;
  };

  coreEvents.emit(CoreEvent.ExternalEditorOpening, { isTerminal });

  try {
    if (isTerminal) {
      const result = spawnSync(executable, spawnArgs, {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      if (result.error) {
        throw fail(
          `Failed to launch ${displayName}: ${result.error.message}. ${hint}`,
        );
      }
      if (typeof result.status === 'number' && result.status !== 0) {
        throw fail(
          `${displayName} exited with status ${result.status}. ${hint}`,
        );
      }
    } else {
      // Published before the spawn so Ctrl+X works from the first moment the
      // gate is locked — the Opening event that locks it has already fired.
      const session: ActiveGuiEditorSession = {
        filePath,
        executable,
        args,
        displayName,
      };
      activeGuiSession = session;
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, spawnArgs, {
            // Not 'inherit': a GUI editor needs no terminal, and we no longer
            // hide behind the alt screen. The `code`/`cursor` launchers are
            // shell wrappers that can write to stderr, which would land in the
            // live frame and corrupt the UI until the next full repaint.
            // stderr is piped rather than dropped so a failure is diagnosable.
            stdio: ['ignore', 'ignore', 'pipe'],
            shell: process.platform === 'win32',
          });

          // Must be drained, or a chatty wrapper filling the pipe buffer would
          // block the child forever. Capped so it cannot grow without bound.
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer | string) => {
            if (stderr.length < MAX_CAPTURED_STDERR) {
              stderr += chunk.toString();
            }
          });

          child.on('error', (err) => {
            reject(
              fail(`Failed to launch ${displayName}: ${err.message}. ${hint}`),
            );
          });

          child.on('close', (status) => {
            if (typeof status === 'number' && status !== 0) {
              // Keep the user-facing text short; the launcher's own words go
              // to the run log, which is where the last round of this bug was
              // eventually diagnosed from.
              const detail = stderr.trim().slice(0, MAX_CAPTURED_STDERR);
              if (detail) {
                runLogger.warn(`${displayName} stderr: ${detail}`);
              }
              reject(
                fail(`${displayName} exited with status ${status}. ${hint}`),
              );
            } else {
              resolve();
            }
          });
        });
      } finally {
        // Identity compare, not an unconditional clear: two GUI sessions can
        // overlap (the gate is a boolean and never promised mutual exclusion),
        // and the first one to finish must not wipe the later one's slot —
        // that would silently kill its Ctrl+X with no error anywhere.
        if (activeGuiSession === session) {
          activeGuiSession = null;
        }
      }
    }
  } finally {
    coreEvents.emit(CoreEvent.ExternalEditorClosed, { isTerminal });
  }
}

/**
 * Reopens the file the active GUI editor session is holding, in the same
 * editor — the escape hatch for a window that got buried behind other windows
 * or closed by accident. No-op when no GUI session is live, which also covers
 * the terminal editor path (it never records a session) and the case where no
 * editor resolved at all.
 *
 * Deliberately emits neither ExternalEditorOpening nor ExternalEditorClosed.
 * The input gate unlocks on any Closed — a boolean that fails open, see
 * `inputLockedRef` in KeypressContext — so a second event pair would release
 * the gate while the original editor is still open, bringing back the echo
 * bug the gate exists to prevent.
 *
 * Fire-and-forget by design: the session's original child still decides when
 * the session ends, so there is nothing here worth awaiting, and nothing may
 * reject into the keypress pipeline that calls this.
 *
 * Reuses the editor resolved when the session started rather than resolving
 * again: `/editor` may have changed the preference meanwhile, and this has to
 * reopen the same file in the same editor, not open a different one.
 */
export function relaunchActiveExternalEditor(): void {
  const session = activeGuiSession;
  if (!session) {
    return;
  }

  const { filePath, executable, args, displayName } = session;
  try {
    const child = spawn(executable, [...args, filePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_CAPTURED_STDERR) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (err) => {
      // Worth surfacing: unlike the original launch, the UI keeps rendering
      // during a GUI session, so the user actually sees this.
      coreEvents.emitFeedback(
        'warning',
        `Failed to reopen ${displayName}: ${err.message}`,
        err,
      );
    });

    child.on('close', (status) => {
      // A non-zero exit here only means this extra window was dismissed. The
      // session's own child is what reports real failures, so this is log-only.
      if (typeof status === 'number' && status !== 0) {
        const detail = stderr.trim().slice(0, MAX_CAPTURED_STDERR);
        runLogger.warn(
          `${displayName} reopen exited with status ${status}${
            detail ? `: ${detail}` : ''
          }`,
        );
      }
    });
  } catch (err) {
    // spawn can still throw synchronously (EMFILE, bad shell on Windows).
    // Never let that escape into the keypress pipeline.
    runLogger.warn(`Failed to reopen ${displayName}: ${String(err)}`);
  }
}
