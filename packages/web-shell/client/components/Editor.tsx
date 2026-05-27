import { useEffect, useRef, useCallback, useState } from 'react';
import {
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  autocompletion,
  completionStatus,
  startCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { minimalSetup } from 'codemirror';
import type { CommandInfo } from '../adapters/types';
import type { PromptImage } from '../adapters/promptTypes';
import { slashCompletionSource } from '../completions/slashCompletion';
import { createAtCompletionSource } from '../completions/atCompletion';
import { useInputHistory } from '../hooks/useInputHistory';
import { useI18n } from '../i18n';
import {
  inputHighlight,
  inputHighlightTheme,
} from '../extensions/inputHighlight';
import { isEditableTarget } from '../utils/dom';
import styles from './Editor.module.css';

interface EditorProps {
  onSubmit: (text: string, images?: PromptImage[]) => boolean | void;
  onCycleMode?: () => void;
  onToggleShortcuts?: () => void;
  disabled?: boolean;
  placeholderText?: string;
  commands: CommandInfo[];
  skills?: string[];
  queuedMessages?: string[];
  onPopQueuedMessages?: () => string | null;
  onClearQueuedMessages?: () => boolean;
  prefix?: string;
  currentMode?: string;
  draftText?: string;
  draftVersion?: number;
  daemonBaseUrl?: string;
  daemonToken?: string;
}

const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();

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

export function Editor({
  onSubmit,
  onCycleMode,
  onToggleShortcuts,
  disabled = false,
  placeholderText = 'Type a message...',
  commands,
  skills = [],
  queuedMessages = [],
  onPopQueuedMessages,
  onClearQueuedMessages,
  prefix = '>',
  currentMode = 'default',
  draftText,
  draftVersion,
  daemonBaseUrl,
  daemonToken,
}: EditorProps) {
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
  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;
  const onPopQueuedMessagesRef = useRef(onPopQueuedMessages);
  onPopQueuedMessagesRef.current = onPopQueuedMessages;
  const onClearQueuedMessagesRef = useRef(onClearQueuedMessages);
  onClearQueuedMessagesRef.current = onClearQueuedMessages;
  const languageRef = useRef(language);
  languageRef.current = language;
  const daemonBaseUrlRef = useRef(daemonBaseUrl);
  daemonBaseUrlRef.current = daemonBaseUrl;
  const daemonTokenRef = useRef(daemonToken);
  daemonTokenRef.current = daemonToken;
  const [shellMode, setShellMode] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<string[]>([]);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchDraftRef = useRef('');
  const [pastedImages, setPastedImages] = useState<PromptImage[]>([]);
  const pastedImagesRef = useRef<PromptImage[]>([]);

  const {
    push,
    navigateUp,
    navigateDown,
    reset,
    getReverseMatches,
    resetSearch,
  } = useInputHistory();
  const historyActionsRef = useRef({
    push,
    navigateUp,
    navigateDown,
    reset,
    getReverseMatches,
    resetSearch,
  });
  historyActionsRef.current = {
    push,
    navigateUp,
    navigateDown,
    reset,
    getReverseMatches,
    resetSearch,
  };
  pastedImagesRef.current = pastedImages;

  useEffect(() => {
    if (!containerRef.current) return;

    const submitText = (view: EditorView, textOverride?: string) => {
      const text = (textOverride ?? view.state.doc.toString()).trim();
      if (!text) return true;
      const images = pastedImagesRef.current;
      const accepted = onSubmitRef.current(
        text,
        images.length > 0 ? [...images] : undefined,
      );
      if (accepted === false) return true;
      historyActionsRef.current.push(text);
      historyActionsRef.current.reset();
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
        submitText,
        () => languageRef.current,
      ),
      createAtCompletionSource({
        get baseUrl() {
          return daemonBaseUrlRef.current;
        },
        get token() {
          return daemonTokenRef.current;
        },
      }),
    ];

    const submitKeymap = keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          return submitText(view);
        },
      },
      {
        key: 'Shift-Enter',
        run: () => false,
      },
      {
        key: 'Escape',
        run: () => {
          if (queuedMessagesRef.current.length === 0) return false;
          return onClearQueuedMessagesRef.current?.() ?? false;
        },
      },
      {
        key: 'Ctrl-o',
        run: () => true,
      },
      {
        key: 'ArrowUp',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          if (view.state.doc.lines > 1) return false;
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
          const prev = historyActionsRef.current.navigateUp(current);
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
          if (completionStatus(view.state) === 'active') return false;
          if (view.state.doc.lines > 1) return false;
          const next = historyActionsRef.current.navigateDown();
          if (next === null) return false;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next },
            selection: { anchor: next.length },
          });
          return true;
        },
      },
      {
        key: 'Ctrl-r',
        run: (view) => {
          const query = view.state.doc.toString();
          searchDraftRef.current = query;
          setSearchMode(true);
          setSearchQuery(query);
          setSearchMatches(historyActionsRef.current.getReverseMatches(query));
          setSearchActiveIndex(0);
          historyActionsRef.current.resetSearch();
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return true;
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

    const shellModeDetector = ViewPlugin.fromClass(
      class {
        update(update: ViewUpdate) {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            setShellMode(text.startsWith('!'));
          }
        }
      },
    );

    const slashCompletionRestarter = EditorView.updateListener.of((update) => {
      if (!update.docChanged || completionStatus(update.state) === 'active') {
        return;
      }
      const selection = update.state.selection.main;
      if (!selection.empty) return;
      const line = update.state.doc.lineAt(selection.head);
      const textBefore = line.text.slice(0, selection.head - line.from);
      const shouldCompleteSlash =
        line.from === 0 &&
        textBefore.startsWith('/') &&
        !textBefore.includes('\n');
      if (!shouldCompleteSlash) return;
      window.setTimeout(() => {
        const view = viewRef.current;
        if (!view || completionStatus(view.state) === 'active') return;
        const nextSelection = view.state.selection.main;
        if (!nextSelection.empty) return;
        const nextLine = view.state.doc.lineAt(nextSelection.head);
        const nextTextBefore = nextLine.text.slice(
          0,
          nextSelection.head - nextLine.from,
        );
        if (nextLine.from === 0 && nextTextBefore.startsWith('/')) {
          startCompletion(view);
        }
      }, 0);
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
          aboveCursor: true,
          activateOnCompletion: (completion) =>
            typeof completion.apply === 'string' &&
            completion.apply.endsWith(' '),
        }),
        placeholderCompartment.of(placeholder('')),
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        inputHighlight,
        inputHighlightTheme,
        shellModeDetector,
        slashCompletionRestarter,
        EditorView.inputHandler.of((view, from, to, insert) => {
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
            return false;
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
          '.cm-tooltip-autocomplete': {
            background: 'var(--bg-secondary, #161616)',
            border: '1px solid var(--border-color, #2a2a2a)',
            borderRadius: '6px',
            overflow: 'hidden',
          },
          '.cm-tooltip-autocomplete ul': {
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '13px',
          },
          '.cm-tooltip-autocomplete ul li': {
            display: 'flex',
            alignItems: 'baseline',
            minWidth: '0',
            padding: '4px 10px',
            color: 'var(--text-primary, #e4e4e4)',
            overflow: 'hidden',
          },
          '.cm-tooltip-autocomplete ul li[aria-selected]': {
            background: 'var(--bg-tertiary, #1e1e1e)',
            color: 'var(--accent-color, #4a9eff)',
          },
          '.cm-completionLabel': {
            fontFamily: 'var(--font-mono, monospace)',
            flexShrink: '0',
            minWidth: '14ch',
            maxWidth: '28ch',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
          '.cm-completionDetail': {
            flex: '1 1 auto',
            minWidth: '0',
            fontStyle: 'normal',
            color: 'var(--text-dimmed, #666)',
            marginLeft: '8px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
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
    view.dispatch({
      effects: placeholderCompartment.reconfigure(placeholder(placeholderText)),
    });
  }, [placeholderText]);

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
    const handler = (event: KeyboardEvent) => {
      if (disabledRef.current || searchMode) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      if (isEditableTarget(event.target)) return;

      const view = viewRef.current;
      if (!view || view.hasFocus) return;

      event.preventDefault();
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
  }, [searchMode]);

  const focus = useCallback(() => {
    viewRef.current?.focus();
  }, []);

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
    (restoreDraft: boolean) => {
      if (restoreDraft) {
        replaceEditorText(searchDraftRef.current);
      }
      setSearchMode(false);
      setSearchQuery('');
      setSearchMatches([]);
      setSearchActiveIndex(0);
      historyActionsRef.current.resetSearch();
      viewRef.current?.focus();
    },
    [replaceEditorText],
  );

  const submitSearchMatch = useCallback(
    (match: string) => {
      const view = viewRef.current;
      if (!view) return;
      closeSearch(false);
      const text = match.trim();
      if (!text) return;
      const images = pastedImagesRef.current;
      const accepted = onSubmitRef.current(
        text,
        images.length > 0 ? [...images] : undefined,
      );
      if (accepted === false) {
        replaceEditorText(match);
        return;
      }
      historyActionsRef.current.push(text);
      historyActionsRef.current.reset();
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
    setSearchMatches(historyActionsRef.current.getReverseMatches(q));
    setSearchActiveIndex(0);
    historyActionsRef.current.resetSearch();
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

  return (
    <div className={containerClass} onClick={focus}>
      <div className={styles.borderTop} />
      {searchMode && (
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
      )}
      {searchMode && searchMatches.length > 0 && (
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
      {searchMode && searchMatches.length === 0 && (
        <div className={styles.searchEmpty}>{t('editor.noHistory')}</div>
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
        <span
          className={`${styles.prefix} ${shellMode ? styles.prefixShell : ''}`}
        >
          {shellMode ? '!' : prefix}
        </span>
        <div ref={containerRef} className={styles.wrapper} />
      </div>
      <div className={styles.borderBottom} />
    </div>
  );
}
