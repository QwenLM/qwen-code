/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  coreEvents,
  CoreEvent,
  runLogger,
  type Config,
  type ExternalEditorPayload,
} from '@qwen-code/core';
import { useStdin, InternalStdinContext } from 'ink';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import type {
  InputEvent,
  Key as InkKey,
} from '../../ink/events/input-event.js';
import { nonAlphanumericKeys } from '../../ink/parse-keypress.js';
import { parseMouseEvent } from '../utils/mouse.js';
import { containsControlCharacters } from '../utils/textUtils.js';
import { relaunchActiveExternalEditor } from '../utils/editorUtils.js';
import { Command, type KeyMatchers } from '../key/keyMatchers.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { FOCUS_IN, FOCUS_OUT } from '../../ink/termio/csi.js';
import { terminalCapabilityManager } from '../utils/terminalCapabilityManager.js';
import { isAppleTerminal } from '../utils/terminalUtils.js';
import {
  isModifierPressed,
  prewarmNativeModifierDetector,
} from '../utils/nativeModifierDetector.js';
import { useSettingsStore } from './SettingsContext.js';

/**
 * The two keys that survive the external-editor input gate.
 *
 * Matched through the active `KeyMatchers` rather than hardcoded 'ctrl+x' /
 * 'ctrl+c' so a user who rebound either command keeps the escape hatch on
 * their own binding.
 */
const isEditorRelaunchKey = (matchers: KeyMatchers, key: Key) =>
  matchers[Command.OPEN_EXTERNAL_EDITOR](key);
const isEditorInterruptKey = (matchers: KeyMatchers, key: Key) =>
  matchers[Command.QUIT](key);

export const BACKSLASH_ENTER_TIMEOUT = 5;
export const ESC_TIMEOUT = 50;
export const PASTE_TIMEOUT = 30_000;
export const FAST_RETURN_TIMEOUT = 30;

/**
 * Map CC Ink's key name + boolean flags to the string name format
 * expected by GMN's KeypressContext consumers.
 *
 * CC Ink's ParsedKey.name uses strings like 'up', 'down', 'return', etc.
 * which mostly match GMN's format. This function normalizes edge cases.
 */
function mapKeyName(parsedName: string, inkKey: InkKey): string {
  // CC Ink uses 'return', GMN uses 'enter'
  if (parsedName === 'return' || inkKey.return) return 'enter';
  // Ensure arrow keys are named correctly
  if (inkKey.upArrow) return 'up';
  if (inkKey.downArrow) return 'down';
  if (inkKey.leftArrow) return 'left';
  if (inkKey.rightArrow) return 'right';
  if (inkKey.pageUp) return 'pageup';
  if (inkKey.pageDown) return 'pagedown';
  if (inkKey.home) return 'home';
  if (inkKey.end) return 'end';
  if (inkKey.backspace) return 'backspace';
  if (inkKey.delete) return 'delete';
  if (inkKey.escape) return 'escape';
  if (inkKey.tab) return 'tab';
  return parsedName;
}

function nonKeyboardEventFilter(
  keypressHandler: KeypressHandler,
): KeypressHandler {
  return (key: Key) => {
    if (
      !parseMouseEvent(key.sequence) &&
      key.sequence !== FOCUS_IN &&
      key.sequence !== FOCUS_OUT
    ) {
      keypressHandler(key);
    }
  };
}

export function shouldSubmitFastReturnAfterInsertable(key: Key | null): boolean {
  if (!key?.insertable || key.name === 'paste' || !key.sequence) {
    return false;
  }

  // Coalesced-Enter heuristic: a single-line text chunk
  // followed immediately by Enter is user input + submit, while embedded CR/LF
  // is treated as multiline paste from a terminal without bracketed paste.
  // Control characters mark an unrecognized escape sequence rather than typed
  // text, and must never be coalesced into a submission.
  return (
    !key.sequence.endsWith('\\') &&
    !/[\r\n]/.test(key.sequence) &&
    !containsControlCharacters(key.sequence)
  );
}

/**
 * Converts return keys pressed quickly after multiline insertable input into a
 * shift+return. Single-line coalesced text+return is allowed to submit.
 *
 * This accommodates older terminals that paste text without bracketing without
 * swallowing Windows/SSH chunks like "hello\r" or "hello\r\n".
 */
