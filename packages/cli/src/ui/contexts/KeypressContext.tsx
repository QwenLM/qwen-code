/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  KittySequenceOverflowEvent,
  logKittySequenceOverflow,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { useStdin } from 'ink';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import {
  BACKSLASH_ENTER_DETECTION_WINDOW_MS,
  CHAR_CODE_ESC,
  KITTY_CTRL_C,
  KITTY_KEYCODE_BACKSPACE,
  KITTY_KEYCODE_ENTER,
  KITTY_KEYCODE_NUMPAD_ENTER,
  KITTY_KEYCODE_TAB,
  MAX_KITTY_SEQUENCE_LENGTH,
  KITTY_MODIFIER_BASE,
  KITTY_MODIFIER_EVENT_TYPES_OFFSET,
  MODIFIER_SHIFT_BIT,
  MODIFIER_ALT_BIT,
  MODIFIER_CTRL_BIT,
} from '../utils/platformConstants.js';
import { clipboardHasImage } from '../utils/clipboardUtils.js';

import { FOCUS_IN, FOCUS_OUT } from '../hooks/useFocus.js';

const ESC = '\u001B';
export const PASTE_MODE_PREFIX = `${ESC}[200~`;
export const PASTE_MODE_SUFFIX = `${ESC}[201~`;
export const DRAG_COMPLETION_TIMEOUT_MS = 100; // Broadcast full path after 100ms if no more input
// Kitty sequence timeout: 200ms balances between:
// - Too short: prematurely clear valid sequences during slow input
// - Too long: delayed recovery from interrupted sequences (e.g., IME interruptions)
// Based on empirical testing with IME input patterns in VS Code integrated terminal.
export const KITTY_SEQUENCE_TIMEOUT_MS = 200;

// Paste idle timeout: auto-recovers from a stuck bracketed-paste mode
// when `paste-end` (`ESC[201~`) never arrives. Without this safety net, a
// lost paste-end marker leaves `isPaste = true` forever, every subsequent
// keystroke (including Ctrl+C) is silently buffered, and the only way to
// recover is to kill the terminal. 1000ms is long enough to cover slow
// chunked pastes on cold terminals yet short enough that users don't
// perceive the recovery as a hang.
export const PASTE_IDLE_TIMEOUT_MS = 1000;
export const SINGLE_QUOTE = "'";
export const DOUBLE_QUOTE = '"';

// Kitty keypad private-use keycodes (0xE000-0xE026)
// Reference: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions
const KITTY_KEYPAD_PRINTABLE_KEYCODE_TO_CHAR: Record<number, string> = {
  57399: '0',
  57400: '1',
  57401: '2',
  57402: '3',
  57403: '4',
  57404: '5',
  57405: '6',
  57406: '7',
  57407: '8',
  57408: '9',
  57409: '.',
  57410: '/',
  57411: '*',
  57412: '-',
  57413: '+',
  // 57414 is keypad Enter - handled separately via CSI~ sequence
  57415: '=',
  57416: ',',
};

const KITTY_KEYPAD_FUNCTIONAL_KEYCODE_TO_NAME: Record<number, string> = {
  57417: 'left',
  57418: 'right',
  57419: 'up',
  57420: 'down',
  57421: 'pageup',
  57422: 'pagedown',
  57423: 'home',
  57424: 'end',
  57425: 'insert',
  57426: 'delete',
};

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  paste: boolean;
  sequence: string;
  kittyProtocol?: boolean;
  pasteImage?: boolean;
}

export type KeypressHandler = (key: Key) => void;

interface KeypressContextValue {
  subscribe: (handler: KeypressHandler) => void;
  unsubscribe: (handler: KeypressHandler) => void;
  pasteWorkaround: boolean;
}

const KeypressContext = createContext<KeypressContextValue | undefined>(
  undefined,
);
const debugLogger = createDebugLogger('KEYPRESS');

export function useKeypressContext() {
  const context = useContext(KeypressContext);
  if (!context) {
    throw new Error(
      'useKeypressContext must be used within a KeypressProvider',
    );
  }
  return context;
}

