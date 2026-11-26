/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import process from 'node:process';
import { z } from 'zod';
import { parse as parseIgnoringComments } from 'comment-json';
import { isNodeError, Storage } from '@qwen-code/core';

/**
 * Command enum for all available keyboard shortcuts
 */
import type { Key } from '../hooks/useKeypress.js';
import { SHIFT_TAB_KEY } from '../constants/shortcuts.js';

export enum Command {
  // Basic Controls
  RETURN = 'basic.confirm',
  ESCAPE = 'basic.cancel',
  QUIT = 'basic.quit',
  EXIT = 'basic.exit',

  // Cursor Movement
  HOME = 'cursor.home',
  END = 'cursor.end',
  MOVE_UP = 'cursor.up',
  MOVE_DOWN = 'cursor.down',
  MOVE_LEFT = 'cursor.left',
  MOVE_RIGHT = 'cursor.right',
  MOVE_WORD_LEFT = 'cursor.wordLeft',
  MOVE_WORD_RIGHT = 'cursor.wordRight',

  // Editing
  KILL_LINE_RIGHT = 'edit.deleteRightAll',
  KILL_LINE_LEFT = 'edit.deleteLeftAll',
  CLEAR_INPUT = 'edit.clear',
  DELETE_WORD_BACKWARD = 'edit.deleteWordLeft',
  DELETE_WORD_FORWARD = 'edit.deleteWordRight',
  DELETE_CHAR_LEFT = 'edit.deleteLeft',
  DELETE_CHAR_RIGHT = 'edit.deleteRight',
  UNDO = 'edit.undo',
  REDO = 'edit.redo',

  // Scrolling
  SCROLL_UP = 'scroll.up',
  SCROLL_DOWN = 'scroll.down',
  SCROLL_HOME = 'scroll.home',
  SCROLL_END = 'scroll.end',
  PAGE_UP = 'scroll.pageUp',
  PAGE_DOWN = 'scroll.pageDown',

  // History & Search
  HISTORY_UP = 'history.previous',
  HISTORY_DOWN = 'history.next',
  REVERSE_SEARCH = 'history.search.start',
  SUBMIT_REVERSE_SEARCH = 'history.search.submit',
  ACCEPT_SUGGESTION_REVERSE_SEARCH = 'history.search.accept',

  // Navigation
  NAVIGATION_UP = 'nav.up',
  NAVIGATION_DOWN = 'nav.down',
  DIALOG_NAVIGATION_UP = 'nav.dialog.up',
  DIALOG_NAVIGATION_DOWN = 'nav.dialog.down',
  DIALOG_NEXT = 'nav.dialog.next',
  DIALOG_PREV = 'nav.dialog.previous',
  ASK_USER_ADD_NOTES = 'askUser.addNotes',
  ASK_USER_TOGGLE_OPTION = 'askUser.toggleOption',
  ASK_USER_SUBMIT_SELECTION = 'askUser.submitSelection',
  SITES_ENVIRONMENT = 'sites.environment',
  SITES_ADD_SECRET = 'sites.addSecret',
  SITES_OPEN = 'sites.open',
  SITES_SAVE = 'sites.save',
  SITES_REFRESH = 'sites.refresh',
  SITES_SHARE = 'sites.share',
  SITES_PUBLISH = 'sites.publish',
  SITES_UNPUBLISH = 'sites.unpublish',
  SITES_DELETE = 'sites.delete',
  SITES_REMOVE_TARGET = 'sites.removeTarget',
  MODEL_REFRESH = 'model.refresh',
  MODEL_ADD = 'model.add',
  MODEL_EDIT = 'model.edit',
  PROVIDER_CUSTOM = 'provider.custom',
  PROVIDER_PRESETS = 'provider.presets',
  MODEL_DELETE = 'model.delete',
  SESSION_TOGGLE_PROJECT_SCOPE = 'session.toggleProjectScope',
  SESSION_TOGGLE_BRANCH_SCOPE = 'session.toggleBranchScope',
  SESSION_TOGGLE_WORKTREE_SCOPE = 'session.toggleWorktreeScope',
  SESSION_PREVIEW = 'session.preview',
  SESSION_TOGGLE_SHORTCUT_HELP = 'session.toggleShortcutHelp',

  // Suggestions & Completions
  ACCEPT_SUGGESTION = 'suggest.accept',
  COMPLETION_UP = 'suggest.focusPrevious',
  COMPLETION_DOWN = 'suggest.focusNext',
  EXPAND_SUGGESTION = 'suggest.expand',
  COLLAPSE_SUGGESTION = 'suggest.collapse',

  // Text Input
  SUBMIT = 'input.submit',
  QUEUE_MESSAGE = 'input.queueMessage',
  SEND_NOW = 'input.sendNow',
  NEWLINE = 'input.newline',
  OPEN_EXTERNAL_EDITOR = 'input.openExternalEditor',
  PASTE_CLIPBOARD = 'input.paste',
  PASTE_CLIPBOARD_IMAGE = 'input.pasteImage',
  STASH_PROMPT = 'input.stash',
  WORKFLOW_KEYWORD_TOGGLE = 'chat.workflowKeywordToggle',
  WORKFLOW_AGENT_SKIP = 'workflow.agentSkip',

