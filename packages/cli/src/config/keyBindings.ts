/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command enum for all available keyboard shortcuts
 */
export enum Command {
  // Basic bindings
  RETURN = 'return',
  ESCAPE = 'escape',

  // Cursor movement
  HOME = 'home',
  END = 'end',

  // Text deletion
  KILL_LINE_RIGHT = 'killLineRight',
  KILL_LINE_LEFT = 'killLineLeft',
  CLEAR_INPUT = 'clearInput',
  DELETE_WORD_BACKWARD = 'deleteWordBackward',

  // Screen control
  CLEAR_SCREEN = 'clearScreen',

  // History navigation
  HISTORY_UP = 'historyUp',
  HISTORY_DOWN = 'historyDown',
  NAVIGATION_UP = 'navigationUp',
  NAVIGATION_DOWN = 'navigationDown',

  // Auto-completion
  ACCEPT_SUGGESTION = 'acceptSuggestion',
  COMPLETION_UP = 'completionUp',
  COMPLETION_DOWN = 'completionDown',

  // Text input
  SUBMIT = 'submit',
  NEWLINE = 'newline',

  // External tools
  OPEN_EXTERNAL_EDITOR = 'openExternalEditor',
  PASTE_CLIPBOARD_IMAGE = 'pasteClipboardImage',

  // App level bindings
  TOGGLE_TOOL_DESCRIPTIONS = 'toggleToolDescriptions',
  TOGGLE_IDE_CONTEXT_DETAIL = 'toggleIDEContextDetail',
  QUIT = 'quit',
  EXIT = 'exit',
  SHOW_MORE_LINES = 'showMoreLines',
  RETRY_LAST = 'retryLast',
  TOGGLE_COMPACT_MODE = 'toggleCompactMode',
  TOGGLE_RENDER_MODE = 'toggleRenderMode',
  /**
   * Promote the running foreground shell command to a background task.
   * The child process keeps running and the agent's turn unblocks; the
   * shell becomes a regular `BackgroundShellEntry` visible in `/tasks`,
   * the Background tasks dialog, and stoppable via `task_stop`.
   * No-op when no foreground shell is currently executing.
   */
  PROMOTE_SHELL_TO_BACKGROUND = 'promoteShellToBackground',

  // Shell commands
  REVERSE_SEARCH = 'reverseSearch',
  SUBMIT_REVERSE_SEARCH = 'submitReverseSearch',
  ACCEPT_SUGGESTION_REVERSE_SEARCH = 'acceptSuggestionReverseSearch',
  TOGGLE_SHELL_INPUT_FOCUS = 'toggleShellInputFocus',

  // Suggestion expansion
  EXPAND_SUGGESTION = 'expandSuggestion',
  COLLAPSE_SUGGESTION = 'collapseSuggestion',
}

/**
 * Data-driven key binding structure for user configuration
 */
export interface KeyBinding {
  /** The key name (e.g., 'a', 'return', 'tab', 'escape') */
  key?: string;
  /** The key sequence (e.g., '\x18' for Ctrl+X) - alternative to key name */
  sequence?: string;
  /** Control key requirement: true=must be pressed, false=must not be pressed, undefined=ignore */
  ctrl?: boolean;
  /** Shift key requirement: true=must be pressed, false=must not be pressed, undefined=ignore */
  shift?: boolean;
  /** Command/meta key requirement: true=must be pressed, false=must not be pressed, undefined=ignore */
  command?: boolean;
  /** Paste operation requirement: true=must be paste, false=must not be paste, undefined=ignore */
  paste?: boolean;
  meta?: boolean;
}

/**
 * Configuration type mapping commands to their key bindings
 */
export type KeyBindingConfig = {
  readonly [C in Command]: readonly KeyBinding[];
};

/**
 * Default key binding configuration
 * Matches the original hard-coded logic exactly
 */
