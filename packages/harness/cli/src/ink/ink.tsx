/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/// <reference path="./types.d.ts" />
import autoBind from 'auto-bind';
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readSync,
  writeSync,
} from 'fs';
import noop from 'lodash-es/noop.js';
import throttle from 'lodash-es/throttle.js';
import { type ReactNode } from 'react';
import type { FiberRoot } from 'react-reconciler';
import { ConcurrentRoot } from 'react-reconciler/constants.js';
import { onExit } from 'signal-exit';
import { flushInteractionTime } from './stubs/state.js';
import { FocusManager } from './focus.js';
import { getYogaCounters } from './stubs/yoga-counters.js';
import { logForDebugging } from './stubs/debug.js';
import { logError } from './stubs/log.js';
import { format } from 'util';
import App from './components/App.js';
import type {
  CursorDeclaration,
  CursorDeclarationSetter,
} from './components/CursorDeclarationContext.js';
import { FRAME_INTERVAL_MS } from './constants.js';
import * as dom from './dom.js';
import { emptyFrame, type Frame, type FrameEvent } from './frame.js';
import instances from './instances.js';
import { LogUpdate } from './log-update.js';
import { nodeCache } from './node-cache.js';
import { optimize } from './optimizer.js';
import reconciler, {
  getLastCommitMs,
  getLastYogaMs,
  recordYogaMs,
  resetProfileCounters,
} from './reconciler.js';
import { didLayoutShift } from './render-node-to-output.js';
import createRenderer, { type Renderer } from './renderer.js';
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  migrateScreenPools,
  StylePool,
} from './screen.js';
import {
  SYNC_OUTPUT_SUPPORTED,
  supportsExtendedKeys,
  type Terminal,
  writeDiffToTerminal,
} from './terminal.js';
import {
  clampCursorMoveY,
  CURSOR_HOME,
  cursorMove,
  cursorPosition,
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
  eraseToEndOfScreen,
  RESET_SCROLL_REGION,
} from './termio/csi.js';
import {
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
} from './termio/dec.js';
import { RESTORE_CURSOR, SAVE_CURSOR } from './termio/esc.js';
import {
  hasReportedProgramStatus,
  markProgramStatusReported,
} from './program-status.js';
import { CLEAR_PROGRAM_STATUS } from './termio/programStatus.js';
import {
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  LINK_END,
  supportsTabStatus,
  wrapForMultiplexer,
} from './termio/osc.js';
import {
  flushResizeObserversSync,
  triggerResizeObservers,
} from './compat/ResizeObserver.js';
import {
  type AfterLayoutRegistry,
  createAfterLayoutRegistry,
} from './layout-effects.js';

// Alt-screen: renderer.ts sets cursor.visible = !isTTY || screen.height===0,
// which is always false in alt-screen (TTY + content fills screen).
// Reusing a frozen object saves 1 allocation per frame.
const ALT_SCREEN_ANCHOR_CURSOR = Object.freeze({
  x: 0,
  y: 0,
  visible: false,
});
// Upper bound on layout→measure→setState rounds inside one frame. Three is
// generous for the real chains (controls height → available height → list
// measurement); hitting it means something is oscillating, and the frame is
// repainted next tick rather than looping synchronously forever.
const MAX_LAYOUT_SETTLE_PASSES = 3;

const CURSOR_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: CURSOR_HOME,
});

// Cached per-Ink-instance, invalidated on resize. frame.cursor.y for
// alt-screen is always terminalRows - 1 (renderer.ts).
function makeAltScreenParkPatch(terminalRows: number) {
  return Object.freeze({
    type: 'stdout' as const,
    content: cursorPosition(terminalRows, 1),
  });
}
export type Options = {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  waitUntilExit?: () => Promise<void>;
  onFrame?: (event: FrameEvent) => void;
};
export default class Ink {
  private readonly log: LogUpdate;
  private readonly terminal: Terminal;
  private scheduleRender: (() => void) & {
    cancel?: () => void;
  };
  // Ignore last render after unmounting a tree to prevent empty output before exit
  private isUnmounted = false;
  private isPaused = false;
  private readonly container: FiberRoot;
  private rootNode: dom.DOMElement;
  private renderer: Renderer;
  private readonly stylePool: StylePool;
  private charPool: CharPool;
  private hyperlinkPool: HyperlinkPool;
  private exitPromise?: Promise<void>;
  private restoreConsole?: () => void;
  private restoreStderr?: () => void;
  private readonly unsubscribeTTYHandlers?: () => void;
  private terminalColumns: number;
  private terminalRows: number;
  private currentNode: ReactNode = null;
  private frontFrame: Frame;
  private backFrame: Frame;
  private lastPoolResetTime = performance.now();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by onComputeLayout after every commit; cleared by computeLayoutNow.
  private layoutDirty = false;
  // Re-entrancy guard for the per-frame settle loop, which commits React work
  // and would otherwise re-enter through onRender/onImmediateRender.
  private isSettling = false;
  private readonly afterLayoutRegistry: AfterLayoutRegistry =
    createAfterLayoutRegistry();
  private lastYogaCounters: {
    ms: number;
    visited: number;
    measured: number;
    cacheHits: number;
    live: number;
  } = {
    ms: 0,
    visited: 0,
    measured: 0,
    cacheHits: 0,
    live: 0,
  };
  private altScreenParkPatch: Readonly<{
    type: 'stdout';
    content: string;
  }>;
  // Set by <AlternateScreen> via setAltScreenActive(). Controls the
  // renderer's cursor.y clamping (keeps cursor in-viewport to avoid
  // LF-induced scroll when screen.height === terminalRows) and gates
  // alt-screen-aware SIGCONT/resize/unmount handling.
  private altScreenActive = false;
  // Set alongside altScreenActive so SIGCONT resume knows whether to
  // re-enable mouse tracking (not all <AlternateScreen> uses want it).
  private altScreenMouseTracking = false;
  // True when the previous frame's screen buffer cannot be trusted for
  // blit — resetFramesForAltScreen() replaced it with blanks, or
  // a destructive clear reset it to 0×0. Forces one full-render frame;
  // steady-state frames after clear it and regain the blit + narrow-damage
  // fast path.
  private prevFrameContaminated = false;
  // Native cursor positioning: a component (via useDeclaredCursor) declares
  // where the caret is; onRender parks the physical terminal cursor there
  // so the OS IME candidate window appears at the right position.
  private cursorDeclaration: CursorDeclaration | null = null;
  private displayCursor: { x: number; y: number } | null = null;
  private setCursorDeclaration: CursorDeclarationSetter = (
    decl,
    clearIfNode,
  ) => {
    if (
      decl === null &&
      clearIfNode !== undefined &&
      this.cursorDeclaration?.node !== clearIfNode
    ) {
      return;
    }
    this.cursorDeclaration = decl;
  };
  constructor(private readonly options: Options) {
    autoBind(this);
    if (this.options.patchConsole) {
      this.restoreConsole = this.patchConsole();
      this.restoreStderr = this.patchStderr();
    }
    this.terminal = {
      stdout: options.stdout,
      stderr: options.stderr,
    };
    this.terminalColumns = options.stdout.columns || 80;
    this.terminalRows = options.stdout.rows || 24;
    this.altScreenParkPatch = makeAltScreenParkPatch(this.terminalRows);
    this.stylePool = new StylePool();
    this.charPool = new CharPool();
    this.hyperlinkPool = new HyperlinkPool();
    this.frontFrame = emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );
    this.backFrame = emptyFrame(
      this.terminalRows,
      this.terminalColumns,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );

    // Keep the shell prefix through the current cursor in native scrollback,
    // discard stale cells below it, and give the first frame a blank viewport.
    // Saving the cursor is necessary because DECSTBM homes it on some terminals.
    if (options.stdout.isTTY) {
      options.stdout.write(
        LINK_END +
          '\x1b[0m' +
          SAVE_CURSOR +
          RESET_SCROLL_REGION +
          RESTORE_CURSOR +
          eraseToEndOfScreen() +
          '\r\n'.repeat(this.terminalRows) +
          CURSOR_HOME +
          SHOW_CURSOR,
      );
    }

    this.log = new LogUpdate({
      isTTY: (options.stdout.isTTY as boolean | undefined) || false,
      stylePool: this.stylePool,
    });

    // scheduleRender is called from the reconciler's resetAfterCommit, which
    // runs BEFORE React's layout phase (ref attach + useLayoutEffect). Any
    // state set in layout effects — notably the cursorDeclaration from
    // useDeclaredCursor — would lag one commit behind if we rendered
    // synchronously. Deferring to a microtask runs onRender after layout
    // effects have committed, so the native cursor tracks the caret without
    // a one-keystroke lag. Same event-loop tick, so throughput is unchanged.
    // Test env uses onImmediateRender (direct onRender, no throttle) so
    // existing synchronous lastFrame() tests are unaffected.
    const deferredRender = (): void => queueMicrotask(this.onRender);
    this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
      leading: true,
      trailing: true,
    });

    // Ignore last render after unmounting a tree to prevent empty output before exit
    this.isUnmounted = false;

    // Unmount when process exits
    this.unsubscribeExit = onExit(this.unmount, {
      alwaysLast: false,
    });
    if (options.stdout.isTTY) {
      options.stdout.on('resize', this.handleResize);
      process.on('SIGCONT', this.handleResume);
      this.unsubscribeTTYHandlers = () => {
        options.stdout.off('resize', this.handleResize);
        process.off('SIGCONT', this.handleResume);
      };
    }
    this.rootNode = dom.createNode('ink-root');
    this.rootNode.focusManager = new FocusManager(() => false);
    this.renderer = createRenderer(this.rootNode, this.stylePool);
    this.rootNode.onRender = this.scheduleRender;
    this.rootNode.onImmediateRender = this.onRender.bind(this);
    // The reconciler calls this after every commit. It only records that the
    // tree changed — the layout itself happens once per frame in
    // computeLayoutNow(). Layout used to run here, which meant a full yoga
    // pass per commit (~2x the frame rate while streaming) even though only
    // the frame consumes the result.
    this.rootNode.onComputeLayout = () => {
      this.layoutDirty = true;
    };
    // Readers that run between frames (measureElement from a layout effect,
    // getBoundingBox from a mouse handler) call this to avoid stale geometry.
    this.rootNode.ensureLayout = this.computeLayoutNow;

    this.container = reconciler.createContainer(
      this.rootNode,
      ConcurrentRoot,
      null,
      false,
      null,
      'id',
      noop,
      // onUncaughtError
      noop,
      // onCaughtError
      noop,
      // onRecoverableError
      noop, // onDefaultTransitionIndicator
    );
    if (process.env['DEV'] === 'true') {
      // @ts-expect-error outdated types
      reconciler.injectIntoDevTools();
    }
  }
  /**
   * Recompute yoga layout if a commit has dirtied it. Idempotent and free of
   * React side effects, so it is safe to call from anywhere — including a
   * layout effect or a mouse handler.
   */
  private computeLayoutNow = (): void => {
    // Guard against accessing freed Yoga nodes after unmount
    if (this.isUnmounted || !this.layoutDirty) {
      return;
    }
    if (!this.rootNode.yogaNode) {
      return;
    }
    this.layoutDirty = false;
    const t0 = performance.now();
    this.rootNode.yogaNode.setWidth(this.terminalColumns);
    this.rootNode.yogaNode.calculateLayout(this.terminalColumns);
    const ms = performance.now() - t0;
    recordYogaMs(ms);
    const c = getYogaCounters();
    // Accumulated across the frame's settle passes so onFrame reports the
    // whole cost rather than only the last pass.
    this.lastYogaCounters = {
      ms: this.lastYogaCounters.ms + ms,
      visited: this.lastYogaCounters.visited + c.visited,
      measured: this.lastYogaCounters.measured + c.measured,
      cacheHits: this.lastYogaCounters.cacheHits + c.cacheHits,
      live: c.live,
    };
    // After yoga layout is computed, notify ResizeObservers so components
    // like VirtualizedList can measure their container dimensions.
    triggerResizeObservers();
  };

  /**
   * Bring layout and the components that read it to a fixed point for this
   * frame, then leave the tree ready to paint.
   *
   * The loop reproduces what used to happen synchronously per commit —
   * layout, measure, setState, layout again — but at most once per frame.
   * `flushSyncFromReconciler` (not `flushSyncWork`) is required: callbacks run
   * outside React's event scope, so their updates land in the default lane and
   * would otherwise survive the loop and leave it falsely converged.
   */
  private settleLayoutForFrame(): void {
    if (this.isSettling) return;
    this.isSettling = true;
    // Both render entry points must be muted: resetAfterCommit calls
    // onImmediateRender under NODE_ENV=test and onRender otherwise, and a
    // flush below will commit.
    const origOnRender = this.rootNode.onRender;
    const origOnImmediateRender = this.rootNode.onImmediateRender;
    this.rootNode.onRender = noop;
    this.rootNode.onImmediateRender = noop;
    let unsettled = false;
    try {
      for (let pass = 0; pass < MAX_LAYOUT_SETTLE_PASSES; pass++) {
        // Callbacks are armed by a commit, and layout may already have been
        // computed on demand (measureElement, getBoundingBox) since then — so
        // pending work, not just a dirty tree, has to keep the loop going.
        if (!this.layoutDirty && !this.afterLayoutRegistry.hasPending()) break;
        this.computeLayoutNow();
        flushResizeObserversSync();
        // flushSyncFromReconciler raises the callbacks' updates to the sync
        // lane; flushSyncWork then drains them. Without the second call the
        // commit lands on a later tick and the frame paints stale geometry.
        reconciler.flushSyncFromReconciler(this.runAfterLayoutCallbacks);
        reconciler.flushSyncWork();
      }
      if (this.layoutDirty || this.afterLayoutRegistry.hasPending()) {
        // Did not converge. Paint geometry that matches the committed tree
        // rather than a half-updated frame, and try again next frame.
        this.computeLayoutNow();
        unsettled = true;
      }
    } finally {
      this.rootNode.onRender = origOnRender;
      this.rootNode.onImmediateRender = origOnImmediateRender;
      this.isSettling = false;
    }
    if (unsettled) {
      logForDebugging(
        `layout did not settle within ${MAX_LAYOUT_SETTLE_PASSES} passes; ` +
          'repainting next frame',
        { level: 'warn' },
      );
      this.scheduleRender();
    }
  }

  private runAfterLayoutCallbacks = (): void => {
    this.afterLayoutRegistry.runPending();
  };

  private handleResume = () => {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) {
      return;
    }

    this.reassertTerminalModes();

    if (this.altScreenActive) {
      this.reenterAltScreen();
    } else {
      this.displayCursor = null;
      this.log.forceReset('recovery');
    }

    this.scheduleRender();
  };

  // NOT debounced. A debounce opens a window where stdout.columns is NEW
  // but this.terminalColumns/Yoga are OLD — any scheduleRender during that
  // window (spinner, clock) makes log-update detect a width change and
  // clear the screen, then the debounce fires and clears again (double
  // blank→paint flicker). useVirtualScroll's height scaling already bounds
  // the per-resize cost; synchronous handling keeps dimensions consistent.
  private handleResize = () => {
    const cols = this.options.stdout.columns || 80;
    const rows = this.options.stdout.rows || 24;
    // Terminals often emit 2+ resize events for one user action (window
    // settling). Same-dimension events are no-ops; skip to avoid redundant
    // frame resets and renders.
    if (cols === this.terminalColumns && rows === this.terminalRows) return;
    this.terminalColumns = cols;
    this.terminalRows = rows;
    this.altScreenParkPatch = makeAltScreenParkPatch(this.terminalRows);

    // Alt-screen resize: clear alt buffer and do a single synchronous
    // repaint. Do NOT exit/re-enter alt — the bounce through main screen
    // causes iTerm2 to capture main-screen content into alt scrollback,
    // which is exactly the "duplicate content on scroll-up" bug.
    // Just erase the visible alt area and repaint atomically.
    if (
      this.altScreenActive &&
      !this.isPaused &&
      this.options.stdout.isTTY &&
      this.currentNode !== null
    ) {
      this.options.stdout.write(
        ERASE_SCREEN +
          CURSOR_HOME +
          (this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : ''),
      );
      this.resetFramesForAltScreen();
      // Suppress onRender from reconciler's resetAfterCommit during render().
      const origOnRender = this.rootNode.onRender;
      this.rootNode.onRender = noop;
      try {
        this.render(this.currentNode);
      } catch (e) {
        this.rootNode.onRender = origOnRender;
        throw e;
      }
      this.rootNode.onRender = origOnRender;
      this.scheduleRender.cancel?.();
      this.onRender();
      return;
    }

    // Re-render the React tree with updated props so the context value changes.
    // React's commit phase will call onComputeLayout() to recalculate yoga layout
    // with the new dimensions, then call onRender() to render the updated frame.
    // We don't call scheduleRender() here because that would render before the
    // layout is updated, causing a mismatch between viewport and content dimensions.

    // Keep the Windows path synchronous to avoid ConPTY's async resize echo,
    // but let LogUpdate own the viewport reset instead of writing CSI 2J/3J.
    if (
      process.platform === 'win32' &&
      !this.altScreenActive &&
      !this.isPaused &&
      this.options.stdout.isTTY &&
      this.currentNode !== null
    ) {
      this.log.forceReset('resize');
      const origOnRender = this.rootNode.onRender;
      this.rootNode.onRender = noop;
      try {
        this.render(this.currentNode);
      } finally {
        this.rootNode.onRender = origOnRender;
      }
      this.scheduleRender.cancel?.();
      this.onRender();
      return;
    }

    if (this.currentNode !== null) {
      this.render(this.currentNode);
    }
  };
  resolveExitPromise: () => void = () => {};
  rejectExitPromise: (reason?: Error) => void = () => {};
  unsubscribeExit: () => void = () => {};

  /**
   * First half of `enterAlternateScreen()`: pause Ink, suspend stdin, and turn
   * off every terminal mode that generates input — kitty keyboard,
   * modifyOtherKeys, mouse tracking, focus reporting.
   *
   * Disabling them is not optional on that path. stdin is suspended (listeners
   * removed, raw mode off), so nothing drains it and the tty echoes whatever
   * arrives straight onto the screen: focus reporting alone paints `^[[O` /
   * `^[[I` on every focus change, and mouse tracking spews on every pointer
   * move. Restored by `exitAlternateScreen()`.
   *
   * Private on purpose. This is a terminal handoff, appropriate only when a
   * child process takes over the terminal and drives its own termios. A GUI
   * editor needs no handoff at all: leaving raw mode drops the tty into
   * canonical mode, where ECHO paints onto the live frame, ICANON queues
   * keystrokes for late delivery, and ISIG turns Ctrl+C into a session-killing
   * SIGINT. That path drops input in software instead — see inputLockedRef in
   * KeypressContext.
   */
  private suspendTerminalModes(): void {
    this.pause();
    this.suspendStdin();
    this.options.stdout.write(
      // Disable extended key reporting first — editors that don't speak
      // CSI-u (e.g. nano) show "Unknown sequence" for every Ctrl-<key> if
      // kitty/modifyOtherKeys stays active.
      DISABLE_KITTY_KEYBOARD +
        DISABLE_MODIFY_OTHER_KEYS +
        (this.altScreenMouseTracking ? DISABLE_MOUSE_TRACKING : '') +
        '\x1b[?1004l', // disable focus reporting
    );
  }

  /**
   * Re-arm the terminal modes `suspendTerminalModes()` turned off.
   *
   * Pop-before-push keeps the Kitty stack balanced: a well-behaved editor
   * restores our entry on exit, so without the pop we'd accumulate depth on
   * each round-trip. Terminal editors also write their own modifyOtherKeys
   * level on entry, leaving us unable to tell ctrl+shift+<letter> from
   * ctrl+<letter> until we re-assert ours.
   */
  private writeRestoredInputModes(): void {
    this.options.stdout.write(
      '\x1b[?1004h' +
        (supportsExtendedKeys()
          ? DISABLE_KITTY_KEYBOARD +
            ENABLE_KITTY_KEYBOARD +
            ENABLE_MODIFY_OTHER_KEYS
          : ''),
    );
  }

  /**
   * Pause Ink and hand the terminal over to an external TUI (e.g. git
   * commit editor). In non-fullscreen mode this enters the alt screen;
   * in fullscreen mode we're already in alt so we just clear it.
   * Call `exitAlternateScreen()` when done to restore Ink.
   */
  enterAlternateScreen(): void {
    // Input-mode suspension, then the screen switch.
    this.suspendTerminalModes();
    this.options.stdout.write(
      // If already in alt screen, must exit first so that the erase below
      // clears MAIN screen scrollback (not alt buffer scrollback). iTerm2
      // shows main-screen scrollback when user scrolls up in alt mode.
      (this.altScreenActive
        ? EXIT_ALT_SCREEN + '\x1b[2J\x1b[3J\x1b[H' + ENTER_ALT_SCREEN
        : '\x1b[?1049h') +
        '\x1b[0m' +
        // reset attributes
        '\x1b[?25h' +
        // show cursor
        '\x1b[2J' +
        // clear alt screen
        '\x1b[H', // cursor home
    );
  }

  /**
   * Resume Ink after an external TUI handoff with a full repaint.
   * In non-fullscreen mode this exits the alt screen back to main;
   * in fullscreen mode we re-enter alt and clear + repaint.
   *
   * The re-enter matters: terminal editors (vim, nano, less) write
   * smcup/rmcup (?1049h/?1049l), so even though we started in alt,
   * the editor's rmcup on exit drops us to main screen. Without
   * re-entering, the 2J below wipes the user's main-screen scrollback
   * and subsequent renders land in main — native terminal scroll
   * returns, fullscreen scroll is dead.
   */
  exitAlternateScreen(): void {
    if (this.altScreenActive) {
      // Fullscreen mode: vim's rmcup dropped us to main. Clear main screen
      // scrollback first (so iTerm2 scroll-up shows nothing), then re-enter alt.
      this.options.stdout.write(
        '\x1b[2J\x1b[3J\x1b[H' +
          // clear main screen + scrollback + home
          ENTER_ALT_SCREEN +
          // re-enter alt
          '\x1b[2J\x1b[H' +
          // clear alt buffer + home
          (this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : '') +
          '\x1b[?25l', // hide cursor (Ink manages)
      );
    } else {
      // Non-fullscreen: clear the temporary alt screen, then restore the main
      // screen. The alt buffer is discarded, so CSI 3J is unnecessary and
      // could be interpreted by some terminals as clearing main scrollback.
      this.options.stdout.write(
        ERASE_SCREEN +
          CURSOR_HOME +
          EXIT_ALT_SCREEN +
          '\x1b[?25l', // hide cursor
      );
    }
    this.resumeStdin();
    if (this.altScreenActive) {
      this.resetFramesForAltScreen();
    } else {
      this.displayCursor = null;
      this.log.forceReset('recovery');
    }
    this.resume();
    this.writeRestoredInputModes();
  }
  onRender() {
    if (this.isUnmounted || this.isPaused || this.isSettling) {
      return;
    }
    // Entering a render cancels any pending drain tick — this render will
    // handle the drain (and re-schedule below if needed). Prevents a
    // wheel-event-triggered render AND a drain-timer render both firing.
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    // Flush deferred interaction-time update before rendering so we call
    // Date.now() at most once per frame instead of once per keypress.
    // Done before the render to avoid dirtying state that would trigger
    // an extra React re-render cycle.
    flushInteractionTime();
    // Layout is no longer computed per commit; bring it (and everything that
    // measures it) to a fixed point before painting.
    this.settleLayoutForFrame();
    const renderStart = performance.now();
    const terminalWidth = this.options.stdout.columns || 80;
    const terminalRows = this.options.stdout.rows || 24;
    const frame = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: this.options.stdout.isTTY,
      terminalWidth,
      terminalRows,
      altScreen: this.altScreenActive,
      prevFrameContaminated: this.prevFrameContaminated,
    });
    const rendererMs = performance.now() - renderStart;

    // Full-damage backstop: applies on BOTH alt-screen and main-screen.
    // Layout shifts (spinner appears, status line resizes) can leave stale
    // cells at sibling boundaries that per-node damage tracking misses.
    // didLayoutShift() tracks exactly this (any node's cached yoga
    // position/size differs from current, or a child was removed).
    // Steady-state frames (spinner rotate, clock tick, text stream into
    // fixed-height box) don't shift layout, so normal damage bounds are
    // correct and diffEach only compares the damaged region.
    // prevFrameContaminated covers explicit cache invalidation/clear cleanup.
    if (didLayoutShift() || this.prevFrameContaminated) {
      frame.screen.damage = {
        x: 0,
        y: 0,
        width: frame.screen.width,
        height: frame.screen.height,
      };
    }

    // Alt-screen: anchor the physical cursor to (0,0) before every diff.
    // All cursor moves in log-update are RELATIVE to prev.cursor; if tmux
    // (or any emulator) perturbs the physical cursor out-of-band (status
    // bar refresh, pane redraw, Cmd+K wipe), the relative moves drift and
    // content creeps up 1 row/frame. CSI H resets the physical cursor;
    // passing prev.cursor=(0,0) makes the diff compute from the same spot.
    // Self-healing against any external cursor manipulation. Main-screen
    // can't do this — cursor.y tracks scrollback rows CSI H can't reach.
    // The CSI H write is deferred until after the diff is computed so we
    // can skip it for empty diffs (no writes → physical cursor unused).
    let prevFrame = this.frontFrame;
    // Main-screen preamble: if we previously parked the cursor at a
    // declared position, the diff engine assumes it starts at
    // prevFrame.cursor. Prepend a move back before the diff.
    let cursorPreamble: string | null = null;
    if (this.displayCursor !== null && !this.altScreenActive) {
      const pdx = this.frontFrame.cursor.x - this.displayCursor.x;
      const pdy = clampCursorMoveY(
        this.frontFrame.cursor.y - this.displayCursor.y,
        terminalRows,
      );
      if (pdx !== 0 || pdy !== 0) {
        cursorPreamble = cursorMove(pdx, pdy);
      }
    }
    if (this.altScreenActive) {
      prevFrame = {
        ...this.frontFrame,
        cursor: ALT_SCREEN_ANCHOR_CURSOR,
      };
    }
    const tDiff = performance.now();
    const diff = this.log.render(
      prevFrame,
      frame,
      this.altScreenActive,
      // DECSTBM needs BSU/ESU atomicity — without it the outer terminal
      // renders the scrolled-but-not-yet-repainted intermediate state.
      // tmux is the main case (re-emits DECSTBM with its own timing and
      // doesn't implement DEC 2026, so SYNC_OUTPUT_SUPPORTED is false).
      SYNC_OUTPUT_SUPPORTED,
    );
    const diffMs = performance.now() - tDiff;
    // Swap buffers
    this.backFrame = this.frontFrame;
    this.frontFrame = frame;

    // Periodically reset char/hyperlink pools to prevent unbounded growth
    // during long sessions. 5 minutes is infrequent enough that the O(cells)
    // migration cost is negligible. Reuses renderStart to avoid extra clock call.
    if (renderStart - this.lastPoolResetTime > 5 * 60 * 1000) {
      this.resetPools();
      this.lastPoolResetTime = renderStart;
    }
    const flickers: FrameEvent['flickers'] = [];
    for (const patch of diff) {
      if (
        patch.type === 'clearTerminal' ||
        patch.type === 'eraseViewport'
      ) {
        flickers.push({
          desiredHeight: frame.screen.height,
          availableHeight: frame.viewport.height,
          reason: patch.reason,
        });
      }
    }
    const tOptimize = performance.now();
    const optimized = optimize(diff);
    const optimizeMs = performance.now() - tOptimize;
    const hasDiff = optimized.length > 0;
    const hasTerminalReset = optimized.some(
      (patch) =>
        patch.type === 'eraseViewport' || patch.type === 'clearTerminal',
    );
    // Main-screen preamble: move cursor back from park position before diff.
    if (
      cursorPreamble !== null &&
      hasDiff &&
      !hasTerminalReset &&
      !this.altScreenActive
    ) {
      optimized.unshift({ type: 'stdout' as const, content: cursorPreamble });
    }
    if (this.altScreenActive && hasDiff) {
      // Prepend CSI H to anchor the physical cursor to (0,0) so
      // log-update's relative moves compute from a known spot (self-healing
      // against out-of-band cursor drift, see the ALT_SCREEN_ANCHOR_CURSOR
      // comment above). Append CSI row;1 H to park the cursor at the bottom
      // row (where the prompt input is) — without this, the cursor ends
      // wherever the last diff write landed (a different row every frame),
      // making iTerm2's cursor guide flicker as it chases the cursor.
      // BSU/ESU protects content atomicity but iTerm2's guide tracks cursor
      // position independently. Parking at bottom (not 0,0) keeps the guide
      // where the user's attention is.
      //
      optimized.unshift(CURSOR_HOME_PATCH);
      optimized.push(this.altScreenParkPatch);
    }

    // Native cursor positioning: park the terminal cursor at the declared
    // position so IME preedit text renders inline and screen readers /
    // magnifiers can follow the input. nodeCache holds the absolute screen
    // rect populated by renderNodeToOutput this frame — if the declared
    // node didn't render (stale declaration after remount, or scrolled out
    // of view), it won't be in the cache and no move is emitted.
    const decl = this.cursorDeclaration;
    const rect = decl !== null ? nodeCache.get(decl.node) : undefined;
    const target =
      decl !== null && rect !== undefined
        ? { x: rect.x + decl.relativeX, y: rect.y + decl.relativeY }
        : null;
    const parked = this.displayCursor;
    const targetMoved =
      target !== null &&
      (parked === null || parked.x !== target.x || parked.y !== target.y);
    if (hasDiff || targetMoved || (target === null && parked !== null)) {
      if (target !== null) {
        if (this.altScreenActive) {
          // Absolute CUP (1-indexed); replaces the default bottom-row park.
          const row = Math.min(Math.max(target.y + 1, 1), terminalRows);
          const col = Math.min(Math.max(target.x + 1, 1), terminalWidth);
          // Remove the default altScreenParkPatch (last element) and
          // replace with the declared cursor position.
          if (this.altScreenActive && optimized.length > 0) {
            const last = optimized[optimized.length - 1];
            if (
              last &&
              'content' in last &&
              last.content === this.altScreenParkPatch.content
            ) {
              optimized[optimized.length - 1] = {
                type: 'stdout' as const,
                content: cursorPosition(row, col),
              };
            } else {
              optimized.push({
                type: 'stdout' as const,
                content: cursorPosition(row, col),
              });
            }
          }
        } else {
          // Main screen: move cursor from frame.cursor to target.
          const from =
            !hasDiff && parked !== null
              ? parked
              : { x: frame.cursor.x, y: frame.cursor.y };
          const dx = target.x - from.x;
          const dy = clampCursorMoveY(target.y - from.y, terminalRows);
          if (dx !== 0 || dy !== 0) {
            optimized.push({
              type: 'stdout' as const,
              content: cursorMove(dx, dy),
            });
          }
        }
        this.displayCursor = target;
      } else {
        // Declaration cleared (input blur, unmount).
        if (parked !== null && !this.altScreenActive && !hasDiff) {
          const rdx = frame.cursor.x - parked.x;
          const rdy = clampCursorMoveY(frame.cursor.y - parked.y, terminalRows);
          if (rdx !== 0 || rdy !== 0) {
            optimized.push({
              type: 'stdout' as const,
              content: cursorMove(rdx, rdy),
            });
          }
        }
        this.displayCursor = null;
      }
    }

    const tWrite = performance.now();
    writeDiffToTerminal(
      this.terminal,
      optimized,
      this.altScreenActive && !SYNC_OUTPUT_SUPPORTED,
      terminalRows,
    );
    const writeMs = performance.now() - tWrite;

    // Update blit safety for the NEXT frame.
    this.prevFrameContaminated = false;

    // A ScrollBox has pendingScrollDelta left to drain — schedule the next
    // frame. MUST NOT call this.scheduleRender() here: we're inside a
    // trailing-edge throttle invocation, timerId is undefined, and lodash's
    // debounce sees timeSinceLastCall >= wait (last call was at the start
    // of this window) → leadingEdge fires IMMEDIATELY → double render ~0.1ms
    // apart → jank. Use a plain timeout. If a wheel event arrives first,
    // its scheduleRender path fires a render which clears this timer at
    // the top of onRender — no double.
    //
    // Drain frames are cheap (DECSTBM + ~10 patches, ~200 bytes) so run at
    // quarter interval (~250fps, setTimeout practical floor) for max scroll
    // speed. Regular renders stay at FRAME_INTERVAL_MS via the throttle.
    if (frame.scrollDrainPending) {
      this.drainTimer = setTimeout(
        () => this.onRender(),
        FRAME_INTERVAL_MS >> 2,
      );
    }
    const yogaMs = getLastYogaMs();
    const commitMs = getLastCommitMs();
    const yc = this.lastYogaCounters;
    // Reset so drain-only frames (no React commit) don't repeat stale values.
    resetProfileCounters();
    this.lastYogaCounters = {
      ms: 0,
      visited: 0,
      measured: 0,
      cacheHits: 0,
      live: 0,
    };
    this.options.onFrame?.({
      durationMs: performance.now() - renderStart,
      phases: {
        renderer: rendererMs,
        diff: diffMs,
        optimize: optimizeMs,
        write: writeMs,
        patches: diff.length,
        yoga: yogaMs,
        commit: commitMs,
        yogaVisited: yc.visited,
        yogaMeasured: yc.measured,
        yogaCacheHits: yc.cacheHits,
        yogaLive: yc.live,
      },
      flickers,
    });
  }
  pause(): void {
    // Flush pending React updates and render before pausing.
    reconciler.flushSyncFromReconciler();
    this.onRender();
    this.isPaused = true;
  }
  resume(): void {
    this.isPaused = false;
    this.onRender();
  }

  /**
   * Reset frame buffers so the next render writes the full screen from scratch.
   * Call this before resume() when the terminal content has been corrupted by
   * an external process (e.g. tmux, shell, full-screen TUI).
   */
  repaint(): void {
    this.displayCursor = null;
    this.frontFrame = emptyFrame(
      this.frontFrame.viewport.height,
      this.frontFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );
    this.backFrame = emptyFrame(
      this.backFrame.viewport.height,
      this.backFrame.viewport.width,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    );
    this.log.reset();
  }

  /** Request a renderer-owned active viewport rebuild on the next frame. */
  requestViewportReset(): void {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) return;
    this.displayCursor = null;
    this.log.forceReset('recovery');
    this.scheduleRender();
  }

  /** Replace the active transcript and replay its complete logical frame. */
  requestTranscriptReplacement(): void {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) return;
    this.displayCursor = null;
    this.log.forceTranscriptReplacement();
    this.scheduleRender();
  }

  /**
   * Clear the active screen and native scrollback without rendering.
   *
   * Callers update the React conversation state at the same time. Scheduling
   * here would replay the old tree before that state commits and copy stale
   * conversation rows back into the freshly cleared terminal.
   */
  clearConversation(): void {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) return;
    if (this.altScreenActive) {
      this.options.stdout.write(
        LINK_END +
          '\x1b[0m' +
          EXIT_ALT_SCREEN +
          ERASE_SCREEN +
          ERASE_SCROLLBACK +
          CURSOR_HOME +
          ENTER_ALT_SCREEN +
          ERASE_SCREEN +
          CURSOR_HOME,
      );
      this.resetFramesForAltScreen();
    } else {
      this.options.stdout.write(
        LINK_END +
          '\x1b[0m' +
          ERASE_SCREEN +
          ERASE_SCROLLBACK +
          CURSOR_HOME,
      );
      this.repaint();
      this.prevFrameContaminated = true;
    }
  }

  /**
   * Mark the previous frame as untrustworthy for blit, forcing the next
   * render to do a full-damage diff instead of the per-node fast path.
   *
   * This performs no screen clear or extra stdout write. Call
   * from a useLayoutEffect cleanup when unmounting a tall overlay: the
   * blit fast path can copy stale cells from the overlay frame into rows
   * the shrunken layout no longer reaches, leaving a ghost title/divider.
   * onRender resets the flag at frame end so it's one-shot.
   */
  invalidatePrevFrame(): void {
    this.prevFrameContaminated = true;
  }

  /**
   * Called by the <AlternateScreen> component on mount/unmount.
   * Controls cursor.y clamping in the renderer and gates alt-screen-aware
   * behavior in SIGCONT/resize/unmount handlers. Repaints on change so
   * the first alt-screen frame (and first main-screen frame on exit) is
   * a full redraw with no stale diff state.
   */
  setAltScreenActive(active: boolean, mouseTracking = false): void {
    if (this.altScreenActive === active) return;
    this.altScreenActive = active;
    this.altScreenMouseTracking = active && mouseTracking;
    if (active) {
      this.resetFramesForAltScreen();
    } else {
      this.displayCursor = null;
      this.log.forceReset('recovery');
    }
  }
  get isAltScreenActive(): boolean {
    return this.altScreenActive;
  }

  /**
   * Re-assert terminal modes after a gap (>5s stdin silence or event-loop
   * stall). Catches tmux detach→attach, ssh reconnect, and laptop
   * sleep/wake — none of which send SIGCONT. The terminal may reset DEC
   * private modes on reconnect; this method restores them.
   *
   * Always re-asserts extended key reporting and mouse tracking. Mouse
   * tracking is idempotent (DEC private mode set-when-set is a no-op). The
   * Kitty keyboard protocol is NOT — CSI >1u is a stack push, so we pop
   * first to keep depth balanced (pop on empty stack is a no-op per spec,
   * so after a terminal reset this still restores depth 0→1). Without the
   * pop, each >5s idle gap adds a stack entry, and the single pop on exit
   * or suspend can't drain them — the shell is left in CSI u mode where
   * Ctrl+C/Ctrl+D leak as escape sequences. The alt-screen
   * re-entry (ERASE_SCREEN + frame reset) is NOT idempotent — it blanks the
   * screen — so it's opt-in via includeAltScreen. The stdin-gap caller fires
   * on ordinary >5s idle + keypress and must not erase; the event-loop stall
   * detector fires on genuine sleep/wake and opts in. tmux attach / ssh
   * reconnect typically send a resize, which already covers alt-screen via
   * handleResize.
   */
  reassertTerminalModes = (includeAltScreen = false): void => {
    if (!this.options.stdout.isTTY) return;
    // Don't touch the terminal during an editor handoff — re-enabling kitty
    // keyboard here would undo enterAlternateScreen's disable and nano would
    // start seeing CSI-u sequences again.
    if (this.isPaused) return;
    // Extended keys — re-assert if enabled (App.tsx enables these on
    // allowlisted terminals at raw-mode entry; a terminal reset clears them).
    // Pop-before-push keeps Kitty stack depth at 1 instead of accumulating
    // on each call.
    if (supportsExtendedKeys()) {
      this.options.stdout.write(
        DISABLE_KITTY_KEYBOARD +
          ENABLE_KITTY_KEYBOARD +
          ENABLE_MODIFY_OTHER_KEYS,
      );
    }
    if (!this.altScreenActive) return;
    // Mouse tracking — idempotent, safe to re-assert on every stdin gap.
    if (this.altScreenMouseTracking) {
      this.options.stdout.write(ENABLE_MOUSE_TRACKING);
    }
    // Alt-screen re-entry — destructive (ERASE_SCREEN). Only for callers that
    // have a strong signal the terminal actually dropped mode 1049.
    if (includeAltScreen) {
      this.reenterAltScreen();
    }
  };

  /**
   * Mark this instance as unmounted so future unmount() calls early-return.
   * Called by gracefulShutdown's cleanupTerminalModes() after it has sent
   * EXIT_ALT_SCREEN but before the remaining terminal-reset sequences.
   * Without this, signal-exit's deferred ink.unmount() (triggered by
   * process.exit()) runs the full unmount path: onRender() + writeSync
   * cleanup block + updateContainerSync → AlternateScreen unmount cleanup.
   * The result is 2-3 redundant EXIT_ALT_SCREEN sequences landing on the
   * main screen AFTER printResumeHint(), which tmux (at least) interprets
   * as restoring the saved cursor position — clobbering the resume hint.
   */
  detachForShutdown(): void {
    this.isUnmounted = true;
    // Cancel any pending throttled render so it doesn't fire between
    // cleanupTerminalModes() and process.exit() and write to main screen.
    this.scheduleRender.cancel?.();
    // Restore stdin from raw mode. unmount() used to do this via React
    // unmount (App.componentWillUnmount → handleSetRawMode(false)) but we're
    // short-circuiting that path. Must use this.options.stdin — NOT
    // process.stdin — because getStdinOverride() may have opened /dev/tty
    // when stdin is piped.
    const stdin = this.options.stdin as NodeJS.ReadStream & {
      isRaw?: boolean;
      setRawMode?: (m: boolean) => void;
    };
    this.drainStdin();
    if (stdin.isTTY && stdin.isRaw && stdin.setRawMode) {
      stdin.setRawMode(false);
    }
  }

  /** @see drainStdin */
  drainStdin(): void {
    drainStdin(this.options.stdin);
  }

  /**
   * Re-enter alt-screen, clear, home, re-enable mouse tracking, and reset
   * frame buffers so the next render repaints from scratch. Self-heal for
   * SIGCONT, resize, and stdin-gap/event-loop-stall (sleep/wake) — any of
   * which can leave the terminal in main-screen mode while altScreenActive
   * stays true. ENTER_ALT_SCREEN is a terminal-side no-op if already in alt.
   */
  private reenterAltScreen(): void {
    // Exit alt screen first so the subsequent ERASE clears the MAIN screen's
    // scrollback (iTerm2 shows main-screen scrollback when scrolling up in
    // alt mode). Then re-enter alt and clear the alt buffer.
    this.options.stdout.write(
      EXIT_ALT_SCREEN +
        ERASE_SCREEN +
        ERASE_SCROLLBACK +
        CURSOR_HOME +
        ENTER_ALT_SCREEN +
        ERASE_SCREEN +
        CURSOR_HOME +
        (this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : ''),
    );
    this.resetFramesForAltScreen();
  }

  /**
   * Seed prev/back frames with full-size BLANK screens (rows×cols of empty
   * cells, not 0×0). In alt-screen mode, next.screen.height is always
   * terminalRows; if prev.screen.height is 0 (emptyFrame's default),
   * log-update sees heightDelta > 0 ('growing') and calls renderFrameSlice,
   * whose trailing per-row CR+LF at the last row scrolls the alt screen,
   * permanently desyncing the virtual and physical cursors by 1 row.
   *
   * With a rows×cols blank prev, heightDelta === 0 → standard diffEach
   * → moveCursorTo (CSI cursorMove, no LF, no scroll).
   *
   * viewport.height = rows + 1 matches the renderer's alt-screen output,
   * preventing a spurious resize trigger on the first frame. cursor.y = 0
   * matches the physical cursor after ENTER_ALT_SCREEN + CSI H (home).
   */
  private resetFramesForAltScreen(): void {
    this.displayCursor = null;
    const rows = this.terminalRows;
    const cols = this.terminalColumns;
    const blank = (): Frame => ({
      screen: createScreen(
        cols,
        rows,
        this.stylePool,
        this.charPool,
        this.hyperlinkPool,
      ),
      viewport: {
        width: cols,
        height: rows + 1,
      },
      cursor: {
        x: 0,
        y: 0,
        visible: true,
      },
    });
    this.frontFrame = blank();
    this.backFrame = blank();
    this.log.reset();
    // Fresh frontFrame is blank rows×cols — blitting from it would copy
    // blanks over content. Next alt-screen frame must full-render.
    this.prevFrameContaminated = true;
  }

  // Methods to properly suspend stdin for external editor usage
  // This is needed to prevent Ink from swallowing keystrokes when an external editor is active
  private stdinListeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }> = [];
  private wasRawMode = false;
  suspendStdin(): void {
    const stdin = this.options.stdin;
    if (!stdin.isTTY) {
      return;
    }

    // Store and remove all 'readable' event listeners temporarily
    // This prevents Ink from consuming stdin while the editor is active
    const readableListeners = stdin.listeners('readable');
    logForDebugging(
      `[stdin] suspendStdin: removing ${readableListeners.length} readable listener(s), wasRawMode=${
        (
          stdin as NodeJS.ReadStream & {
            isRaw?: boolean;
          }
        ).isRaw ?? false
      }`,
    );
    readableListeners.forEach((listener) => {
      this.stdinListeners.push({
        event: 'readable',
        listener: listener as (...args: unknown[]) => void,
      });
      stdin.removeListener(
        'readable',
        listener as (...args: unknown[]) => void,
      );
    });

    // If raw mode is enabled, disable it temporarily
    const stdinWithRaw = stdin as NodeJS.ReadStream & {
      isRaw?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    if (stdinWithRaw.isRaw && stdinWithRaw.setRawMode) {
      stdinWithRaw.setRawMode(false);
      this.wasRawMode = true;
    }
  }
  resumeStdin(): void {
    const stdin = this.options.stdin;
    if (!stdin.isTTY) {
      return;
    }

    // Re-attach all the stored listeners
    if (this.stdinListeners.length === 0 && !this.wasRawMode) {
      logForDebugging(
        '[stdin] resumeStdin: called with no stored listeners and wasRawMode=false (possible desync)',
        {
          level: 'warn',
        },
      );
    }
    logForDebugging(
      `[stdin] resumeStdin: re-attaching ${this.stdinListeners.length} listener(s), wasRawMode=${this.wasRawMode}`,
    );
    this.stdinListeners.forEach(({ event, listener }) => {
      stdin.addListener(event, listener);
    });
    this.stdinListeners = [];

    // Re-enable raw mode if it was enabled before
    if (this.wasRawMode) {
      const stdinWithRaw = stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      };
      if (stdinWithRaw.setRawMode) {
        stdinWithRaw.setRawMode(true);
      }
      this.wasRawMode = false;
    }
  }

  render(node: ReactNode): void {
    this.currentNode = node;
    const tree = (
      <App
        stdin={this.options.stdin}
        stdout={this.options.stdout}
        stderr={this.options.stderr}
        exitOnCtrlC={this.options.exitOnCtrlC}
        onExit={this.unmount}
        terminalColumns={this.terminalColumns}
        terminalRows={this.terminalRows}
        onStdinResume={this.reassertTerminalModes}
        scheduleRender={this.scheduleRender}
        requestViewportReset={this.requestViewportReset}
        requestTranscriptReplacement={this.requestTranscriptReplacement}
        invalidatePrevFrame={this.invalidatePrevFrame}
        clearConversation={this.clearConversation}
        onCursorDeclaration={this.setCursorDeclaration}
        afterLayoutRegistry={this.afterLayoutRegistry}
      >
        {node}
      </App>
    );

    reconciler.updateContainerSync(tree, this.container, null, noop);
    reconciler.flushSyncWork();

    // In test mode the reconciler paints from resetAfterCommit, which runs
    // *before* React's layout phase — so on the first commit the after-layout
    // registry is still empty and nothing has measured. flushSyncWork above
    // has now run those layout effects, so paint once more to give tests the
    // settled frame they used to get from the measurement-driven second
    // commit. Later commits already have a populated registry.
    if (process.env['NODE_ENV'] === 'test') {
      this.onRender();
    }
  }
  unmount(error?: Error | number | null): void {
    if (this.isUnmounted) {
      return;
    }
    this.onRender();
    this.unsubscribeExit();
    if (typeof this.restoreConsole === 'function') {
      this.restoreConsole();
    }
    this.restoreStderr?.();
    this.unsubscribeTTYHandlers?.();

    // Non-TTY environments don't handle erasing ansi escapes well, so it's better to
    // only render last frame of non-static output
    const diff = this.log.renderPreviousOutput_DEPRECATED(this.frontFrame);
    writeDiffToTerminal(
      this.terminal,
      optimize(diff),
      false,
      this.options.stdout.rows || 24,
    );

    // Clean up terminal modes synchronously before process exit.
    // React's componentWillUnmount won't run in time when process.exit() is called,
    // so we must reset terminal modes here to prevent escape sequence leakage.
    // Use writeSync to stdout (fd 1) to ensure writes complete before exit.
    // We unconditionally send all disable sequences because terminal detection
    // may not work correctly (e.g., in tmux, screen) and these are no-ops on
    // terminals that don't support them.
    /* eslint-disable custom-rules/no-sync-fs -- process exiting; async writes would be dropped */
    if (this.options.stdout.isTTY) {
      if (this.altScreenActive) {
        // <AlternateScreen>'s unmount effect won't run during signal-exit.
        // Exit alt screen FIRST so other cleanup sequences go to the main screen.
        writeSync(1, EXIT_ALT_SCREEN);
      }
      // Disable mouse tracking — unconditional because altScreenActive can be
      // stale if AlternateScreen's unmount (which flips the flag) raced a
      // blocked event loop + SIGINT. No-op if tracking was never enabled.
      writeSync(1, DISABLE_MOUSE_TRACKING);
      // Drain stdin so in-flight mouse events don't leak to the shell
      this.drainStdin();
      // Disable extended key reporting (both kitty and modifyOtherKeys)
      writeSync(1, DISABLE_MODIFY_OTHER_KEYS);
      writeSync(1, DISABLE_KITTY_KEYBOARD);
      // Disable focus events (DECSET 1004)
      writeSync(1, DFE);
      // Disable bracketed paste mode
      writeSync(1, DBP);
      // Show cursor
      writeSync(1, SHOW_CURSOR);
      // Clear iTerm2 progress bar
      writeSync(1, CLEAR_ITERM2_PROGRESS);
      // Clear tab status (OSC 21337) so a stale dot doesn't linger
      if (supportsTabStatus())
        writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS));
      // Drop our OSC 7501 records. Never multiplexer-wrapped: the outer
      // terminal cannot tell panes apart.
      if (hasReportedProgramStatus()) {
        writeSync(1, CLEAR_PROGRAM_STATUS);
        markProgramStatusReported(false);
      }
    }
    /* eslint-enable custom-rules/no-sync-fs */

    this.isUnmounted = true;

    // Cancel any pending throttled renders to prevent accessing freed Yoga nodes
    this.scheduleRender.cancel?.();
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    reconciler.updateContainerSync(null, this.container, null, noop);
    reconciler.flushSyncWork();
    instances.delete(this.options.stdout);

    // Free the root yoga node, then clear its reference. Children are already
    // freed by the reconciler's removeChildFromContainer; using .free() (not
    // .freeRecursive()) avoids double-freeing them.
    this.rootNode.yogaNode?.free();
    this.rootNode.yogaNode = undefined;
    if (error instanceof Error) {
      this.rejectExitPromise(error);
    } else {
      this.resolveExitPromise();
    }
  }
  async waitUntilExit(): Promise<void> {
    this.exitPromise ||= new Promise((resolve, reject) => {
      this.resolveExitPromise = resolve;
      this.rejectExitPromise = reject;
    });
    return this.exitPromise;
  }
  resetLineCount(): void {
    if (this.options.stdout.isTTY) {
      this.displayCursor = null;
      // Swap so old front becomes back (for screen reuse), then reset front
      this.backFrame = this.frontFrame;
      this.frontFrame = emptyFrame(
        this.frontFrame.viewport.height,
        this.frontFrame.viewport.width,
        this.stylePool,
        this.charPool,
        this.hyperlinkPool,
      );
      this.log.reset();
    }
  }

  /**
   * Replace char/hyperlink pools with fresh instances to prevent unbounded
   * growth during long sessions. Migrates the front frame's screen IDs into
   * the new pools so diffing remains correct. The back frame doesn't need
   * migration — resetScreen zeros it before any reads.
   *
   * Call between conversation turns or periodically.
   */
  resetPools(): void {
    this.charPool = new CharPool();
    this.hyperlinkPool = new HyperlinkPool();
    migrateScreenPools(
      this.frontFrame.screen,
      this.charPool,
      this.hyperlinkPool,
    );
    // Back frame's data is zeroed by resetScreen before reads, but its pool
    // references are used by the renderer to intern new characters. Point
    // them at the new pools so the next frame's IDs are comparable.
    this.backFrame.screen.charPool = this.charPool;
    this.backFrame.screen.hyperlinkPool = this.hyperlinkPool;
  }
  patchConsole(): () => void {
    // biome-ignore lint/suspicious/noConsole: intentionally patching global console
    const con = console;
    const originals: Partial<Record<keyof Console, Console[keyof Console]>> =
      {};
    const toDebug = (...args: unknown[]) =>
      logForDebugging(`console.log: ${format(...args)}`);
    const toError = (...args: unknown[]) =>
      logError(new Error(`console.error: ${format(...args)}`));
    for (const m of CONSOLE_STDOUT_METHODS) {
      originals[m] = con[m];
      con[m] = toDebug;
    }
    for (const m of CONSOLE_STDERR_METHODS) {
      originals[m] = con[m];
      con[m] = toError;
    }
    originals.assert = con.assert;
    con.assert = (condition: unknown, ...args: unknown[]) => {
      if (!condition) toError(...args);
    };
    return () => Object.assign(con, originals);
  }

  /**
   * Intercept process.stderr.write so stray writes (config.ts, hooks.ts,
   * third-party deps) don't corrupt the alt-screen buffer. patchConsole only
   * hooks console.* methods — direct stderr writes bypass it, land at the
   * parked cursor, scroll the alt-screen, and desync frontFrame from the
   * physical terminal. Next diff writes only changed-in-React cells at
   * absolute coords → interleaved garbage.
   *
   * Swallows the write (routes text to the debug log) and, in alt-screen,
   * forces a full-damage repaint as a defensive recovery. Not patching
   * process.stdout — Ink itself writes there.
   */
  private patchStderr(): () => void {
    const stderr = process.stderr;
    const originalWrite = stderr.write;
    let reentered = false;
    const intercept = (
      chunk: Uint8Array | string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      // Reentrancy guard: logForDebugging → writeToStderr → here. Pass
      // through to the original so --debug-to-stderr still works and we
      // don't stack-overflow.
      if (reentered) {
        const encoding =
          typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
        return originalWrite.call(stderr, chunk, encoding, callback);
      }
      reentered = true;
      try {
        const text =
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8');
        logForDebugging(`[stderr] ${text}`, {
          level: 'warn',
        });
        if (this.altScreenActive && !this.isUnmounted && !this.isPaused) {
          this.prevFrameContaminated = true;
          this.scheduleRender();
        }
      } finally {
        reentered = false;
        callback?.();
      }
      return true;
    };
    stderr.write = intercept;
    return () => {
      if (stderr.write === intercept) {
        stderr.write = originalWrite;
      }
    };
  }
}