export function KeypressProvider({
  children,
  kittyProtocolEnabled,
  pasteWorkaround = false,
  config,
  debugKeystrokeLogging,
  initialInputChunks = [],
}: {
  children?: React.ReactNode;
  kittyProtocolEnabled: boolean;
  pasteWorkaround?: boolean;
  config?: Config;
  debugKeystrokeLogging?: boolean;
  initialInputChunks?: readonly Buffer[];
}) {
  const { stdin, setRawMode } = useStdin();
  const subscribers = useRef<Set<KeypressHandler>>(new Set()).current;
  const initialInputReplayScheduled = useRef(false);
  const initialInputChunksRef = useRef<readonly Buffer[]>(initialInputChunks);

  const scheduleInitialInputReplay = useCallback(() => {
    if (
      initialInputReplayScheduled.current ||
      initialInputChunksRef.current.length === 0
    ) {
      return;
    }

    initialInputReplayScheduled.current = true;
    setTimeout(() => {
      for (const chunk of initialInputChunksRef.current) {
        stdin.emit('data', chunk);
      }
      initialInputChunksRef.current = [];
    }, 0);
  }, [stdin]);

  const subscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.add(handler);
      scheduleInitialInputReplay();
    },
    [scheduleInitialInputReplay, subscribers],
  );

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.delete(handler);
    },
    [subscribers],
  );

  useEffect(() => {
    const wasRaw = stdin.isRaw;
    if (wasRaw === false) {
      setRawMode(true);
    }

    const keypressStream = new PassThrough();
    let usePassthrough = false;
    // Use passthrough mode when pasteWorkaround is enabled,
    if (pasteWorkaround) {
      usePassthrough = true;
    }

    let isPaste = false;
    let pasteBuffer = Buffer.alloc(0);
    // Set to true when paste mode is ended by something other than a
    // received paste-end event (idle timeout or Ctrl+C escape). The next
    // real paste-end event that arrives — if any — is then a stale echo
    // and must be swallowed instead of producing a spurious empty paste.
    let pasteAlreadyFlushed = false;
    let pasteIdleTimeout: NodeJS.Timeout | null = null;
    const kittySequenceBufferRef = { current: '' };
    let kittySequenceTimeout: NodeJS.Timeout | null = null;
    let backslashTimeout: NodeJS.Timeout | null = null;
    let waitingForEnterAfterBackslash = false;
    let rawDataBuffer = Buffer.alloc(0);
    let rawFlushTimeout: NodeJS.Timeout | null = null;

    const updateKittyBuffer = (value: string) => {
      kittySequenceBufferRef.current = value;
    };

    const clearKittyTimeout = () => {
      if (kittySequenceTimeout) {
        clearTimeout(kittySequenceTimeout);
        kittySequenceTimeout = null;
      }
    };

    const startKittyTimeout = () => {
      clearKittyTimeout();
      kittySequenceTimeout = setTimeout(() => {
        if (kittySequenceBufferRef.current) {
          // Before discarding, try to salvage any parseable sequences
          // that may have been missed (e.g., due to chunked input).
          while (kittySequenceBufferRef.current) {
            const parsed = parseKittyPrefix(kittySequenceBufferRef.current);
            if (parsed) {
              kittySequenceBufferRef.current =
                kittySequenceBufferRef.current.slice(parsed.length);
              broadcast(parsed.key);
              continue;
            }
            const plain = parsePlainTextPrefix(kittySequenceBufferRef.current);
            if (plain) {
              kittySequenceBufferRef.current =
                kittySequenceBufferRef.current.slice(plain.length);
              broadcast(plain.key);
              continue;
            }
            break;
          }
          // Clear any remaining unparseable content
          if (kittySequenceBufferRef.current) {
            if (debugKeystrokeLogging) {
              debugLogger.debug(
                '[DEBUG] Kitty buffer timeout, clearing:',
                kittySequenceBufferRef.current,
              );
            }
            kittySequenceBufferRef.current = '';
          }
        }
      }, KITTY_SEQUENCE_TIMEOUT_MS);
    };

    const clearKittyBufferAndTimeout = () => {
      clearKittyTimeout();
      kittySequenceBufferRef.current = '';
    };

    const clearPasteIdleTimeout = () => {
      if (pasteIdleTimeout) {
        clearTimeout(pasteIdleTimeout);
        pasteIdleTimeout = null;
      }
    };

    // Force-flush a paste that has gone too long without its paste-end
    // marker. Rather than dropping whatever the user typed, broadcast the
    // buffered content as a regular paste event and reset state so the
    // next keystroke is handled normally.
    const forceFlushStuckPaste = () => {
      clearPasteIdleTimeout();
      // Nothing to recover from: not in paste mode AND no buffered content.
      // We still run when either condition is true — e.g. isPaste=true with
      // an empty buffer (need to clear the flag) or isPaste=false with stale
      // buffered content (e.g. after a race between Ctrl+C and the timer).
      if (!isPaste && pasteBuffer.length === 0) return;
      const buffered = pasteBuffer.toString();
      isPaste = false;
      pasteBuffer = Buffer.alloc(0);
      pasteAlreadyFlushed = true;
      if (buffered.length > 0) {
        broadcast({
          name: '',
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: buffered,
        });
      }
    };

    const startPasteIdleTimeout = () => {
      clearPasteIdleTimeout();
      pasteIdleTimeout = setTimeout(
        forceFlushStuckPaste,
        PASTE_IDLE_TIMEOUT_MS,
      );
    };

    const createPrintableKey = (char: string): Key => {
      const printableName =
        char === ' '
          ? 'space'
          : /^[A-Za-z]$/.test(char)
            ? char.toLowerCase()
            : char;

      return {
        name: printableName,
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: char,
        kittyProtocol: true,
      };
    };

    // Parse a single complete kitty sequence from the start (prefix) of the
    // buffer and return both the Key and the number of characters consumed.
    // This lets us "peel off" one complete event when multiple sequences arrive
    // in a single chunk, preventing buffer overflow and fragmentation.
    // Parse a single complete kitty/parameterized/legacy sequence from the start
    // of the buffer and return both the parsed Key and the number of characters
    // consumed. This enables peel-and-continue parsing for batched input.
    const parseKittyPrefix = (
      buffer: string,
    ): { key: Key; length: number } | null => {
      // In older terminals ESC [ Z was used as Cursor Backward Tabulation (CBT)
      // In newer terminals the same functionality of key combination for moving
      // backward through focusable elements is Shift+Tab, hence we will
      // map ESC [ Z to Shift+Tab
      // 0) Reverse Tab (legacy): ESC [ Z
      //    Treat as Shift+Tab for UI purposes.
      //    Regex parts:
      //    ^     - start of buffer
      //    ESC [ - CSI introducer
      //    Z     - legacy reverse tab
      const revTabLegacy = new RegExp(`^${ESC}\\[Z`);
      let m = buffer.match(revTabLegacy);
      if (m) {
        return {
          key: {
            name: 'tab',
            ctrl: false,
            meta: false,
            shift: true,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      // 1) Reverse Tab (parameterized): ESC [ 1 ; <mods> Z
      //    Parameterized reverse Tab: ESC [ 1 ; <mods> Z
      const revTabParam = new RegExp(`^${ESC}\\[1;(\\d+)Z`);
      m = buffer.match(revTabParam);
      if (m) {
        let mods = parseInt(m[1], 10);
        if (mods >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          mods -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const bits = mods - KITTY_MODIFIER_BASE;
        const alt = (bits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT;
        const ctrl = (bits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        return {
          key: {
            name: 'tab',
            ctrl,
            meta: alt,
            // Reverse tab implies Shift behavior; force shift regardless of mods
            shift: true,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      // 2) Parameterized functional: ESC [ 1 ; <mods> (A|B|C|D|H|F|P|Q|R|S)
      // 2) Parameterized functional: ESC [ 1 ; <mods> (A|B|C|D|H|F|P|Q|R|S)
      //    Arrows, Home/End, F1–F4 with modifiers encoded in <mods>.
      const arrowPrefix = new RegExp(`^${ESC}\\[1;(\\d+)([ABCDHFPQSR])`);
      m = buffer.match(arrowPrefix);
      if (m) {
        let mods = parseInt(m[1], 10);
        if (mods >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          mods -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const bits = mods - KITTY_MODIFIER_BASE;
        const shift = (bits & MODIFIER_SHIFT_BIT) === MODIFIER_SHIFT_BIT;
        const alt = (bits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT;
        const ctrl = (bits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        const sym = m[2];
        const symbolToName: { [k: string]: string } = {
          A: 'up',
          B: 'down',
          C: 'right',
          D: 'left',
          H: 'home',
          F: 'end',
          P: 'f1',
          Q: 'f2',
          R: 'f3',
          S: 'f4',
        };
        const name = symbolToName[sym] || '';
        if (!name) return null;
        return {
          key: {
            name,
            ctrl,
            meta: alt,
            shift,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      // 3) CSI-u form: ESC [ <code>[:<shifted>][:<base>] ; <mods>[:<event>] [; <text>] (u|~)
      // 3) CSI-u and tilde-coded functional keys with optional kitty extensions:
      //    Full kitty format: ESC [ code:shifted:base ; mods:event ; text u
      //    'u' terminator: Kitty CSI-u; '~' terminator: tilde-coded function keys.
      //    The colon-separated fields (shifted key, base key, event type, text)
      //    are optional extensions that some terminals send.
      const csiUPrefix = new RegExp(
        `^${ESC}\\[(\\d+)(?::\\d+)*(?:;(\\d+)(?::\\d+)*)?(?:;\\d+)?([u~])`,
      );
      m = buffer.match(csiUPrefix);
      if (m) {
        const keyCode = parseInt(m[1], 10);
        let modifiers = m[2] ? parseInt(m[2], 10) : KITTY_MODIFIER_BASE;
        if (modifiers >= KITTY_MODIFIER_EVENT_TYPES_OFFSET) {
          modifiers -= KITTY_MODIFIER_EVENT_TYPES_OFFSET;
        }
        const modifierBits = modifiers - KITTY_MODIFIER_BASE;
        const shift =
          (modifierBits & MODIFIER_SHIFT_BIT) === MODIFIER_SHIFT_BIT;
        const alt = (modifierBits & MODIFIER_ALT_BIT) === MODIFIER_ALT_BIT;
        const ctrl = (modifierBits & MODIFIER_CTRL_BIT) === MODIFIER_CTRL_BIT;
        const terminator = m[3];

        // Tilde-coded functional keys (Delete, Insert, PageUp/Down, Home/End)
        if (terminator === '~') {
          let name: string | null = null;
          switch (keyCode) {
            case 1:
              name = 'home';
              break;
            case 2:
              name = 'insert';
              break;
            case 3:
              name = 'delete';
              break;
            case 4:
              name = 'end';
              break;
            case 5:
              name = 'pageup';
              break;
            case 6:
              name = 'pagedown';
              break;
            default:
              break;
          }
          if (name) {
            return {
              key: {
                name,
                ctrl,
                meta: alt,
                shift,
                paste: false,
                sequence: buffer.slice(0, m[0].length),
                kittyProtocol: true,
              },
              length: m[0].length,
            };
          }
        }

        const kittyKeyCodeToName: { [key: number]: string } = {
          [CHAR_CODE_ESC]: 'escape',
          [KITTY_KEYCODE_TAB]: 'tab',
          [KITTY_KEYCODE_BACKSPACE]: 'backspace',
          [KITTY_KEYCODE_ENTER]: 'return',
          [KITTY_KEYCODE_NUMPAD_ENTER]: 'return',
        };

        const name = kittyKeyCodeToName[keyCode];
        if (name) {
          return {
            key: {
              name,
              ctrl,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true,
            },
            length: m[0].length,
          };
        }

        if (!ctrl) {
          const keypadChar = KITTY_KEYPAD_PRINTABLE_KEYCODE_TO_CHAR[keyCode];
          if (keypadChar) {
            return {
              key: {
                name: keypadChar,
                ctrl: false,
                meta: alt,
                shift,
                paste: false,
                sequence: keypadChar,
                kittyProtocol: true,
              },
              length: m[0].length,
            };
          }
        }

        const keypadName = KITTY_KEYPAD_FUNCTIONAL_KEYCODE_TO_NAME[keyCode];
        if (keypadName) {
          return {
            key: {
              name: keypadName,
              ctrl,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true,
            },
            length: m[0].length,
          };
        }

        // Printable CSI-u keys (including space) should behave like regular
        // character input so downstream text inputs receive the literal char.
        // Kitty uses the Unicode private use area for some functional keys
        // such as keypad events, so exclude that range from generic printable
        // conversion and handle mapped keys explicitly above.
        if (
          terminator === 'u' &&
          !ctrl &&
          keyCode >= 32 &&
          keyCode !== 127 &&
          keyCode <= 0x10ffff &&
          !(keyCode >= 0xe000 && keyCode <= 0xf8ff)
        ) {
          return {
            key: {
              ...createPrintableKey(String.fromCodePoint(keyCode)),
              meta: alt,
              shift,
            },
            length: m[0].length,
          };
        }

        // Ctrl+letters
        if (
          ctrl &&
          keyCode >= 'a'.charCodeAt(0) &&
          keyCode <= 'z'.charCodeAt(0)
        ) {
          const letter = String.fromCharCode(keyCode);
          return {
            key: {
              name: letter,
              ctrl: true,
              meta: alt,
              shift,
              paste: false,
              sequence: buffer.slice(0, m[0].length),
              kittyProtocol: true,
            },
            length: m[0].length,
          };
        }
      }

      // 4) Legacy function keys (no parameters): ESC [ (A|B|C|D|H|F)
      //    Arrows + Home/End without modifiers.
      const legacyFuncKey = new RegExp(`^${ESC}\\[([ABCDHF])`);
      m = buffer.match(legacyFuncKey);
      if (m) {
        const sym = m[1];
        const nameMap: { [key: string]: string } = {
          A: 'up',
          B: 'down',
          C: 'right',
          D: 'left',
          H: 'home',
          F: 'end',
        };
        const name = nameMap[sym]!;
        return {
          key: {
            name,
            ctrl: false,
            meta: false,
            shift: false,
            paste: false,
            sequence: buffer.slice(0, m[0].length),
            kittyProtocol: true,
          },
          length: m[0].length,
        };
      }

      return null;
    };

    const getCompleteCsiSequenceLength = (buffer: string): number | null => {
      if (!buffer.startsWith(`${ESC}[`)) {
        return null;
      }

      for (let i = 2; i < buffer.length; i++) {
        const code = buffer.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          return i + 1;
        }
        if (code < 0x20 || code > 0x3f) {
          return 0;
        }
      }

      return null;
    };

    const parsePlainTextPrefix = (
      buffer: string,
    ): { key: Key; length: number } | null => {
      if (!buffer || buffer.startsWith(ESC)) {
        return null;
      }

      const [char] = Array.from(buffer);
      if (!char) {
        return null;
      }

      return {
        key: createPrintableKey(char),
        length: char.length,
      };
    };

    const broadcast = (key: Key) => {
      for (const handler of subscribers) {
        handler(key);
      }
    };

    // Matches terminal query responses (DA1, DA2, Kitty protocol query)
    // that may arrive late from startup detection in kittyProtocolDetector.
    // These are never valid user input.
    // eslint-disable-next-line no-control-regex
    const TERMINAL_RESPONSE_RE = /^\x1b\[[?>][\d;]*[uc]$/;

    const handleKeypress = async (_: unknown, key: Key) => {
      if (TERMINAL_RESPONSE_RE.test(key.sequence)) {
        return;
      }
      if (key.sequence === FOCUS_IN || key.sequence === FOCUS_OUT) {
        return;
      }

      // Ctrl+C is an always-available escape hatch. It MUST be processed
      // before the `isPaste` branch below, otherwise a stuck paste mode
      // (paste-start without paste-end) silently buffers every key —
      // including Ctrl+C itself — and the user has no way to recover
      // without killing the terminal.
      const isCtrlCKey =
        (key.ctrl && key.name === 'c') ||
        key.sequence === `${ESC}${KITTY_CTRL_C}`;
      if (isCtrlCKey) {
        if (isPaste || pasteBuffer.length > 0) {
          isPaste = false;
          pasteBuffer = Buffer.alloc(0);
          pasteAlreadyFlushed = true;
          clearPasteIdleTimeout();
        }
        if (kittySequenceBufferRef.current && debugKeystrokeLogging) {
          debugLogger.debug(
            '[DEBUG] Kitty buffer cleared on Ctrl+C:',
            kittySequenceBufferRef.current,
          );
        }
        clearKittyBufferAndTimeout();
        if (key.sequence === `${ESC}${KITTY_CTRL_C}`) {
          broadcast({
            name: 'c',
            ctrl: true,
            meta: false,
            shift: false,
            paste: false,
            sequence: key.sequence,
            kittyProtocol: true,
          });
        } else {
          broadcast(key);
        }
        return;
      }

      if (key.name === 'paste-start') {
        isPaste = true;
        pasteAlreadyFlushed = false;
        startPasteIdleTimeout();
        return;
      }
      if (key.name === 'paste-end') {
        clearPasteIdleTimeout();
        // A stale paste-end may arrive after we force-flushed the paste
        // via the idle timeout or Ctrl+C escape — swallow it so we don't
        // broadcast a spurious empty/image paste event.
        if (pasteAlreadyFlushed) {
          // Reset for the next paste cycle.
          pasteAlreadyFlushed = false;
          isPaste = false;
          pasteBuffer = Buffer.alloc(0);
          return;
        }
        isPaste = false;
        if (pasteBuffer.toString().length > 0) {
          broadcast({
            name: '',
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            sequence: pasteBuffer.toString(),
          });
        } else {
          const hasImage = await clipboardHasImage();
          broadcast({
            name: '',
            ctrl: false,
            meta: false,
            shift: false,
            paste: true,
            pasteImage: hasImage,
            sequence: pasteBuffer.toString(),
          });
        }

        pasteBuffer = Buffer.alloc(0);
        return;
      }

      if (isPaste) {
        pasteBuffer = Buffer.concat([pasteBuffer, Buffer.from(key.sequence)]);
        startPasteIdleTimeout();
        return;
      }

      // Note: We no longer treat quotes specially for drag-and-drop detection.
      // Modern terminals use bracketed paste mode (PASTE_MODE_PREFIX) for file drops,
      // which is handled above. This prevents input lag on quote keystrokes.

      if (key.name === 'return' && waitingForEnterAfterBackslash) {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          ...key,
          shift: true,
          sequence: '\r', // Corrected escaping for newline
        });
        return;
      }

      if (key.sequence === '\\' && !key.name) {
        // Corrected escaping for backslash
        waitingForEnterAfterBackslash = true;
        backslashTimeout = setTimeout(() => {
          waitingForEnterAfterBackslash = false;
          backslashTimeout = null;
          broadcast(key);
        }, BACKSLASH_ENTER_DETECTION_WINDOW_MS);
        return;
      }

      if (waitingForEnterAfterBackslash && key.name !== 'return') {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          name: '',
          sequence: '\\',
          ctrl: false,
          meta: false,
          shift: false,
          paste: false,
        });
      }

      if (['up', 'down', 'left', 'right'].includes(key.name)) {
        broadcast(key);
        return;
      }

      // Ctrl+C is handled earlier, above the paste-state branches, so
      // that it remains an escape hatch even when paste mode is stuck.

      if (kittyProtocolEnabled) {
        if (
          kittySequenceBufferRef.current ||
          (key.sequence.startsWith(`${ESC}[`) &&
            !key.sequence.startsWith(PASTE_MODE_PREFIX) &&
            !key.sequence.startsWith(PASTE_MODE_SUFFIX) &&
            !key.sequence.startsWith(FOCUS_IN) &&
            !key.sequence.startsWith(FOCUS_OUT))
        ) {
          updateKittyBuffer(kittySequenceBufferRef.current + key.sequence);
          startKittyTimeout();

          if (debugKeystrokeLogging) {
            debugLogger.debug(
              '[DEBUG] Kitty buffer accumulating:',
              kittySequenceBufferRef.current,
            );
          }

          // Try to peel off as many complete sequences as are available at the
          // start of the buffer. This handles batched inputs cleanly. If the
          // prefix is incomplete or invalid, skip to the next CSI introducer
          // (ESC[) so that a following valid sequence can still be parsed.
          let bufferedInputHandled = false;
          while (kittySequenceBufferRef.current) {
            const parsed = parseKittyPrefix(kittySequenceBufferRef.current);
            if (parsed) {
              if (debugKeystrokeLogging) {
                const parsedSequence = kittySequenceBufferRef.current.slice(
                  0,
                  parsed.length,
                );
                if (kittySequenceBufferRef.current.length > parsed.length) {
                  debugLogger.debug(
                    '[DEBUG] Kitty sequence parsed successfully (prefix):',
                    parsedSequence,
                  );
                } else {
                  debugLogger.debug(
                    '[DEBUG] Kitty sequence parsed successfully:',
                    parsedSequence,
                  );
                }
              }
              // Consume the parsed prefix and broadcast it.
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(parsed.length),
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              broadcast(parsed.key);
              bufferedInputHandled = true;
              continue;
            }

            const completeUnsupportedCsiLength = getCompleteCsiSequenceLength(
              kittySequenceBufferRef.current,
            );
            if (completeUnsupportedCsiLength) {
              if (debugKeystrokeLogging) {
                debugLogger.debug(
                  '[DEBUG] Dropping unsupported complete CSI sequence:',
                  kittySequenceBufferRef.current.slice(
                    0,
                    completeUnsupportedCsiLength,
                  ),
                );
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(
                  completeUnsupportedCsiLength,
                ),
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              bufferedInputHandled = true;
              continue;
            }

            const plainTextPrefix = parsePlainTextPrefix(
              kittySequenceBufferRef.current,
            );
            if (plainTextPrefix) {
              if (debugKeystrokeLogging) {
                debugLogger.debug(
                  '[DEBUG] Recovered plain text after kitty sequence:',
                  plainTextPrefix.key.sequence,
                );
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(plainTextPrefix.length),
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              broadcast(plainTextPrefix.key);
              bufferedInputHandled = true;
              continue;
            }

            // Look for the next potential CSI start beyond index 0
            const nextStart = kittySequenceBufferRef.current.indexOf(
              `${ESC}[`,
              1,
            );
            if (nextStart > 0) {
              if (debugKeystrokeLogging) {
                debugLogger.debug(
                  '[DEBUG] Skipping incomplete/invalid CSI prefix:',
                  kittySequenceBufferRef.current.slice(0, nextStart),
                );
              }
              updateKittyBuffer(
                kittySequenceBufferRef.current.slice(nextStart),
              );
              if (!kittySequenceBufferRef.current) {
                clearKittyTimeout();
              }
              bufferedInputHandled = true;
              continue;
            }
            break;
          }
          if (bufferedInputHandled) return;

          if (config?.getDebugMode() || debugKeystrokeLogging) {
            const codes = Array.from(kittySequenceBufferRef.current).map(
              (ch: string) => ch.charCodeAt(0),
            );
            debugLogger.warn('Kitty sequence buffer has char codes:', codes);
          }

          if (
            kittySequenceBufferRef.current.length > MAX_KITTY_SEQUENCE_LENGTH
          ) {
            if (debugKeystrokeLogging) {
              debugLogger.debug(
                '[DEBUG] Kitty buffer overflow, clearing:',
                kittySequenceBufferRef.current,
              );
            }
            if (config) {
              const event = new KittySequenceOverflowEvent(
                kittySequenceBufferRef.current.length,
                kittySequenceBufferRef.current,
              );
              logKittySequenceOverflow(config, event);
            }
            clearKittyBufferAndTimeout();
          } else {
            return;
          }
        }
      }

      if (key.name === 'return' && key.sequence === `${ESC}\r`) {
        key.meta = true;
      }
      broadcast({ ...key, paste: isPaste });
    };

    const clearRawFlushTimeout = () => {
      if (rawFlushTimeout) {
        clearTimeout(rawFlushTimeout);
        rawFlushTimeout = null;
      }
    };

    const createPasteKeyEvent = (
      name: 'paste-start' | 'paste-end' | '' = '',
      sequence: string = '',
    ): Key => ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence,
    });

    const flushRawBuffer = () => {
      if (!rawDataBuffer.length) {
        return;
      }

      const pasteModePrefixBuffer = Buffer.from(PASTE_MODE_PREFIX);
      const pasteModeSuffixBuffer = Buffer.from(PASTE_MODE_SUFFIX);
      const data = rawDataBuffer;
      let cursor = 0;

      while (cursor < data.length) {
        const prefixPos = data.indexOf(pasteModePrefixBuffer, cursor);
        const suffixPos = data.indexOf(pasteModeSuffixBuffer, cursor);
        const hasPrefix =
          prefixPos !== -1 &&
          prefixPos + pasteModePrefixBuffer.length <= data.length;
        const hasSuffix =
          suffixPos !== -1 &&
          suffixPos + pasteModeSuffixBuffer.length <= data.length;

        let markerPos = -1;
        let markerLength = 0;
        let markerType: 'prefix' | 'suffix' | null = null;

        if (hasPrefix && (!hasSuffix || prefixPos < suffixPos)) {
          markerPos = prefixPos;
          markerLength = pasteModePrefixBuffer.length;
          markerType = 'prefix';
        } else if (hasSuffix) {
          markerPos = suffixPos;
          markerLength = pasteModeSuffixBuffer.length;
          markerType = 'suffix';
        }

        if (markerPos === -1) {
          break;
        }

        const nextData = data.slice(cursor, markerPos);
        if (nextData.length > 0) {
          keypressStream.write(nextData);
        }
        if (markerType === 'prefix') {
          handleKeypress(undefined, createPasteKeyEvent('paste-start'));
        } else if (markerType === 'suffix') {
          handleKeypress(undefined, createPasteKeyEvent('paste-end'));
        }
        cursor = markerPos + markerLength;
      }

      rawDataBuffer = data.slice(cursor);

      if (rawDataBuffer.length === 0) {
        return;
      }

      if (
        (rawDataBuffer.length <= 2 && rawDataBuffer.includes(0x0d)) ||
        !rawDataBuffer.includes(0x0d) ||
        isPaste
      ) {
        keypressStream.write(rawDataBuffer);
      } else {
        // Flush raw data buffer as a paste event
        handleKeypress(undefined, createPasteKeyEvent('paste-start'));
        keypressStream.write(rawDataBuffer);
        handleKeypress(undefined, createPasteKeyEvent('paste-end'));
      }

      rawDataBuffer = Buffer.alloc(0);
      clearRawFlushTimeout();
    };

    const handleRawKeypress = (_data: Buffer) => {
      const data = Buffer.isBuffer(_data) ? _data : Buffer.from(_data, 'utf8');

      // Buffer the incoming data
      rawDataBuffer = Buffer.concat([rawDataBuffer, data]);

      clearRawFlushTimeout();

      // On some Windows terminals, during a paste, the terminal might send a
      // single return character chunk. In this case, we need to wait a time period
      // to know if it is part of a paste or just a return character.
      const isReturnChar =
        rawDataBuffer.length <= 2 && rawDataBuffer.includes(0x0d);
      if (isReturnChar) {
        rawFlushTimeout = setTimeout(flushRawBuffer, 100);
      } else {
        flushRawBuffer();
      }
    };

    let rl: readline.Interface;

    if (usePassthrough) {
      rl = readline.createInterface({
        input: keypressStream,
        escapeCodeTimeout: 0,
      });
      readline.emitKeypressEvents(keypressStream, rl);
      keypressStream.on('keypress', handleKeypress);
      stdin.on('data', handleRawKeypress);
    } else {
      rl = readline.createInterface({ input: stdin, escapeCodeTimeout: 0 });
      readline.emitKeypressEvents(stdin, rl);
      stdin.on('keypress', handleKeypress);
    }

    return () => {
      if (usePassthrough) {
        keypressStream.removeListener('keypress', handleKeypress);
        stdin.removeListener('data', handleRawKeypress);
      } else {
        stdin.removeListener('keypress', handleKeypress);
      }

      rl.close();

      // Restore the terminal to its original state.
      if (wasRaw === false) {
        setRawMode(false);
      }

      if (backslashTimeout) {
        clearTimeout(backslashTimeout);
        backslashTimeout = null;
      }

      clearKittyBufferAndTimeout();
      clearPasteIdleTimeout();

      if (rawFlushTimeout) {
        clearTimeout(rawFlushTimeout);
        rawFlushTimeout = null;
      }

      // Flush any pending paste data to avoid data loss on exit.
      if (isPaste) {
        broadcast({
          name: '',
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          sequence: pasteBuffer.toString(),
        });
        pasteBuffer = Buffer.alloc(0);
      }
    };
  }, [
    stdin,
    setRawMode,
    kittyProtocolEnabled,
    debugKeystrokeLogging,
    pasteWorkaround,
    config,
    subscribers,
    initialInputChunks,
  ]);

  return (
    <KeypressContext.Provider
      value={{ subscribe, unsubscribe, pasteWorkaround }}
    >
      {children}
    </KeypressContext.Provider>
  );
}
