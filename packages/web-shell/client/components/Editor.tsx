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
  type CompletionSource,
} from '@codemirror/autocomplete';
import { minimalSetup } from 'codemirror';
import type { CommandInfo } from '../adapters/types';
import { slashCompletionSource } from '../completions/slashCompletion';
import { atCompletionSource } from '../completions/atCompletion';
import { useInputHistory } from '../hooks/useInputHistory';
import {
  inputHighlight,
  inputHighlightTheme,
} from '../extensions/inputHighlight';

export interface PastedImage {
  data: string;
  media_type: string;
}

interface EditorProps {
  onSubmit: (text: string, images?: PastedImage[]) => boolean | void;
  onCycleMode?: () => void;
  onToggleShortcuts?: () => void;
  disabled?: boolean;
  placeholderText?: string;
  commands: CommandInfo[];
  skills?: string[];
  prefix?: string;
  currentMode?: string;
  draftText?: string;
  draftVersion?: number;
}

const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();

function getModeClass(mode: string, shellMode: boolean): string {
  if (shellMode) return '';
  switch (mode) {
    case 'plan':
      return 'editor-mode-plan';
    case 'auto-edit':
      return 'editor-mode-auto-edit';
    case 'yolo':
      return 'editor-mode-yolo';
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
  prefix = '>',
  currentMode = 'default',
  draftText,
  draftVersion,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCycleModeRef = useRef(onCycleMode);
  onCycleModeRef.current = onCycleMode;
  const onToggleShortcutsRef = useRef(onToggleShortcuts);
  onToggleShortcutsRef.current = onToggleShortcuts;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const [shellMode, setShellMode] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const pastedImagesRef = useRef<PastedImage[]>([]);

  const { push, navigateUp, navigateDown, reset, searchReverse, resetSearch } =
    useInputHistory();
  const historyActionsRef = useRef({
    push,
    navigateUp,
    navigateDown,
    reset,
    resetSearch,
  });
  historyActionsRef.current = {
    push,
    navigateUp,
    navigateDown,
    reset,
    resetSearch,
  };
  pastedImagesRef.current = pastedImages;

  useEffect(() => {
    if (!containerRef.current) return;

    const completionSources: CompletionSource[] = [
      slashCompletionSource(
        () => commandsRef.current,
        () => skillsRef.current,
      ),
      atCompletionSource,
    ];

    const submitKeymap = keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          const text = view.state.doc.toString().trim();
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
        },
      },
      {
        key: 'Shift-Enter',
        run: () => false,
      },
      {
        key: 'ArrowUp',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false;
          if (view.state.doc.lines > 1) return false;
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
        run: () => {
          setSearchMode(true);
          setSearchQuery('');
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
            for (const item of items) {
              if (item.type.startsWith('image/')) {
                event.preventDefault();
                const file = item.getAsFile();
                if (!file) return true;
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1];
                  setPastedImages((prev) => [
                    ...prev,
                    { data: base64, media_type: item.type },
                  ]);
                };
                reader.readAsDataURL(file);
                return true;
              }
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
            padding: '4px 10px',
            color: 'var(--text-primary, #e4e4e4)',
          },
          '.cm-tooltip-autocomplete ul li[aria-selected]': {
            background: 'var(--bg-tertiary, #1e1e1e)',
            color: 'var(--accent-color, #4a9eff)',
          },
          '.cm-completionLabel': {
            fontFamily: 'var(--font-mono, monospace)',
          },
          '.cm-completionDetail': {
            fontStyle: 'normal',
            color: 'var(--text-dimmed, #666)',
            marginLeft: '8px',
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

  const focus = useCallback(() => {
    viewRef.current?.focus();
  }, []);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchMode(false);
      resetSearch();
      viewRef.current?.focus();
    } else if (e.key === 'Enter') {
      setSearchMode(false);
      resetSearch();
      viewRef.current?.focus();
    } else if (e.key === 'r' && e.ctrlKey) {
      e.preventDefault();
      const result = searchReverse(searchQuery);
      if (result && viewRef.current) {
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: result,
          },
          selection: { anchor: result.length },
        });
      }
    }
  };

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    resetSearch();
    if (q) {
      const result = searchReverse(q);
      if (result && viewRef.current) {
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: result,
          },
          selection: { anchor: result.length },
        });
      }
    }
  };

  const modeClass = getModeClass(currentMode, shellMode);
  const containerClass = [
    'editor-container',
    shellMode ? 'editor-shell-mode' : '',
    modeClass,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClass} onClick={focus}>
      <div className="editor-border-top" />
      {searchMode && (
        <div className="editor-search-bar">
          <span className="editor-search-label">reverse-i-search:</span>
          <input
            ref={searchInputRef}
            className="editor-search-input"
            value={searchQuery}
            onChange={handleSearchInput}
            onKeyDown={handleSearchKeyDown}
            placeholder="type to search..."
          />
        </div>
      )}
      {pastedImages.length > 0 && (
        <div className="editor-images">
          {pastedImages.map((img, i) => (
            <div key={i} className="editor-image-thumb">
              <img src={`data:${img.media_type};base64,${img.data}`} alt="" />
              <button
                className="editor-image-remove"
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
      <div className="editor-line">
        <span
          className={`editor-prefix ${shellMode ? 'editor-prefix-shell' : ''}`}
        >
          {shellMode ? '!' : prefix}
        </span>
        <div ref={containerRef} className="editor-wrapper" />
      </div>
      <div className="editor-border-bottom" />
    </div>
  );
}