/**
 * Discard pending stdin bytes so in-flight escape sequences (mouse tracking
 * reports, bracketed-paste markers) don't leak to the shell after exit.
 *
 * Two layers of trickiness:
 *
 * 1. setRawMode is termios, not fcntl — the stdin fd stays blocking, so
 *    readSync on it would hang forever. Node doesn't expose fcntl, so we
 *    open /dev/tty fresh with O_NONBLOCK (all fds to the controlling
 *    terminal share one line-discipline input queue).
 *
 * 2. By the time forceExit calls this, detachForShutdown has already put
 *    the TTY back in cooked (canonical) mode. Canonical mode line-buffers
 *    input until newline, so O_NONBLOCK reads return EAGAIN even when
 *    mouse bytes are sitting in the buffer. We briefly re-enter raw mode
 *    so reads return any available bytes, then restore cooked mode.
 *
 * Safe to call multiple times. Call as LATE as possible in the exit path:
 * DISABLE_MOUSE_TRACKING has terminal round-trip latency, so events can
 * arrive for a few ms after it's written.
 */
/* eslint-disable custom-rules/no-sync-fs -- must be sync; called from signal handler / unmount */
export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return;
  // Drain Node's stream buffer (bytes libuv already pulled in). read()
  // returns null when empty — never blocks.
  try {
    while (stdin.read() !== null) {
      /* discard */
    }
  } catch {
    /* stream may be destroyed */
  }
  // No /dev/tty on Windows; CONIN$ doesn't support O_NONBLOCK semantics.
  // Windows Terminal also doesn't buffer mouse reports the same way.
  if (process.platform === 'win32') return;
  // termios is per-device: flip stdin to raw so canonical-mode line
  // buffering doesn't hide partial input from the non-blocking read.
  // Restored in the finally block.
  const tty = stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  const wasRaw = tty.isRaw === true;
  // Drain the kernel TTY buffer via a fresh O_NONBLOCK fd. Bounded at 64
  // reads (64KB) — a real mouse burst is a few hundred bytes; the cap
  // guards against a terminal that ignores O_NONBLOCK.
  let fd = -1;
  try {
    // setRawMode inside try: on revoked TTY (SIGHUP/SSH disconnect) the
    // ioctl throws EBADF — same recovery path as openSync/readSync below.
    if (!wasRaw) tty.setRawMode?.(true);
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) break;
    }
  } catch {
    // EAGAIN (buffer empty — expected), ENXIO/ENOENT (no controlling tty),
    // EBADF/EIO (TTY revoked — SIGHUP, SSH disconnect)
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (!wasRaw) {
      try {
        tty.setRawMode?.(false);
      } catch {
        /* TTY may be gone */
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

const CONSOLE_STDOUT_METHODS = [
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'count',
  'countReset',
  'group',
  'groupCollapsed',
  'groupEnd',
  'table',
  'time',
  'timeEnd',
  'timeLog',
] as const;
const CONSOLE_STDERR_METHODS = ['warn', 'error', 'trace'] as const;
