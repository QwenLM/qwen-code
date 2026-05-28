import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { PermissionRequest } from '../../adapters/types';
import { useI18n } from '../../i18n';
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
}

export function AskUserQuestion({ request, onConfirm }: AskUserQuestionProps) {
  const { t } = useI18n();
  const questions = useMemo(
    () =>
      Array.isArray(request.rawInput?.questions)
        ? (request.rawInput.questions as Question[])
        : [],
    [request.rawInput],
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [selectedMulti, setSelectedMulti] = useState<Record<number, string[]>>(
    {},
  );
  const [customFocused, setCustomFocused] = useState(false);
  const submittedRef = useRef(false);

  // Total tabs = questions + submit tab
  const totalTabs = questions.length + 1;
  const isOnSubmitTab = currentIdx === questions.length;

  useEffect(() => {
    submittedRef.current = false;
    setCurrentIdx(0);
    setSelectedIdx(0);
    setAnswers({});
    setCustomInputs({});
    setSelectedMulti({});
    setCustomFocused(false);
  }, [request.id]);

  const current = isOnSubmitTab ? undefined : questions[currentIdx];
  const isMulti = current?.multiSelect ?? false;
  const totalOptions = isOnSubmitTab ? 2 : (current?.options.length ?? 0) + 1;
  const otherOptionIdx = current?.options.length ?? 0;

  const getSelectedIdxForTab = useCallback(
    (
      tabIdx: number,
      nextAnswers = answers,
      nextCustomInputs = customInputs,
      nextSelectedMulti = selectedMulti,
    ): number => {
      if (tabIdx === questions.length) return 0;
      const question = questions[tabIdx];
      if (!question) return 0;
      const otherIdx = question.options.length;
      if (question.multiSelect) {
        const selected = nextSelectedMulti[tabIdx] || [];
        const selectedOptionIdx = question.options.findIndex((option) =>
          selected.includes(option.label),
        );
        if (selectedOptionIdx >= 0) return selectedOptionIdx;
        return nextCustomInputs[tabIdx] ? otherIdx : 0;
      }
      const answer = nextAnswers[tabIdx];
      const answerOptionIdx = question.options.findIndex(
        (option) => option.label === answer,
      );
      if (answerOptionIdx >= 0) return answerOptionIdx;
      return nextCustomInputs[tabIdx] || answer ? otherIdx : 0;
    },
    [answers, customInputs, questions, selectedMulti],
  );

  const buildResult = useCallback((): Record<string, string> => {
    const result: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q) continue;
      if (q.multiSelect) {
        const multi = selectedMulti[i] || [];
        const custom = customInputs[i];
        const all = custom ? [...multi, custom] : multi;
        result[q.question] = all.join(', ');
      } else {
        result[q.question] = answers[i] || customInputs[i] || '';
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

  const switchQuestion = useCallback(
    (direction: 1 | -1) => {
      if (totalTabs <= 1) return;
      setCurrentIdx((idx) => {
        const next = (idx + direction + totalTabs) % totalTabs;
        setSelectedIdx(getSelectedIdxForTab(next));
        setCustomFocused(false);
        return next;
      });
    },
    [getSelectedIdxForTab, totalTabs],
  );

  const focusCustomInput = useCallback(
    (initialValue?: string) => {
      if (initialValue !== undefined) {
        setCustomInputs((prev) => ({ ...prev, [currentIdx]: initialValue }));
      }
      setCustomFocused(true);
    },
    [currentIdx],
  );

  const handleSelectOption = useCallback(
    (idx: number) => {
      if (isOnSubmitTab) {
        if (idx === 0) {
          handleSubmit();
        } else {
          handleCancel();
        }
        return;
      }
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
        if (currentIdx < questions.length - 1) {
          const nextIdx = currentIdx + 1;
          setCurrentIdx(nextIdx);
          setSelectedIdx(getSelectedIdxForTab(nextIdx, nextAnswers));
        } else {
          // Last question answered — go to submit tab
          setCurrentIdx(questions.length);
          setSelectedIdx(getSelectedIdxForTab(questions.length, nextAnswers));
        }
      }
    },
    [
      isOnSubmitTab,
      current,
      currentIdx,
      isMulti,
      selectedMulti,
      answers,
      questions,
      handleSubmit,
      handleCancel,
      focusCustomInput,
      getSelectedIdxForTab,
    ],
  );

  const handleToggle = useCallback(
    (idx: number) => {
      if (isOnSubmitTab || !current || !isMulti) return;
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
    [
      isOnSubmitTab,
      current,
      isMulti,
      selectedMulti,
      currentIdx,
      focusCustomInput,
    ],
  );

  useEffect(() => {
    if (customFocused) return;
    const claimKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        claimKey(e);
        setSelectedIdx((i) => Math.min(i + 1, totalOptions - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        claimKey(e);
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'ArrowRight') {
        claimKey(e);
        switchQuestion(1);
      } else if (e.key === 'ArrowLeft') {
        claimKey(e);
        switchQuestion(-1);
      } else if (e.key === ' ') {
        claimKey(e);
        if (isMulti) {
          handleToggle(selectedIdx);
        } else {
          handleSelectOption(selectedIdx);
        }
      } else if (e.key === 'Enter') {
        claimKey(e);
        if (isMulti) {
          // In multiSelect, Enter advances to next tab or submits
          if (currentIdx < questions.length - 1) {
            const nextIdx = currentIdx + 1;
            setCurrentIdx(nextIdx);
            setSelectedIdx(getSelectedIdxForTab(nextIdx));
          } else {
            setCurrentIdx(questions.length);
            setSelectedIdx(getSelectedIdxForTab(questions.length));
          }
        } else {
          handleSelectOption(selectedIdx);
        }
      } else if (e.key === 'Escape') {
        claimKey(e);
        handleCancel();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < totalOptions) {
          claimKey(e);
          setSelectedIdx(idx);
          if (!isMulti) {
            handleSelectOption(idx);
          } else {
            handleToggle(idx);
          }
        }
      } else if (
        !isOnSubmitTab &&
        selectedIdx === otherOptionIdx &&
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        claimKey(e);
        focusCustomInput(e.key);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    customFocused,
    totalOptions,
    selectedIdx,
    otherOptionIdx,
    isMulti,
    isOnSubmitTab,
    currentIdx,
    questions.length,
    handleSelectOption,
    handleToggle,
    handleCancel,
    switchQuestion,
    focusCustomInput,
    getSelectedIdxForTab,
  ]);

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const val = customInputs[currentIdx];
      if (val) {
        if (!isMulti) {
          const nextAnswers = { ...answers, [currentIdx]: val };
          setAnswers(nextAnswers);
          if (currentIdx < questions.length - 1) {
            const nextIdx = currentIdx + 1;
            setCurrentIdx(nextIdx);
            setSelectedIdx(getSelectedIdxForTab(nextIdx, nextAnswers));
            setCustomFocused(false);
            return;
          }
          // Go to submit tab
          setCurrentIdx(questions.length);
          setSelectedIdx(getSelectedIdxForTab(questions.length, nextAnswers));
          setCustomFocused(false);
          return;
        }
        setCustomFocused(false);
        // Multi — advance to next or submit tab
        if (currentIdx < questions.length - 1) {
          const nextIdx = currentIdx + 1;
          setCurrentIdx(nextIdx);
          setSelectedIdx(getSelectedIdxForTab(nextIdx));
        } else {
          setCurrentIdx(questions.length);
          setSelectedIdx(getSelectedIdxForTab(questions.length));
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setCustomFocused(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setCustomFocused(false);
      setSelectedIdx((i) => Math.min(i + 1, totalOptions - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setCustomFocused(false);
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      setCustomFocused(false);
      switchQuestion(e.shiftKey ? -1 : 1);
    }
  };

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

  const getAnswerText = (i: number): string => {
    const q = questions[i];
    if (!q) return '';
    if (q.multiSelect) {
      const multi = selectedMulti[i] || [];
      const custom = customInputs[i];
      const all = custom ? [...multi, custom] : multi;
      return all.join(', ');
    }
    return answers[i] || customInputs[i] || '';
  };

  return (
    <div className={styles.question}>
      {/* Header line like CLI */}
      <div className={styles.titleLine}>
        <span className={styles.icon}>?</span>
        <span className={styles.toolName}>AskUserQuestion</span>
        <span className={styles.toolDesc}>
          {t('askUser.title', { count: questions.length })}
        </span>
      </div>

      {/* Tabs for navigation */}
      <div className={styles.tabs}>
        {questions.map((q, i) => (
          <button
            key={i}
            className={`${styles.tab} ${
              i === currentIdx ? styles.tabActive : ''
            }`}
            onClick={() => {
              setCurrentIdx(i);
              setSelectedIdx(getSelectedIdxForTab(i));
              setCustomFocused(false);
            }}
          >
            {q.header}
            {hasAnswer(i) && <span className={styles.tabCheck}> ✓</span>}
          </button>
        ))}
        <button
          className={`${styles.tab} ${isOnSubmitTab ? styles.tabActive : ''}`}
          onClick={() => {
            setCurrentIdx(questions.length);
            setSelectedIdx(getSelectedIdxForTab(questions.length));
            setCustomFocused(false);
          }}
        >
          {t('askUser.submit')}
        </button>
      </div>

      {isOnSubmitTab ? (
        /* Submit confirmation tab */
        <div className={styles.submitTab}>
          <div className={styles.header}>{t('askUser.confirmTitle')}</div>
          <div className={styles.summary}>
            {questions.map((q, i) => (
              <div key={i} className={styles.summaryRow}>
                <span className={styles.summaryLabel}>{q.header}:</span>
                <span className={styles.summaryValue}>
                  {getAnswerText(i) || '—'}
                </span>
              </div>
            ))}
          </div>
          <div className={styles.text}>{t('askUser.confirmPrompt')}</div>
          <div className={styles.options}>
            <div
              className={`${styles.option} ${
                selectedIdx === 0 ? styles.optionActive : ''
              }`}
              onClick={handleSubmit}
              onMouseEnter={() => setSelectedIdx(0)}
            >
              <span className={styles.pointer}>
                {selectedIdx === 0 ? '›' : ' '}
              </span>
              <span className={styles.optionNum}>1.</span>
              <span className={styles.optionLabel}>
                {t('askUser.submitAnswers')}
              </span>
            </div>
            <div
              className={`${styles.option} ${
                selectedIdx === 1 ? styles.optionActive : ''
              }`}
              onClick={handleCancel}
              onMouseEnter={() => setSelectedIdx(1)}
            >
              <span className={styles.pointer}>
                {selectedIdx === 1 ? '›' : ' '}
              </span>
              <span className={styles.optionNum}>2.</span>
              <span className={styles.optionLabel}>{t('askUser.cancel')}</span>
            </div>
          </div>
        </div>
      ) : current ? (
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

          {/* Options list */}
          <div className={styles.options}>
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
                  {isMulti && (
                    <span className={styles.checkbox}>
                      {isSelected ? '[✓]' : '[ ]'}
                    </span>
                  )}
                  <span className={styles.optionNum}>{i + 1}.</span>
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
                  {isMulti && (
                    <span className={styles.checkbox}>
                      {hasCustomValue ? '[✓]' : '[ ]'}
                    </span>
                  )}
                  <span className={styles.optionNum}>
                    {current.options.length + 1}.
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
                      onKeyDown={handleCustomKeyDown}
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

      {/* Footer hint */}
      <div className={styles.footer}>
        {isMulti ? t('askUser.footerMulti') : t('askUser.footer')}
      </div>
    </div>
  );
}