function bufferFastReturn(keypressHandler: KeypressHandler): KeypressHandler {
  let lastKeyTime = 0;
  let lastInsertableKey: Key | null = null;
  return (key: Key) => {
    const now = Date.now();
    if (key.name === 'enter' && now - lastKeyTime <= FAST_RETURN_TIMEOUT) {
      if (shouldSubmitFastReturnAfterInsertable(lastInsertableKey)) {
        keypressHandler({
          ...key,
          coalescedSubmitText: lastInsertableKey?.sequence,
        });
      } else {
        keypressHandler({
          ...key,
          name: 'enter',
          shift: true, // to make it a newline, not a submission
          alt: false,
          ctrl: false,
          cmd: false,
          sequence: '\r',
          insertable: true,
        });
      }
    } else {
      keypressHandler(key);
    }
    if (key.insertable) {
      lastKeyTime = now;
      lastInsertableKey = key;
    } else {
      lastKeyTime = 0;
      lastInsertableKey = null;
    }
  };
}

/**
 * Apple Terminal modifier detection for Enter keypresses.
 *
 * Apple Terminal.app doesn't encode modifier state in escape sequences, so
 * Shift+Enter arrives as a bare CR — identical to a plain Enter. On macOS,
 * when we detect Apple Terminal and the terminal cannot distinguish modified
 * Enter natively, we query CoreGraphics for the current physical Shift state
 * through an in-process N-API binding.
 *
 * Option+Enter remains an ESC+CR sequence after /terminal-setup enables
 * Option-as-Meta, while Ctrl+J is already a distinct LF byte. Neither needs
 * native modifier inference here.
 */
function appleTerminalModifierDetection(
  keypressHandler: KeypressHandler,
): KeypressHandler {
  // Only active on macOS Apple Terminal when the terminal can't distinguish
  // modified Enter on its own.
  const shouldDetect =
    process.platform === 'darwin' &&
    isAppleTerminal() &&
    !terminalCapabilityManager.canDistinguishModifiedEnter();

  if (!shouldDetect) {
    return keypressHandler;
  }

  return (key: Key) => {
    if (key.name === 'enter' && !key.shift && !key.alt && !key.ctrl) {
      if (isModifierPressed('shift')) {
        keypressHandler({
          ...key,
          shift: true,
          insertable: true,
        });
        return;
      }
    }
    keypressHandler(key);
  };
}

/**
 * SSH Alt+Enter bare-CR coalescing.
 *
 * Over SSH, Alt+Enter sometimes produces a bare \r byte that leaks through
 * without the meta/alt flag set. If the terminal doesn't support Kitty or
 * modifyOtherKeys, an Enter that arrives within a short window after an
 * ESC byte (the beginning of an alt-sequence) can be mis-parsed.
 *
 * This filter catches lone \r keys over SSH and, when paired with a preceding
 * ESC within a small window, converts them to alt+enter. This is a best-effort
 * heuristic — the BACKSLASH_ENTER_TIMEOUT constant controls the window.
 */
export const SSH_ALT_ENTER_TIMEOUT = 50;

function bufferSSHAltEnter(keypressHandler: KeypressHandler): KeypressHandler {
  const isSSHSession = Boolean(
    process.env['SSH_TTY'] ||
      process.env['SSH_CONNECTION'] ||
      process.env['SSH_CLIENT'],
  );

  if (
    !isSSHSession ||
    terminalCapabilityManager.canDistinguishModifiedEnter()
  ) {
    return keypressHandler;
  }

  let lastEscTime = 0;

  return (key: Key) => {
    // Track ESC keypresses
    if (key.name === 'escape') {
      lastEscTime = Date.now();
    }

    // If we see a bare Enter shortly after an ESC, treat as Alt+Enter
    if (
      key.name === 'enter' &&
      !key.shift &&
      !key.alt &&
      !key.ctrl &&
      Date.now() - lastEscTime <= SSH_ALT_ENTER_TIMEOUT
    ) {
      lastEscTime = 0;
      keypressHandler({
        ...key,
        alt: true,
      });
      return;
    }

    keypressHandler(key);
  };
}

/**
 * Buffers "/" keys to see if they are followed return.
 * Will flush the buffer if no data is received for DRAG_COMPLETION_TIMEOUT_MS
 * or when a null key is received.
 */
