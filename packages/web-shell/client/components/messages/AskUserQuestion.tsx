import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { PermissionRequest } from '../../adapters/types';
import { useI18n } from '../../i18n';
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
}

export function AskUserQuestion({
  request,
  onConfirm,
  variant = 'inline',
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
  const submittedRef = useRef(false);

  useEffect(() => {
    const firstQuestion = questions[0];
    submittedRef.current = false;
    setCurrentIdx(0);
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
      }`}
    >
      {/* Header line like CLI */}
      <div className={styles.titleLine}>
        <span className={styles.icon}>?</span>
        <span className={styles.toolName}>
          {localizeToolDisplayName('ask_user_question', t)}
        </span>
        <span className={styles.toolDesc}>
          {t('askUser.progress', {
            current: displayIdx + 1,
            total: questions.length,
          })}
        </span>
      </div>

      {/* Progress indicator */}
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

      {current ? (
        /* Question content */
        <>
          {/* Question text */}
          <p className={styles.text}>
            {current.question}
            {isMulti && (
              <span className={styles.multiHint}>
                {' '}
                ({t('askUser.multiHint')})
              </span>
            )}
          </p>
          <p className={styles.description}>{t('askUser.selectAnswer')}</p>

          {/* Options list */}
          <div
            className={styles.options}
            onMouseLeave={() => setSelectedIdx(null)}
          >
            {current.options.map((opt, i) => {
              const isActive = i === selectedIdx;
              const isSelected = isMulti
                ? (selectedMulti[currentIdx] || []).includes(opt.label)
                : answers[currentIdx] === opt.label;

              return (
                <div
                  key={opt.label}
                  className={`${styles.option} ${
                    isActive ? styles.optionActive : ''
                  } ${isSelected ? styles.optionSelected : ''}`}
                  onClick={() => {
                    setSelectedIdx(i);
                    if (isMulti) {
                      handleToggle(i);
                    } else {
                      handleSelectOption(i);
                    }
                  }}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  <span className={styles.pointer}>{isActive ? '›' : ' '}</span>
                  <span className={styles.optionNum}>{i + 1}</span>
                  <span className={styles.optionContent}>
                    <span className={styles.optionLabel}>{opt.label}</span>
                    {opt.description && (
                      <span className={styles.optionDesc}>
                        {opt.description}
                      </span>
                    )}
                  </span>
                </div>
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
                  onClick={() => {
                    setSelectedIdx(current.options.length);
                    focusCustomInput();
                  }}
                  onMouseEnter={() => setSelectedIdx(current.options.length)}
                >
                  <span className={styles.pointer}>
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
                      onChange={(e) =>
                        setCustomInputs({
                          ...customInputs,
                          [currentIdx]: e.target.value,
                        })
                      }
                      onBlur={() => setCustomFocused(false)}
                      autoFocus
                    />
                  ) : (
                    <span
                      className={`${styles.optionLabel} ${
                        customInputs[currentIdx] ? '' : styles.optionPlaceholder
                      }`}
                    >
                      {customInputs[currentIdx] || t('askUser.typePlaceholder')}
                    </span>
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
    </div>
  );
}
