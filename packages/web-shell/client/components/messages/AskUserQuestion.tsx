import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { PermissionRequest } from '../../adapters/types';
import type { QuestionAnswer } from '../../chat-core/contract';
import { useI18n } from '../../i18n';
import { isEditableTarget } from '../../utils/dom';
import { Spinner } from '../ui/spinner';
import { localizeToolDisplayName } from './toolFormatting';
import styles from './AskUserQuestion.module.css';
import { BrowserNotificationControl } from './BrowserNotificationControl';

interface Question {
  id?: string;
  question: string;
  header: string;
  options: { id?: string; label: string; description: string }[];
  multiSelect?: boolean;
  required?: boolean;
  allowText?: boolean;
  maxTextLength?: number;
  multilineText?: boolean;
}

function optionValue(index: number): string {
  return String(index);
}

function isQuestionRequired(question: Question): boolean {
  return question.required !== false;
}

function isQuestionTextAllowed(question: Question): boolean {
  return question.allowText !== false;
}

function questionRowCount(question: Question): number {
  return isQuestionTextAllowed(question)
    ? question.options.length + 1
    : question.options.length;
}

export type AskUserQuestionDraft = Record<
  string,
  { optionIds: string[]; text: string }
>;

interface AskUserQuestionProps {
  request: PermissionRequest;
  onConfirm: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
    structuredAnswers?: readonly QuestionAnswer[],
  ) => Promise<boolean>;
  onError: (error: unknown, fallback: string) => void;
  variant?: 'inline' | 'floating';
  /** Disables answering and submitting while keeping questions inspectable. */
  disabled?: boolean;
  /** Blocks only submission (Submit button and submit shortcuts) while keeping inputs editable. */
  submitDisabled?: boolean;
  /** Optional initial draft hydrated when a request mounts or changes identity. */
  initialDraft?: AskUserQuestionDraft;
  /** Emitted after user-driven answer edits so a host can preserve drafts across switches. */
  onDraftChange?: (draft: AskUserQuestionDraft) => void;
  customInputLabel?: string;
  /**
   * Opens a side task that explains the pending question before the user
   * answers. Omitted when the host has no side-task surface, which hides the
   * action entirely.
   */
  onAskDetails?: () => void;
  /**
   * Whether this question should pull keyboard focus to its first option when it
   * becomes the topmost one. Defaults to true. Split-view panes pass false so an
   * question in one pane doesn't steal focus from the pane the user is in; like
   * ToolApproval, keyboard handling is focus-scoped, so it stays operable once
   * the user tabs/clicks into it.
   */
  keyboardActive?: boolean;
}

function hasCustomAnswer(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function isQuestionAnswered(
  question: Question,
  index: number,
  multiSelections: Record<number, string[]>,
  answerMap: Record<number, string>,
  customMap: Record<number, string>,
): boolean {
  const custom = isQuestionTextAllowed(question) ? customMap[index] : undefined;
  if (hasCustomAnswer(custom)) return true;
  if (question.multiSelect) {
    return (multiSelections[index]?.length ?? 0) > 0;
  }
  const answer = answerMap[index];
  return (
    answer !== undefined &&
    question.options.some((_, optionIdx) => optionValue(optionIdx) === answer)
  );
}

function hydrateQuestionDraft(
  questions: readonly Question[],
  draft: AskUserQuestionDraft | undefined,
): {
  answers: Record<number, string>;
  selectedMulti: Record<number, string[]>;
  customInputs: Record<number, string>;
  firstSelectedIdx: number | null;
} {
  const answers: Record<number, string> = {};
  const selectedMulti: Record<number, string[]> = {};
  const customInputs: Record<number, string> = {};
  if (draft) {
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      if (!question) continue;
      const entry = draft[question.id ?? String(i)];
      if (!entry) continue;
      const allowText = isQuestionTextAllowed(question);
      const text = allowText ? entry.text : '';
      const matchedIndices: number[] = [];
      for (const optionId of entry.optionIds) {
        const idx = question.options.findIndex(
          (option) => option.id === optionId,
        );
        if (idx >= 0 && !matchedIndices.includes(idx)) {
          matchedIndices.push(idx);
        }
      }
      if (question.multiSelect) {
        if (matchedIndices.length > 0) {
          selectedMulti[i] = matchedIndices.map(optionValue);
        }
        if (text.length > 0) {
          customInputs[i] = text;
        }
      } else if (matchedIndices.length > 0) {
        answers[i] = optionValue(matchedIndices[0]!);
      } else if (text.length > 0) {
        customInputs[i] = text;
      }
    }
  }
  const firstQuestion = questions[0];
  if (
    firstQuestion &&
    isQuestionRequired(firstQuestion) &&
    !firstQuestion.multiSelect &&
    firstQuestion.options[0] &&
    answers[0] === undefined &&
    !(customInputs[0]?.length ?? 0)
  ) {
    answers[0] = optionValue(0);
  }
  let firstSelectedIdx: number | null = null;
  if (firstQuestion && questionRowCount(firstQuestion) > 0) {
    if (
      isQuestionTextAllowed(firstQuestion) &&
      (customInputs[0]?.length ?? 0) > 0
    ) {
      firstSelectedIdx = firstQuestion.options.length;
    } else if (!firstQuestion.multiSelect && answers[0] !== undefined) {
      firstSelectedIdx = Number(answers[0]);
    } else {
      firstSelectedIdx = 0;
    }
  }
  return { answers, selectedMulti, customInputs, firstSelectedIdx };
}