function bufferBackslashEnter(
  keypressHandler: KeypressHandler,
): KeypressHandler {
  const bufferer = (function* (): Generator<void, void, Key | null> {
    while (true) {
      const key = yield;

      if (key == null) {
        continue;
      } else if (key.sequence !== '\\') {
        keypressHandler(key);
        continue;
      }

      const timeoutId = setTimeout(
        () => bufferer.next(null),
        BACKSLASH_ENTER_TIMEOUT,
      );
      const nextKey = yield;
      clearTimeout(timeoutId);

      if (nextKey === null) {
        keypressHandler(key);
      } else if (nextKey.name === 'enter') {
        // Emit a plain shift+enter. The other modifiers must be cleared, not
        // inherited: a coalesced Option+Enter arrives as alt+enter, and
        // shift+alt+enter matches no binding (KeyBinding.matches compares all
        // four modifier bits), so the keypress — and the buffered backslash —
        // would be swallowed. bufferFastReturn clears them for the same reason.
        keypressHandler({
          ...nextKey,
          shift: true,
          alt: false,
          ctrl: false,
          cmd: false,
          sequence: '\r', // Corrected escaping for newline
        });
      } else {
        keypressHandler(key);
        keypressHandler(nextKey);
      }
    }
  })();

  bufferer.next(); // prime the generator so it starts listening.

  return (key: Key) => {
    bufferer.next(key);
  };
}

// NOTE: bufferPaste, createDataListener, and emitKeys have been removed.
// CC Ink's parser (parseMultipleKeypresses in App.tsx) now handles all raw
// byte parsing, escape sequence buffering, and bracketed paste aggregation.
// KeypressContext subscribes to internal_eventEmitter 'input' events instead
// of registering a raw stdin 'data' listener.

export interface Key {
  name: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  cmd: boolean; // Command/Windows/Super key
  insertable: boolean;
  sequence: string;
  coalescedSubmitText?: string;
}

export type KeypressHandler = (key: Key) => boolean | void;

interface KeypressContextValue {
  /** Exclusive ephemeral input: bypass debug logs and text-coalescing history. */
  registerSensitiveInput: (handler: KeypressHandler) => () => void;
  subscribe: (handler: KeypressHandler) => void;
  unsubscribe: (handler: KeypressHandler) => void;
  /**
   * Register a callback that fires on every keypress, before dispatch.
   * Used by useFocus to detect terminal activity without participating
   * in the context dispatch chain.
   */
  registerOnAnyKeypress: (cb: () => void) => void;
  unregisterOnAnyKeypress: (cb: () => void) => void;
}

