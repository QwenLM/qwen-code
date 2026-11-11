/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import type { Writable } from 'stream';
import { env } from './stubs/env.js';
import {
  getClearTerminalSequence,
  getEraseViewportSequence,
} from './clearTerminal.js';
import type { Diff } from './frame.js';
import {
  clampCursorMoveY,
  cursorMove,
  cursorTo,
  eraseLines,
} from './termio/csi.js';
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from './termio/dec.js';
import { LINK_END, link } from './termio/osc.js';

const SGR_RESET = '\x1b[0m';

/**
 * Checks if the terminal supports DEC mode 2026 (synchronized output).
 * When supported, BSU/ESU sequences prevent visible flicker during redraws.
 */
export function isSynchronizedOutputSupported(): boolean {
  // tmux parses and proxies every byte but doesn't implement DEC 2026.
  // BSU/ESU pass through to the outer terminal but tmux has already
  // broken atomicity by chunking. Skip to save 16 bytes/frame + parser work.
  if (process.env['TMUX']) return false;

  // SSH sessions: env vars like WT_SESSION/TERM_PROGRAM are not forwarded,
  // so we can't identify the client terminal. Modern terminals universally
  // support DEC 2026 (unknown modes are silently ignored per spec), and the
  // cost of unsynchronized output over SSH (GPU renderer overload on Windows
  // Terminal) far outweighs the cost of 16 extra bytes/frame on terminals
  // that ignore the mode.
  if (process.env['SSH_CONNECTION'] || process.env['SSH_TTY']) return true;

  const termProgram = process.env['TERM_PROGRAM'];
  const term = process.env['TERM'];

  // Modern terminals with known DEC 2026 support
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true;
  }

  // kitty sets TERM=xterm-kitty or KITTY_WINDOW_ID
  if (term?.includes('kitty') || process.env['KITTY_WINDOW_ID']) return true;

  // Ghostty may set TERM=xterm-ghostty without TERM_PROGRAM
  if (term === 'xterm-ghostty') return true;

  // foot sets TERM=foot or TERM=foot-extra
  if (term?.startsWith('foot')) return true;

  // Alacritty may set TERM containing 'alacritty'
  if (term?.includes('alacritty')) return true;

  // Zed uses the alacritty_terminal crate which supports DEC 2026
  if (process.env['ZED_TERM']) return true;

  // Windows Terminal
  if (process.env['WT_SESSION']) return true;

  // VTE-based terminals (GNOME Terminal, Tilix, etc.) since VTE 0.68
  const vteVersion = process.env['VTE_VERSION'];
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

// -- XTVERSION-detected terminal name (populated async at startup) --
//
// TERM_PROGRAM is not forwarded over SSH by default, so env-based detection
// fails when the app runs remotely inside a VS Code integrated terminal.
// XTVERSION (CSI > 0 q → DCS > | name ST) goes through the pty — the query
// reaches the *client* terminal and the reply comes back through stdin.
// App.tsx fires the query when raw mode enables; setXtversionName() is called
// from the response handler. Readers should treat undefined as "not yet known"
// and fall back to env-var detection.

let xtversionName: string | undefined;

/** Record the XTVERSION response. Called once from App.tsx when the reply
 *  arrives on stdin. No-op if already set (defend against re-probe).
 *  If the identified terminal supports DEC 2026, upgrades SYNC_OUTPUT_SUPPORTED. */
export function setXtversionName(name: string): void {
  if (xtversionName === undefined) {
    xtversionName = name;
    if (xtversionSupportsSyncOutput(name)) {
      setSyncOutputSupported();
    }
  }
}

function xtversionSupportsSyncOutput(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('microsoft.windowsterminal')) return true;
  if (lower.startsWith('xterm.js')) return true;
  if (lower.startsWith('wezterm')) return true;
  if (lower.startsWith('iterm2')) return true;
  if (lower.startsWith('ghostty')) return true;
  if (lower.startsWith('foot')) return true;
  if (lower.startsWith('alacritty')) return true;
  if (lower.startsWith('kitty')) return true;
  if (lower.startsWith('contour')) return true;
  return false;
}

/** True if running in an xterm.js-based terminal (VS Code, Cursor, Windsurf
 *  integrated terminals). Combines TERM_PROGRAM env check (fast, sync, but
 *  not forwarded over SSH) with the XTVERSION probe result (async, survives
 *  SSH — query/reply goes through the pty). Early calls may miss the probe
 *  reply — call lazily (e.g. in an event handler) if SSH detection matters. */