function buildQuestionDraft(
  questions: readonly Question[],
  multiSelections: Record<number, string[]>,
  answerMap: Record<number, string>,
  customMap: Record<number, string>,
): AskUserQuestionDraft {
  const draft: AskUserQuestionDraft = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (!question) continue;
    const text = isQuestionTextAllowed(question) ? (customMap[i] ?? '') : '';
    const selectedSet = question.multiSelect
      ? new Set(multiSelections[i] ?? [])
      : answerMap[i] !== undefined
        ? new Set([answerMap[i]])
        : new Set<string>();
    const optionIds = question.options
      .filter((_, index) => selectedSet.has(optionValue(index)))
      .map((option) => option.id)
      .filter((id): id is string => id !== undefined);
    if (optionIds.length > 0 || text.length > 0) {
      draft[question.id ?? String(i)] = { optionIds, text };
    }
  }
  return draft;
}

export function AskUserQuestion({
  request,
  onConfirm,
  onError,
  variant = 'inline',
  disabled = false,
  submitDisabled = false,
  initialDraft,
  onDraftChange,
  keyboardActive = true,
  customInputLabel,
  onAskDetails,
}: AskUserQuestionProps) {
  const submitShortcutLabel =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? '')
      ? '⌘↵'
      : 'Ctrl↵';
  const { t, isRtl } = useI18n();
  const questions = useMemo(
    () =>
      Array.isArray(request.rawInput?.questions)
        ? (request.rawInput.questions as Question[])
        : [],
    [request.rawInput],
  );
  const [initialState] = useState(() =>
    hydrateQuestionDraft(questions, initialDraft),
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    initialState.firstSelectedIdx,
  );
  const [answers, setAnswers] = useState<Record<number, string>>(
    initialState.answers,
  );
  const [customInputs, setCustomInputs] = useState<Record<number, string>>(
    initialState.customInputs,
  );
  const [selectedMulti, setSelectedMulti] = useState<Record<number, string[]>>(
    initialState.selectedMulti,
  );
  const [customFocused, setCustomFocused] = useState(false);
  const [multilineSession, setMultilineSession] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const submissionAttemptRef = useRef(0);
  // Roving-tabindex refs: option buttons (one per question option) plus the
  // "Other" trigger that reveals the custom input.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const customRef = useRef<HTMLButtonElement | null>(null);
  const selectedIdxRef = useRef<number | null>(selectedIdx);
  const selectedIdxByQuestionRef = useRef<Record<number, number | null>>({
    0: initialState.firstSelectedIdx,
  });
  const hydratedSourceRef = useRef({ questions, requestId: request.id });
  const focusAfterQuestionChangeRef = useRef(false);
  const focusCustomTriggerAfterEditRef = useRef(false);
  const focusCustomTriggerAfterSubmitFailureRef = useRef(false);
  const initialDraftRef = useRef(initialDraft);
  initialDraftRef.current = initialDraft;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const draftDirtyRef = useRef(false);
  selectedIdxRef.current = selectedIdx;
  const questionTextId = useId();
  const headingId = useId();

  useEffect(() => {
    if (
      hydratedSourceRef.current.questions === questions &&
      hydratedSourceRef.current.requestId === request.id
    ) {
      return;
    }
    hydratedSourceRef.current = { questions, requestId: request.id };
    const hydrated = hydrateQuestionDraft(questions, initialDraftRef.current);
    submittedRef.current = false;
    submissionAttemptRef.current++;
    draftDirtyRef.current = false;
    setSubmitting(false);
    setCollapsed(false);
    setCurrentIdx(0);
    // Sync the ref too so the focus effect (which runs in this same commit on a
    // new request) reads the fresh index, not the previous request's selection.
    selectedIdxByQuestionRef.current = { 0: hydrated.firstSelectedIdx };
    selectedIdxRef.current = hydrated.firstSelectedIdx;
    setSelectedIdx(hydrated.firstSelectedIdx);
    setAnswers(hydrated.answers);
    setCustomInputs(hydrated.customInputs);
    setSelectedMulti(hydrated.selectedMulti);
    setCustomFocused(false);
    focusCustomTriggerAfterSubmitFailureRef.current = false;
  }, [questions, request.id]);

  useEffect(() => {
    if (!draftDirtyRef.current || !onDraftChangeRef.current) return;
    onDraftChangeRef.current(
      buildQuestionDraft(questions, selectedMulti, answers, customInputs),
    );
  }, [answers, customInputs, questions, selectedMulti]);

  const current = questions[currentIdx];
  const isMulti = current?.multiSelect ?? false;
  const currentRequired = current ? isQuestionRequired(current) : true;
  const currentAllowText = current ? isQuestionTextAllowed(current) : true;
  const controlsDisabled = submitting || disabled;
  const submitBlocked = controlsDisabled || submitDisabled;
  const cancelOption = request.options.find(
    (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
  );

  const rememberSelectedIndex = useCallback(
    (idx: number | null) => {
      selectedIdxByQuestionRef.current[currentIdx] = idx;
      selectedIdxRef.current = idx;
      setSelectedIdx(idx);
    },
    [currentIdx],
  );

  const buildResult = useCallback(
    (
      multiSelections: Record<number, string[]> = selectedMulti,
      answerMap: Record<number, string> = answers,
      customMap: Record<number, string> = customInputs,
    ): Record<string, string> => {
      const result: Record<string, string> = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q) continue;
        const custom = isQuestionTextAllowed(q) ? customMap[i] : undefined;
        if (q.multiSelect) {
          const multi = multiSelections[i] || [];
          const labels = multi.map(
            (selected) =>
              q.options.find((_, index) => optionValue(index) === selected)
                ?.label ?? selected,
          );
          const all = hasCustomAnswer(custom) ? [...labels, custom] : labels;
          result[String(i)] = all.join(', ');
        } else {
          const selected = q.options.find(
            (_, index) => optionValue(index) === answerMap[i],
          );
          result[String(i)] =
            selected?.label || (hasCustomAnswer(custom) ? custom : '');
        }
      }
      return result;
    },
    [questions, selectedMulti, customInputs, answers],
  );

  const buildStructuredAnswers = useCallback(
    (
      multiSelections: Record<number, string[]> = selectedMulti,
      answerMap: Record<number, string> = answers,
      customMap: Record<number, string> = customInputs,
    ): readonly QuestionAnswer[] => {
      const rendered = buildResult(multiSelections, answerMap, customMap);
      const entries: QuestionAnswer[] = [];
      for (let i = 0; i < questions.length; i++) {
        const question = questions[i];
        if (!question) continue;
        const custom = isQuestionTextAllowed(question)
          ? customMap[i]
          : undefined;
        const selected = question.multiSelect
          ? (multiSelections[i] || [])
              .map((selection) => question.options[Number(selection)])
              .filter(
                (option): option is Question['options'][number] =>
                  option !== undefined,
              )
          : question.options.filter(
              (_, index) => optionValue(index) === answerMap[i],
            );
        // Unanswered optional questions are omitted from structured answers
        // (Managed backends reject answer objects with neither optionIds nor text).
        if (
          !isQuestionRequired(question) &&
          selected.length === 0 &&
          !hasCustomAnswer(custom)
        ) {
          continue;
        }
        const optionIds =
          selected.length > 0 &&
          question.options.every((option) => option.id !== undefined)
            ? selected.map((option) => option.id ?? '')
            : undefined;
        entries.push({
          questionId: question.id ?? String(i),
          value: rendered[String(i)] ?? '',
          ...(optionIds === undefined ? {} : { optionIds }),
          ...(hasCustomAnswer(custom) ? { text: custom } : {}),
        });
      }
      return entries;
    },
    [answers, buildResult, customInputs, questions, selectedMulti],
  );

  const submitDecision = useCallback(
    async (
      optionId: string,
      submittedAnswers?: Record<string, string>,
      structuredAnswers?: readonly QuestionAnswer[],
    ): Promise<void> => {
      if (submittedRef.current || disabled) return;
      submittedRef.current = true;
      const attempt = ++submissionAttemptRef.current;
      setSubmitting(true);
      try {
        const accepted =
          structuredAnswers === undefined
            ? await onConfirm(request.id, optionId, submittedAnswers)
            : await onConfirm(
                request.id,
                optionId,
                submittedAnswers,
                structuredAnswers,
              );
        if (!accepted) throw new Error(t('askUser.submitFailed'));
      } catch (error) {
        if (submissionAttemptRef.current !== attempt) return;
        submittedRef.current = false;
        setSubmitting(false);
        onError(error, t('askUser.submitFailed'));
      }
    },
    [disabled, onConfirm, onError, request.id, t],
  );

  const handleSubmit = useCallback(
    (
      submittedAnswers?: Record<string, string>,
      multiSelections?: Record<number, string[]>,
      answerMap?: Record<number, string>,
      customMap?: Record<number, string>,
    ) => {
      if (submittedRef.current || disabled || submitDisabled) return;
      const resolvedMulti = multiSelections ?? selectedMulti;
      const resolvedAnswers = answerMap ?? answers;
      const resolvedCustom = customMap ?? customInputs;
      const result =
        submittedAnswers ??
        buildResult(resolvedMulti, resolvedAnswers, resolvedCustom);
      if (
        !questions.every(
          (q, idx) =>
            !isQuestionRequired(q) ||
            isQuestionAnswered(
              q,
              idx,
              resolvedMulti,
              resolvedAnswers,
              resolvedCustom,
            ),
        )
      ) {
        return;
      }
      const submitOption = request.options.find((o) => o.kind === 'allow_once');
      if (!submitOption) {
        const message = t('askUser.submitOptionUnavailable');
        onError(new Error(message), message);
        return;
      }
      const carriesStructuredAnswers = questions.every(
        (question) =>
          question.id !== undefined &&
          question.options.every((option) => option.id !== undefined),
      );
      void submitDecision(
        submitOption.id,
        result,
        carriesStructuredAnswers
          ? buildStructuredAnswers(
              resolvedMulti,
              resolvedAnswers,
              resolvedCustom,
            )
          : undefined,
      );
    },
    [
      answers,
      buildResult,
      buildStructuredAnswers,
      customInputs,
      disabled,
      onError,
      questions,
      request.options,
      selectedMulti,
      submitDecision,
      submitDisabled,
      t,
    ],
  );

  const allQuestionsAnswered = questions.every(
    (q, idx) =>
      !isQuestionRequired(q) ||
      isQuestionAnswered(q, idx, selectedMulti, answers, customInputs),
  );

  const handleCancel = useCallback(() => {
    if (submittedRef.current || disabled || !cancelOption) return;
    void submitDecision(cancelOption.id);
  }, [cancelOption, disabled, submitDecision]);

  const focusCustomInput = useCallback(
    (initialValue?: string) => {
      if (!currentAllowText || controlsDisabled) return;
      if (initialValue !== undefined) {
        draftDirtyRef.current = true;
        setCustomInputs((prev) => ({ ...prev, [currentIdx]: initialValue }));
      }
      if (!isMulti) {
        if (currentIdx in answers) {
          draftDirtyRef.current = true;
        }
        setAnswers((prev) => {
          if (!(currentIdx in prev)) return prev;
          const next = { ...prev };
          delete next[currentIdx];
          return next;
        });
      }
      setMultilineSession(
        Boolean(current?.multilineText) ||
          Boolean((initialValue ?? customInputs[currentIdx])?.includes('\n')),
      );
      setCustomFocused(true);
    },
    [
      answers,
      controlsDisabled,
      current,
      currentAllowText,
      currentIdx,
      customInputs,
      isMulti,
    ],
  );

  const handleSelectOption = useCallback(
    (idx: number) => {
      if (!current || controlsDisabled) return;
      const isOther = currentAllowText && idx === current.options.length;
      if (isOther) {
        focusCustomInput();
        return;
      }
      if (idx < 0 || idx >= current.options.length) return;
      const value = optionValue(idx);
      draftDirtyRef.current = true;
      if (isMulti) {
        setSelectedMulti((prev) => {
          const selected = prev[currentIdx] || [];
          const next = selected.includes(value)
            ? selected.filter((selectedValue) => selectedValue !== value)
            : [...selected, value];
          return { ...prev, [currentIdx]: next };
        });
      } else {
        if (!currentRequired && answers[currentIdx] === value) {
          setAnswers((prev) => {
            const next = { ...prev };
            delete next[currentIdx];
            return next;
          });
          return;
        }
        const nextAnswers = { ...answers, [currentIdx]: value };
        setAnswers(nextAnswers);
        setCustomInputs((prev) => {
          if (!(currentIdx in prev)) return prev;
          const next = { ...prev };
          delete next[currentIdx];
          return next;
        });
      }
    },
    [
      answers,
      controlsDisabled,
      current,
      currentAllowText,
      currentIdx,
      currentRequired,
      focusCustomInput,
      isMulti,
    ],
  );

  const handleToggle = useCallback(
    (idx: number) => {
      if (!current || !isMulti || controlsDisabled) return;
      if (currentAllowText && idx === current.options.length) {
        focusCustomInput();
        return;
      }
      if (idx < 0 || idx >= current.options.length) return;
      const value = optionValue(idx);
      draftDirtyRef.current = true;
      setSelectedMulti((prev) => {
        const selected = prev[currentIdx] || [];
        const next = selected.includes(value)
          ? selected.filter((selectedValue) => selectedValue !== value)
          : [...selected, value];
        return { ...prev, [currentIdx]: next };
      });
    },
    [
      controlsDisabled,
      current,
      currentAllowText,
      currentIdx,
      focusCustomInput,
      isMulti,
    ],
  );

  // Unified option activation for click, native Enter/Space, and digit
  // shortcuts: the "Other" row reveals/focuses the custom input; otherwise
  // toggle (multi) or pick (single).
  const chooseOption = useCallback(
    (idx: number) => {
      if (!current || controlsDisabled) return;
      const total = questionRowCount(current);
      if (idx < 0 || idx >= total) return;
      rememberSelectedIndex(idx);
      if (currentAllowText && idx === current.options.length) {
        focusCustomInput();
        return;
      }
      if (isMulti) handleToggle(idx);
      else handleSelectOption(idx);
    },
    [
      controlsDisabled,
      current,
      currentAllowText,
      isMulti,
      focusCustomInput,
      handleToggle,
      handleSelectOption,
      rememberSelectedIndex,
    ],
  );

  // Move the selection to a specific option index, keeping focus, the roving
  // tabindex, and — for required single-select — the committed answer in sync,
  // so aria-checked follows focus per the radiogroup contract. Optional
  // single-select moves focus only so navigating never fabricates an answer.
  const selectIndex = useCallback(
    (idx: number) => {
      if (!current) return;
      const total = questionRowCount(current);
      if (total === 0 || idx < 0 || idx >= total) return;
      rememberSelectedIndex(idx);
      if (currentAllowText && idx === current.options.length) {
        customRef.current?.focus();
        if (!isMulti && currentRequired && !controlsDisabled) {
          if (currentIdx in answers) {
            draftDirtyRef.current = true;
          }
          setAnswers((prev) => {
            if (!(currentIdx in prev)) return prev;
            const cleared = { ...prev };
            delete cleared[currentIdx];
            return cleared;
          });
        }
      } else {
        optionRefs.current[idx]?.focus();
        if (!isMulti && currentRequired && !controlsDisabled) {
          handleSelectOption(idx);
        }
      }
    },
    [
      answers,
      controlsDisabled,
      current,
      currentAllowText,
      currentIdx,
      currentRequired,
      isMulti,
      handleSelectOption,
      rememberSelectedIndex,
    ],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (!current) return;
      const total = questionRowCount(current);
      if (total === 0) return;
      // Compute from the ref (kept in sync) so rapid key repeats advance
      // correctly before re-render.
      const base = selectedIdxRef.current ?? 0;
      selectIndex((base + delta + total) % total);
    },
    [current, selectIndex],
  );

  const getSelectedIndexForQuestion = useCallback(
    (questionIdx: number): number | null => {
      const question = questions[questionIdx];
      if (!question) return null;
      const total = questionRowCount(question);
      if (total === 0) return null;
      if (Object.hasOwn(selectedIdxByQuestionRef.current, questionIdx)) {
        const stored = selectedIdxByQuestionRef.current[questionIdx];
        if (stored !== null && stored !== undefined && stored < total) {
          return stored;
        }
      }
      if (
        isQuestionTextAllowed(question) &&
        hasCustomAnswer(customInputs[questionIdx])
      ) {
        return question.options.length;
      }
      if (!question.multiSelect) {
        const answer = answers[questionIdx];
        const answerIdx = question.options.findIndex(
          (_, index) => optionValue(index) === answer,
        );
        if (answerIdx >= 0) return answerIdx;
      }
      return 0;
    },
    [answers, customInputs, questions],
  );

  const selectQuestion = useCallback(
    (nextIdx: number) => {
      const question = questions[nextIdx];
      if (!question) return;
      const nextSelectedIdx = getSelectedIndexForQuestion(nextIdx);
      selectedIdxByQuestionRef.current[nextIdx] = nextSelectedIdx;
      selectedIdxRef.current = nextSelectedIdx;
      setSelectedIdx(nextSelectedIdx);
      setCustomFocused(false);
      focusAfterQuestionChangeRef.current = true;
      setCurrentIdx(nextIdx);

      if (question.multiSelect || !isQuestionRequired(question)) return;
      const allowText = isQuestionTextAllowed(question);
      setAnswers((prev) =>
        prev[nextIdx] ||
        (allowText && (customInputs[nextIdx]?.length ?? 0) > 0) ||
        (allowText && nextSelectedIdx === question.options.length) ||
        !question.options[0]
          ? prev
          : { ...prev, [nextIdx]: optionValue(0) },
      );
    },
    [customInputs, getSelectedIndexForQuestion, questions],
  );

  const handlePrevious = useCallback(() => {
    if (currentIdx <= 0) return;
    selectQuestion(currentIdx - 1);
  }, [currentIdx, selectQuestion]);

  const handleNext = useCallback(() => {
    if (currentIdx >= questions.length - 1) return;
    selectQuestion(currentIdx + 1);
  }, [currentIdx, questions.length, selectQuestion]);

  const advanceQuestion = useCallback(
    (
      submittedAnswers?: Record<string, string>,
      multiSelections?: Record<number, string[]>,
      answerMap?: Record<number, string>,
      customMap?: Record<number, string>,
    ) => {
      setCustomFocused(false);
      if (currentIdx < questions.length - 1) {
        selectQuestion(currentIdx + 1);
        return;
      }
      if (customFocused) {
        focusCustomTriggerAfterSubmitFailureRef.current = true;
      }
      if (!submitBlocked) {
        handleSubmit(submittedAnswers, multiSelections, answerMap, customMap);
      }
    },
    [
      currentIdx,
      customFocused,
      handleSubmit,
      questions.length,
      selectQuestion,
      submitBlocked,
    ],
  );

  useEffect(() => {
    if (!focusAfterQuestionChangeRef.current || !current) return;
    focusAfterQuestionChangeRef.current = false;
    const idx = selectedIdxRef.current;
    if (idx === null) return;
    if (currentAllowText && idx === current.options.length) {
      customRef.current?.focus();
    } else {
      optionRefs.current[idx]?.focus();
    }
  }, [current, currentAllowText, currentIdx]);

  useEffect(() => {
    if (customFocused || !focusCustomTriggerAfterEditRef.current) return;
    focusCustomTriggerAfterEditRef.current = false;
    customRef.current?.focus();
  }, [customFocused]);

  useEffect(() => {
    if (
      customFocused ||
      submitting ||
      !focusCustomTriggerAfterSubmitFailureRef.current
    ) {
      return;
    }
    focusCustomTriggerAfterSubmitFailureRef.current = false;
    if (
      document.activeElement === document.body ||
      document.activeElement === document.documentElement
    ) {
      customRef.current?.focus();
    }
  }, [customFocused, submitting]);

  const handleCustomInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        focusCustomTriggerAfterEditRef.current = true;
        setCustomFocused(false);
      } else if (
        e.key === 'Enter' &&
        !(e.currentTarget.tagName === 'TEXTAREA' && e.shiftKey) &&
        !controlsDisabled &&
        hasCustomAnswer(customInputs[currentIdx])
      ) {
        e.preventDefault();
        e.stopPropagation();
        advanceQuestion();
      }
    },
    [advanceQuestion, controlsDisabled, currentIdx, customInputs],
  );

  // Panel-wide action shortcuts stay consistent across controls;
  // option navigation remains scoped to the roving-tabindex option group.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        e.currentTarget.querySelector('[data-web-shell-notification-open]') &&
        ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ||
          (!isEditableTarget(e.target) &&
            e.target instanceof Element &&
            e.target.closest('[data-web-shell-ask-option]') &&
            ((e.key >= '1' && e.key <= '9') ||
              e.key === 'Enter' ||
              e.key === ' ')))
      ) {
        e.preventDefault();
        return;
      }

      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (collapsed) {
        if (
          e.key === 'Escape' ||
          (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
        ) {
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!submitBlocked) handleSubmit();
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.key === 'Escape') {
        if (cancelOption) {
          e.preventDefault();
          if (!controlsDisabled) handleCancel();
        }
        return;
      }
      const isOptionTarget = (e.target as HTMLElement).closest(
        '[data-web-shell-ask-option]',
      );
      const prevKey = isRtl ? 'ArrowRight' : 'ArrowLeft';
      const nextKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
      if (!isOptionTarget) {
        if (!current) return;
        if (e.key === prevKey) {
          e.preventDefault();
          handlePrevious();
        } else if (e.key === nextKey) {
          e.preventDefault();
          handleNext();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          selectIndex(selectedIdxRef.current ?? 0);
        }
        return;
      }
      if (!current) return;
      const total = questionRowCount(current);
      if (e.key === prevKey) {
        e.preventDefault();
        handlePrevious();
      } else if (e.key === nextKey) {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (total > 0) selectIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (total > 0) selectIndex(total - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (controlsDisabled || total === 0) return;
        const idx = selectedIdxRef.current ?? 0;
        if (
          currentAllowText &&
          idx === current.options.length &&
          !hasCustomAnswer(customInputs[currentIdx])
        ) {
          chooseOption(idx);
        } else {
          if (isMulti && idx < current.options.length) {
            const value = optionValue(idx);
            const selected = selectedMulti[currentIdx] || [];
            if (!selected.includes(value)) {
              const nextSelectedMulti = {
                ...selectedMulti,
                [currentIdx]: [...selected, value],
              };
              draftDirtyRef.current = true;
              setSelectedMulti(nextSelectedMulti);
              advanceQuestion(
                buildResult(nextSelectedMulti),
                nextSelectedMulti,
              );
              return;
            }
          } else if (
            !isMulti &&
            !currentRequired &&
            idx < current.options.length
          ) {
            const value = optionValue(idx);
            if (answers[currentIdx] !== value) {
              const nextAnswers = { ...answers, [currentIdx]: value };
              const nextCustomInputs = { ...customInputs };
              delete nextCustomInputs[currentIdx];
              draftDirtyRef.current = true;
              setAnswers(nextAnswers);
              setCustomInputs(nextCustomInputs);
              advanceQuestion(
                buildResult(selectedMulti, nextAnswers, nextCustomInputs),
                selectedMulti,
                nextAnswers,
                nextCustomInputs,
              );
              return;
            }
          }
          advanceQuestion();
        }
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < total) {
          e.preventDefault();
          if (!controlsDisabled) chooseOption(idx);
        }
      }
    },
    [
      advanceQuestion,
      answers,
      buildResult,
      cancelOption,
      chooseOption,
      collapsed,
      controlsDisabled,
      current,
      currentAllowText,
      currentIdx,
      currentRequired,
      customInputs,
      handleCancel,
      handleNext,
      handlePrevious,
      handleSubmit,
      isMulti,
      isRtl,
      moveSelection,
      selectedMulti,
      selectIndex,
      submitBlocked,
    ],
  );

  // Pull focus to the current option (or the custom input while editing) when
  // this question becomes the topmost one or a new request arrives. See
  // ToolApproval's matching effect for the prev-flag reasoning.
  const prevKeyboardActiveRef = useRef(false);
  const prevRequestIdRef = useRef(request.id);
  useEffect(() => {
    const wasActive = prevKeyboardActiveRef.current;
    const prevRequestId = prevRequestIdRef.current;
    prevKeyboardActiveRef.current = keyboardActive;
    if (!keyboardActive || !current) return;
    const requestChanged = request.id !== prevRequestId;
    if (requestChanged && currentIdx !== 0) return;
    if (wasActive && !requestChanged) return;
    prevRequestIdRef.current = request.id;
    const idx = selectedIdxRef.current;
    if (idx === null) return;
    if (currentAllowText && idx === current.options.length) {
      customRef.current?.focus();
    } else {
      optionRefs.current[idx]?.focus();
    }
  }, [current, currentAllowText, currentIdx, keyboardActive, request.id]);

  if (questions.length === 0) return null;

  const displayIdx = Math.min(currentIdx, questions.length - 1);
  const isLastQuestion = currentIdx === questions.length - 1;
  const isSingleQuestion = questions.length === 1;
  const hasCurrentCustomAnswer =
    currentAllowText && hasCustomAnswer(customInputs[currentIdx]);
  const isEmptyCustomTrigger =
    currentAllowText &&
    current !== undefined &&
    !customFocused &&
    selectedIdx === current.options.length &&
    !hasCurrentCustomAnswer;
  const contextualShortcutHint =
    customFocused && !hasCurrentCustomAnswer
      ? t('askUser.shortcuts.inputEmpty')
      : isEmptyCustomTrigger
        ? t(
            isMulti
              ? 'askUser.shortcuts.customTriggerMulti'
              : 'askUser.shortcuts.customTrigger',
          )
        : customFocused
          ? t(
              isSingleQuestion
                ? 'askUser.shortcuts.inputSingle'
                : isLastQuestion
                  ? 'askUser.shortcuts.inputFinal'
                  : 'askUser.shortcuts.inputNext',
            )
          : isMulti
            ? t(
                isSingleQuestion
                  ? 'askUser.shortcuts.multiSingle'
                  : isLastQuestion
                    ? 'askUser.shortcuts.multiFinal'
                    : 'askUser.shortcuts.multiNext',
              )
            : t(
                isSingleQuestion
                  ? 'askUser.shortcuts.optionsSingle'
                  : isLastQuestion
                    ? 'askUser.shortcuts.optionsFinal'
                    : 'askUser.shortcuts.optionsNext',
              );
  const shortcutHint =
    currentIdx > 0 && !customFocused
      ? `${t('askUser.shortcuts.previous')} · ${contextualShortcutHint}`
      : contextualShortcutHint;

  return (
    <div
      className={`${styles.question} ${
        variant === 'floating' ? styles.floating : ''
      } ${collapsed ? styles.collapsed : ''}`}
      data-web-shell-ask-panel
      role="dialog"
      tabIndex={-1}
      aria-label={localizeToolDisplayName('ask_user_question', t)}
      // aria-labelledby wins over aria-label, so when expanded name the dialog
      // with BOTH the tool name and the question (otherwise the tool-name
      // context is dropped). The tool-name span is display:none but accname
      // still uses a directly-referenced hidden element's text.
      aria-labelledby={collapsed ? undefined : `${headingId} ${questionTextId}`}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        if (isEditableTarget(target) || target.closest('button, a[href]')) {
          return;
        }
        e.currentTarget.focus();
      }}
      onKeyDown={handleKeyDown}
    >
      {/* Header line like CLI */}
      <div className={styles.titleLine}>
        <span className={styles.icon} aria-hidden="true">
          ?
        </span>
        <span className={styles.toolName} id={headingId}>
          {localizeToolDisplayName('ask_user_question', t)}
        </span>
        <span className={styles.toolDesc}>
          {t('askUser.progress', {
            current: displayIdx + 1,
            total: questions.length,
          })}
        </span>

        {/* Progress indicator + collapse toggle */}
        <div className={styles.topRight}>
          <div className={styles.tabs}>
            {questions.map((_, i) => (
              <span
                key={i}
                className={`${styles.tab} ${
                  i === currentIdx ? styles.tabActive : ''
                }`}
                aria-hidden="true"
              />
            ))}
          </div>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('common.expand') : t('common.collapse')}
            title={collapsed ? t('common.expand') : t('common.collapse')}
          >
            {collapsed ? t('common.expand') : t('common.collapse')}
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className={`${styles.collapseIcon} ${
                collapsed ? styles.collapseIconCollapsed : ''
              }`}
            >
              <path
                d="M4 10l4-4 4 4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
          </button>
          <BrowserNotificationControl />
        </div>
      </div>

      {!collapsed && (
        <>
          {current ? (
            /* Question content */
            <>
              {/* Question text */}
              <p className={styles.text} id={questionTextId}>
                {current.question}
                {isMulti && (
                  <span className={styles.multiHint}>
                    {' '}
                    ({t('askUser.multiHint')})
                  </span>
                )}
              </p>
              <p className={styles.description}>{t('askUser.selectAnswer')}</p>

              {/* Options list — roving tabindex. Single-select uses radio
                  semantics (radiogroup/radio + aria-checked) so screen readers
                  convey mutual exclusivity; multi-select uses toggle buttons
                  (aria-pressed). The "Other" row is a trigger that reveals a
                  text input (kept out of the button so interactive content isn't
                  nested in a button). */}
              <div
                className={styles.options}
                role={isMulti ? 'group' : 'radiogroup'}
                aria-labelledby={questionTextId}
              >
                {current.options.map((opt, i) => {
                  const isActive = i === selectedIdx;
                  const isSelected = isMulti
                    ? (selectedMulti[currentIdx] || []).includes(optionValue(i))
                    : answers[currentIdx] === optionValue(i);

                  return (
                    <button
                      key={optionValue(i)}
                      type="button"
                      ref={(el) => {
                        optionRefs.current[i] = el;
                      }}
                      className={`${styles.option} ${
                        isSelected ? styles.optionSelected : ''
                      }`}
                      data-web-shell-ask-option
                      tabIndex={isActive ? 0 : -1}
                      role={isMulti ? undefined : 'radio'}
                      aria-checked={isMulti ? undefined : isSelected}
                      aria-pressed={isMulti ? isSelected : undefined}
                      aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                      disabled={controlsDisabled}
                      onClick={() => chooseOption(i)}
                      onFocus={() => rememberSelectedIndex(i)}
                    >
                      <span className={styles.pointer} aria-hidden="true">
                        {isActive ? '›' : ' '}
                      </span>
                      <span className={styles.optionNum} aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className={styles.optionContent}>
                        <span className={styles.optionLabel}>{opt.label}</span>
                        {opt.description && (
                          <span className={styles.optionDesc}>
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}

                {/* Other / custom input option */}
                {currentAllowText &&
                  (() => {
                    const isCustomActive =
                      selectedIdx === current.options.length;
                    const hasCustomValue = hasCustomAnswer(
                      customInputs[currentIdx],
                    );
                    return (
                      <div
                        className={`${styles.option} ${
                          hasCustomValue ? styles.optionSelected : ''
                        }`}
                        // The whole row is clickable (it carries cursor:pointer via
                        // styles.option), so clicks on the padding — not just the
                        // inner trigger/input — activate the "Other" option. The
                        // trigger button has no onClick of its own; its click (and
                        // native Enter/Space activation) bubbles up to here.
                        onClick={() => {
                          if (!controlsDisabled) {
                            chooseOption(current.options.length);
                          }
                        }}
                        onMouseDown={(e) => {
                          if (!customFocused || isEditableTarget(e.target)) {
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        <span className={styles.pointer} aria-hidden="true">
                          {isCustomActive ? '›' : ' '}
                        </span>
                        <span className={styles.editIcon} aria-hidden="true">
                          <svg viewBox="0 0 16 16">
                            <path
                              d="M3.2 10.9 4 7.8 10.8 1l3.2 3.2-6.8 6.8-3 .8zM10 1.8l3.2 3.2M3 14h10"
                              fill="none"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        {customFocused ? (
                          multilineSession ? (
                            <textarea
                              rows={Math.min(
                                6,
                                Math.max(
                                  1,
                                  (customInputs[currentIdx] || '').split('\n')
                                    .length,
                                ),
                              )}
                              className={`${styles.customInput} ${styles.customTextarea}`}
                              placeholder={
                                customInputLabel ?? t('askUser.typePlaceholder')
                              }
                              value={customInputs[currentIdx] || ''}
                              aria-label={
                                customInputLabel ?? t('askUser.typePlaceholder')
                              }
                              maxLength={current.maxTextLength}
                              disabled={controlsDisabled}
                              onChange={(e) => {
                                draftDirtyRef.current = true;
                                setCustomInputs({
                                  ...customInputs,
                                  [currentIdx]: e.target.value,
                                });
                              }}
                              // Clicking inside the textarea positions the caret;
                              // don't let it bubble to the row's onClick and
                              // re-trigger the option choice.
                              onClick={(e) => e.stopPropagation()}
                              onFocus={() =>
                                rememberSelectedIndex(current.options.length)
                              }
                              onBlur={() => setCustomFocused(false)}
                              onKeyDown={handleCustomInputKeyDown}
                              autoFocus
                            />
                          ) : (
                            <input
                              type="text"
                              className={styles.customInput}
                              placeholder={
                                customInputLabel ?? t('askUser.typePlaceholder')
                              }
                              value={customInputs[currentIdx] || ''}
                              aria-label={
                                customInputLabel ?? t('askUser.typePlaceholder')
                              }
                              maxLength={current.maxTextLength}
                              disabled={controlsDisabled}
                              onChange={(e) => {
                                draftDirtyRef.current = true;
                                setCustomInputs({
                                  ...customInputs,
                                  [currentIdx]: e.target.value,
                                });
                              }}
                              // Clicking inside the input positions the caret; don't
                              // let it bubble to the row's onClick and re-trigger the
                              // option choice.
                              onClick={(e) => e.stopPropagation()}
                              onFocus={() =>
                                rememberSelectedIndex(current.options.length)
                              }
                              onBlur={() => setCustomFocused(false)}
                              onKeyDown={handleCustomInputKeyDown}
                              autoFocus
                            />
                          )
                        ) : (
                          <button
                            type="button"
                            ref={customRef}
                            className={`${styles.customTrigger} ${
                              hasCustomValue ? '' : styles.optionPlaceholder
                            } ${
                              hasCustomValue &&
                              (customInputs[currentIdx]?.includes('\n') ??
                                false)
                                ? styles.customTriggerMultiline
                                : ''
                            }`}
                            data-web-shell-ask-option
                            tabIndex={isCustomActive ? 0 : -1}
                            role={isMulti ? undefined : 'radio'}
                            aria-checked={isMulti ? undefined : hasCustomValue}
                            aria-pressed={isMulti ? hasCustomValue : undefined}
                            aria-keyshortcuts={
                              current.options.length < 9
                                ? String(current.options.length + 1)
                                : undefined
                            }
                            disabled={controlsDisabled}
                            onFocus={() =>
                              rememberSelectedIndex(current.options.length)
                            }
                          >
                            {hasCustomValue
                              ? customInputs[currentIdx]
                              : (customInputLabel ??
                                t('askUser.typePlaceholder'))}
                          </button>
                        )}
                      </div>
                    );
                  })()}
              </div>
            </>
          ) : null}
          <div className={styles.actions}>
            <p className={styles.shortcuts} title={shortcutHint}>
              {shortcutHint}
            </p>
            {onAskDetails && (
              <button
                type="button"
                className={styles.detailsButton}
                disabled={controlsDisabled}
                title={t('askUser.askDetailsHint')}
                onClick={onAskDetails}
              >
                {t('askUser.askDetails')}
              </button>
            )}
            {cancelOption && (
              <button
                type="button"
                className={styles.ignoreButton}
                disabled={controlsDisabled}
                aria-keyshortcuts="Escape"
                data-shortcut="Esc"
                onClick={handleCancel}
              >
                {t('askUser.ignore')}
              </button>
            )}
            {questions.length > 1 && (
              <>
                <button
                  type="button"
                  className={styles.button}
                  disabled={submitting || currentIdx <= 0}
                  onClick={handlePrevious}
                >
                  {t('common.previous')}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={submitting || currentIdx >= questions.length - 1}
                  onClick={handleNext}
                >
                  {t('common.next')}
                </button>
              </>
            )}
            <button
              type="button"
              className={`${styles.button} ${styles.submitButton}`}
              disabled={submitBlocked || !allQuestionsAnswered}
              aria-busy={submitting}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              data-shortcut={submitShortcutLabel}
              onClick={() => handleSubmit()}
            >
              {submitting ? (
                <>
                  <Spinner
                    className={styles.submitSpinner}
                    aria-hidden="true"
                  />
                  {t('askUser.submitting')}
                </>
              ) : (
                t('askUser.submit')
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
