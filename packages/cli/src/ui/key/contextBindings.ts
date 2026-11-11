/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context-aware key binding declarations.
 *
 * Defines the three-tuple `{context, key, action}` binding format.
 * Each ContextBindingBlock declares bindings for a single context.
 */

import type { KeyboardContextName } from '../contexts/KeyboardContextRegistry.js';
import {
  DEFAULT_IMAGE_PASTE_KEY_PATTERNS,
  getDefaultTextPasteKeyPatterns,
  KeyBinding,
} from './keyBindings.js';
import type { Key } from '../contexts/KeypressContext.js';
import { SHIFT_TAB_KEY } from '../constants/shortcuts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A block of bindings for a single context.
 * Keys are key patterns (e.g. 'ctrl+c'), values are action names (e.g. 'app:interrupt').
 * A null value explicitly unbinds a key in this context.
 */
export interface ContextBindingBlock {
  context: KeyboardContextName;
  penetrate?: boolean; // If true, bindings in this context are never shadowed
  bindings: Record<string, string | null>;
}

/**
 * A single parsed binding ready for matching.
 */
export interface ParsedContextBinding {
  context: KeyboardContextName;
  keyBinding: KeyBinding;
  action: string;
  penetrate: boolean;
}

// ---------------------------------------------------------------------------
// Default context bindings
// ---------------------------------------------------------------------------

function createActionBindings(
  keyPatterns: readonly string[],
  action: string,
): Record<string, string> {
  return Object.fromEntries(
    keyPatterns.map((keyPattern) => [keyPattern, action]),
  );
}

const defaultTextPasteActionBindings = createActionBindings(
  getDefaultTextPasteKeyPatterns(),
  'input:paste',
);
const defaultImagePasteActionBindings = createActionBindings(
  DEFAULT_IMAGE_PASTE_KEY_PATTERNS,
  'input:pasteImage',
);

/**
 * Default context bindings organized by context. This is the single source
 * of truth for the context routing system.
 */