export function isXtermJs(): boolean {
  if (process.env['TERM_PROGRAM'] === 'vscode') return true;
  return xtversionName?.startsWith('xterm.js') ?? false;
}

// Terminals known to correctly implement the Kitty keyboard protocol
// (CSI >1u) and/or xterm modifyOtherKeys (CSI >4;2m) for ctrl+shift+<letter>
// disambiguation. We previously enabled unconditionally (#23350), assuming
// terminals silently ignore unknown CSI — but some terminals honor the enable
// and emit codepoints our input parser doesn't handle (notably over SSH and
// in xterm.js-based terminals like VS Code). tmux is allowlisted because it
// accepts modifyOtherKeys and doesn't forward the kitty sequence to the outer
// terminal.
const EXTENDED_KEYS_TERMINALS = [
  'iTerm.app',
  'kitty',
  'WezTerm',
  'ghostty',
  'tmux',
  'windows-terminal',
];

/** True if this terminal correctly handles extended key reporting
 *  (Kitty keyboard protocol + xterm modifyOtherKeys). */
export function supportsExtendedKeys(): boolean {
  return EXTENDED_KEYS_TERMINALS.includes(env.terminal ?? '');
}

// Computed at module load; upgraded by setSyncOutputSupported() if XTVERSION
// later identifies a capable terminal (covers SSH where env detection failed).
// ESM live binding ensures all importers see the updated value.
export let SYNC_OUTPUT_SUPPORTED = isSynchronizedOutputSupported();

/** Upgrade sync-output flag to true. Called when XTVERSION identifies a
 *  terminal with DEC 2026 support. Only flips false→true, never downgrades. */
export function setSyncOutputSupported(): void {
  SYNC_OUTPUT_SUPPORTED = true;
}

export type Terminal = {
  stdout: Writable;
  stderr: Writable;
};

export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
  terminalRows?: number,
): void {
  // No output if there are no patches
  if (diff.length === 0) {
    return;
  }

  // BSU/ESU wrapping is opt-out to keep main-screen behavior unchanged.
  // Callers pass skipSyncMarkers=true when the terminal doesn't support
  // DEC 2026 (e.g. tmux) AND the cost matters (high-frequency alt-screen).
  // Additionally, only emit BSU/ESU on terminals that actually support
  // DEC 2026 synchronized output. Terminals like Terminal.app silently
  // ignore these sequences, but they add unnecessary bytes to the output
  // buffer and can confuse PTY chunking on slow/legacy terminals.
  const useSync = !skipSyncMarkers && SYNC_OUTPUT_SUPPORTED;

  // LogUpdate computes every frame from stylePool.none. The physical terminal
  // is not guaranteed to agree: another stdout writer, a terminal reconnect,
  // or an emulator-specific selective-reset bug can leave SGR attributes such
  // as dim active between frames. Hard-reset at both boundaries so each frame
  // is self-contained and the virtual style state can recover immediately.
  // Keep the resets inside BSU/ESU so synchronized terminals never expose the
  // reset-before-paint intermediate state.
  let buffer = useSync ? BSU + SGR_RESET : SGR_RESET;

  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        buffer += patch.content;
        break;
      case 'clear':
        if (patch.count > 0) {
          buffer += eraseLines(patch.count);
        }
        break;
      case 'eraseViewport':
        buffer += getEraseViewportSequence(patch.rows);
        break;
      case 'clearTerminal':
        buffer += LINK_END + '\x1b[0m' + getClearTerminalSequence();
        break;
      case 'cursorHide':
        buffer += HIDE_CURSOR;
        break;
      case 'cursorShow':
        buffer += SHOW_CURSOR;
        break;
      case 'cursorMove':
        buffer += cursorMove(
          patch.x,
          terminalRows !== undefined && terminalRows > 1
            ? clampCursorMoveY(patch.y, terminalRows)
            : patch.y,
        );
        break;
      case 'cursorTo':
        buffer += cursorTo(patch.col);
        break;
      case 'carriageReturn':
        buffer += '\r';
        break;
      case 'hyperlink':
        buffer += link(patch.uri);
        break;
      case 'styleStr':
        buffer += patch.str;
        break;
    }
  }

  // Do not leak the final cell's rendition to cursor movement, raw terminal
  // control writes, or the next frame. This is intentionally a hard reset,
  // rather than the selective transitions generated by diffAnsiCodes.
  buffer += SGR_RESET;

  // Add synchronized update end and flush buffer
  if (useSync) buffer += ESU;
  terminal.stdout.write(buffer);
}
