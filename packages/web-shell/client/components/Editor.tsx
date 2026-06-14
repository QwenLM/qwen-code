import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useCallback,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { EditorView, keymap, placeholder, tooltips } from '@codemirror/view';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { minimalSetup } from 'codemirror';
import type { CommandInfo } from '../adapters/types';
import type { PromptImage } from '../adapters/promptTypes';
import {
  useOptionalWorkspace,
  type UseDaemonFollowupSuggestionReturn,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  slashCompletionSource,
  getImplicitTabCompletion,
  getMissingSlashPrefixCompletion,
  type SkillInfo,
} from '../completions/slashCompletion';
import type { CommandDisplayCategoryOrder } from '../utils/commandDisplay';
import { createAtCompletionSource } from '../completions/atCompletion';
import { useInputHistory } from '../hooks/useInputHistory';
import { useI18n } from '../i18n';
import {
  inputHighlight,
  inputHighlightTheme,
} from '../extensions/inputHighlight';
import { isEditableTarget } from '../utils/dom';
import { PromptChevron } from './PromptChevron';
import styles from './Editor.module.css';

interface EditorProps {
  onSubmit: (text: string, images?: PromptImage[]) => boolean | void;
  onCycleMode?: () => void;
  onToggleShortcuts?: () => void;
  disabled?: boolean;
  placeholderText?: string;
  commands: CommandInfo[];
  skills?: SkillInfo[];
  slashCommandCategoryOrder?: CommandDisplayCategoryOrder;
  queuedMessages?: string[];
  onPopQueuedMessages?: () => string | null;
  onClearQueuedMessages?: () => boolean;
  currentMode?: string;
  draftText?: string;
  draftVersion?: number;
  onFocusFooter?: () => boolean;
  dialogOpen?: boolean;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  onAcceptFollowup?: UseDaemonFollowupSuggestionReturn['onAcceptFollowup'];
  onDismissFollowup?: UseDaemonFollowupSuggestionReturn['onDismissFollowup'];
  sessionName?: string;
}

export interface EditorHandle {
  clearText(): void;
  focus(): void;
  getText(): string;
  insertText(text: string): void;
  retryLast(): void;
}

