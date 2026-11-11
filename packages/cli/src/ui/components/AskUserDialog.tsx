/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useReducer,
} from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  type Question,
  type QuestionAnnotation,
  type EditorType,
  NOTES_ONLY_ANSWER,
} from '@qwen-code/core';
import {
  useSelectionList,
  type SelectionListItem,
} from '../hooks/useSelectionList.js';
import { BaseTabDialog, type TabItem } from './shared/BaseTabDialog.js';
import { readClipboardText } from '../utils/clipboardUtils.js';
import type { Key } from '../hooks/useKeypress.js';
// NOTE: We intentionally do NOT use useTabbedNavigation here.
// That hook registers Tabs context + action handlers which would hijack
// left/right/tab keys from the selection list and Dialog context.
// AskUserDialog only needs state management for tab indices — keyboard
// tab switching is handled via Dialog context action handlers
// dispatched through BaseTabDialog's Dialog fallback.

import { RenderInline } from '../utils/InlineMarkdownRenderer.js';
import { AskUserPreview } from './AskUserPreview.js';
import { WarningMessage } from './messages/WarningMessage.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

import { calculateCenteredWindow } from '../utils/calculateCenteredWindow.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import type { ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { Command } from '../key/keyBindings.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { figures } from '../utils/figures.js';
import { HorizontalLine } from './shared/HorizontalLine.js';
import {
  InputField,
  resolveInlineSelectionInputLayout,
} from './shared/InputField.js';
import {
  expandPastePlaceholders,
  useTextBuffer,
  type TextBuffer,
} from './shared/text-buffer.js';

// ---------------------------------------------------------------------------
// AskUser-specific input routing
// ---------------------------------------------------------------------------

/**
 * Preserve the few keyboard semantics that belong to AskUser rather than the
 * text editor itself. Character editing, cursor rendering, submit, and terminal
 * paste stay owned by TextInput/TextBuffer.
 */
function useAskUserInputRouting(
  buffer: TextBuffer,
  isActive: boolean,
  clearOnEscape = true,
) {
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  const dialogHandlers = useMemo(
    () => ({
      'dialog:escape': () => {
        if (clearOnEscape && bufferRef.current.text !== '') {
          bufferRef.current.setText('', 'end');
          return true;
        }
        return false;
      },
      'dialog:navigate:left': (key: Key) => {
        bufferRef.current.handleInput(key);
        return true;
      },
      'dialog:navigate:right': (key: Key) => {
        bufferRef.current.handleInput(key);
        return true;
      },
      'cursor:home': (key: Key) => {
        bufferRef.current.handleInput(key);
        return true;
      },
      'cursor:end': (key: Key) => {
        bufferRef.current.handleInput(key);
        return true;
      },
      'input:openExternalEditor': () => {
        void bufferRef.current.openInExternalEditor();
        return true;
      },
      'input:paste': () => {
        const doPaste = async () => {
          const text = await readClipboardText();
          if (text) {
            bufferRef.current.insert(text, { paste: true });
          }
        };
        void doPaste();
        return true;
      },
    }),

    [clearOnEscape],
  );

  useRegisterActionHandlers('Dialog', dialogHandlers, isActive, {
    prepend: true,
  });

  const globalHandlers = useMemo(
    () => ({
      'app:interrupt': () => {
        if (bufferRef.current.text !== '') {
          bufferRef.current.setText('', 'end');
          return true;
        }
        return false;
      },
    }),

    [],
  );

  useRegisterActionHandlers('Global', globalHandlers, isActive);
}

interface AskUserDialogState {
  /** Answers keyed by question text. */
  answers: { [questionText: string]: string };
  /** Preview and notes metadata keyed by question text. */
  annotations: { [questionText: string]: QuestionAnnotation };
  /** Preserve choice identity and input drafts independently of answer strings. */
  choiceStates: Record<string, ChoiceState>;
  isChatFocused: boolean;
  isEditingCustomOption: boolean;
  submitted: boolean;
}

type AskUserDialogAction =
  | {
      type: 'SET_ANSWER';
      payload: {
        questionText: string;
        answer: string;
        annotation?: QuestionAnnotation;
        submit?: boolean;
      };
    }
  | {
      type: 'SET_CHOICE_STATE';
      payload: { questionText: string; state: ChoiceState };
    }
  | { type: 'SET_CHAT_FOCUSED'; payload: boolean }
  | { type: 'SET_NOTES'; payload: { questionText: string; notes: string } }
  | { type: 'SET_EDITING_CUSTOM'; payload: { isEditing: boolean } }
  | { type: 'SUBMIT' };

const initialState: AskUserDialogState = {
  answers: {},
  annotations: {},
  choiceStates: {},
  isChatFocused: false,
  isEditingCustomOption: false,
  submitted: false,
};

