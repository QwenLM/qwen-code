/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { PureComponent, type ErrorInfo, type ReactNode } from 'react';
import { updateLastInteractionTime } from '../stubs/state.js';
import { profiler } from '../../ui/components/profiler-state.js';
import { logForDebugging } from '../stubs/debug.js';
import { isEnvTruthy } from '../stubs/envUtils.js';
import { logError } from '../stubs/log.js';
import { EventEmitter } from '../events/emitter.js';
import { InputEvent } from '../events/input-event.js';
import { TerminalFocusEvent } from '../events/terminal-focus-event.js';
import {
  INITIAL_STATE,
  type ParsedInput,
  parseMultipleKeypresses,
} from '../parse-keypress.js';
import reconciler from '../reconciler.js';
import { setXtversionName, supportsExtendedKeys } from '../terminal.js';
import {
  getTerminalFocused,
  setTerminalFocused,
} from '../terminal-focus-state.js';
import {
  programStatus,
  TerminalQuerier,
  xtversion,
} from '../terminal-querier.js';
import {
  setProgramStatusSupported,
  shouldProbeProgramStatus,
} from '../program-status.js';
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  FOCUS_IN,
  FOCUS_OUT,
} from '../termio/csi.js';
import {
  DBP,
  DFE,
  EBP,
  EFE,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from '../termio/dec.js';
import AfterLayoutContext from './AfterLayoutContext.js';
import AppContext from './AppContext.js';
import { ClockProvider } from './ClockContext.js';
import CursorDeclarationContext, {
  type CursorDeclarationSetter,
} from './CursorDeclarationContext.js';
import StdinContext from './StdinContext.js';
import StdoutContext from '../compat/StdoutContext.js';
import { TerminalFocusProvider } from './TerminalFocusContext.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';
import type { AfterLayoutRegistry } from '../layout-effects.js';

// After this many milliseconds of stdin silence, the next chunk triggers
// a terminal mode re-assert (mouse tracking). Catches tmux detach→attach,
// ssh reconnect, and laptop wake — the terminal resets DEC private modes
// but no signal reaches us. 5s is well above normal inter-keystroke gaps
// but short enough that the first scroll after reattach works.
const STDIN_RESUME_GAP_MS = 5000;
type Props = {
  readonly children: ReactNode;
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly exitOnCtrlC: boolean;
  readonly onExit: (error?: Error) => void;
  readonly terminalColumns: number;
  readonly terminalRows: number;
  // Called when stdin data arrives after a >STDIN_RESUME_GAP_MS gap.
  // Ink re-asserts terminal modes: extended key reporting, and (when in
  // fullscreen) re-enters alt-screen + mouse tracking. Idempotent on the
  // terminal side. Optional so testing.tsx doesn't need to stub it.
  readonly onStdinResume?: () => void;
  // Trigger a re-render from the Ink engine. Passed from Ink.scheduleRender
  // so useApp().rerender() triggers an actual frame repaint.
  readonly scheduleRender?: () => void;
  // Request a renderer-owned viewport rebuild on the next frame.
  readonly requestViewportReset?: () => void;
  // Replace the active transcript with a destructive full-frame replay.
  readonly requestTranscriptReplacement?: () => void;
  // Mark the previous frame as contaminated so the next render does a
  // full-damage diff without requesting a viewport reset.
  readonly invalidatePrevFrame?: () => void;
  // Explicitly clear screen + scrollback and reset diff state.
  readonly clearConversation?: () => void;
  // Receives the declared native-cursor position from useDeclaredCursor
  // so ink.tsx can park the terminal cursor there after each frame.
  // Enables IME composition at the input caret and lets screen readers /
  // magnifiers track the input. Optional so testing.tsx doesn't need to stub it.
  readonly onCursorDeclaration?: CursorDeclarationSetter;
  // This root's after-layout callback registry. Scoped to the root rather
  // than module-global so a second root (tests render several) cannot
  // run this one's callbacks.
  readonly afterLayoutRegistry?: AfterLayoutRegistry | null;
};

type State = {
  readonly error?: Error;
};

// Root component for all Ink apps
// It renders stdin and stdout contexts, so that children can access them if needed
// It also handles Ctrl+C exiting and cursor visibility
export default class App extends PureComponent<Props, State> {
  static displayName = 'InternalApp';
  static getDerivedStateFromError(error: Error) {
    return {
      error,
    };
  }
  override state = {
    error: undefined,
  };

  // Count how many components enabled raw mode to avoid disabling
  // raw mode until all components don't need it anymore
  rawModeEnabledCount = 0;
  internal_eventEmitter = new EventEmitter();
  keyParseState = INITIAL_STATE;
  // Timer for flushing incomplete escape sequences
  incompleteEscapeTimer: NodeJS.Timeout | null = null;
  // Timeout durations for incomplete sequences (ms)
  readonly NORMAL_TIMEOUT = 50; // Short timeout for regular esc sequences
  readonly PASTE_TIMEOUT = 2000; // Allow slow/chunked paste before recovery

  // Terminal query/response dispatch. Responses arrive on stdin (parsed
  // out by parse-keypress) and are routed to pending promise resolvers.
  querier = new TerminalQuerier(this.props.stdout);

  // Timestamp of last stdin chunk. Used to detect long gaps (tmux attach,
  // ssh reconnect, laptop wake) and trigger terminal mode re-assert.
  // Initialized to now so startup doesn't false-trigger.
  lastStdinTime = Date.now();

  // Determines if TTY is supported on the provided stdin
  isRawModeSupported(): boolean {
    return this.props.stdin.isTTY;
  }
  override render() {
    return (
      <TerminalSizeContext.Provider
        value={{
          columns: this.props.terminalColumns,
          rows: this.props.terminalRows,
        }}
      >
        <StdoutContext.Provider
          value={{
            stdout: this.props.stdout,
            write: this.handleStdoutWrite,
          }}
        >
          <AppContext.Provider
            value={{
              exit: this.handleExit,
              rerender: this.props.scheduleRender ?? (() => {}),
              requestViewportReset: this.props.requestViewportReset,
              requestTranscriptReplacement:
                this.props.requestTranscriptReplacement,
              invalidatePrevFrame: this.props.invalidatePrevFrame,
              clearConversation: this.props.clearConversation,
            }}
          >
            <StdinContext.Provider
              value={{
                stdin: this.props.stdin,
                setRawMode: this.handleSetRawMode,
                isRawModeSupported: this.isRawModeSupported(),
                internal_exitOnCtrlC: this.props.exitOnCtrlC,
                internal_eventEmitter: this.internal_eventEmitter,
                internal_querier: this.querier,
              }}
            >
              <TerminalFocusProvider>
                <ClockProvider>
                  <CursorDeclarationContext.Provider
                    value={this.props.onCursorDeclaration ?? (() => {})}
                  >
                    <AfterLayoutContext.Provider
                      value={this.props.afterLayoutRegistry ?? null}
                    >
                      {this.props.children}
                    </AfterLayoutContext.Provider>
                  </CursorDeclarationContext.Provider>
                </ClockProvider>
              </TerminalFocusProvider>
            </StdinContext.Provider>
          </AppContext.Provider>
        </StdoutContext.Provider>
      </TerminalSizeContext.Provider>
    );
  }
  handleStdoutWrite = (data: string): void => {
    this.props.stdout.write(data);
  };
  override componentDidMount() {
    // In accessibility mode, keep the native cursor visible for screen magnifiers and other tools
    if (
      this.props.stdout.isTTY &&
      !isEnvTruthy(process.env['QODEER_ACCESSIBILITY'])
    ) {
      this.props.stdout.write(HIDE_CURSOR);
    }
  }
  override componentWillUnmount() {
    if (this.props.stdout.isTTY) {
      this.props.stdout.write(SHOW_CURSOR);
    }

    // Clear any pending timers
    if (this.incompleteEscapeTimer) {
      clearTimeout(this.incompleteEscapeTimer);
      this.incompleteEscapeTimer = null;
    }
    // ignore calling setRawMode on an handle stdin it cannot be called
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false);
    }
  }
  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logForDebugging(
      [
        `[App.componentDidCatch] Caught error in render tree: ${error.message}`,
        `terminal_columns=${this.props.terminalColumns}`,
        `terminal_rows=${this.props.terminalRows}`,
        `stdout_columns=${this.props.stdout.columns ?? 'unknown'}`,
        `stdout_rows=${this.props.stdout.rows ?? 'unknown'}`,
        `stdin_is_tty=${this.props.stdin.isTTY === true}`,
        `stdout_is_tty=${this.props.stdout.isTTY === true}`,
        `term_program=${process.env['TERM_PROGRAM'] ?? 'unknown'}`,
        `term=${process.env['TERM'] ?? 'unknown'}`,
        `component_stack=${errorInfo.componentStack || 'unavailable'}`,
        `error_stack=${error.stack ?? 'unavailable'}`,
      ].join('\n'),
      { level: 'error' },
    );
    this.handleExit(error);
  }
  handleSetRawMode = (isEnabled: boolean): void => {
    const { stdin } = this.props;
    if (!this.isRawModeSupported()) {
      if (stdin === process.stdin) {
        throw new Error(
          'Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
        );
      } else {
        throw new Error(
          'Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
        );
      }
    }
    stdin.setEncoding('utf8');
    if (isEnabled) {
      // Ensure raw mode is enabled only once
      if (this.rawModeEnabledCount === 0) {
        stdin.ref();
        stdin.setRawMode(true);
        stdin.addListener('readable', this.handleReadable);
        // Enable bracketed paste mode
        this.props.stdout.write(EBP);
        // Enable terminal focus reporting (DECSET 1004)
        this.props.stdout.write(EFE);
        // Enable extended key reporting so ctrl+shift+<letter> is
        // distinguishable from ctrl+<letter>. We write both the kitty stack
        // push (CSI >1u) and xterm modifyOtherKeys level 2 (CSI >4;2m) —
        // terminals honor whichever they implement (tmux only accepts the
        // latter).
        if (supportsExtendedKeys()) {
          this.props.stdout.write(ENABLE_KITTY_KEYBOARD);
          this.props.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
        }
        // Probe terminal identity. XTVERSION survives SSH (query/reply goes
        // through the pty), unlike TERM_PROGRAM. Used for wheel-scroll base
        // detection when env vars are absent. Fire-and-forget: the DA1
        // sentinel bounds the round-trip, and if the terminal ignores the
        // query, flush() still resolves and name stays undefined.
        // Deferred to next tick so it fires AFTER the current synchronous
        // init sequence completes — avoids interleaving with alt-screen/mouse
        // tracking enable writes that may happen in the same render cycle.
        // The OSC 7501 probe rides the same batch: a reply ahead of the DA1
        // sentinel means the terminal tracks program status.
        setImmediate(() => {
          void Promise.all([
            this.querier.send(xtversion()),
            shouldProbeProgramStatus()
              ? this.querier.send(programStatus())
              : undefined,
            this.querier.flush(),
          ]).then(([r, ps]) => {
            if (r) {
              setXtversionName(r.name);
              logForDebugging(`XTVERSION: terminal identified as "${r.name}"`);
            } else {
              logForDebugging('XTVERSION: no reply (terminal ignored query)');
            }
            if (ps) {
              setProgramStatusSupported();
              logForDebugging('OSC 7501: terminal supports program status');
            }
          });
        });
      }
      this.rawModeEnabledCount++;
      return;
    }

    // Disable raw mode only when no components left that are using it
    if (--this.rawModeEnabledCount === 0) {
      this.props.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
      this.props.stdout.write(DISABLE_KITTY_KEYBOARD);
      // Disable terminal focus reporting (DECSET 1004)
      this.props.stdout.write(DFE);
      // Disable bracketed paste mode
      this.props.stdout.write(DBP);
      stdin.setRawMode(false);
      stdin.removeListener('readable', this.handleReadable);
      stdin.unref();
    }
  };

  // Helper to flush incomplete escape sequences
  flushIncomplete = (): void => {
    // Clear the timer reference
    this.incompleteEscapeTimer = null;

    // Paste mode can be waiting for PASTE_END while the tokenizer buffer is
    // empty, so mode must participate in the flush decision.
    if (
      !this.keyParseState.incomplete &&
      this.keyParseState.mode !== 'IN_PASTE'
    ) {
      return;
    }

    // Fullscreen: if stdin has data waiting, it's almost certainly the
    // continuation of the buffered sequence (e.g. `[<64;74;16M` after a
    // lone ESC). Node's event loop runs the timers phase before the poll
    // phase, so when a heavy render blocks the loop past 50ms, this timer
    // fires before the queued readable event even though the bytes are
    // already buffered. Re-arm instead of flushing: handleReadable will
    // drain stdin next and clear this timer. Prevents both the spurious
    // Escape key and the lost scroll event.
    if (this.props.stdin.readableLength > 0) {
      this.incompleteEscapeTimer = setTimeout(
        this.flushIncomplete,
        this.NORMAL_TIMEOUT,
      );
      return;
    }

    // Process incomplete as a flush operation (input=null)
    // This reuses all existing parsing logic
    this.processInput(null);
  };

  // Process input through the parser and handle the results
  processInput = (input: string | Buffer | null): void => {
    // Parse input using our state machine
    const [keys, newState] = parseMultipleKeypresses(
      this.keyParseState,
      input,
      (sequence) => this.querier.expectsResponsePrefix(sequence),
    );
    this.keyParseState = newState;

    // Process ALL keys in a SINGLE discreteUpdates call to prevent
    // "Maximum update depth exceeded" error when many keys arrive at once
    // (e.g., from paste operations or holding keys rapidly).
    // This batches all state updates from handleInput and all useInput
    // listeners together within one high-priority update context.
    if (keys.length > 0) {
      reconciler.discreteUpdates(
        processKeysInBatch,
        this,
        keys,
        undefined,
        undefined,
      );
    }

    // Cancel the prior timer even when this chunk completed the sequence.
    if (this.incompleteEscapeTimer) {
      clearTimeout(this.incompleteEscapeTimer);
      this.incompleteEscapeTimer = null;
    }

    // A paste can be incomplete with an empty tokenizer buffer while waiting
    // for PASTE_END, so keep a recovery timer for the parser mode as well.
    if (
      this.keyParseState.incomplete ||
      this.keyParseState.mode === 'IN_PASTE'
    ) {
      this.incompleteEscapeTimer = setTimeout(
        this.flushIncomplete,
        this.keyParseState.mode === 'IN_PASTE'
          ? this.PASTE_TIMEOUT
          : this.NORMAL_TIMEOUT,
      );
    }
  };
  handleReadable = (): void => {
    // Detect long stdin gaps (tmux attach, ssh reconnect, laptop wake).
    // The terminal may have reset DEC private modes; re-assert mouse
    // tracking. Checked before the read loop so one Date.now() covers
    // all chunks in this readable event.
    const now = Date.now();
    if (now - this.lastStdinTime > STDIN_RESUME_GAP_MS) {
      this.props.onStdinResume?.();
    }
    this.lastStdinTime = now;

    // Report stdin activity to the profiler unconditionally. During a
    // bracketed paste, data arrives in multiple chunks but intermediate
    // chunks may not produce any parsed keys (the paste buffer is still
    // accumulating). Without this, the profiler sees renders happening
    // with no "action" and incorrectly classifies them as idle frames,
    // which can trigger the debug console after 5+ idle frames/second.
    profiler.reportAction();

    try {
      let chunk;
      while ((chunk = this.props.stdin.read() as string | null) !== null) {
        // Process the input chunk
        this.processInput(chunk);
      }
    } catch (error) {
      // In Bun, an uncaught throw inside a stream 'readable' handler can
      // permanently wedge the stream: data stays buffered and 'readable'
      // never re-emits. Catching here ensures the stream stays healthy so
      // subsequent keystrokes are still delivered.
      logError(error);

      // Re-attach the listener in case the exception detached it.
      // Bun may remove the listener after an error; without this,
      // the session freezes permanently (stdin reader dead, event loop alive).
      const { stdin } = this.props;
      if (
        this.rawModeEnabledCount > 0 &&
        !stdin.listeners('readable').includes(this.handleReadable)
      ) {
        logForDebugging(
          'handleReadable: re-attaching stdin readable listener after error recovery',
          {
            level: 'warn',
          },
        );
        stdin.addListener('readable', this.handleReadable);
      }
    }
  };
  handleInput = (input: string | undefined): void => {
    // Exit on Ctrl+C
    if (input === '\x03' && this.props.exitOnCtrlC) {
      this.handleExit();
    }
  };
  handleExit = (error?: Error): void => {
    if (this.isRawModeSupported()) {
      this.handleSetRawMode(false);
    }
    this.props.onExit(error);
  };
  handleTerminalFocus = (isFocused: boolean): void => {
    // setTerminalFocused notifies subscribers: TerminalFocusProvider (context)
    // and Clock (interval speed) — no App setState needed.
    setTerminalFocused(isFocused);
  };
}