const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();
const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const LARGE_PASTE_LINE_THRESHOLD = 10;

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function isLargePaste(text: string): boolean {
  return (
    [...text].length > LARGE_PASTE_CHAR_THRESHOLD ||
    text.split('\n').length > LARGE_PASTE_LINE_THRESHOLD
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LargePastePlaceholderResult {
  placeholderText: string;
  nextPasteId: number;
}

export function createLargePastePlaceholder(
  pendingPastes: Map<string, string>,
  nextPasteId: number,
  pasted: string,
): LargePastePlaceholderResult {
  const charCount = [...pasted].length;
  const base = `[Pasted Content ${charCount} chars]`;
  const placeholderText = nextPasteId === 1 ? base : `${base} #${nextPasteId}`;
  pendingPastes.set(placeholderText, pasted);
  return { placeholderText, nextPasteId: nextPasteId + 1 };
}

export function prunePendingPastes(
  pendingPastes: Map<string, string>,
  docText: string,
): number | null {
  for (const placeholderText of pendingPastes.keys()) {
    if (!docText.includes(placeholderText)) {
      pendingPastes.delete(placeholderText);
    }
  }
  return pendingPastes.size === 0 ? 1 : null;
}

export function expandLargePastePlaceholders(
  pendingPastes: Map<string, string>,
  text: string,
): string {
  if (pendingPastes.size === 0) return text;
  const placeholders = [...pendingPastes.keys()].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = new RegExp(placeholders.map(escapeRegExp).join('|'), 'g');
  return text.replace(
    pattern,
    (placeholderText) => pendingPastes.get(placeholderText) ?? placeholderText,
  );
}

function getModeClass(mode: string, shellMode: boolean): string {
  if (shellMode) return '';
  switch (mode) {
    case 'plan':
      return styles.modePlan;
    case 'auto-edit':
      return styles.modeAutoEdit;
    case 'yolo':
      return styles.modeYolo;
    default:
      return '';
  }
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  {
    onSubmit,
    onCycleMode,
    onToggleShortcuts,
    disabled = false,
    placeholderText = 'Type a message...',
    commands,
    skills = [],
    slashCommandCategoryOrder,
    queuedMessages = [],
    onPopQueuedMessages,
    onClearQueuedMessages,
    currentMode = 'default',
    draftText,
    draftVersion,
    onFocusFooter,
    dialogOpen = false,
    followupState,
    onAcceptFollowup,
    onDismissFollowup,
    sessionName,
  },
  ref,
) {
  const workspace = useOptionalWorkspace();
  const { language, t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCycleModeRef = useRef(onCycleMode);
  onCycleModeRef.current = onCycleMode;
  const onToggleShortcutsRef = useRef(onToggleShortcuts);
  onToggleShortcutsRef.current = onToggleShortcuts;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const slashCommandCategoryOrderRef = useRef(slashCommandCategoryOrder);
  slashCommandCategoryOrderRef.current = slashCommandCategoryOrder;
  const tRef = useRef(t);
  tRef.current = t;
  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;
  const onPopQueuedMessagesRef = useRef(onPopQueuedMessages);
  onPopQueuedMessagesRef.current = onPopQueuedMessages;
  const onClearQueuedMessagesRef = useRef(onClearQueuedMessages);
  onClearQueuedMessagesRef.current = onClearQueuedMessages;
  const followupStateRef = useRef(followupState);
  followupStateRef.current = followupState;
  const onAcceptFollowupRef = useRef(onAcceptFollowup);
  onAcceptFollowupRef.current = onAcceptFollowup;
  const onDismissFollowupRef = useRef(onDismissFollowup);
  onDismissFollowupRef.current = onDismissFollowup;
  const onFocusFooterRef = useRef(onFocusFooter);
  onFocusFooterRef.current = onFocusFooter;
  const languageRef = useRef(language);
  languageRef.current = language;
  const workspaceActionsRef = useRef(workspace?.actions);
  workspaceActionsRef.current = workspace?.actions;
  const [shellMode, setShellMode] = useState(false);
  const shellModeRef = useRef(shellMode);
  shellModeRef.current = shellMode;
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<string[]>([]);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchUiRef = useRef<HTMLDivElement>(null);
  const searchDraftRef = useRef('');
  const [pastedImages, setPastedImages] = useState<PromptImage[]>([]);
  const pastedImagesRef = useRef<PromptImage[]>([]);
  const pendingPastesRef = useRef<Map<string, string>>(new Map());
  const nextPasteIdRef = useRef(1);
  // Tracks a trigger char ('/' or '@') inserted by a hint button so it can be
  // removed if the user cancels completion (Escape) without typing past it.
  const autoTriggerRef = useRef<{ text: string; from: number } | null>(null);

  const promptHistory = useInputHistory();
  const shellHistory = useInputHistory('qwen-web-shell-command-history');

  const {
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  } = promptHistory;
  const historyActionsRef = useRef({
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  });
  historyActionsRef.current = {
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  };
  const shellHistoryActionsRef = useRef(shellHistory);
  shellHistoryActionsRef.current = shellHistory;
  pastedImagesRef.current = pastedImages;

  // Open the reverse-i-search history panel. Shared by the Ctrl+R keymap and
  // the mouse-discoverable history button so both stay in lockstep.
  const openHistorySearch = useCallback(() => {
    if (disabledRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    const query = view.state.doc.toString();
    searchDraftRef.current = query;
    setSearchMode(true);
    setSearchQuery(query);
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    setSearchMatches(history.getReverseMatches(query));
    setSearchActiveIndex(0);
    history.resetSearch();
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);
  const openHistorySearchRef = useRef(openHistorySearch);
  openHistorySearchRef.current = openHistorySearch;

  // Fill the editor with the previous history entry (mirrors ArrowUp), used by
  // the clickable "history" hint so mouse users can walk history too.
  const navigatePrevHistory = useCallback(() => {
    if (disabledRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    // Match the ArrowUp keymap: when the completion menu is open, move its
    // selection instead of navigating history.
    if (completionStatus(view.state) === 'active') {
      moveCompletionSelection(false)(view);
      view.focus();
      return;
    }
    // ...and leave multi-line input alone rather than replacing a multi-line
    // draft with a single history entry.
    if (view.state.doc.lines > 1) {
      view.focus();
      return;
    }
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    const current = view.state.doc.toString();
    const prev = history.navigateUp(current);
    if (prev !== null) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: prev },
        selection: { anchor: prev.length },
      });
    }
    view.focus();
  }, []);

  // Step toward newer history (mirrors ArrowDown); paired with the "previous"
  // hint so mouse users can walk history in both directions.
  const navigateNextHistory = useCallback(() => {
    if (disabledRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    // Match the ArrowDown keymap: when the completion menu is open, move its
    // selection instead of navigating history.
    if (completionStatus(view.state) === 'active') {
      moveCompletionSelection(true)(view);
      view.focus();
      return;
    }
    // ...and leave multi-line input alone rather than replacing a multi-line
    // draft with a single history entry.
    if (view.state.doc.lines > 1) {
      view.focus();
      return;
    }
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    const next = history.navigateDown();
    if (next !== null) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: next.length },
      });
    }
    view.focus();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create a tooltip portal div on document.body so autocomplete
    // dropdowns escape any ancestor `overflow: hidden` (e.g. the host
    // app's container). We sync the current theme class and computed CSS
    // variables so the portal keeps the same colors after theme changes.
    const tooltipPortal = document.createElement('div');
    tooltipPortal.setAttribute('data-web-shell-tooltip-portal', '');
    tooltipPortal.style.position = 'fixed';
    tooltipPortal.style.inset = '0';
    tooltipPortal.style.zIndex = 'var(--web-shell-tooltip-z-index)';
    tooltipPortal.style.pointerEvents = 'none';
    const THEME_RE = /\b\S*theme(?:Dark|Light)\S*/gi;
    const syncTheme = () => {
      let el: Element | null = containerRef.current;
      let themeClass: string | null = null;
      if (containerRef.current) {
        const computedStyle = getComputedStyle(containerRef.current);
        for (let i = 0; i < computedStyle.length; i += 1) {
          const name = computedStyle[i];
          if (name.startsWith('--')) {
            tooltipPortal.style.setProperty(
              name,
              computedStyle.getPropertyValue(name),
            );
          }
        }
        if (
          !computedStyle.getPropertyValue('--web-shell-tooltip-z-index').trim()
        ) {
          tooltipPortal.style.setProperty(
            '--web-shell-tooltip-z-index',
            '1000',
          );
        }
      }
      while (el) {
        const match = el.className?.match?.(THEME_RE);
        if (match) {
          themeClass = match[0];
          break;
        }
        el = el.parentElement;
      }
      if (themeClass) {
        // Keep only the theme class on the portal - old theme class
        // from a previous sync is replaced atomically.
        tooltipPortal.className = themeClass;
      }
    };
    syncTheme();
    document.body.appendChild(tooltipPortal);

    // Observe class changes on every ancestor up to (and including)
    // the themed one, so light↔dark switches propagate to the portal.
    const observer = new MutationObserver(syncTheme);
    let el: Element | null = containerRef.current;
    while (el) {
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
      if (el.className?.match?.(THEME_RE)) break;
      el = el.parentElement;
    }

    const submitText = (view: EditorView, textOverride?: string) => {
      const rawText = (textOverride ?? view.state.doc.toString()).trim();
      if (!rawText) return true;
      const text = expandLargePastePlaceholders(
        pendingPastesRef.current,
        rawText,
      );
      const images = pastedImagesRef.current;
      const isShellMode = shellModeRef.current;
      const accepted = onSubmitRef.current(
        isShellMode ? `!${text}` : text,
        images.length > 0 ? [...images] : undefined,
      );
      if (accepted === false) return true;
      onDismissFollowupRef.current?.();
      pendingPastesRef.current.clear();
      nextPasteIdRef.current = 1;
      if (isShellMode) {
        shellHistoryActionsRef.current.push(text);
        shellHistoryActionsRef.current.reset();
      } else {
        historyActionsRef.current.push(text);
        historyActionsRef.current.reset();
      }
      setPastedImages([]);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
      });
      return true;
    };

    const completionSources: CompletionSource[] = [
      slashCompletionSource(
        () => commandsRef.current,
        () => skillsRef.current,
        () => languageRef.current,
        (key) => tRef.current(key),
        () => slashCommandCategoryOrderRef.current,
      ),
      createAtCompletionSource(
        () => workspaceActionsRef.current?.globWorkspace,
      ),
    ];

    // Shared newline handler for all multi-line input shortcuts. Inserts a
    // literal '\n' at the cursor instead of submitting.
    const insertNewline = (view: EditorView) => {
      view.dispatch(view.state.replaceSelection('\n'));
      return true;
    };

    const submitKeymap = keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          const followup = followupStateRef.current;
          if (
            view.state.doc.toString().length === 0 &&
            followup?.isVisible &&
            followup.suggestion
          ) {
            onAcceptFollowupRef.current?.('enter', { skipOnAccept: true });
            return submitText(view, followup.suggestion);
          }
          return submitText(view);
        },
      },
      // Newline shortcuts, mirroring the CLI TUI's NEWLINE bindings:
      // Shift+Enter, Ctrl+J, Ctrl+Enter / Cmd+Enter (Mod-Enter), and
      // Option/Alt+Enter for terminal muscle memory.
      {
        key: 'Shift-Enter',
        run: insertNewline,
      },
      {
        key: 'Ctrl-j',
        run: insertNewline,
      },
      {
        key: 'Mod-Enter',
        run: insertNewline,
      },
      {
        key: 'Alt-Enter',
        run: insertNewline,
      },
      {
        key: 'Escape',
        run: () => {
          if (shellModeRef.current) {
            setShellMode(false);
            return true;
          }
          if (queuedMessagesRef.current.length === 0) return false;
          return onClearQueuedMessagesRef.current?.() ?? false;
        },
      },
      {
        key: 'Ctrl-o',
        run: () => true,
      },
      {
        key: 'Ctrl-l',
        run: () => true,
      },
      {
        key: 'Ctrl-y',
        run: () => true,
      },
      {
        key: 'ArrowUp',
        run: (view) => {
          const history = shellModeRef.current
            ? shellHistoryActionsRef.current
            : historyActionsRef.current;
          const isBrowsingHistory = history.isNavigating();
          if (completionStatus(view.state) === 'active' && !isBrowsingHistory) {
            return moveCompletionSelection(false)(view);
          }
          if (isBrowsingHistory) {
            closeCompletion(view);
          }
          if (view.state.doc.lines > 1) return false;
          if (shellModeRef.current) {
            const current = view.state.doc.toString();
            const prev = history.navigateUp(current);
            if (prev === null) return true;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: prev },
              selection: { anchor: prev.length },
            });
            return true;
          }
          if (queuedMessagesRef.current.length > 0) {
            const queuedText = onPopQueuedMessagesRef.current?.();
            if (queuedText) {
              const current = view.state.doc.toString();
              const next = current.trim()
                ? `${queuedText}\n${current}`
                : queuedText;
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: next },
                selection: { anchor: next.length },
              });
              return true;
            }
          }
          const current = view.state.doc.toString();
          const prev = history.navigateUp(current);
          if (prev === null) return false;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: prev },
            selection: { anchor: prev.length },
          });
          return true;
        },
      },
      {
        key: 'ArrowDown',
        run: (view) => {
          const history = shellModeRef.current
            ? shellHistoryActionsRef.current
            : historyActionsRef.current;
          const isBrowsingHistory = history.isNavigating();
          if (completionStatus(view.state) === 'active' && !isBrowsingHistory) {
            return moveCompletionSelection(true)(view);
          }
          if (isBrowsingHistory) {
            closeCompletion(view);
          }
          if (view.state.doc.lines > 1) return false;
          if (shellModeRef.current) {
            const next = history.navigateDown();
            if (next === null) return true;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: next },
              selection: { anchor: next.length },
            });
            return true;
          }
          const next = history.navigateDown();
          if (next === null) {
            return onFocusFooterRef.current?.() ?? false;
          }
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next },
            selection: { anchor: next.length },
          });
          return true;
        },
      },
      {
        key: 'Ctrl-r',
        run: () => {
          openHistorySearchRef.current();
          return true;
        },
      },
      {
        key: 'Tab',
        // Priority: active menu > implicit subcommand > missing "/" prefix > followup suggestion
        run: (view) => {
          if (completionStatus(view.state) === 'active') {
            return acceptCompletion(view);
          }
          const text = view.state.doc.toString();
          const implicitResult = getImplicitTabCompletion(
            text,
            commandsRef.current,
            languageRef.current,
          );
          if (implicitResult) {
            view.dispatch({
              changes: {
                from: 0,
                to: view.state.doc.length,
                insert: implicitResult,
              },
              selection: { anchor: implicitResult.length },
            });
            return true;
          }
          const missingSlash = getMissingSlashPrefixCompletion(
            text,
            commandsRef.current,
          );
          if (missingSlash) {
            view.dispatch({
              changes: {
                from: 0,
                to: view.state.doc.length,
                insert: missingSlash,
              },
              selection: { anchor: missingSlash.length },
            });
            return true;
          }
          const followup = followupStateRef.current;
          if (text.length === 0 && followup?.isVisible && followup.suggestion) {
            onAcceptFollowupRef.current?.('tab');
            return true;
          }
          return true;
        },
      },
      {
        key: 'ArrowRight',
        run: (view) => {
          const followup = followupStateRef.current;
          if (
            completionStatus(view.state) !== 'active' &&
            view.state.doc.toString().length === 0 &&
            followup?.isVisible &&
            followup.suggestion
          ) {
            onAcceptFollowupRef.current?.('right');
            return true;
          }
          return false;
        },
      },
      {
        key: 'Shift-Tab',
        run: () => {
          onCycleModeRef.current?.();
          return true;
        },
      },
    ]);

    const slashCompletionRestarter = EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) {
        return;
      }
      if (update.docChanged && pendingPastesRef.current.size > 0) {
        const nextPasteId = prunePendingPastes(
          pendingPastesRef.current,
          update.state.doc.toString(),
        );
        if (nextPasteId !== null) {
          nextPasteIdRef.current = nextPasteId;
        }
      }
      const selection = update.state.selection.main;
      if (!selection.empty) return;
      const line = update.state.doc.lineAt(selection.head);
      const shouldCompleteSlash = line.from === 0 && line.text.startsWith('/');
      if (!shouldCompleteSlash) return;
      window.setTimeout(() => {
        const view = viewRef.current;
        if (!view || completionStatus(view.state) === 'active') return;
        const nextSelection = view.state.selection.main;
        if (!nextSelection.empty) return;
        const nextLine = view.state.doc.lineAt(nextSelection.head);
        if (nextLine.from === 0 && nextLine.text.startsWith('/')) {
          startCompletion(view);
        }
      }, 0);
    });

    // Remove a hint-button-inserted trigger ('/' or '@') when its completion
    // menu closes for any reason — Escape, click-away, blur — and the user
    // never typed past it. Watching the completion status covers every
    // dismissal path, not just the Escape key.
    let prevCompletionActive = false;
    const triggerCleanupListener = EditorView.updateListener.of((update) => {
      const trigger = autoTriggerRef.current;
      const nowActive = completionStatus(update.state) === 'active';
      if (trigger) {
        const doc = update.state.doc;
        const intact =
          doc.length === trigger.from + trigger.text.length &&
          doc.sliceString(trigger.from) === trigger.text;
        if (!intact) {
          // The user typed/edited past the trigger — keep their content.
          autoTriggerRef.current = null;
        } else if (prevCompletionActive && !nowActive) {
          autoTriggerRef.current = null;
          const { view } = update;
          const { from } = trigger;
          window.setTimeout(() => {
            if (viewRef.current !== view) return;
            const d = view.state.doc;
            // Re-check in case the user typed between close and this callback.
            if (
              d.length === from + trigger.text.length &&
              d.sliceString(from) === trigger.text
            ) {
              view.dispatch({ changes: { from, to: d.length, insert: '' } });
            }
          }, 0);
        }
      }
      prevCompletionActive = nowActive;
    });

    const state = EditorState.create({
      doc: '',
      extensions: [
        Prec.highest(submitKeymap),
        minimalSetup,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        autocompletion({
          override: completionSources,
          activateOnTyping: true,
          icons: false,
          optionClass: (completion) =>
            completion.type === 'file'
              ? 'cm-file-completion'
              : completion.info
                ? 'cm-command-info-completion'
                : '',
          aboveCursor: true,
          positionInfo: (_view, list, option, info, space) => {
            const infoHeight = info.bottom - info.top;
            const spaceBelow = space.bottom - list.bottom;
            const placeBelow =
              spaceBelow >= infoHeight || spaceBelow > list.top;
            const side = placeBelow ? 'top' : 'bottom';
            const offset = placeBelow
              ? option.bottom - list.top
              : list.bottom - option.top;
            return {
              style: `${side}: ${offset}px`,
              class: 'cm-completionInfo-right-narrow',
            };
          },
          activateOnCompletion: (completion) =>
            typeof completion.apply === 'string' &&
            completion.apply.endsWith(' '),
        }),
        // Render tooltips (including autocomplete panel) inside a portal
        // div on document.body so host-app containers with
        // `overflow: hidden` cannot clip the dropdown.
        tooltips({ parent: tooltipPortal }),
        placeholderCompartment.of(placeholder('')),
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        inputHighlight(
          () => commandsRef.current,
          () => languageRef.current,
        ),
        inputHighlightTheme,
        slashCompletionRestarter,
        triggerCleanupListener,
        EditorView.inputHandler.of((view, from, to, insert) => {
          if (
            insert.length > 0 &&
            view.state.doc.toString() === '' &&
            followupStateRef.current?.isVisible
          ) {
            onDismissFollowupRef.current?.();
          }
          if (
            insert === '!' &&
            view.state.doc.toString() === '' &&
            completionStatus(view.state) !== 'active'
          ) {
            setShellMode((value) => !value);
            return true;
          }
          if (
            insert === '?' &&
            view.state.doc.toString() === '' &&
            completionStatus(view.state) !== 'active'
          ) {
            onToggleShortcutsRef.current?.();
            return true;
          }
          return false;
        }),
        EditorView.domEventHandlers({
          paste(event) {
            const items = event.clipboardData?.items;
            if (!items) return false;
            let hasImage = false;
            for (const item of items) {
              if (item.type.startsWith('image/')) {
                hasImage = true;
                const file = item.getAsFile();
                if (!file) continue;
                const mediaType = item.type;
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1];
                  setPastedImages((prev) => [
                    ...prev,
                    { data: base64, media_type: mediaType },
                  ]);
                };
                reader.readAsDataURL(file);
              }
            }
            if (hasImage) {
              event.preventDefault();
              return true;
            }
            const pasted = normalizePastedText(
              event.clipboardData?.getData('text/plain') ?? '',
            );
            if (!pasted || !isLargePaste(pasted)) return false;

            event.preventDefault();
            if (
              view.state.doc.toString() === '' &&
              followupStateRef.current?.isVisible
            ) {
              onDismissFollowupRef.current?.();
            }
            const { placeholderText, nextPasteId } =
              createLargePastePlaceholder(
                pendingPastesRef.current,
                nextPasteIdRef.current,
                pasted,
              );
            nextPasteIdRef.current = nextPasteId;
            const selection = view.state.selection.main;
            view.dispatch({
              changes: {
                from: selection.from,
                to: selection.to,
                insert: placeholderText,
              },
              selection: { anchor: selection.from + placeholderText.length },
              scrollIntoView: true,
            });
            return true;
          },
        }),
        EditorView.theme({
          '&': {
            fontSize: '14px',
            background: 'transparent',
            border: 'none',
          },
          '&.cm-focused': {
            outline: 'none',
          },
          '.cm-scroller': {
            overflow: 'visible',
          },
          '.cm-content': {
            padding: '0',
            fontFamily: 'var(--font-mono, "SF Mono", "Fira Code", monospace)',
            color: 'var(--text-primary, #e0e0e0)',
            caretColor: 'var(--accent-color, #4a9eff)',
          },
          '.cm-line': {
            padding: '0',
          },
          '.cm-placeholder': {
            color: 'var(--text-dimmed, #666)',
          },
          '.cm-cursor': {
            borderLeftColor: 'var(--accent-color, #4a9eff)',
            borderLeftWidth: '2px',
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
      observer.disconnect();
      tooltipPortal.remove();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(
        EditorView.editable.of(!disabled),
      ),
    });
    if (!disabled) {
      view.focus();
    }
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const followupSuggestion =
      followupState?.isVisible && followupState.suggestion
        ? followupState.suggestion
        : null;
    const nextPlaceholder = followupSuggestion ?? placeholderText;
    view.dispatch({
      effects: placeholderCompartment.reconfigure(placeholder(nextPlaceholder)),
    });
  }, [placeholderText, followupState?.isVisible, followupState?.suggestion]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || draftText === undefined) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: draftText },
      selection: { anchor: draftText.length },
    });
    view.focus();
  }, [draftText, draftVersion]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || completionStatus(view.state) !== 'active') return;
    closeCompletion(view);
    window.setTimeout(() => {
      if (viewRef.current === view) {
        startCompletion(view);
      }
    }, 0);
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (dialogOpen) {
      view.contentDOM.blur();
    } else {
      view.focus();
    }
  }, [dialogOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (disabledRef.current || searchMode || dialogOpen) return;
      if (event.defaultPrevented) return;
      const view = viewRef.current;
      const followup = followupStateRef.current;
      if (
        view &&
        !view.hasFocus &&
        followup?.isVisible &&
        followup.suggestion &&
        view.state.doc.toString().length === 0 &&
        !isEditableTarget(event.target)
      ) {
        if (
          event.key === 'Tab' &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          completionStatus(view.state) !== 'active'
        ) {
          event.preventDefault();
          onAcceptFollowupRef.current?.('tab');
          return;
        }
        if (
          event.key === 'ArrowRight' &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          completionStatus(view.state) !== 'active'
        ) {
          event.preventDefault();
          onAcceptFollowupRef.current?.('right');
          return;
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      if (isEditableTarget(event.target)) return;

      if (!view || view.hasFocus) return;

      event.preventDefault();
      if (event.key === '!' && view.state.doc.toString() === '') {
        if (followupStateRef.current?.isVisible) {
          onDismissFollowupRef.current?.();
        }
        setShellMode((value) => !value);
        view.focus();
        return;
      }
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: event.key },
        selection: { anchor: selection.from + event.key.length },
        scrollIntoView: true,
      });
      view.focus();
      if (event.key === '/' || event.key === '@') {
        window.setTimeout(() => {
          const nextView = viewRef.current;
          if (nextView && nextView.hasFocus) {
            startCompletion(nextView);
          }
        }, 0);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchMode, dialogOpen]);

  const focus = useCallback(() => {
    viewRef.current?.focus();
  }, []);

  const insertText = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view || !text) {
      view?.focus();
      return;
    }
    const selection = view.state.selection.main;
    let insert = text;
    // Make the trigger characters idempotent so a second click re-opens the
    // menu instead of inserting a duplicate.
    let skipInsert = false;
    let caretOverride: number | null = null;
    // Whether to open the completion menu afterwards. A mid-line '/' no-op
    // (non-empty draft) must not, since the slash source needs a line-leading
    // '/' and would otherwise pop an empty/unrelated menu.
    let openMenu = text === '/' || text === '@';
    if (text === '/') {
      // The slash-command menu only triggers on a line-leading '/'. Re-open the
      // menu (don't insert) when the line already starts with '/', and no-op
      // when the editor holds other text: inserting a mid-line '/' wouldn't open
      // the menu, and replacing the draft would silently destroy it. The user
      // can clear the draft themselves to start a command on an empty line.
      const line = view.state.doc.lineAt(selection.head);
      if (line.text.startsWith('/')) {
        skipInsert = true; // re-open the menu on the existing command
      } else if (view.state.doc.length > 0) {
        skipInsert = true;
        openMenu = false; // no-op on a non-empty draft; don't pop an empty menu
      }
    } else if (text === '@') {
      const before =
        selection.from > 0
          ? view.state.doc.sliceString(selection.from - 1, selection.from)
          : '';
      const after = view.state.doc.sliceString(
        selection.from,
        selection.from + 1,
      );
      if (after === '@') {
        // Cursor sits directly before an existing '@'; step over it instead of
        // inserting a duplicate, so the menu opens on the existing mention.
        skipInsert = true;
        caretOverride = selection.from + 1;
      } else if (before === '@') {
        // Already an '@' right before the cursor — just re-open the menu.
        skipInsert = true;
      } else if (before && !/\s/.test(before)) {
        // An @-mention only parses at a token boundary, so when it lands
        // mid-word prepend a space to detach it.
        insert = ' @';
      }
    }
    if (!skipInsert) {
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert },
        selection: { anchor: selection.from + insert.length },
        scrollIntoView: true,
      });
      // Remember the click-inserted trigger so Escape can undo it if the user
      // never types past it (see the Escape keymap).
      if (openMenu) {
        autoTriggerRef.current = { text: insert, from: selection.from };
      }
    } else if (caretOverride !== null) {
      view.dispatch({
        selection: { anchor: caretOverride },
        scrollIntoView: true,
      });
    }
    view.focus();
    if (openMenu) {
      window.setTimeout(() => {
        const nextView = viewRef.current;
        if (nextView && nextView.hasFocus) {
          startCompletion(nextView);
        }
      }, 0);
    }
  }, []);

  const getText = useCallback(() => {
    return viewRef.current?.state.doc.toString() ?? '';
  }, []);

  const clearText = useCallback(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.length === 0) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '' },
    });
    setPastedImages([]);
    pendingPastesRef.current.clear();
    nextPasteIdRef.current = 1;
  }, []);

  const retryLast = useCallback(() => {
    const last = historyActionsRef.current.getLastEntry(
      (e) => !e.startsWith('/') && !e.startsWith('!'),
    );
    if (!last) return;
    const accepted = onSubmitRef.current(last);
    if (accepted === false) return;
    setPastedImages([]);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      clearText,
      focus,
      getText,
      insertText,
      retryLast,
    }),
    [clearText, focus, getText, insertText, retryLast],
  );

  const replaceEditorText = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      scrollIntoView: true,
    });
  }, []);

  const closeSearch = useCallback(
    (restoreDraft: boolean, keepFocus = true) => {
      if (restoreDraft) {
        replaceEditorText(searchDraftRef.current);
      }
      setSearchMode(false);
      setSearchQuery('');
      setSearchMatches([]);
      setSearchActiveIndex(0);
      const history = shellModeRef.current
        ? shellHistoryActionsRef.current
        : historyActionsRef.current;
      history.resetSearch();
      // Outside-click dismissal passes keepFocus=false so focus isn't stolen
      // from whatever the user clicked (e.g. a button/link in the transcript).
      if (keepFocus) {
        viewRef.current?.focus();
      }
    },
    [replaceEditorText],
  );

  // While the reverse-i-search panel is open, a primary-button / touch press
  // outside it behaves like Escape: cancel the search and restore the draft.
  // Mirrors the inline-panel dismissal (Settings/Mode pickers).
  useEffect(() => {
    if (!searchMode) return;
    const onPointerOutside = (event: Event) => {
      // Only the primary (left) button dismisses; middle-click pastes and
      // right-click opens a context menu. Touch events have no button.
      if (event instanceof MouseEvent && event.button !== 0) return;
      if (event.defaultPrevented) return;
      const panel = searchUiRef.current;
      const target = event.target;
      if (panel && target instanceof Node && !panel.contains(target)) {
        closeSearch(true, false);
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    window.addEventListener('touchstart', onPointerOutside);
    return () => {
      window.removeEventListener('mousedown', onPointerOutside);
      window.removeEventListener('touchstart', onPointerOutside);
    };
  }, [searchMode, closeSearch]);

  const submitSearchMatch = useCallback(
    (match: string) => {
      const view = viewRef.current;
      if (!view) return;
      closeSearch(false);
      const text = match.trim();
      if (!text) return;
      const images = pastedImagesRef.current;
      const isShellMode = shellModeRef.current;
      const accepted = onSubmitRef.current(
        isShellMode ? `!${text}` : text,
        images.length > 0 ? [...images] : undefined,
      );
      if (accepted === false) {
        replaceEditorText(match);
        return;
      }
      onDismissFollowupRef.current?.();
      if (isShellMode) {
        shellHistoryActionsRef.current.push(text);
        shellHistoryActionsRef.current.reset();
      } else {
        historyActionsRef.current.push(text);
        historyActionsRef.current.reset();
      }
      setPastedImages([]);
      replaceEditorText('');
    },
    [closeSearch, replaceEditorText],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch(true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const match = searchMatches[searchActiveIndex];
      if (match) {
        replaceEditorText(match);
      }
      closeSearch(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const match = searchMatches[searchActiveIndex];
      if (match) {
        submitSearchMatch(match);
      } else {
        closeSearch(false);
      }
    } else if (e.key === 'r' && e.ctrlKey) {
      e.preventDefault();
      if (searchMatches.length > 0) {
        setSearchActiveIndex((index) => (index + 1) % searchMatches.length);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (searchMatches.length > 0) {
        setSearchActiveIndex((index) => (index + 1) % searchMatches.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (searchMatches.length > 0) {
        setSearchActiveIndex(
          (index) => (index - 1 + searchMatches.length) % searchMatches.length,
        );
      }
    }
  };

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    setSearchMatches(history.getReverseMatches(q));
    setSearchActiveIndex(0);
    history.resetSearch();
  };

  const modeClass = getModeClass(currentMode, shellMode);
  const containerClass = [
    styles.container,
    shellMode ? styles.shellMode : '',
    modeClass,
  ]
    .filter(Boolean)
    .join(' ');
  const visibleSearchStart = Math.max(
    0,
    Math.min(searchActiveIndex - 2, searchMatches.length - 6),
  );
  const visibleSearchMatches = searchMatches.slice(
    visibleSearchStart,
    visibleSearchStart + 6,
  );
  const prefixClass = [
    styles.prefix,
    shellMode
      ? styles.prefixShell
      : currentMode === 'yolo'
        ? styles.prefixYolo
        : currentMode === 'auto-edit'
          ? styles.prefixAutoEdit
          : '',
  ]
    .filter(Boolean)
    .join(' ');
  const prefixContent = shellMode ? (
    '!'
  ) : currentMode === 'yolo' ? (
    '*'
  ) : (
    <PromptChevron />
  );
  // A faint, always-on hint row that surfaces the otherwise-hidden input
  // shortcuts (history search, slash commands, file mentions) so they stay
  // discoverable even while typing. Hidden where it would conflict or not
  // apply: shell mode (different prefix), reverse-i-search (its own hint bar),
  // a followup suggestion occupying the placeholder, while disabled (the
  // buttons would otherwise bypass the editor's disabled guard), or while a
  // dialog is open (matching the Ctrl+R keymap guard).
  const showShortcutHints =
    !shellMode &&
    !searchMode &&
    !followupState?.isVisible &&
    !disabled &&
    !dialogOpen;
  // Enable/disable the ↑/↓ history hints based on whether there's an older /
  // newer entry to move to (mirrors the keyboard no-op at the ends).
  const histNav = (shellMode ? shellHistory : promptHistory).nav;
  // Shared props for the hint-row buttons: keep focus in the editor
  // (preventDefault on mousedown) and don't bubble to the container's click-
  // to-focus handler (stopPropagation on click).
  const hintProps = (handler: () => void, haspopup?: 'dialog' | 'listbox') => ({
    type: 'button' as const,
    className: styles.hintItem,
    ...(haspopup ? { 'aria-haspopup': haspopup } : {}),
    onMouseDown: (e: ReactMouseEvent<HTMLButtonElement>) => e.preventDefault(),
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      handler();
    },
  });

  return (
    <div className={containerClass} onClick={focus}>
      <div className={styles.borderTop}>
        {sessionName && (
          <span className={styles.borderTopLabel}>{sessionName}</span>
        )}
      </div>
      {searchMode && (
        <div ref={searchUiRef}>
          <div className={styles.searchBar}>
            <span className={styles.searchLabel}>reverse-i-search:</span>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              value={searchQuery}
              onChange={handleSearchInput}
              onKeyDown={handleSearchKeyDown}
              placeholder="type to search..."
            />
            <span className={styles.searchHint}>
              ctrl+r next · tab accept · enter send · esc cancel
            </span>
          </div>
          {searchMatches.length > 0 && (
            <div className={styles.searchResults}>
              {visibleSearchMatches.map((match, index) => {
                const matchIndex = visibleSearchStart + index;
                return (
                  <button
                    key={`${match}-${matchIndex}`}
                    type="button"
                    className={`${styles.searchResult} ${
                      matchIndex === searchActiveIndex
                        ? styles.searchResultActive
                        : ''
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      replaceEditorText(match);
                      closeSearch(false);
                    }}
                  >
                    <span className={styles.searchResultMarker}>
                      {matchIndex === searchActiveIndex ? '›' : ''}
                    </span>
                    <span className={styles.searchResultText}>{match}</span>
                  </button>
                );
              })}
            </div>
          )}
          {searchMatches.length === 0 && (
            <div className={styles.searchEmpty}>{t('editor.noHistory')}</div>
          )}
        </div>
      )}
      {pastedImages.length > 0 && (
        <div className={styles.images}>
          {pastedImages.map((img, i) => (
            <div key={i} className={styles.imageThumb}>
              <img src={`data:${img.media_type};base64,${img.data}`} alt="" />
              <button
                className={styles.imageRemove}
                onClick={(e) => {
                  e.stopPropagation();
                  setPastedImages((prev) => prev.filter((_, idx) => idx !== i));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.line}>
        <span className={prefixClass}>{prefixContent}</span>
        <div ref={containerRef} className={styles.wrapper} />
      </div>
      {showShortcutHints && (
        <div className={styles.hints}>
          <button {...hintProps(navigatePrevHistory)} disabled={!histNav.canUp}>
            <span className={styles.hintKey}>↑</span>
            {t('editor.hintPrev')}
          </button>
          <span className={styles.hintSep}>·</span>
          <button
            {...hintProps(navigateNextHistory)}
            disabled={!histNav.canDown}
          >
            <span className={styles.hintKey}>↓</span>
            {t('editor.hintNext')}
          </button>
          <span className={styles.hintSep}>·</span>
          <button {...hintProps(openHistorySearch, 'dialog')}>
            <span className={styles.hintKey}>ctrl+r</span>
            {t('editor.hintSearch')}
          </button>
          <span className={styles.hintSep}>·</span>
          <button {...hintProps(() => insertText('/'), 'listbox')}>
            <span className={styles.hintKey}>/</span>
            {t('editor.hintCommands')}
          </button>
          <span className={styles.hintSep}>·</span>
          <button {...hintProps(() => insertText('@'), 'listbox')}>
            <span className={styles.hintKey}>@</span>
            {t('editor.hintFiles')}
          </button>
        </div>
      )}
      <div className={styles.borderBottom} />
    </div>
  );
});