function askUserDialogReducerLogic(
  state: AskUserDialogState,
  action: AskUserDialogAction,
): AskUserDialogState {
  if (state.submitted) {
    return state;
  }

  switch (action.type) {
    case 'SET_ANSWER': {
      const { questionText, answer, annotation, submit } = action.payload;
      const hasAnswer =
        answer !== undefined && answer !== null && answer.trim() !== '';
      const newAnswers = { ...state.answers };
      const newAnnotations = { ...state.annotations };

      if (hasAnswer) {
        newAnswers[questionText] = answer;
      } else {
        delete newAnswers[questionText];
      }

      if (annotation?.preview || annotation?.notes) {
        newAnnotations[questionText] = annotation;
      } else {
        delete newAnnotations[questionText];
      }

      return {
        ...state,
        answers: newAnswers,
        annotations: newAnnotations,
        submitted: submit ? true : state.submitted,
      };
    }
    case 'SET_CHOICE_STATE': {
      const { questionText, state: choiceState } = action.payload;
      return {
        ...state,
        choiceStates: { ...state.choiceStates, [questionText]: choiceState },
      };
    }
    case 'SET_CHAT_FOCUSED':
      return state.isChatFocused === action.payload
        ? state
        : { ...state, isChatFocused: action.payload };
    case 'SET_NOTES': {
      const { questionText, notes } = action.payload;
      if ((state.annotations[questionText]?.notes ?? '') === notes)
        return state;
      return {
        ...state,
        annotations: {
          ...state.annotations,
          [questionText]: { ...state.annotations[questionText], notes },
        },
      };
    }
    case 'SET_EDITING_CUSTOM': {
      if (state.isEditingCustomOption === action.payload.isEditing) {
        return state;
      }
      return {
        ...state,
        isEditingCustomOption: action.payload.isEditing,
      };
    }
    case 'SUBMIT': {
      return {
        ...state,
        submitted: true,
      };
    }
    default: {
      action satisfies never;
      return state;
    }
  }
}

/**
 * Props for the AskUserDialog component.
 */
interface AskUserDialogProps {
  getPreferredEditor?: () => EditorType | undefined;
  /**
   * The list of questions to ask the user.
   */
  questions: Question[];
  /**
   * Callback fired when the user submits their answers.
   * Returns a map of question text to answer string and, for preview
   * questions, the selected preview and optional notes.
   */
  onSubmit: (
    answers: { [questionText: string]: string },
    annotations?: { [questionText: string]: QuestionAnnotation },
  ) => void;
  /**
   * Callback fired when the user cancels the dialog (e.g. via Escape).
   */
  onCancel: (feedback?: string) => void;
  /**
   * Optional callback to notify parent when text input is active.
   * Useful for managing global keypress handlers.
   */
  onActiveTextInputChange?: (active: boolean) => void;
  /**
   * Width of the dialog.
   */
  width: number;
  /**
   * Height constraint for scrollable content.
   */
  availableHeight?: number;
  /**
   * Custom keyboard shortcut hints (e.g., ["Ctrl+P to edit"])
   */
  extraParts?: string[];
}

interface ReviewViewProps {
  questions: Question[];
  answers: { [questionText: string]: string };
  onSubmit: () => void;
  onCancel: () => void;
}