export const defaultKeyBindings: KeyBindingConfig = {
  // Basic bindings
  [Command.RETURN]: [{ key: 'return' }],
  [Command.ESCAPE]: [{ key: 'escape' }],

  // Cursor movement
  [Command.HOME]: [{ key: 'a', ctrl: true }],
  [Command.END]: [{ key: 'e', ctrl: true }],

  // Text deletion
  [Command.KILL_LINE_RIGHT]: [{ key: 'k', ctrl: true }],
  [Command.KILL_LINE_LEFT]: [{ key: 'u', ctrl: true }],
  [Command.CLEAR_INPUT]: [{ key: 'c', ctrl: true }],
  // Added command (meta/alt/option) for mac compatibility
  [Command.DELETE_WORD_BACKWARD]: [
    { key: 'backspace', ctrl: true },
    { key: 'backspace', command: true },
    // MinTTY (Git Bash on Windows) emits the byte \x1f (ASCII Unit
    // Separator, rendered as "^_" by `cat -v`) for Ctrl+Backspace under
    // its standard Ctrl-modifies-meta-keys convention. The same byte is
    // the historical Ctrl-mapping of the Unit Separator on traditional
    // ANSI/VT terminals (Ctrl+_ and Ctrl+/ also emit it), but qwen-code
    // doesn't bind those keystrokes elsewhere so this entry is additive
    // and non-conflicting on every platform.
    { sequence: '\x1f' },
  ],

  // Screen control
  [Command.CLEAR_SCREEN]: [{ key: 'l', ctrl: true }],

  // History navigation
  [Command.HISTORY_UP]: [{ key: 'p', ctrl: true }],
  [Command.HISTORY_DOWN]: [{ key: 'n', ctrl: true }],
  [Command.NAVIGATION_UP]: [{ key: 'up' }],
  [Command.NAVIGATION_DOWN]: [{ key: 'down' }],

  // Auto-completion
  [Command.ACCEPT_SUGGESTION]: [{ key: 'tab' }, { key: 'return', ctrl: false }],
  // Completion navigation uses only arrow keys
  // Ctrl+P/N are reserved for history navigation (HISTORY_UP/DOWN)
  [Command.COMPLETION_UP]: [{ key: 'up' }],
  [Command.COMPLETION_DOWN]: [{ key: 'down' }],

  // Text input
  // Must also exclude shift to allow shift+enter for newline
  [Command.SUBMIT]: [
    {
      key: 'return',
      ctrl: false,
      command: false,
      paste: false,
      shift: false,
    },
  ],
  // Split into multiple data-driven bindings
  // Now also includes shift+enter for multi-line input
  [Command.NEWLINE]: [
    { key: 'return', ctrl: true },
    { key: 'return', command: true },
    { key: 'return', paste: true },
    { key: 'return', shift: true },
    { key: 'j', ctrl: true },
  ],

  // External tools
  [Command.OPEN_EXTERNAL_EDITOR]: [
    { key: 'x', ctrl: true },
    { sequence: '\x18', ctrl: true },
  ],
  [Command.PASTE_CLIPBOARD_IMAGE]:
    process.platform === 'win32'
      ? [
          { key: 'v', command: true },
          { key: 'v', meta: true },
        ]
      : [
          { key: 'v', ctrl: true },
          { key: 'v', command: true },
        ],

  // App level bindings
  [Command.TOGGLE_TOOL_DESCRIPTIONS]: [{ key: 't', ctrl: true }],
  [Command.TOGGLE_IDE_CONTEXT_DETAIL]: [{ key: 'g', ctrl: true }],
  [Command.QUIT]: [{ key: 'c', ctrl: true }],
  [Command.EXIT]: [{ key: 'd', ctrl: true }],
  [Command.SHOW_MORE_LINES]: [{ key: 's', ctrl: true }],
  [Command.RETRY_LAST]: [{ key: 'y', ctrl: true }],
  [Command.TOGGLE_COMPACT_MODE]: [{ key: 'o', ctrl: true }],
  [Command.TOGGLE_RENDER_MODE]: [{ key: 'm', meta: true }],
  [Command.PROMOTE_SHELL_TO_BACKGROUND]: [{ key: 'b', ctrl: true }],

  // Shell commands
  [Command.REVERSE_SEARCH]: [{ key: 'r', ctrl: true }],
  // Note: original logic ONLY checked ctrl=false, ignored meta/shift/paste
  [Command.SUBMIT_REVERSE_SEARCH]: [{ key: 'return', ctrl: false }],
  [Command.ACCEPT_SUGGESTION_REVERSE_SEARCH]: [{ key: 'tab' }],
  [Command.TOGGLE_SHELL_INPUT_FOCUS]: [{ key: 'f', ctrl: true }],

  // Suggestion expansion
  [Command.EXPAND_SUGGESTION]: [{ key: 'right' }],
  [Command.COLLAPSE_SUGGESTION]: [{ key: 'left' }],
};