  // App Controls
  SHOW_ERROR_DETAILS = 'app.showErrorDetails',
  SHOW_FULL_TODOS = 'app.showFullTodos',
  TOGGLE_MARKDOWN = 'app.toggleMarkdown',
  TOGGLE_YOLO = 'app.toggleYolo',
  CYCLE_PERMISSION_MODE = 'app.cyclePermissionMode',
  SHOW_MORE_LINES = 'app.showMoreLines',
  EXPAND_PASTE = 'app.expandPaste',
  CLEAR_SCREEN = 'app.clearScreen',
  RESTART_APP = 'app.restart',
  SUSPEND_APP = 'app.suspend',

  // Background Shell Controls
  BACKGROUND_SHELL_ESCAPE = 'background.escape',
  BACKGROUND_SHELL_SELECT = 'background.select',
  TOGGLE_BACKGROUND_SHELL = 'background.toggle',
  TOGGLE_BACKGROUND_SHELL_LIST = 'background.toggleList',
  KILL_BACKGROUND_SHELL = 'background.kill',
  SHOW_BACKGROUND_SHELL_UNFOCUS_WARNING = 'background.unfocusWarning',

  // Extension Controls
  UPDATE_EXTENSION = 'extension.update',
  LINK_EXTENSION = 'extension.link',

  DUMP_FRAME = 'app.dumpFrame',
  START_RECORDING = 'app.startRecording',
  STOP_RECORDING = 'app.stopRecording',

  // Dev-only Controls (only active when DEV=true)
  DEV_RELAUNCH = 'dev.relaunch',

  // Diff Viewer Controls
  SWITCH_VIEW = 'diff.switchView',
}

/**
 * Data-driven key binding structure for user configuration
 */
export class KeyBinding {
  private static readonly VALID_LONG_KEYS = new Set([
    ...Array.from({ length: 35 }, (_, i) => `f${i + 1}`), // Function Keys
    ...Array.from({ length: 10 }, (_, i) => `numpad${i}`), // Numpad Numbers
    // Navigation & Actions
    'left',
    'up',
    'right',
    'down',
    'pageup',
    'pagedown',
    'end',
    'home',
    'tab',
    'enter',
    'escape',
    'space',
    'backspace',
    'delete',
    'clear',
    'pausebreak',
    'capslock',
    'insert',
    'numlock',
    'scrolllock',
    'printscreen',
    'numpad_multiply',
    'numpad_add',
    'numpad_separator',
    'numpad_subtract',
    'numpad_decimal',
    'numpad_divide',
  ]);

  /** The key name (e.g., 'a', 'enter', 'tab', 'escape') */
  readonly name: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly cmd: boolean;

  constructor(pattern: string) {
    let remains = pattern.trim();
    let shift = false;
    let alt = false;
    let ctrl = false;
    let cmd = false;

    let matched: boolean;
    do {
      matched = false;
      const lowerRemains = remains.toLowerCase();
      if (lowerRemains.startsWith('ctrl+')) {
        ctrl = true;
        remains = remains.slice(5);
        matched = true;
      } else if (lowerRemains.startsWith('shift+')) {
        shift = true;
        remains = remains.slice(6);
        matched = true;
      } else if (lowerRemains.startsWith('alt+')) {
        alt = true;
        remains = remains.slice(4);
        matched = true;
      } else if (lowerRemains.startsWith('option+')) {
        alt = true;
        remains = remains.slice(7);
        matched = true;
      } else if (lowerRemains.startsWith('opt+')) {
        alt = true;
        remains = remains.slice(4);
        matched = true;
      } else if (lowerRemains.startsWith('cmd+')) {
        cmd = true;
        remains = remains.slice(4);
        matched = true;
      } else if (lowerRemains.startsWith('meta+')) {
        cmd = true;
        remains = remains.slice(5);
        matched = true;
      }
    } while (matched);

    const key = remains;

    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    const isSingleChar = [...key].length === 1;

    if (!isSingleChar && !KeyBinding.VALID_LONG_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `Invalid keybinding key: "${key}" in "${pattern}".` +
          ` Must be a single character or one of: ${[...KeyBinding.VALID_LONG_KEYS].join(', ')}`,
      );
    }

    this.name = key.toLowerCase();
    this.shift = shift || (isSingleChar && this.name !== key);
    this.alt = alt;
    this.ctrl = ctrl;
    this.cmd = cmd;
  }

  matches(key: Key): boolean {
    return (
      key.name === this.name &&
      !!key.shift === !!this.shift &&
      !!key.alt === !!this.alt &&
      !!key.ctrl === !!this.ctrl &&
      !!key.cmd === !!this.cmd
    );
  }

  equals(other: KeyBinding): boolean {
    return (
      this.name === other.name &&
      this.shift === other.shift &&
      this.alt === other.alt &&
      this.ctrl === other.ctrl &&
      this.cmd === other.cmd
    );
  }
}

/**
 * Configuration type mapping commands to their key bindings
 */
export type KeyBindingConfig = Map<Command, readonly KeyBinding[]>;