export const defaultContextBindings: ContextBindingBlock[] = [
  // ----- Layer 1: Global (always active, penetrates) -----
  // NOTE: ctrl+c is intentionally NOT in the penetrating block.
  // It's in the non-penetrating Global block below so that higher-priority
  // contexts (e.g. Chat:edit:clear, HistorySearch:history:search:cancel)
  // can handle Ctrl+C first and return false to bubble to the legacy quit
  // handler, which preserves the dual-handler flow:
  //   InputPrompt clears text + resets completion → AppContainer counts presses.
  {
    context: 'Global',
    penetrate: true,
    bindings: {
      'ctrl+d': 'app:exit',
      'ctrl+z': 'app:suspend',
      f12: 'app:showErrorDetails',
      'ctrl+t': 'app:toggleTodos',
      'alt+m': 'app:toggleMarkdown',
      'ctrl+o': 'app:showMoreLines',
      f8: 'app:dumpFrame',
      f5: 'dev:relaunch',
    },
  },
  // Non-penetrating Global bindings — checked LAST, after all context-specific
  // bindings. This allows escape/ctrl+c to be overridden by Dialog, Chat, etc.
  {
    context: 'Global',
    penetrate: false,
    bindings: {
      'ctrl+c': 'app:interrupt',
      escape: 'app:escape',
      [SHIFT_TAB_KEY]: 'app:cyclePermissionMode',
      'ctrl+y': 'app:toggleYolo',
    },
  },

  // ----- Layer 2: Main views -----
  {
    context: 'Chat',
    bindings: {
      // Escape — Chat owns ESC so double-press rewind works.
      // When the handler returns false (e.g. during streaming), the dispatch
      // cascades to Global's app:escape for stream cancellation.
      escape: 'chat:escape',
      // Text Input
      enter: 'input:submit',
      'ctrl+enter': 'input:newline',
      'cmd+enter': 'input:newline',
      'alt+enter': 'input:newline',
      'shift+enter': 'input:newline',
      'ctrl+j': 'input:newline',
      tab: 'input:queueMessage',
      ...defaultTextPasteActionBindings,
      ...defaultImagePasteActionBindings,
      'ctrl+x': 'input:openExternalEditor',
      // Stash. Raw mode disables IXON, so ctrl+s never reaches flow control.
      'ctrl+s': 'input:stash',
      'alt+w': 'chat:workflowKeywordToggle',
      // History
      'ctrl+p': 'history:previous',
      'ctrl+n': 'history:next',
      'ctrl+r': 'history:search:start',
      // Shell focus
      'ctrl+b': 'app:toggleBackgroundShell',
      'ctrl+l': 'app:toggleBackgroundShellList',
      // Editing
      backspace: 'edit:deleteLeft',
      'ctrl+h': 'edit:deleteLeft',
      delete: 'edit:deleteRight',
      // NOTE: ctrl+d is NOT bound here. Global penetrating binds ctrl+d → app:exit
      // (exits when buffer empty, returns false when buffer has text).
      // When app:exit returns false, the Chat fallback (handleInput → buffer.handleInput)
      // handles ctrl+d as DELETE_CHAR_RIGHT. No explicit Chat binding needed.
      'ctrl+k': 'edit:deleteRightAll',
      'ctrl+u': 'edit:deleteLeftAll',
      'ctrl+w': 'edit:deleteWordLeft',
      'ctrl+backspace': 'edit:deleteWordLeft',
      'alt+backspace': 'edit:deleteWordLeft',
      'ctrl+delete': 'edit:deleteWordRight',
      'alt+delete': 'edit:deleteWordRight',
      'alt+d': 'edit:deleteWordRight',
      'ctrl+c': 'edit:clear',
      // Cursor
      'ctrl+a': 'cursor:home',
      home: 'cursor:home',
      'ctrl+e': 'cursor:end',
      end: 'cursor:end',
      up: 'cursor:up',
      down: 'cursor:down',
      left: 'cursor:left',
      right: 'cursor:right',
      'ctrl+f': 'cursor:right',
      'ctrl+left': 'cursor:wordLeft',
      'alt+left': 'cursor:wordLeft',
      'alt+b': 'cursor:wordLeft',
      'ctrl+right': 'cursor:wordRight',
      'alt+right': 'cursor:wordRight',
      'alt+f': 'cursor:wordRight',
      // Undo/Redo
      'cmd+z': 'edit:undo',
      'alt+z': 'edit:undo',
      'ctrl+shift+z': 'edit:redo',
      'cmd+shift+z': 'edit:redo',
      'alt+shift+z': 'edit:redo',
      // Scrolling
      'shift+up': 'scroll:up',
      'shift+down': 'scroll:down',
      'ctrl+home': 'scroll:home',
      'shift+home': 'scroll:home',
      'ctrl+end': 'scroll:end',
      'shift+end': 'scroll:end',
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
    },
  },

  // ----- Layer 3: Overlay modes -----
  {
    context: 'Autocomplete',
    bindings: {
      tab: 'suggest:accept',
      enter: 'suggest:accept',
      up: 'suggest:focusPrevious',
      'ctrl+p': 'suggest:focusPrevious',
      down: 'suggest:focusNext',
      'ctrl+n': 'suggest:focusNext',
      right: 'suggest:expand',
      left: 'suggest:collapse',
      escape: 'basic:cancel',
    },
  },

  {
    context: 'AgentRail',
    bindings: {
      up: 'agentRail:up',
      down: 'agentRail:down',
      enter: 'agentRail:select',
      escape: 'agentRail:escape',
    },
  },

  {
    context: 'HistorySearch',
    bindings: {
      'ctrl+r': 'history:search:next',
      tab: 'history:search:accept',
      escape: 'history:search:accept',
      enter: 'history:search:submit',
      'ctrl+c': 'history:search:cancel',
    },
  },

  {
    context: 'CommandSearch',
    bindings: {
      up: 'suggest:focusPrevious',
      down: 'suggest:focusNext',
      tab: 'suggest:accept',
      enter: 'suggest:accept',
      escape: 'basic:cancel',
    },
  },

  {
    context: 'VimNormal',
    bindings: {
      // Motions
      h: 'vim:motion:h',
      j: 'vim:motion:j',
      k: 'vim:motion:k',
      l: 'vim:motion:l',
      w: 'vim:motion:w',
      b: 'vim:motion:b',
      e: 'vim:motion:e',
      '0': 'vim:motion:lineStart',
      $: 'vim:motion:lineEnd',
      // Operators
      d: 'vim:operator:d',
      c: 'vim:operator:c',
      y: 'vim:operator:y',
      x: 'vim:operator:x',
      // Enter INSERT
      i: 'vim:enterInsert:i',
      a: 'vim:enterInsert:a',
      'shift+a': 'vim:enterInsert:A',
      'shift+i': 'vim:enterInsert:I',
      o: 'vim:enterInsert:o',
      'shift+o': 'vim:enterInsert:O',
      // Other
      '/': 'vim:search',
      u: 'vim:undo',
      'ctrl+r': 'vim:redo',
    },
  },

  // ----- Layer 4: Modal overlays -----
  {
    context: 'Dialog',
    bindings: {
      escape: 'dialog:escape',
      enter: 'dialog:confirm',
      up: 'dialog:navigate:up',
      down: 'dialog:navigate:down',
      tab: 'dialog:tab:next',
      [SHIFT_TAB_KEY]: 'dialog:tab:previous',
      left: 'dialog:navigate:left',
      right: 'dialog:navigate:right',
      'ctrl+r': 'model:refresh',
      // Opens the filter in lists that keep their search box unfocused until
      // asked (SettingsListPanel's `searchTrigger: 'slash'`). Lists whose
      // search box is always focused never see it — their text input consumes
      // the key first, and their panel declines the action.
      '/': 'dialog:search',
      // Inline editing
      backspace: 'edit:deleteLeft',
      delete: 'edit:deleteRight',
      'ctrl+h': 'edit:deleteLeft',
      'ctrl+l': 'dialog:clearItem',
      home: 'cursor:home',
      end: 'cursor:end',
      'ctrl+a': 'cursor:home',
      'ctrl+e': 'cursor:end',
      'ctrl+k': 'edit:deleteRightAll',
      'ctrl+u': 'edit:deleteLeftAll',
      'ctrl+w': 'edit:deleteWordLeft',
      // Paste
      ...defaultTextPasteActionBindings,
      ...defaultImagePasteActionBindings,
      // Scrolling
      'shift+up': 'scroll:up',
      'shift+down': 'scroll:down',
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
      // External editor (used by ExitPlanModeDialog)
      'ctrl+x': 'input:openExternalEditor',
    },
  },

  {
    context: 'Fullscreen',
    bindings: {
      escape: 'fullscreen:dismiss',
      q: 'fullscreen:dismiss',
      up: 'dialog:navigate:up',
      down: 'dialog:navigate:down',
      // Scrolling
      'shift+up': 'scroll:up',
      'shift+down': 'scroll:down',
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
    },
  },

  // ----- Layer 5: Shared primitives -----
  {
    context: 'Select',
    bindings: {
      up: 'select:previous',
      'ctrl+p': 'select:previous',
      down: 'select:next',
      'ctrl+n': 'select:next',
      enter: 'select:accept',
      escape: 'select:cancel',
      // NOTE: j/k intentionally removed — they conflict with search/text input
      // in dialogs that combine Select with a search box.
    },
  },

  {
    context: 'Tabs',
    bindings: {
      tab: 'tabs:next',
      right: 'tabs:next',
      [SHIFT_TAB_KEY]: 'tabs:previous',
      left: 'tabs:previous',
    },
  },

  {
    context: 'Confirmation',
    bindings: {
      y: 'confirm:yes',
      enter: 'confirm:yes',
      n: 'confirm:no',
      escape: 'confirm:no',
      up: 'confirm:navigate:up',
      down: 'confirm:navigate:down',
    },
  },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse ContextBindingBlock[] into a flat array of ParsedContextBinding.
 * Each block's key patterns are parsed into KeyBinding instances for matching.
 *
 * Null-valued bindings are skipped (they represent explicit unbinds, used
 * in user overrides to remove a default binding).
 */
export function parseContextBindings(
  blocks: ContextBindingBlock[],
): ParsedContextBinding[] {
  const result: ParsedContextBinding[] = [];

  for (const block of blocks) {
    const { context, penetrate = false, bindings } = block;

    for (const [keyPattern, action] of Object.entries(bindings)) {
      if (action === null) continue; // Explicit unbind

      try {
        const keyBinding = new KeyBinding(keyPattern);
        result.push({
          context,
          keyBinding,
          action,
          penetrate,
        });
      } catch {
        // Invalid key pattern — skip silently (will be reported in loadCustomKeybindings)
      }
    }
  }

  return result;
}

/**
 * Pre-parsed default bindings, ready for use by ContextResolver.
 */
export const defaultParsedBindings: ParsedContextBinding[] =
  parseContextBindings(defaultContextBindings);

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Index parsed bindings by context for efficient lookup.
 */
export function indexBindingsByContext(
  bindings: ParsedContextBinding[],
): Map<KeyboardContextName, ParsedContextBinding[]> {
  const index = new Map<KeyboardContextName, ParsedContextBinding[]>();

  for (const binding of bindings) {
    let list = index.get(binding.context);
    if (!list) {
      list = [];
      index.set(binding.context, list);
    }
    list.push(binding);
  }

  return index;
}

/**
 * Find the first binding in a list that matches a key event.
 */
export function findMatchingBinding(
  bindings: ParsedContextBinding[],
  key: Key,
): ParsedContextBinding | undefined {
  return bindings.find((b) => b.keyBinding.matches(key));
}
