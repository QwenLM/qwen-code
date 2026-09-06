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
import { useI18n } from '../../i18n';
import { isEditableTarget } from '../../utils/dom';
import { Spinner } from '../ui/spinner';
import { localizeToolDisplayName } from './toolFormatting';
import styles from './AskUserQuestion.module.css';

interface Question {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect?: boolean;
}

interface AskUserQuestionProps {
  request: PermissionRequest;
  onConfirm: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => Promise<boolean>;
  onError: (error: unknown, fallback: string) => void;
  variant?: 'inline' | 'floating';
  customInputLabel?: string;
  /**
   * Whether this question should pull keyboard focus to its first option when it
   * becomes the topmost one. Defaults to true. Split-view panes pass false so an
   * question in one pane doesn't steal focus from the pane the user is in; like
   * ToolApproval, keyboard handling is focus-scoped, so it stays operable once
   * the user tabs/clicks into it.
   */
  keyboardActive?: boolean;
}

function hasCustomAnswer(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function AskUserQuestion({
  request,
  onConfirm,
  onError,
  variant = 'inline',
  keyboardActive = true,
  customInputLabel,
}: AskUserQuestionProps) {
  const submitShortcutLabel =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? '')
      ? '⌘↵'
      : 'Ctrl↵';
  const { t } = useI18n();
  const questions = useMemo(
    () =>
      Array.isArray(request.rawInput?.questions)
        ? (request.rawInput.questions as Question[])
        : [],
    [request.rawInput],
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [selectedMulti, setSelectedMulti] = useState<Record<number, string[]>>(
    {},
  );
  const [customFocused, setCustomFocused] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const submissionAttemptRef = useRef(0);
  // Roving-tabindex refs: option buttons (one per question option) plus the
  // "Other" trigger that reveals the custom input.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const customRef = useRef<HTMLButtonElement | null>(null);
  const selectedIdxRef = useRef<number | null>(selectedIdx);
  const selectedIdxByQuestionRef = useRef<Record<number, number | null>>({});
  const focusAfterQuestionChangeRef = useRef(false);
  const focusCustomTriggerAfterEditRef = useRef(false);
  const focusCustomTriggerAfterSubmitFailureRef = useRef(false);
  selectedIdxRef.current = selectedIdx;
  const questionTextId = useId();
  const headingId = useId();

  useEffect(() => {
    const firstQuestion = questions[0];
    submittedRef.current = false;
    submissionAttemptRef.current++;
    setSubmitting(false);
    setCollapsed(false);
    setCurrentIdx(0);
    // Sync the ref too so the focus effect (which runs in this same commit on a
    // new request) reads the fresh index, not the previous request's selection.
    const firstSelectedIdx = firstQuestion ? 0 : null;
    selectedIdxByQuestionRef.current = { 0: firstSelectedIdx };
    selectedIdxRef.current = firstSelectedIdx;
    setSelectedIdx(firstSelectedIdx);
    setAnswers(
      firstQuestion && !firstQuestion.multiSelect && firstQuestion.options[0]
        ? { 0: firstQuestion.options[0].label }
        : {},
    );
    setCustomInputs({});
    setSelectedMulti({});
    setCustomFocused(false);
    focusCustomTriggerAfterSubmitFailureRef.current = false;
  }, [questions, request.id]);

  const current = questions[currentIdx];
  const isMulti = current?.multiSelect ?? false;

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
    ): Record<string, string> => {
      const result: Record<string, string> = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q) continue;
        if (q.multiSelect) {
          const multi = multiSelections[i] || [];
          const custom = customInputs[i];
          const all = hasCustomAnswer(custom) ? [...multi, custom] : multi;
          result[String(i)] = all.join(', ');
        } else {
          const custom = customInputs[i];
          result[String(i)] =
            answers[i] || (hasCustomAnswer(custom) ? custom : '');
        }
      }
      return result;
    },
    [questions, selectedMulti, customInputs, answers],
  );

  const submitDecision = useCallback(
    async (
      optionId: string,
      submittedAnswers?: Record<string, string>,
    ): Promise<void> => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const attempt = ++submissionAttemptRef.current;
      setSubmitting(true);
      try {
        const accepted = await onConfirm(
          request.id,
          optionId,
          submittedAnswers,
        );
        if (!accepted) throw new Error(t('askUser.submitFailed'));
      } catch (error) {
        if (submissionAttemptRef.current !== attempt) return;
        submittedRef.current = false;
        setSubmitting(false);
        onError(error, t('askUser.submitFailed'));
      }
    },
    [onConfirm, onError, request.id, t],
  );

  const handleSubmit = useCallback(
    (submittedAnswers?: Record<string, string>) => {
      if (submittedRef.current) return;
      const submitOption = request.options.find((o) => o.kind === 'allow_once');
      if (!submitOption) {
        const message = t('askUser.submitOptionUnavailable');
        onError(new Error(message), message);
        return;
      }
      void submitDecision(submitOption.id, submittedAnswers ?? buildResult());
    },
    [buildResult, onError, request.options, submitDecision, t],
  );

  const handleCancel = useCallback(() => {
    if (submittedRef.current) return;
    const cancelOption = request.options.find(
      (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
    );
    if (!cancelOption) return;
    void submitDecision(cancelOption.id);
  }, [request.options, submitDecision]);

  const focusCustomInput = useCallback(
    (initialValue?: string) => {
      if (initialValue !== undefined) {
        setCustomInputs((prev) => ({ ...prev, [currentIdx]: initialValue }));
      }
      if (!isMulti) {
        setAnswers((prev) => {
          if (!(currentIdx in prev)) return prev;
          const next = { ...prev };
          delete next[currentIdx];
          return next;
        });
      }
      setCustomFocused(true);
    },
    [currentIdx, isMulti],
  );

  const handleSelectOption = useCallback(
    (idx: number) => {
      if (!current) return;
      const isOther = idx === current.options.length;
      if (isOther) {
        focusCustomInput();
        return;
      }
      const label = current.options[idx].label;
      if (isMulti) {
        setSelectedMulti((prev) => {
          const selected = prev[currentIdx] || [];
          const next = selected.includes(label)
            ? selected.filter((l) => l !== label)
            : [...selected, label];
          return { ...prev, [currentIdx]: next };
        });
      } else {
        const nextAnswers = { ...answers, [currentIdx]: label };
        setAnswers(nextAnswers);
        setCustomInputs((prev) => {
          if (!(currentIdx in prev)) return prev;
          const next = { ...prev };
          delete next[currentIdx];
          return next;
        });
      }
    },
    [current, currentIdx, isMulti, answers, focusCustomInput],
  );

  const handleToggle = useCallback(
    (idx: number) => {
      if (!current || !isMulti) return;
      if (idx === current.options.length) {
        focusCustomInput();
        return;
      }
      const label = current.options[idx].label;
      setSelectedMulti((prev) => {
        const selected = prev[currentIdx] || [];
        const next = selected.includes(label)
          ? selected.filter((l) => l !== label)
          : [...selected, label];
        return { ...prev, [currentIdx]: next };
      });
    },
    [current, isMulti, currentIdx, focusCustomInput],
  );

  // Unified option activation for click, native Enter/Space, and digit
  // shortcuts: the "Other" row reveals/focuses the custom input; otherwise
  // toggle (multi) or pick (single).
  const chooseOption = useCallback(
    (idx: number) => {
      if (!current) return;
      rememberSelectedIndex(idx);
      if (idx === current.options.length) {
        focusCustomInput();
        return;
      }
      if (isMulti) handleToggle(idx);
      else handleSelectOption(idx);
    },
    [
      current,
      isMulti,
      focusCustomInput,
      handleToggle,
      handleSelectOption,
      rememberSelectedIndex,
    ],
  );

  // Move the selection to a specific option index, keeping focus, the roving
  // tabindex, and — for single-select — the committed answer in sync, so
  // aria-checked follows focus per the radiogroup contract. Moving to a regular
  // option commits it as the answer; moving to "Other" clears the regular
  // answer (the custom answer isn't committed until the user types it). Shared
  // by arrow navigation and Home/End so every path behaves identically.
  const selectIndex = useCallback(
    (idx: number) => {
      if (!current) return;
      rememberSelectedIndex(idx);
      if (idx === current.options.length) {
        customRef.current?.focus();
        if (!isMulti) {
          setAnswers((prev) => {
            if (!(currentIdx in prev)) return prev;
            const cleared = { ...prev };
            delete cleared[currentIdx];
            return cleared;
          });
        }
      } else {
        optionRefs.current[idx]?.focus();
        if (!isMulti) handleSelectOption(idx);
      }
    },
    [current, currentIdx, isMulti, handleSelectOption, rememberSelectedIndex],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (!current) return;
      const total = current.options.length + 1;
      // Compute from the ref (kept in sync) so rapid key repeats advance
      // correctly before re-render.
      const base = selectedIdxRef.current ?? 0;
      selectIndex((base + delta + total) % total);
    },
    [current, selectIndex],
  );

  const getSelectedIndexForQuestion = useCallback(
    (questionIdx: number): number | null => {
      if (Object.hasOwn(selectedIdxByQuestionRef.current, questionIdx)) {
        return selectedIdxByQuestionRef.current[questionIdx] ?? null;
      }
      const question = questions[questionIdx];
      if (!question) return null;
      if (hasCustomAnswer(customInputs[questionIdx])) {
        return question.options.length;
      }
      if (!question.multiSelect) {
        const answer = answers[questionIdx];
        const answerIdx = question.options.findIndex(
          (option) => option.label === answer,
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

      if (question.multiSelect) return;
      setAnswers((prev) =>
        prev[nextIdx] ||
        hasCustomAnswer(customInputs[nextIdx]) ||
        nextSelectedIdx === question.options.length ||
        !question.options[0]
          ? prev
          : { ...prev, [nextIdx]: question.options[0].label },
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
    (submittedAnswers?: Record<string, string>) => {
      setCustomFocused(false);
      if (currentIdx < questions.length - 1) {
        selectQuestion(currentIdx + 1);
        return;
      }
      if (customFocused) {
        focusCustomTriggerAfterSubmitFailureRef.current = true;
      }
      if (!submitting) handleSubmit(submittedAnswers);
    },
    [
      currentIdx,
      customFocused,
      handleSubmit,
      questions.length,
      selectQuestion,
      submitting,
    ],
  );

  useEffect(() => {
    if (!focusAfterQuestionChangeRef.current || !current) return;
    focusAfterQuestionChangeRef.current = false;
    const idx = selectedIdxRef.current ?? 0;
    if (idx === current.options.length) customRef.current?.focus();
    else optionRefs.current[idx]?.focus();
  }, [current, currentIdx]);

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
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        focusCustomTriggerAfterEditRef.current = true;
        setCustomFocused(false);
      } else if (
        e.key === 'Enter' &&
        hasCustomAnswer(customInputs[currentIdx])
      ) {
        e.preventDefault();
        e.stopPropagation();
        advanceQuestion();
      }
    },
    [advanceQuestion, currentIdx, customInputs],
  );

  // Panel-wide action shortcuts stay consistent across controls;
  // option navigation remains scoped to the roving-tabindex option group.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
        if (!submitting) handleSubmit();
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
        return;
      }
      const isOptionTarget = (e.target as HTMLElement).closest(
        '[data-web-shell-ask-option]',
      );
      if (!isOptionTarget) {
        if (!current) return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          handlePrevious();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          handleNext();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          selectIndex(selectedIdxRef.current ?? 0);
        }
        return;
      }
      if (!current) return;
      const total = current.options.length + 1;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevious();
      } else if (e.key === 'ArrowRight') {
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
        selectIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        selectIndex(total - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = selectedIdxRef.current ?? 0;
        if (
          idx === current.options.length &&
          !hasCustomAnswer(customInputs[currentIdx])
        ) {
          chooseOption(idx);
        } else {
          if (isMulti && idx < current.options.length) {
            const label = current.options[idx].label;
            const selected = selectedMulti[currentIdx] || [];
            if (!selected.includes(label)) {
              const nextSelectedMulti = {
                ...selectedMulti,
                [currentIdx]: [...selected, label],
              };
              setSelectedMulti(nextSelectedMulti);
              advanceQuestion(buildResult(nextSelectedMulti));
              return;
            }
          }
          advanceQuestion();
        }
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < total) {
          e.preventDefault();
          chooseOption(idx);
        }
      }
    },
    [
      advanceQuestion,
      buildResult,
      chooseOption,
      collapsed,
      current,
      currentIdx,
      customInputs,
      handleCancel,
      handleNext,
      handlePrevious,
      handleSubmit,
      isMulti,
      moveSelection,
      selectedMulti,
      selectIndex,
      submitting,
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
    const idx = selectedIdxRef.current ?? 0;
    if (idx === current.options.length) customRef.current?.focus();
    else optionRefs.current[idx]?.focus();
  }, [current, currentIdx, keyboardActive, request.id]);

  if (questions.length === 0) return null;

  const displayIdx = Math.min(currentIdx, questions.length - 1);
  const isLastQuestion = currentIdx === questions.length - 1;
  const isSingleQuestion = questions.length === 1;
  const hasCurrentCustomAnswer = hasCustomAnswer(customInputs[currentIdx]);
  const isEmptyCustomTrigger =
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
            <svg
              viewBox="0 0 16 16"
              className={`${styles.collapseIcon} ${
                collapsed ? styles.collapseIconCollapsed : ''
              }`}
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
          </button>
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
                    ? (selectedMulti[currentIdx] || []).includes(opt.label)
                    : answers[currentIdx] === opt.label;

                  return (
                    <button
                      key={opt.label}
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
                      disabled={submitting}
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
                {(() => {
                  const isCustomActive = selectedIdx === current.options.length;
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
                        if (!submitting) chooseOption(current.options.length);
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
                          disabled={submitting}
                          onChange={(e) =>
                            setCustomInputs({
                              ...customInputs,
                              [currentIdx]: e.target.value,
                            })
                          }
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
                      ) : (
                        <button
                          type="button"
                          ref={customRef}
                          className={`${styles.customTrigger} ${
                            hasCustomValue ? '' : styles.optionPlaceholder
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
                          disabled={submitting}
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
            <button
              type="button"
              className={styles.ignoreButton}
              disabled={submitting}
              aria-keyshortcuts="Escape"
              data-shortcut="Esc"
              onClick={handleCancel}
            >
              {t('askUser.ignore')}
            </button>
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
              disabled={submitting}
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
