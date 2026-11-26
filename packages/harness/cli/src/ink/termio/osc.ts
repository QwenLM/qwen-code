/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * OSC (Operating System Command) Types and Parser
 */

import { env } from '../stubs/env.js';
import { BEL, ESC, ESC_TYPE, SEP } from './ansi.js';
import type { Action, Color, TabStatusAction } from './types.js';

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC);

/** String Terminator (ESC \) - alternative to BEL for terminating OSC */
export const ST = ESC + '\\';

/** Generate an OSC sequence: ESC ] p1;p2;...;pN <terminator>
 * Uses ST terminator for Kitty (avoids beeps), BEL for others */
export function osc(...parts: (string | number)[]): string {
  const terminator = env.terminal === 'kitty' ? ST : BEL;
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator}`;
}

/**
 * Wrap an escape sequence for terminal multiplexer passthrough.
 * tmux and GNU screen intercept escape sequences; DCS passthrough
 * tunnels them to the outer terminal unmodified.
 *
 * tmux 3.3+ gates this behind `allow-passthrough` (default off). When off,
 * tmux silently drops the whole DCS — no junk, no worse than unwrapped OSC.
 * Users who want passthrough set it in their .tmux.conf; we don't mutate it.
 *
 * Do NOT wrap BEL: raw \x07 triggers tmux's bell-action (window flag);
 * wrapped \x07 is opaque DCS payload and tmux never sees the bell.
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env['TMUX']) {
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b');
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  if (process.env['STY']) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
}



/**
 * OSC command numbers
 */
export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9, // iTerm2 proprietary sequences
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  CLIPBOARD: 52,
  KITTY: 99, // Kitty notification protocol
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777, // Ghostty notification protocol
  PROGRAM_STATUS: 7501, // Program Status Protocol
  TAB_STATUS: 21337, // Tab status extension
} as const;

/**
 * Parse an OSC sequence into an action
 *
 * @param content - The sequence content (without ESC ] and terminator)
 */
export function parseOSC(content: string): Action | null {
  const semicolonIdx = content.indexOf(';');
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content;
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : '';

  const commandNum = parseInt(command, 10);

  // Window/icon title
  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: 'title', action: { type: 'both', title: data } };
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: 'title', action: { type: 'iconName', name: data } };
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: 'title', action: { type: 'windowTitle', title: data } };
  }

  // Hyperlinks (OSC 8)
  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(';');
    const paramsStr = parts[0] ?? '';
    const url = parts.slice(1).join(';');

    if (url === '') {
      return { type: 'link', action: { type: 'end' } };
    }

    const params: Record<string, string> = {};
    if (paramsStr) {
      for (const pair of paramsStr.split(':')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
    }

    return {
      type: 'link',
      action: {
        type: 'start',
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    };
  }

  // Tab status (OSC 21337)
  if (commandNum === OSC.TAB_STATUS) {
    return { type: 'tabStatus', action: parseTabStatus(data) };
  }

  return { type: 'unknown', sequence: `\x1b]${content}` };
}

/**
 * Parse an XParseColor-style color spec into an RGB Color.
 * Accepts `#RRGGBB` and `rgb:R/G/B` (1–4 hex digits per component, scaled
 * to 8-bit). Returns null on parse failure.
 */
export function parseOscColor(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) {
    return {
      type: 'rgb',
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    };
  }
  const rgb = spec.match(
    /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i,
  );
  if (rgb) {
    // XParseColor: N hex digits → value / (16^N - 1), scale to 0-255
    const scale = (s: string) =>
      Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255);
    return {
      type: 'rgb',
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    };
  }
  return null;
}

/**
 * Parse OSC 21337 payload: `key=value;key=value;...` with `\;` and `\\`
 * escapes inside values. Bare key or `key=` clears that field; unknown
 * keys are ignored.
 */
function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {};
  for (const [key, value] of splitTabStatusPairs(data)) {
    switch (key) {
      case 'indicator':
        action.indicator = value === '' ? null : parseOscColor(value);
        break;
      case 'status':
        action.status = value === '' ? null : value;
        break;
      case 'status-color':
        action.statusColor = value === '' ? null : parseOscColor(value);
        break;
    }
  }
  return action;
}

/** Split `k=v;k=v` honoring `\;` and `\\` escapes. Yields [key, unescapedValue]. */
function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = '';
  let val = '';
  let inVal = false;
  let esc = false;
  for (const c of data) {
    if (esc) {
      if (inVal) val += c;
      else key += c;
      esc = false;
    } else if (c === '\\') {
      esc = true;
    } else if (c === ';') {
      yield [key, val];
      key = '';
      val = '';
      inVal = false;
    } else if (c === '=' && !inVal) {
      inVal = true;
    } else if (inVal) {
      val += c;
    } else {
      key += c;
    }
  }
  if (key || inVal) yield [key, val];
}

// Output generators

/** Start a hyperlink (OSC 8). Auto-assigns an id= param derived from the URL
 *  so terminals group wrapped lines of the same link together (the spec says
 *  cells with matching URI *and* nonempty id are joined; without an id each
 *  wrapped line is a separate link — inconsistent hover, partial tooltips).
 *  Empty url = close sequence (empty params per spec). */
export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END;
  const p = { id: osc8Id(url), ...params };
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(':');
  return osc(OSC.HYPERLINK, paramStr, url);
}

function osc8Id(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++)
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** End a hyperlink (OSC 8) */
export const LINK_END = osc(OSC.HYPERLINK, '', '');

// iTerm2 OSC 9 subcommands

/** iTerm2 OSC 9 subcommand numbers */
export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const;

/** Progress operation codes (for use with ITERM2.PROGRESS) */
export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const;

/**
 * Clear iTerm2 progress bar sequence (OSC 9;4;0;BEL)
 * Uses BEL terminator since this is for cleanup (not runtime notification)
 * and we want to ensure it's always sent regardless of terminal type.
 */
export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`;


/** Clear all three OSC 21337 tab-status fields. Used on exit. */
export const CLEAR_TAB_STATUS = osc(
  OSC.TAB_STATUS,
  'indicator=;status=;status-color=',
);

/**
 * Gate for emitting OSC 21337 (tab-status indicator). Ant-only while the
 * spec is unstable. Terminals that don't recognize it discard silently, so
 * emission is safe unconditionally — we don't gate on terminal detection
 * since support is expected across several terminals.
 *
 * Callers must wrap output with wrapForMultiplexer() so tmux/screen
 * DCS-passthrough carries the sequence to the outer terminal.
 */
export function supportsTabStatus(): boolean {
  return process.env['USER_TYPE'] === 'ant';
}