const KeypressContext = createContext<KeypressContextValue | undefined>(
  undefined,
);

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
  config,
}: {
  children: React.ReactNode;
  config?: Config;
}) {
  const { settings } = useSettingsStore();
  const debugKeystrokeLogging = settings.merged.general.debugKeystrokeLogging;

  const { stdin, setRawMode } = useStdin();
  const { internal_eventEmitter } = useContext(InternalStdinContext);

  // Simple ordered set of handlers — no priority, LIFO order.
  // Context routing is the sole subscriber in production; TextInput
  // and useSelectionList subscribe at the same level for legacy compat.
  const subscribers = useRef<Set<KeypressHandler>>(new Set()).current;

  // A GUI external editor owns the prompt but never the terminal, so we hand
  // over nothing: raw mode stays on (the tty doesn't echo, and Ctrl+C stays a
  // byte instead of becoming SIGINT) and Ink keeps draining stdin (nothing
  // queues up in the tty to be delivered once the editor closes). Keys that
  // arrive meanwhile are dropped here instead — except the two escape hatches:
  // the relaunch key reopens the editor window, and the interrupt key is let
  // through so Ctrl+C still means "get me out of here".
  const inputLockedRef = useRef(false);
  const sensitiveInput = useRef<KeypressHandler | undefined>(undefined);
  const registerSensitiveInput = useCallback((handler: KeypressHandler) => {
    sensitiveInput.current = handler;
    return () => { if (sensitiveInput.current === handler) sensitiveInput.current = undefined; };
  }, []);

  // Read through a ref so the input pipeline below never has to be torn down
  // and rebuilt just because custom keybindings finished loading.
  const keyMatchers = useKeyMatchers();
  const keyMatchersRef = useRef(keyMatchers);
  keyMatchersRef.current = keyMatchers;

  useEffect(() => {
    // Only the GUI handoff. The terminal handoff suspends stdin outright, so
    // nothing reaches this provider and a lock there could only wedge input.
    // A missing payload means terminal, matching AppContainer's `?? true`.
    const lock = (payload?: ExternalEditorPayload) => {
      if (payload?.isTerminal === false) {
        inputLockedRef.current = true;
      }
    };
    // Boolean, not a refcount: an unpaired Closed must fail open. A refcount
    // left at a positive depth would kill input for the rest of the session.
    const unlock = (payload?: ExternalEditorPayload) => {
      if (payload?.isTerminal === false) {
        inputLockedRef.current = false;
      }
    };
    coreEvents.on(CoreEvent.ExternalEditorOpening, lock);
    coreEvents.on(CoreEvent.ExternalEditorClosed, unlock);
    return () => {
      coreEvents.off(CoreEvent.ExternalEditorOpening, lock);
      coreEvents.off(CoreEvent.ExternalEditorClosed, unlock);
    };
  }, []);

  const subscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.add(handler);
    },
    [subscribers],
  );

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.delete(handler);
    },
    [subscribers],
  );

  // onAnyKeypress: system-level callbacks (e.g. useFocus terminal activity detection)
  const anyKeypressCallbacks = useRef<Set<() => void>>(new Set()).current;
  const registerOnAnyKeypress = useCallback(
    (cb: () => void) => {
      anyKeypressCallbacks.add(cb);
    },
    [anyKeypressCallbacks],
  );
  const unregisterOnAnyKeypress = useCallback(
    (cb: () => void) => {
      anyKeypressCallbacks.delete(cb);
    },
    [anyKeypressCallbacks],
  );

  const broadcast = useCallback(
    (key: Key) => {
      // Second half of the external-editor lock. `inputHandler` already drops
      // keys at the top of the pipeline; this catches whatever was already
      // in flight inside a buffering wrapper when the lock engaged — e.g. a
      // held '\' that `bufferBackslashEnter` flushes alongside a passing
      // interrupt key. Before the callback loop, so a swallowed key doesn't
      // register as terminal activity either; the interrupt key does pass and
      // genuinely is activity. The relaunch key never reaches here — it is
      // intercepted upstream in `inputHandler`.
      if (
        inputLockedRef.current &&
        !isEditorInterruptKey(keyMatchersRef.current, key)
      ) {
        return;
      }

      // Fire system-level callbacks before dispatch (e.g. useFocus activity detection)
      for (const cb of anyKeypressCallbacks) {
        cb();
      }

      if (debugKeystrokeLogging && !sensitiveInput.current) {
        runLogger.log('[DEBUG] Keystroke:', JSON.stringify(key));
      }

      // LIFO: last subscribed handler fires first (reverse iteration).
      // In practice, context routing is the sole subscriber and handles
      // all dispatch via the context/action handler system.
      const handlers = Array.from(subscribers).reverse();
      for (const handler of handlers) {
        if (handler(key) === true) {
          return;
        }
      }
    },
    [subscribers, anyKeypressCallbacks, debugKeystrokeLogging],
  );

  useEffect(() => {
    terminalCapabilityManager.enableSupportedModes();

    if (
      process.platform === 'darwin' &&
      isAppleTerminal() &&
      !terminalCapabilityManager.canDistinguishModifiedEnter()
    ) {
      prewarmNativeModifierDetector();
    }

    // Always call setRawMode(true) to ensure CC Ink's App registers its
    // stdin 'readable' listener. Even if stdin.isRaw is already true
    // (e.g. gemini.js sets it early), App's rawModeEnabledCount may still
    // be 0, meaning its stdin handler hasn't been registered yet.
    setRawMode(true);

    // Build the processing pipeline for GMN-specific key transformations.
    // CC Ink's parser already handles raw bytes, escape sequences, and paste
    // bracketing. We only need GMN's post-processing layers here.
    //
    // Pipeline order (innermost runs first):
    //   1. nonKeyboardEventFilter — drop mouse/focus events
    //   2. appleTerminalModifierDetection — enrich Enter with native modifier state
    //   3. bufferSSHAltEnter — detect Alt+Enter over SSH (ESC + Enter)
    //   4. bufferFastReturn — protect rapid Enter after multiline insertable text
    //   5. bufferBackslashEnter — treat \ + Enter as Shift+Enter
    let processor = nonKeyboardEventFilter(broadcast);
    processor = appleTerminalModifierDetection(processor);
    processor = bufferSSHAltEnter(processor);
    if (!terminalCapabilityManager.isKittyProtocolEnabled()) {
      processor = bufferFastReturn(processor);
    }
    processor = bufferBackslashEnter(processor);

    /**
     * Convert CC Ink's InputEvent to KeypressContext's Key format and feed
     * through the GMN processing pipeline.
     *
     * CC Ink's App.js reads stdin via 'readable' events, parses keypresses,
     * and emits 'input' events on internal_eventEmitter. We subscribe here
     * instead of adding our own stdin 'data' listener, because mixing
     * 'readable' and 'data' listeners on the same stream causes Node.js
     * to switch to flowing mode, making stdin.read() return null and
     * breaking CC Ink's entire key-parsing pipeline.
     */
    const inputHandler = (event: InputEvent) => {
      const kp = event.keypress;
      const isInsertable =
        !kp.ctrl &&
        !kp.meta &&
        !kp.option &&
        event.input.length > 0 &&
        // Kitty may expose a functional key name as input (e.g. "insert").
        // Use the parser's classification, including keys without Ink flags.
        !nonAlphanumericKeys.includes(kp.name ?? '');
      if (sensitiveInput.current) {
        sensitiveInput.current({
          name: kp.isPasted ? 'paste' : mapKeyName(kp.name ?? '', event.key),
          shift: !!kp.shift,
          alt: !!(kp.meta || kp.option),
          ctrl: !!kp.ctrl,
          cmd: !!kp.super,
          insertable: kp.isPasted || isInsertable,
          sequence: kp.isPasted
            ? (kp.sequence ?? '')
            : (event.input || kp.sequence || ''),
        });
        return;
      }

      if (debugKeystrokeLogging && !sensitiveInput.current) {
        runLogger.log(
          `[DEBUG] CC Ink InputEvent: input=${JSON.stringify(event.input)} name=${kp.name} ctrl=${kp.ctrl} shift=${kp.shift} meta=${kp.meta} isPasted=${kp.isPasted} seq=${JSON.stringify(kp.sequence)}`,
        );
      }

      // Handle pasted content: CC Ink aggregates paste into a single key
      // with isPasted=true and sequence=pasteContent
      if (kp.isPasted) {
        // A paste can never be one of the escape hatches, so the lock takes it
        // whole. Checked after the debug log above, so swallowed input stays
        // diagnosable under debugKeystrokeLogging.
        if (inputLockedRef.current) {
          return;
        }
        processor({
          name: 'paste',
          shift: false,
          alt: false,
          ctrl: false,
          cmd: false,
          insertable: true,
          sequence: kp.sequence ?? '',
        });
        return;
      }

      // Map CC Ink's key to KeypressContext's Key format
      const name = kp.name || '';
      let key: Key = {
        name: mapKeyName(name, event.key),
        shift: kp.shift,
        alt: kp.meta || kp.option,
        ctrl: kp.ctrl,
        cmd: kp.super,
        insertable: isInsertable,
        // Text consumers insert sequence directly. Use the decoded text for
        // CSI u / modifyOtherKeys / keypad input, preserving raw sequences for
        // non-insertable keys so shortcut and control-key handling is unchanged.
        sequence: isInsertable ? event.input : (kp.sequence || ''),
      };

      // Fix Ctrl+J handling: the parser maps \n (0x0a) to {name:'enter'}
      // but Ctrl+J should be {name:'j', ctrl:true} to match the ctrl+j
      // keybinding for newline insertion. Without this, Ctrl+J submits
      // the message instead of inserting a newline.
      if (
        key.sequence === '\n' &&
        key.name === 'enter' &&
        !key.ctrl &&
        !key.shift &&
        !key.alt
      ) {
        key = {
          ...key,
          name: 'j',
          ctrl: true,
          insertable: false,
        };
      }

      // First half of the external-editor lock — see inputLockedRef. Placed
      // after the mapping above so the escape hatches can be matched as real
      // keys, and before `processor` so everything else stays out of the
      // stateful buffering wrappers (backslash+Enter, fast-return, SSH
      // alt-Enter), whose 5-50ms timers would otherwise flush a held key after
      // the lock releases. Neither hatch is a key those wrappers buffer.
      if (inputLockedRef.current) {
        if (isEditorRelaunchKey(keyMatchersRef.current, key)) {
          // Intercepted, never routed. Ctrl+X is bound in both Chat and Dialog
          // (contextBindings.ts), and the Dialog handlers in ExitPlanModeDialog
          // and ToolConfirmationMessage have no re-entrancy guard — routing it
          // would start a second full editor session whose Closed event fails
          // this very lock open while the first editor is still on screen.
          relaunchActiveExternalEditor();
          return;
        }
        if (!isEditorInterruptKey(keyMatchersRef.current, key)) {
          return;
        }
      }

      processor(key);
    };

    internal_eventEmitter.on('input', inputHandler);
    return () => {
      internal_eventEmitter.removeListener('input', inputHandler);
      setRawMode(false);
    };
  }, [
    stdin,
    setRawMode,
    config,
    debugKeystrokeLogging,
    broadcast,
    internal_eventEmitter,
  ]);

  const contextValue = useMemo(
    () => ({
      subscribe,
      unsubscribe,
      registerSensitiveInput,
      registerOnAnyKeypress,
      unregisterOnAnyKeypress,
    }),
    [subscribe, unsubscribe, registerSensitiveInput, registerOnAnyKeypress, unregisterOnAnyKeypress],
  );

  return (
    <KeypressContext.Provider value={contextValue}>
      {children}
    </KeypressContext.Provider>
  );
}