export const DEFAULT_TEXT_PASTE_KEY_PATTERNS = [
  'ctrl+v',
  'cmd+v',
] as const;
export const DEFAULT_IMAGE_PASTE_KEY_PATTERNS = ['alt+v'] as const;

/**
 * Native Windows terminals own regular text paste. Keeping Ctrl+V out of the
 * application-level defaults lets the terminal emit one bracketed-paste
 * transaction instead of making the CLI launch a clipboard subprocess.
 */
export function getDefaultTextPasteKeyPatterns(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === 'win32' ? [] : DEFAULT_TEXT_PASTE_KEY_PATTERNS;
}

/**
 * Default key binding configuration
 * Matches the original hard-coded logic exactly
 */
export const defaultKeyBindingConfig: KeyBindingConfig = new Map([
  // Basic Controls
  [Command.RETURN, [new KeyBinding('enter')]],
  [Command.ESCAPE, [new KeyBinding('escape'), new KeyBinding('ctrl+[')]],
  [Command.QUIT, [new KeyBinding('ctrl+c')]],
  [Command.EXIT, [new KeyBinding('ctrl+d')]],

  // Cursor Movement
  [Command.HOME, [new KeyBinding('ctrl+a'), new KeyBinding('home')]],
  [Command.END, [new KeyBinding('ctrl+e'), new KeyBinding('end')]],
  [Command.MOVE_UP, [new KeyBinding('up')]],
  [Command.MOVE_DOWN, [new KeyBinding('down')]],
  [Command.MOVE_LEFT, [new KeyBinding('left'), new KeyBinding('ctrl+b')]],
  [Command.MOVE_RIGHT, [new KeyBinding('right'), new KeyBinding('ctrl+f')]],
  [
    Command.MOVE_WORD_LEFT,
    [
      new KeyBinding('ctrl+left'),
      new KeyBinding('alt+left'),
      new KeyBinding('alt+b'),
    ],
  ],
  [
    Command.MOVE_WORD_RIGHT,
    [
      new KeyBinding('ctrl+right'),
      new KeyBinding('alt+right'),
      new KeyBinding('alt+f'),
    ],
  ],

  // Editing
  [Command.KILL_LINE_RIGHT, [new KeyBinding('ctrl+k')]],
  [Command.KILL_LINE_LEFT, [new KeyBinding('ctrl+u')]],
  [Command.CLEAR_INPUT, [new KeyBinding('ctrl+c')]],
  [
    Command.DELETE_WORD_BACKWARD,
    [
      new KeyBinding('ctrl+backspace'),
      new KeyBinding('alt+backspace'),
      new KeyBinding('ctrl+w'),
    ],
  ],
  [
    Command.DELETE_WORD_FORWARD,
    [
      new KeyBinding('ctrl+delete'),
      new KeyBinding('alt+delete'),
      new KeyBinding('alt+d'),
    ],
  ],
  [
    Command.DELETE_CHAR_LEFT,
    [new KeyBinding('backspace'), new KeyBinding('ctrl+h')],
  ],
  [
    Command.DELETE_CHAR_RIGHT,
    [new KeyBinding('delete'), new KeyBinding('ctrl+d')],
  ],
  [
    Command.UNDO,
    [
      new KeyBinding('ctrl+_'),
      new KeyBinding('ctrl+shift+-'),
      new KeyBinding('alt+z'),
      new KeyBinding('cmd+z'),
    ],
  ],
  [
    Command.REDO,
    [
      new KeyBinding('ctrl+shift+z'),
      new KeyBinding('cmd+shift+z'),
      new KeyBinding('alt+shift+z'),
    ],
  ],

  // Scrolling
  [Command.SCROLL_UP, [new KeyBinding('shift+up')]],
  [Command.SCROLL_DOWN, [new KeyBinding('shift+down')]],
  [
    Command.SCROLL_HOME,
    [new KeyBinding('ctrl+home'), new KeyBinding('shift+home')],
  ],
  [
    Command.SCROLL_END,
    [new KeyBinding('ctrl+end'), new KeyBinding('shift+end')],
  ],
  [Command.PAGE_UP, [new KeyBinding('pageup')]],
  [Command.PAGE_DOWN, [new KeyBinding('pagedown')]],

  // History & Search
  [Command.HISTORY_UP, [new KeyBinding('ctrl+p')]],
  [Command.HISTORY_DOWN, [new KeyBinding('ctrl+n')]],
  [Command.REVERSE_SEARCH, [new KeyBinding('ctrl+r')]],
  [Command.SUBMIT_REVERSE_SEARCH, [new KeyBinding('enter')]],
  [Command.ACCEPT_SUGGESTION_REVERSE_SEARCH, [new KeyBinding('tab')]],

  // Navigation
  [Command.NAVIGATION_UP, [new KeyBinding('up')]],
  [Command.NAVIGATION_DOWN, [new KeyBinding('down')]],
  // Navigation shortcuts for dialogs. Only arrow keys — j/k vim-style bindings
  // were removed because they conflict with search TextInput in every dialog
  // that uses SettingsListPanel or BaseSelectionList alongside a search box.
  [Command.DIALOG_NAVIGATION_UP, [new KeyBinding('up')]],
  [Command.DIALOG_NAVIGATION_DOWN, [new KeyBinding('down')]],
  [Command.DIALOG_NEXT, [new KeyBinding('tab')]],
  [Command.DIALOG_PREV, [new KeyBinding(SHIFT_TAB_KEY)]],
  [Command.ASK_USER_ADD_NOTES, [new KeyBinding('n')]],
  [Command.ASK_USER_TOGGLE_OPTION, [new KeyBinding('space')]],
  [Command.ASK_USER_SUBMIT_SELECTION, [new KeyBinding('ctrl+enter')]],
  [Command.SITES_ENVIRONMENT, [new KeyBinding('e')]],
  [Command.SITES_ADD_SECRET, [new KeyBinding('a')]],
  [Command.SITES_OPEN, [new KeyBinding('o')]],
  [Command.SITES_SAVE, [new KeyBinding('ctrl+s')]],
  [Command.SITES_REFRESH, [new KeyBinding('r')]],
  [Command.SITES_SHARE, [new KeyBinding('s')]],
  [Command.SITES_PUBLISH, [new KeyBinding('p')]],
  [Command.SITES_UNPUBLISH, [new KeyBinding('u')]],
  [Command.SITES_DELETE, [new KeyBinding('d'), new KeyBinding('delete'), new KeyBinding('backspace')]],
  [Command.SITES_REMOVE_TARGET, [new KeyBinding('d')]],
  [Command.MODEL_REFRESH, [new KeyBinding('ctrl+r')]],
  [Command.MODEL_ADD, [new KeyBinding('n')]],
  [Command.MODEL_EDIT, [new KeyBinding('e')]],
  [Command.PROVIDER_CUSTOM, [new KeyBinding('c')]],
  [Command.PROVIDER_PRESETS, [new KeyBinding('p')]],
  [Command.MODEL_DELETE, [new KeyBinding('d')]],
  [Command.SESSION_TOGGLE_PROJECT_SCOPE, [new KeyBinding('ctrl+a')]],
  [Command.SESSION_TOGGLE_BRANCH_SCOPE, [new KeyBinding('ctrl+b')]],
  [
    Command.SESSION_TOGGLE_WORKTREE_SCOPE,
    [new KeyBinding('ctrl+w')],
  ],
  [Command.SESSION_PREVIEW, [new KeyBinding('space')]],
  [
    Command.SESSION_TOGGLE_SHORTCUT_HELP,
    [
      new KeyBinding('?'),
      new KeyBinding('shift+/'),
      new KeyBinding('shift+?'),
    ],
  ],

  // Suggestions & Completions
  [Command.ACCEPT_SUGGESTION, [new KeyBinding('tab'), new KeyBinding('enter')]],
  [Command.COMPLETION_UP, [new KeyBinding('up'), new KeyBinding('ctrl+p')]],
  [Command.COMPLETION_DOWN, [new KeyBinding('down'), new KeyBinding('ctrl+n')]],
  [Command.EXPAND_SUGGESTION, [new KeyBinding('right')]],
  [Command.COLLAPSE_SUGGESTION, [new KeyBinding('left')]],

  // Text Input
  // Must also exclude shift to allow shift+enter for newline
  [Command.SUBMIT, [new KeyBinding('enter')]],
  [Command.QUEUE_MESSAGE, [new KeyBinding('tab')]],
  // Shares ctrl+enter with NEWLINE: InputPrompt checks SEND_NOW first and
  // only while a model turn is responding, so every other state keeps the
  // newline.
  [Command.SEND_NOW, [new KeyBinding('ctrl+enter')]],
  [
    Command.NEWLINE,
    [
      new KeyBinding('ctrl+enter'),
      new KeyBinding('cmd+enter'),
      new KeyBinding('alt+enter'),
      new KeyBinding('shift+enter'),
      new KeyBinding('ctrl+j'),
    ],
  ],
  [Command.OPEN_EXTERNAL_EDITOR, [new KeyBinding('ctrl+x')]],
  [
    Command.PASTE_CLIPBOARD,
    getDefaultTextPasteKeyPatterns().map(
      (pattern) => new KeyBinding(pattern),
    ),
  ],
  [
    Command.PASTE_CLIPBOARD_IMAGE,
    DEFAULT_IMAGE_PASTE_KEY_PATTERNS.map(
      (pattern) => new KeyBinding(pattern),
    ),
  ],
  [Command.STASH_PROMPT, [new KeyBinding('ctrl+s')]],
  [Command.WORKFLOW_KEYWORD_TOGGLE, [new KeyBinding('alt+w')]],
  [Command.WORKFLOW_AGENT_SKIP, [new KeyBinding('x')]],

  // App Controls
  [Command.SHOW_ERROR_DETAILS, [new KeyBinding('f12')]],
  [Command.SHOW_FULL_TODOS, [new KeyBinding('ctrl+t')]],
  [Command.TOGGLE_MARKDOWN, [new KeyBinding('alt+m')]],
  [Command.TOGGLE_YOLO, [new KeyBinding('ctrl+y')]],
  [Command.CYCLE_PERMISSION_MODE, [new KeyBinding(SHIFT_TAB_KEY)]],
  [Command.SHOW_MORE_LINES, [new KeyBinding('ctrl+o')]],
  [Command.EXPAND_PASTE, [new KeyBinding('ctrl+o')]],
  [Command.CLEAR_SCREEN, [new KeyBinding('ctrl+l')]],
  [Command.RESTART_APP, [new KeyBinding('r'), new KeyBinding('shift+r')]],
  [Command.SUSPEND_APP, [new KeyBinding('ctrl+z')]],
  [Command.DUMP_FRAME, [new KeyBinding('f8')]],
  [Command.START_RECORDING, [new KeyBinding('f6')]],
  [Command.STOP_RECORDING, [new KeyBinding('f7')]],
  [Command.DEV_RELAUNCH, [new KeyBinding('f5')]],

  // Background Shell Controls
  [Command.BACKGROUND_SHELL_ESCAPE, [new KeyBinding('escape')]],
  [Command.BACKGROUND_SHELL_SELECT, [new KeyBinding('enter')]],
  [Command.TOGGLE_BACKGROUND_SHELL, [new KeyBinding('ctrl+b')]],
  [Command.TOGGLE_BACKGROUND_SHELL_LIST, [new KeyBinding('ctrl+l')]],
  [Command.KILL_BACKGROUND_SHELL, [new KeyBinding('ctrl+k')]],
  [Command.SHOW_BACKGROUND_SHELL_UNFOCUS_WARNING, [new KeyBinding('tab')]],

  // Extension Controls
  [Command.UPDATE_EXTENSION, [new KeyBinding('i')]],
  [Command.LINK_EXTENSION, [new KeyBinding('l')]],

  // Diff Viewer Controls
  [Command.SWITCH_VIEW, [new KeyBinding('s')]],
]);