// Helper to process all keys within a single discrete update context.
// discreteUpdates expects (fn, a, b, c, d) -> fn(a, b, c, d)
function processKeysInBatch(
  app: App,
  items: ParsedInput[],
  _unused1: undefined,
  _unused2: undefined,
): void {
  // Update interaction time for notification timeout tracking.
  // This is called from the central input handler to avoid having multiple
  // stdin listeners that can cause race conditions and dropped input.
  // Terminal responses (kind: 'response') are automated, not user input.
  // Mode-1003 no-button motion is also excluded — passive cursor drift is
  // not engagement (would suppress idle notifications + defer housekeeping).
  if (items.some((i) => i.kind === 'key')) {
    updateLastInteractionTime();
    profiler.reportAction();
  }
  for (const item of items) {
    // Terminal responses (DECRPM, DA1, OSC replies, etc.) are not user
    // input — route them to the querier to resolve pending promises.
    if (item.kind === 'response') {
      app.querier.onResponse(item.response);
      continue;
    }
    const sequence = item.sequence;

    // Mouse events are not processed in GMN — skip them.
    if (item.kind === 'mouse') {
      continue;
    }

    // Handle terminal focus events (DECSET 1004)
    if (sequence === FOCUS_IN) {
      app.handleTerminalFocus(true);
      const event = new TerminalFocusEvent('terminalfocus');
      app.internal_eventEmitter.emit('terminalfocus', event);
      continue;
    }
    if (sequence === FOCUS_OUT) {
      app.handleTerminalFocus(false);
      const event = new TerminalFocusEvent('terminalblur');
      app.internal_eventEmitter.emit('terminalblur', event);
      continue;
    }

    // Failsafe: if we receive input, the terminal must be focused
    if (!getTerminalFocused()) {
      setTerminalFocused(true);
    }

    app.handleInput(sequence);
    const event = new InputEvent(item);
    app.internal_eventEmitter.emit('input', event);
  }
}
