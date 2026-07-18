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
  ) => void;
  variant?: 'inline' | 'floating';
  /**
   * Whether this question should pull keyboard focus to its first option when it
   * becomes the topmost one. Defaults to true. Split-view panes pass false so an
   * question in one pane doesn't steal focus from the pane the user is in; like
   * ToolApproval, keyboard handling is focus-scoped, so it stays operable once
   * the user tabs/clicks into it.
   */
  keyboardActive?: boolean;
}

export function AskUserQuestion({
  request,
  onConfirm,
  variant = 'inline',
  keyboardActive = true,
}: AskUserQuestionProps) {
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
  const submittedRef = useRef(false);
  // Roving-tabindex refs: option buttons (one per question option) plus the
  // "Other" trigger that reveals the custom input.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const customRef = useRef<HTMLButtonElement | null>(null);
  const selectedIdxRef = useRef<number | null>(selectedIdx);
  selectedIdxRef.current = selectedIdx;
  const questionTextId = useId();
  const headingId = useId();

  useEffect(() => {
    const firstQuestion = questions[0];
    submittedRef.current = false;
    setCollapsed(false);
    setCurrentIdx(0);
    // Sync the ref too so the focus effect (which runs in this same commit on a
    // new request) reads the fresh index, not the previous request's selection.
    selectedIdxRef.current = firstQuestion?.options.length ? 0 : null;
    setSelectedIdx(firstQuestion?.options.length ? 0 : null);
    setAnswers(
      firstQuestion && !firstQuestion.multiSelect && firstQuestion.options[0]
        ? { 0: firstQuestion.options[0].label }
        : {},
    );
    setCustomInputs({});
    setSelectedMulti(
      firstQuestion?.multiSelect && firstQuestion.options[0]
        ? { 0: [firstQuestion.options[0].label] }
        : {},
    );
    setCustomFocused(false);
  }, [questions, request.id]);

  const current = questions[currentIdx];
  const isMulti = current?.multiSelect ?? false;

  const buildResult = useCallback((): Record<string, string> => {
    const result: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q) continue;
      if (q.multiSelect) {
        const multi = selectedMulti[i] || [];
        const custom = customInputs[i];
        const all = custom ? [...multi, custom] : multi;
        result[String(i)] = all.join(', ');
      } else {
        result[String(i)] = answers[i] || customInputs[i] || '';
      }
    }
    return result;
  }, [questions, selectedMulti, customInputs, answers]);

  const handleSubmit = useCallback(() => {
    if (submittedRef.current) return;
    const submitOption = request.options.find((o) => o.kind === 'allow_once');
    if (!submitOption) return;
    submittedRef.current = true;
    onConfirm(request.id, submitOption.id, buildResult());
  }, [buildResult, request, onConfirm]);

  const handleCancel = useCallback(() => {
    if (submittedRef.current) return;
    const cancelOption = request.options.find(
      (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
    );
    if (!cancelOption) return;
    submittedRef.current = true;
    onConfirm(request.id, cancelOption.id, undefined);
  }, [request, onConfirm]);

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
        const prev = selectedMulti[currentIdx] || [];
        const next = prev.includes(label)
          ? prev.filter((l) => l !== label)
          : [...prev, label];
        setSelectedMulti({ ...selectedMulti, [currentIdx]: next });
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
    [current, currentIdx, isMulti, selectedMulti, answers, focusCustomInput],
  );

  const handleToggle = useCallback(
    (idx: number) => {
      if (!current || !isMulti) return;
      if (idx === current.options.length) {
        focusCustomInput();
        return;
      }
      const label = current.options[idx].label;
      const prev = selectedMulti[currentIdx] || [];
      const next = prev.includes(label)
        ? prev.filter((l) => l !== label)
        : [...prev, label];
      setSelectedMulti({ ...selectedMulti, [currentIdx]: next });
    },
    [current, isMulti, selectedMulti, currentIdx, focusCustomInput],
  );

  // Unified option activation for click, native Enter/Space, and digit
  // shortcuts: the "Other" row reveals/focuses the custom input; otherwise
  // toggle (multi) or pick (single).
  const chooseOption = useCallback(
    (idx: number) => {
      if (!current) return;
      selectedIdxRef.current = idx;
      setSelectedIdx(idx);
      if (idx === current.options.length) {
        focusCustomInput();
        return;
      }
      if (isMulti) handleToggle(idx);
      else handleSelectOption(idx);
    },
    [current, isMulti, focusCustomInput, handleToggle, handleSelectOption],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (!current) return;
      const total = current.options.length + 1;
      // Compute from the ref (kept in sync) so rapid key repeats advance
      // correctly before re-render, and keep the state updater pure (no focus()
      // side effect inside it).
      const base = selectedIdxRef.current ?? 0;
      const next = (base + delta + total) % total;
      selectedIdxRef.current = next;
      setSelectedIdx(next);
      if (next === current.options.length) {
        customRef.current?.focus();
      } else {
        optionRefs.current[next]?.focus();
        // Single-select radiogroup: arrow keys change the selection, not just
        // the focus, so aria-checked (bound to `answers`) follows the option the
        // user moved to and Submit sends that option. The "Other" row is
        // excluded — arrowing to it focuses its trigger; the input opens on
        // Enter, not on arrow.
        if (!isMulti) handleSelectOption(next);
      }
    },
    [current, isMulti, handleSelectOption],
  );

  // Focus-scoped keyboard nav (fires only while focus is inside this question):
  // arrows/j/k move between options and the "Other" row, Home/End jump to the
  // ends, digits pick by position, Escape ignores. Enter/Space activate the
  // focused control natively; the custom <input> keeps its own arrow/caret keys
  // (guarded by isEditableTarget above).
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(e.target)) return;
      // Only react when focus is on an option (a roving-tabindex button or the
      // "Other" trigger) — not on the action buttons (Submit/Previous/Next) or
      // the collapse toggle. Otherwise a digit / j-k / Escape pressed while
      // focused there would silently pick an option or cancel the question; when
      // collapsed the options aren't even rendered, so the toggle is the only
      // focusable element and must not trigger any of this.
      if (!(e.target as HTMLElement).closest('[data-web-shell-ask-option]')) {
        return;
      }
      if (!current) return;
      const total = current.options.length + 1;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        selectedIdxRef.current = 0;
        setSelectedIdx(0);
        optionRefs.current[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = total - 1;
        selectedIdxRef.current = last;
        setSelectedIdx(last);
        if (last === current.options.length) customRef.current?.focus();
        else optionRefs.current[last]?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < total) {
          e.preventDefault();
          chooseOption(idx);
        }
      }
    },
    [current, moveSelection, handleCancel, chooseOption],
  );

  // Pull focus to the current option (or the custom input while editing) when
  // this question becomes the topmost one or a new request arrives. See
  // ToolApproval's matching effect for the prev-flag reasoning.
  const prevKeyboardActiveRef = useRef(false);
  const prevRequestIdRef = useRef(request.id);
  const optionCountRef = useRef(current?.options.length ?? 0);
  optionCountRef.current = current?.options.length ?? 0;
  useEffect(() => {
    const wasActive = prevKeyboardActiveRef.current;
    const prevRequestId = prevRequestIdRef.current;
    prevKeyboardActiveRef.current = keyboardActive;
    prevRequestIdRef.current = request.id;
    if (!keyboardActive) return;
    if (wasActive && request.id === prevRequestId) return;
    const idx = selectedIdxRef.current ?? 0;
    if (idx === optionCountRef.current) customRef.current?.focus();
    else optionRefs.current[idx]?.focus();
  }, [keyboardActive, request.id]);

  if (questions.length === 0) return null;

  // Check which questions have answers
  const hasAnswer = (i: number): boolean => {
    const q = questions[i];
    if (!q) return false;
    if (q.multiSelect) {
      return (selectedMulti[i] || []).length > 0 || !!customInputs[i];
    }
    return !!answers[i] || !!customInputs[i];
  };

  const canSubmit = questions.every((_, i) => hasAnswer(i));
  const displayIdx = Math.min(currentIdx, questions.length - 1);
  const selectQuestion = (nextIdx: number) => {
    const question = questions[nextIdx];
    setCurrentIdx(nextIdx);
    setCustomFocused(false);
    if (!question?.options.length) {
      setSelectedIdx(null);
      return;
    }
    setSelectedIdx(0);
    if (question.multiSelect) {
      setSelectedMulti((prev) =>
        (prev[nextIdx] || []).length > 0 || customInputs[nextIdx]
          ? prev
          : { ...prev, [nextIdx]: [question.options[0].label] },
      );
      return;
    }
    setAnswers((prev) =>
      prev[nextIdx] || customInputs[nextIdx]
        ? prev
        : { ...prev, [nextIdx]: question.options[0].label },
    );
  };
  const handlePrevious = () => {
    if (currentIdx <= 0) return;
    selectQuestion(currentIdx - 1);
  };
  const handleNext = () => {
    if (currentIdx >= questions.length - 1) return;
    selectQuestion(currentIdx + 1);
  };

  return (
    <div
      className={`${styles.question} ${
        variant === 'floating' ? styles.floating : ''
      } ${collapsed ? styles.collapsed : ''}`}
      data-web-shell-ask-panel
      role="alertdialog"
      aria-label={localizeToolDisplayName('ask_user_question', t)}
      // aria-labelledby wins over aria-label, so when expanded name the dialog
      // with BOTH the tool name and the question (otherwise the tool-name
      // context is dropped). The tool-name span is display:none but accname
      // still uses a directly-referenced hidden element's text.
      aria-labelledby={collapsed ? undefined : `${headingId} ${questionTextId}`}
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
                        isActive ? styles.optionActive : ''
                      } ${isSelected ? styles.optionSelected : ''}`}
                      data-web-shell-ask-option
                      tabIndex={isActive ? 0 : -1}
                      role={isMulti ? undefined : 'radio'}
                      aria-checked={isMulti ? undefined : isSelected}
                      aria-pressed={isMulti ? isSelected : undefined}
                      aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                      onClick={() => chooseOption(i)}
                      onFocus={() => setSelectedIdx(i)}
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
                  const hasCustomValue = !!customInputs[currentIdx];
                  return (
                    <div
                      className={`${styles.option} ${
                        isCustomActive ? styles.optionActive : ''
                      } ${hasCustomValue ? styles.optionSelected : ''}`}
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
                          placeholder={t('askUser.typePlaceholder')}
                          value={customInputs[currentIdx] || ''}
                          aria-label={t('askUser.typePlaceholder')}
                          onChange={(e) =>
                            setCustomInputs({
                              ...customInputs,
                              [currentIdx]: e.target.value,
                            })
                          }
                          onFocus={() => setSelectedIdx(current.options.length)}
                          onBlur={() => setCustomFocused(false)}
                          autoFocus
                        />
                      ) : (
                        <button
                          type="button"
                          ref={customRef}
                          className={`${styles.customTrigger} ${
                            customInputs[currentIdx]
                              ? ''
                              : styles.optionPlaceholder
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
                          onClick={() => chooseOption(current.options.length)}
                          onFocus={() => setSelectedIdx(current.options.length)}
                        >
                          {customInputs[currentIdx] ||
                            t('askUser.typePlaceholder')}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            </>
          ) : null}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.ignoreButton}
              onClick={handleCancel}
            >
              {t('askUser.ignore')}
            </button>
            {questions.length > 1 && (
              <>
                <button
                  type="button"
                  className={styles.button}
                  disabled={currentIdx <= 0}
                  onClick={handlePrevious}
                >
                  {t('common.previous')}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={currentIdx >= questions.length - 1}
                  onClick={handleNext}
                >
                  {t('common.next')}
                </button>
              </>
            )}
            <button
              type="button"
              className={`${styles.button} ${styles.submitButton}`}
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              {t('askUser.submit')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