interface CommandCategory {
  readonly title: string;
  readonly commands: readonly Command[];
}

/**
 * Presentation metadata for grouping commands in documentation or UI.
 */
export const commandCategories: readonly CommandCategory[] = [
  {
    title: 'Basic Controls',
    commands: [Command.RETURN, Command.ESCAPE, Command.QUIT, Command.EXIT],
  },
  {
    title: 'Cursor Movement',
    commands: [
      Command.HOME,
      Command.END,
      Command.MOVE_UP,
      Command.MOVE_DOWN,
      Command.MOVE_LEFT,
      Command.MOVE_RIGHT,
      Command.MOVE_WORD_LEFT,
      Command.MOVE_WORD_RIGHT,
    ],
  },
  {
    title: 'Editing',
    commands: [
      Command.KILL_LINE_RIGHT,
      Command.KILL_LINE_LEFT,
      Command.CLEAR_INPUT,
      Command.DELETE_WORD_BACKWARD,
      Command.DELETE_WORD_FORWARD,
      Command.DELETE_CHAR_LEFT,
      Command.DELETE_CHAR_RIGHT,
      Command.UNDO,
      Command.REDO,
    ],
  },
  {
    title: 'Scrolling',
    commands: [
      Command.SCROLL_UP,
      Command.SCROLL_DOWN,
      Command.SCROLL_HOME,
      Command.SCROLL_END,
      Command.PAGE_UP,
      Command.PAGE_DOWN,
    ],
  },
  {
    title: 'History & Search',
    commands: [
      Command.HISTORY_UP,
      Command.HISTORY_DOWN,
      Command.REVERSE_SEARCH,
      Command.SUBMIT_REVERSE_SEARCH,
      Command.ACCEPT_SUGGESTION_REVERSE_SEARCH,
    ],
  },
  {
    title: 'Navigation',
    commands: [
      Command.NAVIGATION_UP,
      Command.NAVIGATION_DOWN,
      Command.DIALOG_NAVIGATION_UP,
      Command.DIALOG_NAVIGATION_DOWN,
      Command.DIALOG_NEXT,
      Command.DIALOG_PREV,
      Command.ASK_USER_ADD_NOTES,
      Command.ASK_USER_TOGGLE_OPTION,
      Command.ASK_USER_SUBMIT_SELECTION,
      Command.SITES_ENVIRONMENT,
      Command.SITES_ADD_SECRET,
      Command.SITES_OPEN,
      Command.SITES_SAVE,
      Command.SITES_REFRESH,
      Command.SITES_SHARE,
      Command.SITES_PUBLISH,
      Command.SITES_UNPUBLISH,
      Command.SITES_DELETE,
      Command.SITES_REMOVE_TARGET,
      Command.MODEL_REFRESH,
      Command.MODEL_ADD,
      Command.MODEL_EDIT,
      Command.PROVIDER_CUSTOM,
      Command.PROVIDER_PRESETS,
      Command.MODEL_DELETE,
      Command.SESSION_TOGGLE_PROJECT_SCOPE,
      Command.SESSION_TOGGLE_BRANCH_SCOPE,
      Command.SESSION_TOGGLE_WORKTREE_SCOPE,
      Command.SESSION_PREVIEW,
      Command.SESSION_TOGGLE_SHORTCUT_HELP,
    ],
  },
  {
    title: 'Suggestions & Completions',
    commands: [
      Command.ACCEPT_SUGGESTION,
      Command.COMPLETION_UP,
      Command.COMPLETION_DOWN,
      Command.EXPAND_SUGGESTION,
      Command.COLLAPSE_SUGGESTION,
    ],
  },
  {
    title: 'Text Input',
    commands: [
      Command.SUBMIT,
      Command.QUEUE_MESSAGE,
      Command.SEND_NOW,
      Command.NEWLINE,
      Command.OPEN_EXTERNAL_EDITOR,
      Command.PASTE_CLIPBOARD,
      Command.PASTE_CLIPBOARD_IMAGE,
      Command.STASH_PROMPT,
      Command.WORKFLOW_KEYWORD_TOGGLE,
    ],
  },
  {
    title: 'Workflow Controls',
    commands: [Command.WORKFLOW_AGENT_SKIP],
  },
  {
    title: 'App Controls',
    commands: [
      Command.SHOW_ERROR_DETAILS,
      Command.SHOW_FULL_TODOS,
      Command.TOGGLE_MARKDOWN,
      Command.TOGGLE_YOLO,
      Command.CYCLE_PERMISSION_MODE,
      Command.SHOW_MORE_LINES,
      Command.EXPAND_PASTE,
      Command.CLEAR_SCREEN,
      Command.RESTART_APP,
      Command.SUSPEND_APP,
    ],
  },
  {
    title: 'Background Shell Controls',
    commands: [
      Command.BACKGROUND_SHELL_ESCAPE,
      Command.BACKGROUND_SHELL_SELECT,
      Command.TOGGLE_BACKGROUND_SHELL,
      Command.TOGGLE_BACKGROUND_SHELL_LIST,
      Command.KILL_BACKGROUND_SHELL,
      Command.SHOW_BACKGROUND_SHELL_UNFOCUS_WARNING,
      Command.DUMP_FRAME,
      Command.START_RECORDING,
      Command.STOP_RECORDING,
      Command.DEV_RELAUNCH,
    ],
  },
  {
    title: 'Extension Controls',
    commands: [Command.UPDATE_EXTENSION, Command.LINK_EXTENSION],
  },
  {
    title: 'Diff Viewer Controls',
    commands: [Command.SWITCH_VIEW],
  },
];