const ReviewView: React.FC<ReviewViewProps> = ({
  questions,
  answers,
  onSubmit,
  onCancel,
}) => {
  const hasUnanswered = questions.some((q) => !answers[q.question]);
  const [selectedAction, setSelectedAction] = useState<'submit' | 'cancel'>(
    'submit',
  );
  const isSubmitSelected = selectedAction === 'submit';
  const isCancelSelected = selectedAction === 'cancel';

  // Handle review confirmation actions through the Confirmation context.
  useRegisterKeyboardContext('Confirmation', true);
  useRegisterActionHandlers('Confirmation', {
    'confirm:yes': () => {
      if (selectedAction === 'submit') {
        onSubmit();
      } else {
        onCancel();
      }
      return true;
    },
    'confirm:no': () => {
      onCancel();
      return true;
    },
    'confirm:navigate:up': () => {
      setSelectedAction('submit');
      return true;
    },
    'confirm:navigate:down': () => {
      setSelectedAction('cancel');
      return true;
    },
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          Review your answers:
        </Text>
      </Box>

      {hasUnanswered && (
        <Box marginBottom={1}>
          <WarningMessage text="You have not answered all questions" />
        </Box>
      )}

      <Box flexDirection="column">
        {questions
          .filter((q) => !!answers[q.question])
          .map((q) => (
            <Box
              key={q.question}
              flexDirection="column"
              marginLeft={1}
              marginBottom={1}
            >
              <Text color={theme.text.primary}>{q.question}</Text>
              <Box marginLeft={2}>
                <Text color={theme.status.success}>
                  → {answers[q.question]}
                </Text>
              </Box>
            </Box>
          ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>
            Ready to submit your answers?
          </Text>
        </Box>
        <Box>
          <Text
            color={
              isSubmitSelected ? theme.status.success : theme.text.secondary
            }
          >
            {isSubmitSelected ? '❯ ' : '  '}Submit answers
          </Text>
        </Box>
        <Box>
          <Text
            color={isCancelSelected ? theme.status.error : theme.text.secondary}
          >
            {isCancelSelected ? '❯ ' : '  '}Cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

/** Chat is a separate focus target below the question controls. */
function ChatRow({ focused, number }: { focused: boolean; number?: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <HorizontalLine />
      <Text color={focused ? theme.ui.focus : theme.text.primary}>
        {focused ? figures.pointer : ' '}{' '}
        {number === undefined ? '' : `${number}. `}Chat about this
      </Text>
    </Box>
  );
}

function useBlockQuestionTabs(active: boolean) {
  useRegisterActionHandlers(
    'Dialog',
    {
      'dialog:tab:next': () => true,
      'dialog:tab:previous': () => true,
      'dialog:navigate:left': () => true,
      'dialog:navigate:right': () => true,
    },
    active,
    { prepend: true },
  );
}

interface ChoiceState {
  /** Option indices; options.length denotes the custom response. */
  selected: number[];
  text: string;
}
const EMPTY_CHOICE_STATE: ChoiceState = { selected: [], text: '' };

function choiceAnswer(question: Question, state: ChoiceState): string {
  return state.selected
    .map((index) =>
      index === question.options.length
        ? state.text
        : question.options[index]?.label,
    )
    .filter((value): value is string => !!value?.trim())
    .join(', ');
}

/** Ordinary questions share an input row, while confirmation remains mode-specific. */
function ChoiceQuestionView({
  question,
  state,
  onStateChange,
  onAnswer,
  onChat,
  onChatFocusChange,
  onEditingCustomOption,
  getPreferredEditor,
  availableWidth,
  availableHeight,
  isLastQuestion,
}: {
  question: Question;
  state: ChoiceState;
  onStateChange: (state: ChoiceState) => void;
  onAnswer: (answer: string) => void;
  onChat: () => void;
  onChatFocusChange: (focused: boolean) => void;
  onEditingCustomOption: (editing: boolean) => void;
  getPreferredEditor?: () => EditorType | undefined;
  availableWidth: number;
  availableHeight?: number;
  isLastQuestion: boolean;
}) {
  const multi = !!question.multiSelect;
  const customIndex = question.options.length;
  const submitIndex = customIndex + 1;
  const chatIndex = customIndex + (multi ? 2 : 1);
  const keyMatchers = useKeyMatchers();
  const { rows } = useTerminalSize();
  const inputLayout = resolveInlineSelectionInputLayout(availableWidth - 8);
  const input = useTextBuffer({
    initialText: state.text,
    initialCursorOffset: state.text.length,
    getPreferredEditor,
    viewport: inputLayout.viewport,
  });
  const text = expandPastePlaceholders(input.text, input.pastedContent);
  const items = useMemo(
    () =>
      Array.from({ length: chatIndex + 1 }, (_, index) => ({
        key: String(index),
        value: index,
      })),
    [chatIndex],
  );
  const select = (index: number) => {
    if (index === chatIndex) {
      onChat();
      return;
    }
    if (multi && index === submitIndex) {
      onAnswer(choiceAnswer(question, { ...state, text }));
      return;
    }
    if (multi) {
      onStateChange({
        text,
        selected: state.selected.includes(index)
          ? state.selected.filter((i) => i !== index)
          : [...state.selected, index],
      });
    } else if (index !== customIndex || text.trim()) {
      const next = { text, selected: [index] };
      onStateChange(next);
      onAnswer(choiceAnswer(question, next));
    }
  };
  const { activeIndex, setActiveIndex } = useSelectionList({
    items,
    onSelect: (index) => {
      // Enter in a multi-select input edits the selection, not the question step.
      if (multi && index === customIndex) return;
      select(index);
    },
    enableNumericSelection: false,
  });
  const editing = activeIndex === customIndex;
  const chatFocused = activeIndex === chatIndex;
  const lastText = useRef(text);
  useEffect(() => {
    if (lastText.current === text) return;
    lastText.current = text;
    const selected = multi
      ? text
        ? state.selected.includes(customIndex)
          ? state.selected
          : [...state.selected, customIndex]
        : state.selected.filter((i) => i !== customIndex)
      : state.selected;
    onStateChange({ selected, text });
  }, [text, multi, customIndex, state.selected, onStateChange]);
  useEffect(() => {
    onEditingCustomOption(editing);
    return () => onEditingCustomOption(false);
  }, [editing, onEditingCustomOption]);
  useEffect(() => {
    onChatFocusChange(chatFocused);
    return () => onChatFocusChange(false);
  }, [chatFocused, onChatFocusChange]);

  useAskUserInputRouting(input, editing);
  useBlockQuestionTabs(chatFocused || (multi && activeIndex === submitIndex));
  useRegisterActionHandlers(
    'Dialog',
    {
      'dialog:tab:next': () => {
        if (multi && editing) setActiveIndex(submitIndex);
        return true;
      },
      'dialog:tab:previous': () => {
        if (multi) setActiveIndex(Math.max(0, activeIndex - 1));
        return true;
      },
    },
    editing || (multi && activeIndex === submitIndex),
    { prepend: true },
  );
  const linesPerItem =
    multi && !question.options.some((option) => option.description) ? 1 : 2;
  const visibleCount = Math.min(
    customIndex + 1,
    5,
    Math.max(
      1,
      Math.floor(
        Math.min(
          rows - 8,
          availableHeight === undefined ? Infinity : availableHeight - 5,
        ) / linesPerItem,
      ),
    ),
  );
  useRegisterFallbackHandler(
    'Select',
    (key) => {
      if (editing) return false;
      if (!chatFocused && keyMatchers[Command.PAGE_DOWN](key)) {
        setActiveIndex(Math.min(customIndex, activeIndex + visibleCount));
        return true;
      }
      if (!chatFocused && keyMatchers[Command.PAGE_UP](key)) {
        setActiveIndex(Math.max(0, activeIndex - visibleCount));
        return true;
      }
      if (
        multi &&
        !chatFocused &&
        keyMatchers[Command.ASK_USER_TOGGLE_OPTION](key)
      ) {
        if (activeIndex <= customIndex) select(activeIndex);
        return true;
      }
      if (key.ctrl || key.alt || !/^[1-9]$/.test(key.sequence)) return false;
      const index = Number(key.sequence) - 1;
      // Chat is numbered customIndex + 2; the multi-select Submit row has no number.
      if (index === customIndex + 1) {
        onChat();
        return true;
      }
      if (chatFocused || index > customIndex) return true;
      if (multi) select(index);
      else if (index === customIndex && !text.trim()) setActiveIndex(index);
      else select(index);
      return true;
    },
    true,
    { prepend: true },
  );

  const start = calculateCenteredWindow(
    Math.min(activeIndex, customIndex),
    customIndex + 1,
    visibleCount,
  );
  const end = start + visibleCount;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary} wrap="wrap">
          {question.question}
        </Text>
      </Box>
      <Box flexDirection="column">
        {items.slice(start, end).map(({ value: index }) => {
          const focused = activeIndex === index && !chatFocused;
          const selected = state.selected.includes(index);
          const color = selected
            ? theme.status.success
            : focused
              ? theme.ui.focus
              : theme.text.primary;
          const custom = index === customIndex;
          const pointer = focused
            ? figures.pointer
            : index === start && start > 0
              ? figures.arrowUp
              : index === end - 1 && end <= customIndex
                ? figures.arrowDown
                : ' ';
          return (
            <Box key={index} flexDirection="column">
              <Box flexDirection="row" alignItems="flex-start">
                <Text color={focused ? theme.ui.focus : theme.text.secondary}>
                  {pointer}{' '}
                </Text>
                <Text dimColor>{index + 1}. </Text>
                {multi && (
                  <Text
                    color={selected ? theme.status.success : theme.text.primary}
                  >
                    [{selected ? '✓' : ' '}]{' '}
                  </Text>
                )}
                {custom ? (
                  focused ? (
                    <InputField
                      variant="inline"
                      buffer={input}
                      placeholder={multi ? 'Type something' : 'Type something.'}
                      onSubmit={() => {
                        if (!multi) select(customIndex);
                      }}
                      onKeyBeforeInput={(key) => {
                        if (
                          !multi ||
                          !keyMatchers[Command.ASK_USER_SUBMIT_SELECTION](key)
                        )
                          return false;
                        onAnswer(choiceAnswer(question, { ...state, text }));
                        return true;
                      }}
                      focus
                      width={inputLayout.fieldWidth}
                    />
                  ) : (
                    <Text
                      color={
                        selected
                          ? theme.status.success
                          : text
                            ? theme.text.primary
                            : theme.text.secondary
                      }
                    >
                      {text || (multi ? 'Type something' : 'Type something.')}
                    </Text>
                  )
                ) : (
                  <Text color={color} wrap="wrap">
                    {question.options[index].label}
                  </Text>
                )}
                {!multi && selected && (
                  <Text color={theme.status.success}> ✓</Text>
                )}
              </Box>
              {!custom && question.options[index].description && (
                <Box paddingLeft={multi ? 7 : 5}>
                  <Text color={color} dimColor>
                    <RenderInline
                      text={question.options[index].description}
                      defaultColor={color}
                    />
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      {multi && (
        <Box>
          <Text
            color={
              activeIndex === submitIndex ? theme.ui.focus : theme.text.primary
            }
          >
            {activeIndex === submitIndex ? figures.pointer : ' '}
          </Text>
          <Box marginLeft={3}>
            <Text
              bold
              color={
                activeIndex === submitIndex
                  ? theme.ui.focus
                  : theme.text.primary
              }
            >
              {isLastQuestion ? 'Submit' : 'Next'}
            </Text>
          </Box>
        </Box>
      )}
      <ChatRow focused={chatFocused} number={customIndex + 2} />
    </Box>
  );
}

// ============== Preview Question View (single-select) ==============

/** A single-select question that has at least one option preview. */
function isPreviewQuestion(question: Question): boolean {
  return !question.multiSelect && question.options.some((o) => o.preview);
}

interface PreviewQuestionViewProps {
  getPreferredEditor?: () => EditorType | undefined;
  question: Question;
  previews: readonly string[];
  onAnswer: (answer: string, annotation: QuestionAnnotation) => void;
  onChat: (notes: string) => void;
  onNotesChange: (notes: string) => void;
  onEditingNotes?: (editing: boolean) => void;
  availableWidth: number;
  availableHeight?: number;
  initialAnswer?: string;
  initialAnnotation?: QuestionAnnotation;
}

type PreviewSelection = { type: 'option'; index: number } | { type: 'chat' };

/** Preview options share a width; navigation never commits an answer. */
const PreviewQuestionView: React.FC<PreviewQuestionViewProps> = ({
  question,
  getPreferredEditor,
  previews,
  onAnswer,
  onChat,
  onNotesChange,
  onEditingNotes,
  availableWidth,
  availableHeight,
  initialAnswer,
  initialAnnotation,
}) => {
  const questionOptions = question.options;
  const initialOptionIndex = Math.max(
    0,
    questionOptions.findIndex((option) => option.label === initialAnswer),
  );
  const [focusedOptionIndex, setFocusedOptionIndex] =
    useState(initialOptionIndex);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const { rows } = useTerminalSize();
  const keyMatchers = useKeyMatchers();
  const notesKey = formatCommand(Command.ASK_USER_ADD_NOTES);
  const leftWidth = Math.min(
    30,
    Math.max(18, Math.floor(availableWidth * 0.4)),
  );
  const previewWidth = Math.max(5, availableWidth - leftWidth - 4);
  // This budget depends on terminal geometry, not the controls area's height.
  const previewMaxLines = Math.max(
    1,
    Math.min(
      rows - 26,
      availableHeight === undefined ? Infinity : availableHeight - 8,
    ),
  );
  const initialNotes = initialAnnotation?.notes ?? '';
  const notesInputLayout = resolveInlineSelectionInputLayout(
    Math.max(1, Math.min(60, previewWidth - 7)),
  );
  const notesInput = useTextBuffer({
    initialText: initialNotes,
    getPreferredEditor,
    initialCursorOffset: initialNotes.length,
    viewport: notesInputLayout.viewport,
  });
  const notesValue = expandPastePlaceholders(
    notesInput.text,
    notesInput.pastedContent,
  );

  useEffect(() => {
    onNotesChange(notesValue);
  }, [notesValue, onNotesChange]);

  // Escape leaves the notes editor without erasing the draft.
  useAskUserInputRouting(notesInput, isEditingNotes, false);
  useRegisterActionHandlers(
    'Dialog',
    {
      'dialog:escape': () => {
        setIsEditingNotes(false);
        return true;
      },
      'dialog:tab:next': () => true,
      'dialog:tab:previous': () => true,
    },
    isEditingNotes,
    { prepend: true },
  );

  useEffect(() => {
    onEditingNotes?.(isEditingNotes);
    return () => onEditingNotes?.(false);
  }, [isEditingNotes, onEditingNotes]);

  const items = useMemo(
    (): Array<SelectionListItem<PreviewSelection>> => [
      ...questionOptions.map((_, index) => ({
        key: `preview-option-${index}`,
        value: { type: 'option' as const, index },
      })),
      {
        key: 'preview-chat',
        value: { type: 'chat' as const },
        hideNumber: true,
      },
    ],
    [questionOptions],
  );

  const answerOption = useCallback(
    (index: number) => {
      const option = questionOptions[index];
      if (!option) return;
      const notes = notesValue.trim();
      onAnswer(option.label, {
        ...(option.preview ? { preview: option.preview } : {}),
        ...(notes ? { notes } : {}),
      });
    },
    [questionOptions, notesValue, onAnswer],
  );

  const [isChatFocused, setIsChatFocused] = useState(false);
  useSelectionList({
    items,
    initialIndex: initialOptionIndex,
    onHighlight: (value) => {
      setIsChatFocused(value.type === 'chat');
      if (value.type === 'option') setFocusedOptionIndex(value.index);
    },
    onSelect: (value) => {
      if (value.type === 'chat') onChat(notesValue.trim());
      else answerOption(value.index);
    },
    isFocused: !isEditingNotes,
    showNumbers: true,
    selectOnNumericInput: false,
    enableNumericSelection: !isChatFocused,
  });
  // Keep parent tab navigation active while Chat is focused.
  useRegisterFallbackHandler(
    'Select',
    (key) => {
      if (!keyMatchers[Command.ASK_USER_ADD_NOTES](key)) return false;
      setIsEditingNotes(true);
      return true;
    },
    !isEditingNotes && !isChatFocused,
  );

  const handleNotesSubmit = () => {
    setIsEditingNotes(false);
    const selectedIndex = questionOptions.findIndex(
      (option) => option.label === initialAnswer,
    );
    if (selectedIndex >= 0) answerOption(selectedIndex);
    else if (notesValue.trim())
      onAnswer(NOTES_ONLY_ANSWER, { notes: notesValue.trim() });
  };
  const focusedOption = questionOptions[focusedOptionIndex];
  const previewText = focusedOption?.preview ?? 'No preview for this option.';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary} wrap="wrap">
          {question.question}
        </Text>
      </Box>
      <Box flexDirection="row" alignItems="flex-start" gap={4}>
        <Box width={leftWidth} flexShrink={0} flexDirection="column">
          {questionOptions.map((option, index) => {
            const focused = focusedOptionIndex === index;
            const selected = initialAnswer === option.label;
            return (
              <Box key={option.label}>
                <Text color={focused ? theme.ui.focus : theme.text.primary}>
                  {focused ? figures.pointer : ' '}
                  {` ${index + 1}. `}
                </Text>
                <Text
                  color={
                    selected
                      ? theme.status.success
                      : focused
                        ? theme.ui.focus
                        : theme.text.primary
                  }
                  bold={focused}
                  wrap="wrap"
                >
                  {option.label}
                  {selected ? ' ✓' : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <AskUserPreview
            text={previewText}
            previews={previews}
            maxWidth={previewWidth}
            maxLines={previewMaxLines}
          />
          <Box marginTop={1} gap={1}>
            <Text color={theme.text.secondary}>Notes:</Text>
            {isEditingNotes ? (
              <InputField
                variant="inline"
                buffer={notesInput}
                placeholder="Add optional notes"
                onSubmit={handleNotesSubmit}
                focus
                width={notesInputLayout.fieldWidth}
              />
            ) : (
              <Text color={theme.text.secondary} dimColor italic wrap="wrap">
                {notesValue || `press ${notesKey} to add notes`}
              </Text>
            )}
          </Box>
        </Box>
      </Box>
      <ChatRow focused={isChatFocused} />
    </Box>
  );
};

export const AskUserDialog: React.FC<AskUserDialogProps> = ({
  questions,
  getPreferredEditor,
  onSubmit,
  onCancel,
  onActiveTextInputChange,
  width,
  availableHeight: availableHeightProp,
  extraParts,
}) => {
  // Do NOT fall back to UIStateContext.availableTerminalHeight: this dialog
  // renders inside the controls area whose height feeds back into that value,
  // creating a loop (dialog size → controls height → availableTerminalHeight
  // → dialog size) that trips React's "Maximum update depth exceeded" guard.
  const availableHeight = availableHeightProp;

  const [state, dispatch] = useReducer(askUserDialogReducerLogic, initialState);
  const {
    answers,
    annotations,
    choiceStates,
    isChatFocused,
    isEditingCustomOption,
    submitted,
  } = state;

  const reviewTabIndex = questions.length;
  const hasMultiSelect = questions.some((q) => q.multiSelect);
  const showReviewTab = questions.length > 1 || hasMultiSelect;

  // Subtract BaseTabDialog chrome (tab bar + separator + footer margin + footer)
  // so child views receive only the height available for their content.
  const TAB_DIALOG_CHROME = showReviewTab ? 4 : 3; // with tabs: tab bar(1) + separator(1) + footer margin(1) + footer(1); without tabs: title(1) + separator(1) + footer(1)
  const contentAvailableHeight =
    availableHeight !== undefined
      ? Math.max(1, availableHeight - TAB_DIALOG_CHROME)
      : undefined;
  const tabCount = showReviewTab ? questions.length + 1 : questions.length;

  // BaseTabDialog handles keyboard navigation with clamped endpoints.
  // goToNextTab (clamping, no wrap) is only used for auto-advance on answer.
  const [currentIndex, setCurrentIndex] = useState(0);

  const goToNextTab = useCallback(() => {
    setCurrentIndex((prev) => Math.min(prev + 1, tabCount - 1));
  }, [tabCount]);

  const currentQuestionIndex = currentIndex;

  const handleChatFocusChange = useCallback((focused: boolean) => {
    dispatch({ type: 'SET_CHAT_FOCUSED', payload: focused });
  }, []);

  const handleEditingCustomOption = useCallback((isEditing: boolean) => {
    dispatch({ type: 'SET_EDITING_CUSTOM', payload: { isEditing } });
  }, []);

  useEffect(() => {
    onActiveTextInputChange?.(isEditingCustomOption);
    return () => {
      onActiveTextInputChange?.(false);
    };
  }, [isEditingCustomOption, onActiveTextInputChange]);

  const isOnReviewTab =
    showReviewTab && currentQuestionIndex === reviewTabIndex;

  useEffect(() => {
    if (submitted) {
      if (Object.keys(annotations).length > 0) {
        onSubmit(answers, annotations);
      } else {
        onSubmit(answers);
      }
    }
  }, [submitted, answers, annotations, onSubmit]);

  const currentQuestion = questions[currentQuestionIndex];
  const previews = useMemo(
    () =>
      questions.flatMap((question) =>
        question.multiSelect
          ? []
          : question.options.flatMap((option) =>
              option.preview ? [option.preview] : [],
            ),
      ),
    [questions],
  );
  const handleNotesChange = useCallback(
    (notes: string) => {
      if (currentQuestion)
        dispatch({
          type: 'SET_NOTES',
          payload: { questionText: currentQuestion.question, notes },
        });
    },
    [currentQuestion],
  );
  const handleChat = useCallback(
    (notes: string) => {
      const context = questions
        .map((question) => {
          const answer = answers[question.question];
          const savedNotes =
            question === currentQuestion
              ? notes
              : annotations[question.question]?.notes;
          return [
            `Question: ${question.question}`,
            answer ? `Answer: ${answer}` : 'No answer provided.',
            savedNotes ? `User notes: ${savedNotes}` : '',
            choiceStates[question.question]?.text &&
            choiceStates[question.question]?.text !== answer
              ? `User draft: ${choiceStates[question.question]?.text}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');
      onCancel(
        `The user wants to discuss these questions. Ask what they would like to clarify, then use their response to reformulate the questions if needed.\n\n${context}`,
      );
    },
    [questions, answers, annotations, choiceStates, currentQuestion, onCancel],
  );

  const handleAnswer = useCallback(
    (answer: string, annotation?: QuestionAnnotation) => {
      if (submitted || !currentQuestion) return;
      const questionText = currentQuestion.question;
      if (showReviewTab) {
        dispatch({
          type: 'SET_ANSWER',
          payload: { questionText, answer, annotation },
        });
        goToNextTab();
      } else {
        dispatch({
          type: 'SET_ANSWER',
          payload: { questionText, answer, annotation, submit: true },
        });
      }
    },
    [currentQuestion, showReviewTab, submitted, goToNextTab],
  );

  const handleReviewSubmit = useCallback(() => {
    if (submitted) return;
    dispatch({ type: 'SUBMIT' });
  }, [submitted]);

  const handleChoiceStateChange = useCallback(
    (state: ChoiceState) => {
      if (submitted || !currentQuestion) return;
      const questionText = currentQuestion.question;
      dispatch({ type: 'SET_CHOICE_STATE', payload: { questionText, state } });
      if (currentQuestion.multiSelect) {
        dispatch({
          type: 'SET_ANSWER',
          payload: {
            questionText,
            answer: choiceAnswer(currentQuestion, state),
          },
        });
      }
    },
    [submitted, currentQuestion],
  );

  // ─── BaseTabDialog tabs ───
  // Multiple questions or any multi-select: question tabs + Review tab.
  // A single ordinary or preview single-select shows only the title.
  const dialogTabs = useMemo((): TabItem[] => {
    if (!showReviewTab) return [];
    const questionTabs: TabItem[] = questions.map((q, i) => ({
      key: String(i),
      label: `${answers[q.question] ? '☒' : '☐'} ${q.header}`,
    }));
    questionTabs.push({
      key: 'review',
      label: 'Submit',
    });
    return questionTabs;
  }, [questions, showReviewTab, answers]);

  const activeTabKey = isOnReviewTab ? 'review' : String(currentQuestionIndex);

  const handleTabChange = useCallback(
    (key: string) => {
      if (key === 'review') {
        setCurrentIndex(reviewTabIndex);
      } else {
        setCurrentIndex(Number(key));
      }
    },
    [reviewTabIndex],
  );

  // Build extra hints for BaseTabDialog's auto-generated footer.
  // BTD auto-adds "Tab/←→ switch" (order 10) and "Esc back" (order 100)
  // via its internal tabNavHints and onClose handler, so we only supply
  // context-specific action hints here.
  const dynamicExtraHints = useMemo((): ShortcutHint[] => {
    const hints: ShortcutHint[] = [];

    if (isOnReviewTab) {
      hints.push({
        label: SHORTCUT_HINTS.SUBMIT,
        order: 30,
      });
    } else if (currentQuestion) {
      if (isEditingCustomOption) {
        const isEditingPreviewNotes = isPreviewQuestion(currentQuestion);
        hints.push({
          label: isEditingPreviewNotes
            ? `Enter submit notes · ${formatCommand(Command.OPEN_EXTERNAL_EDITOR)} edit notes`
            : `${currentQuestion.multiSelect ? formatCommand(Command.ASK_USER_SUBMIT_SELECTION) + ' select' : SHORTCUT_HINTS.SUBMIT} · ${formatCommand(Command.OPEN_EXTERNAL_EDITOR)} edit response`,
          order: 30,
        });
      } else {
        hints.push({ label: SHORTCUT_HINTS.SELECT, order: 30 });
      }

      if (isPreviewQuestion(currentQuestion) && !isEditingCustomOption) {
        hints.push({
          label: `${formatCommand(Command.ASK_USER_ADD_NOTES)} add notes`,
          order: 40,
        });
      }

      // When there's no review tab and not editing, show ↑↓ navigate
      if (!showReviewTab && !isEditingCustomOption) {
        hints.push({ label: SHORTCUT_HINTS.NAVIGATE, order: 20 });
      }
    }

    // Append caller-provided custom hint strings
    if (extraParts) {
      extraParts.forEach((part, i) => {
        hints.push({ label: part, order: 50 + i });
      });
    }

    return hints;
  }, [
    isOnReviewTab,
    currentQuestion,
    isEditingCustomOption,
    showReviewTab,
    extraParts,
  ]);

  // Quit handler: Ctrl+C cancels the dialog (side-effect) but returns false
  // to let the event bubble to AppContainer's interrupt counter.
  const quitHandlers = useMemo(
    () => ({
      'app:interrupt': () => {
        if (!isEditingCustomOption) {
          onCancel();
        }
        return false;
      },
    }),
    [isEditingCustomOption, onCancel],
  );

  useRegisterActionHandlers('Global', quitHandlers, !submitted);

  // Content to render inside BaseTabDialog
  const dialogContent = useMemo(() => {
    if (isOnReviewTab) {
      return (
        <ReviewView
          questions={questions}
          answers={answers}
          onSubmit={handleReviewSubmit}
          onCancel={onCancel}
        />
      );
    }

    if (!currentQuestion) return null;

    // Adjust width for content area padding (BaseTabDialog adds paddingX=1)
    const contentWidth = width - 2;

    if (isPreviewQuestion(currentQuestion)) {
      return (
        <PreviewQuestionView
          key={currentQuestionIndex}
          question={currentQuestion}
          onAnswer={handleAnswer}
          onEditingNotes={handleEditingCustomOption}
          previews={previews}
          getPreferredEditor={getPreferredEditor}
          onChat={handleChat}
          onNotesChange={handleNotesChange}
          availableWidth={contentWidth}
          availableHeight={contentAvailableHeight}
          initialAnswer={answers[currentQuestion.question]}
          initialAnnotation={annotations[currentQuestion.question]}
        />
      );
    }
    return (
      <ChoiceQuestionView
        key={currentQuestionIndex}
        question={currentQuestion}
        onAnswer={handleAnswer}
        onChat={() => handleChat('')}
        onChatFocusChange={handleChatFocusChange}
        getPreferredEditor={getPreferredEditor}
        state={choiceStates[currentQuestion.question] ?? EMPTY_CHOICE_STATE}
        onStateChange={handleChoiceStateChange}
        isLastQuestion={currentQuestionIndex === questions.length - 1}
        onEditingCustomOption={handleEditingCustomOption}
        availableWidth={contentWidth}
        availableHeight={contentAvailableHeight}
      />
    );
  }, [
    isOnReviewTab,
    currentQuestion,
    currentQuestionIndex,
    questions,
    answers,
    annotations,
    handleAnswer,
    handleReviewSubmit,
    onCancel,
    handleChoiceStateChange,
    handleEditingCustomOption,
    width,
    contentAvailableHeight,
    previews,
    handleChat,
    handleNotesChange,
    choiceStates,
    handleChatFocusChange,
    getPreferredEditor,
  ]);

  return (
    <BaseTabDialog
      title="Asking User"
      tabs={dialogTabs}
      activeKey={activeTabKey}
      onTabChange={handleTabChange}
      onClose={onCancel}
      isActive={!submitted}
      showSeparator={true}
      footer={
        isOnReviewTab
          ? `${SHORTCUT_HINTS.TAB_SWITCH} · ${SHORTCUT_HINTS.SELECT} · ${SHORTCUT_HINTS.CANCEL}`
          : isEditingCustomOption
            ? `${dynamicExtraHints.map((hint) => hint.label).join(' · ')} · ${SHORTCUT_HINTS.CANCEL}`
            : isChatFocused
              ? `${SHORTCUT_HINTS.NAVIGATE} · ${SHORTCUT_HINTS.SELECT} · ${SHORTCUT_HINTS.CANCEL}`
              : undefined
      }
      extraHints={dynamicExtraHints}
      orderedTabs={true}
      wrapTabs={false}
      defaultHintLabels={{
        tabSwitch: 'Tab/←→ navigate',
        goBack: SHORTCUT_HINTS.CANCEL,
      }}
    >
      {dialogContent}
    </BaseTabDialog>
  );
};