/**
 * Human-readable descriptions for each command.
 */
export const commandDescriptions: Readonly<Record<Command, string>> = {
  // Basic Controls
  [Command.RETURN]: 'Confirm the current selection or choice.',
  [Command.ESCAPE]: 'Dismiss dialogs or cancel the current focus.',
  [Command.QUIT]:
    'Cancel the current request or quit the CLI when input is empty.',
  [Command.EXIT]: 'Exit the CLI when the input buffer is empty.',

  // Cursor Movement
  [Command.HOME]: 'Move the cursor to the start of the line.',
  [Command.END]: 'Move the cursor to the end of the line.',
  [Command.MOVE_UP]: 'Move the cursor up one line.',
  [Command.MOVE_DOWN]: 'Move the cursor down one line.',
  [Command.MOVE_LEFT]: 'Move the cursor one character to the left.',
  [Command.MOVE_RIGHT]: 'Move the cursor one character to the right.',
  [Command.MOVE_WORD_LEFT]: 'Move the cursor one word to the left.',
  [Command.MOVE_WORD_RIGHT]: 'Move the cursor one word to the right.',

  // Editing
  [Command.KILL_LINE_RIGHT]: 'Delete from the cursor to the end of the line.',
  [Command.KILL_LINE_LEFT]: 'Delete from the cursor to the start of the line.',
  [Command.CLEAR_INPUT]: 'Clear all text in the input field.',
  [Command.DELETE_WORD_BACKWARD]: 'Delete the previous word.',
  [Command.DELETE_WORD_FORWARD]: 'Delete the next word.',
  [Command.DELETE_CHAR_LEFT]: 'Delete the character to the left.',
  [Command.DELETE_CHAR_RIGHT]: 'Delete the character to the right.',
  [Command.UNDO]: 'Undo the most recent text edit.',
  [Command.REDO]: 'Redo the most recent undone text edit.',

  // Scrolling
  [Command.SCROLL_UP]: 'Scroll content up.',
  [Command.SCROLL_DOWN]: 'Scroll content down.',
  [Command.SCROLL_HOME]: 'Scroll to the top.',
  [Command.SCROLL_END]: 'Scroll to the bottom.',
  [Command.PAGE_UP]: 'Scroll up by one page.',
  [Command.PAGE_DOWN]: 'Scroll down by one page.',

  // History & Search
  [Command.HISTORY_UP]: 'Show the previous entry in history.',
  [Command.HISTORY_DOWN]: 'Show the next entry in history.',
  [Command.REVERSE_SEARCH]: 'Start reverse search through history.',
  [Command.SUBMIT_REVERSE_SEARCH]: 'Submit the selected reverse-search match.',
  [Command.ACCEPT_SUGGESTION_REVERSE_SEARCH]:
    'Accept a suggestion while reverse searching.',

  // Navigation
  [Command.NAVIGATION_UP]: 'Move selection up in lists.',
  [Command.NAVIGATION_DOWN]: 'Move selection down in lists.',
  [Command.DIALOG_NAVIGATION_UP]:
    'Move up within dialog options (arrow-up only).',
  [Command.DIALOG_NAVIGATION_DOWN]:
    'Move down within dialog options (arrow-down only).',
  [Command.DIALOG_NEXT]: 'Move to the next item or question in a dialog.',
  [Command.DIALOG_PREV]: 'Move to the previous item or question in a dialog.',
  [Command.ASK_USER_ADD_NOTES]: 'Add notes to an AskUser preview.',
  [Command.ASK_USER_TOGGLE_OPTION]: 'Toggle an AskUser multi-select option.',
  [Command.ASK_USER_SUBMIT_SELECTION]:
    'Continue an AskUser multi-select question.',
  [Command.SITES_ENVIRONMENT]: 'Manage site environment variables.',
  [Command.SITES_ADD_SECRET]: 'Add a site environment variable.',
  [Command.SITES_OPEN]: 'Open the published site in the browser.',
  [Command.SITES_SAVE]: 'Save the current Sites sharing draft.',
  [Command.SITES_REFRESH]: 'Refresh Sites data or check an operation.',
  [Command.SITES_SHARE]: 'Open Sites sharing settings.',
  [Command.SITES_PUBLISH]: 'Publish an uploaded Sites deployment.',
  [Command.SITES_UNPUBLISH]: 'Unpublish the current site.',
  [Command.SITES_DELETE]: 'Confirm project deletion.',
  [Command.SITES_REMOVE_TARGET]: 'Remove the focused email from the sharing draft.',
  [Command.MODEL_REFRESH]:
    'Refresh models and account data in the model dialog.',
  [Command.PROVIDER_CUSTOM]: 'Jump to custom providers in the provider picker.',
  [Command.PROVIDER_PRESETS]:
    'Jump to platform presets in the provider picker.',
  [Command.MODEL_EDIT]: 'Edit the focused local custom model configuration.',
  [Command.MODEL_ADD]: 'Add a custom model from the Custom model list.',
  [Command.MODEL_DELETE]: 'Delete the focused custom model configuration.',
  [Command.SESSION_TOGGLE_PROJECT_SCOPE]:
    'Toggle between current-repository and all-project session scopes.',
  [Command.SESSION_TOGGLE_BRANCH_SCOPE]:
    'Toggle between current-branch and all-branches session scopes.',
  [Command.SESSION_TOGGLE_WORKTREE_SCOPE]:
    'Toggle between current-worktree and all-worktrees session scopes.',
  [Command.SESSION_PREVIEW]: 'Preview the selected session transcript.',
  [Command.SESSION_TOGGLE_SHORTCUT_HELP]:
    'Show or hide additional session browser shortcuts.',

  // Suggestions & Completions
  [Command.ACCEPT_SUGGESTION]: 'Accept the inline suggestion.',
  [Command.COMPLETION_UP]: 'Move to the previous completion option.',
  [Command.COMPLETION_DOWN]: 'Move to the next completion option.',
  [Command.EXPAND_SUGGESTION]: 'Expand an inline suggestion.',
  [Command.COLLAPSE_SUGGESTION]: 'Collapse an inline suggestion.',

  // Text Input
  [Command.SUBMIT]: 'Submit the current prompt.',
  [Command.QUEUE_MESSAGE]:
    'Queue the current prompt to be processed after the current task finishes.',
  [Command.SEND_NOW]:
    'While the model is responding: queue the current prompt, interrupt the turn, and send everything queued right away. Inserts a newline otherwise.',
  [Command.NEWLINE]: 'Insert a newline without submitting.',
  [Command.OPEN_EXTERNAL_EDITOR]:
    'Open the current prompt or the plan in an external editor.',
  [Command.PASTE_CLIPBOARD]: 'Paste from the clipboard.',
  [Command.PASTE_CLIPBOARD_IMAGE]: 'Paste an image from the clipboard.',
  [Command.STASH_PROMPT]:
    'Stash the current prompt and clear the input; press again on an empty input to bring it back. A stashed draft also returns automatically after the next message or command.',
  [Command.WORKFLOW_KEYWORD_TOGGLE]:
    'Toggle whether the UltraCode keyword opts the current prompt into dynamic workflow orchestration.',
  [Command.WORKFLOW_AGENT_SKIP]:
    'Stop the selected workflow agent and continue the workflow with a skipped result.',

  // App Controls
  [Command.SHOW_ERROR_DETAILS]: 'Toggle detailed error information.',
  [Command.SHOW_FULL_TODOS]: 'Toggle the full TODO list.',
  [Command.TOGGLE_MARKDOWN]: 'Toggle Markdown rendering.',
  [Command.TOGGLE_YOLO]: 'Toggle YOLO mode for tool calls.',
  [Command.CYCLE_PERMISSION_MODE]:
    'Cycle through permission modes: default (prompt), acceptEdits (auto-approve edits), and plan (read-only). Plan mode is skipped when the agent is busy.',
  [Command.SHOW_MORE_LINES]:
    'Expand and collapse blocks of content when not in alternate buffer mode.',
  [Command.EXPAND_PASTE]:
    'Expand or collapse a paste placeholder when cursor is over placeholder.',
  [Command.CLEAR_SCREEN]: 'Clear the terminal screen and redraw the UI.',
  [Command.RESTART_APP]: 'Restart the application.',
  [Command.SUSPEND_APP]: 'Suspend the CLI and move it to the background.',

  // Background Shell Controls
  [Command.BACKGROUND_SHELL_ESCAPE]: 'Dismiss background shell list.',
  [Command.BACKGROUND_SHELL_SELECT]:
    'Confirm selection in background shell list.',
  [Command.TOGGLE_BACKGROUND_SHELL]:
    'Move foreground executions to the background.',
  [Command.TOGGLE_BACKGROUND_SHELL_LIST]: 'Toggle background shell list.',
  [Command.KILL_BACKGROUND_SHELL]: 'Kill the active background shell.',
  [Command.SHOW_BACKGROUND_SHELL_UNFOCUS_WARNING]:
    'Show warning when trying to move focus away from background shell.',

  // Extension Controls
  [Command.UPDATE_EXTENSION]: 'Update the current extension if available.',
  [Command.LINK_EXTENSION]: 'Link the current extension to a local path.',

  [Command.DUMP_FRAME]: 'Dump the current frame as a snapshot.',
  [Command.START_RECORDING]: 'Start recording the session.',
  [Command.STOP_RECORDING]: 'Stop recording the session.',
  [Command.DEV_RELAUNCH]:
    'Relaunch the CLI in place (dev builds only, requires DEV=true).',

  // Diff Viewer Controls
  [Command.SWITCH_VIEW]: 'Switch between git and turn diff views.',
};

import { KEYBOARD_CONTEXTS } from '../contexts/KeyboardContextRegistry.js';
import type { KeyboardContextName } from '../contexts/KeyboardContextRegistry.js';

const keybindingsSchema = z.array(
  z
    .object({
      command: z.string().transform((val, ctx) => {
        const negate = val.startsWith('-');
        const commandId = negate ? val.slice(1) : val;

        const result = z.nativeEnum(Command).safeParse(commandId);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid command: "${val}".`,
          });
          return z.NEVER;
        }

        return {
          command: result.data,
          negate,
        };
      }),
      key: z.string(),
      // Phase 0.4: Optional context field for context-aware keybindings
      context: z.enum(KEYBOARD_CONTEXTS).optional(),
    })
    .transform((val) => ({
      commandEntry: val.command,
      key: val.key,
      context: val.context,
    })),
);

import type { ContextBindingBlock } from './contextBindings.js';

/**
 * Loads custom keybindings from the user's keybindings.json file.
 * Keybindings are merged with the default bindings.
 *
 * Entries with a `context` field are collected into `contextOverrides` for
 * the new context routing system. Entries without `context` follow the
 * legacy two-tuple path.
 */
export async function loadCustomKeybindings(): Promise<{
  config: KeyBindingConfig;
  contextOverrides: ContextBindingBlock[];
  errors: string[];
}> {
  const errors: string[] = [];
  let config = defaultKeyBindingConfig;
  const contextOverrides: ContextBindingBlock[] = [];
  // Accumulate context-aware bindings grouped by context name
  const contextBindingsMap = new Map<
    KeyboardContextName,
    Record<string, string | null>
  >();

  const userKeybindingsPath = Storage.getUserKeybindingsPath();

  try {
    const content = await fs.readFile(userKeybindingsPath, 'utf8');
    const parsedJson = parseIgnoringComments(content);
    const result = keybindingsSchema.safeParse(parsedJson);

    if (result.success) {
      config = new Map(defaultKeyBindingConfig);
      for (const { commandEntry, key, context } of result.data) {
        const { command, negate } = commandEntry;

        // Phase 0.4: Context-aware entries go to the new system
        if (context) {
          let bindings = contextBindingsMap.get(context);
          if (!bindings) {
            bindings = {};
            contextBindingsMap.set(context, bindings);
          }
          // Map command enum value to action name (dot → colon)
          // e.g. 'input.submit' → 'input:submit'
          const actionName = negate ? null : command.replace(/\./g, ':');
          bindings[key] = actionName;
          continue; // Don't apply to legacy config
        }

        // Legacy two-tuple path (no context)
        const currentBindings = config.get(command) ?? [];

        try {
          const keyBinding = new KeyBinding(key);

          if (negate) {
            const updatedBindings = currentBindings.filter(
              (b) => !b.equals(keyBinding),
            );
            if (updatedBindings.length === currentBindings.length) {
              throw new Error(`cannot remove "${key}" since it is not bound`);
            }
            config.set(command, updatedBindings);
          } else {
            // Add new binding (prepend so it's the primary one shown in UI)
            config.set(command, [keyBinding, ...currentBindings]);
          }
        } catch (e) {
          errors.push(
            `Invalid keybinding for command "${negate ? '-' : ''}${command}": ${e}`,
          );
        }
      }
    } else {
      errors.push(
        ...result.error.issues.map(
          (issue) =>
            `Keybindings file "${userKeybindingsPath}" error at ${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      // File doesn't exist, use default bindings
    } else {
      errors.push(
        `Error reading keybindings file "${userKeybindingsPath}": ${error}`,
      );
    }
  }

  // Convert accumulated context bindings to ContextBindingBlock array
  for (const [ctx, bindings] of contextBindingsMap) {
    contextOverrides.push({ context: ctx, bindings });
  }

  return { config, contextOverrides, errors };
}
