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

  useEffect(() => {
    submittedRef.current = false;
    setCurrentIdx(0);
    setSelectedIdx(0);
    setAnswers({});
    setCustomInputs({});
    setSelectedMulti({});
    setCustomFocused(false);
  }, [request.id]);

  const current = questions[currentIdx];
  const isMulti = current?.multiSelect ?? false;
  const totalOptions = (current?.options.length ?? 0) + 1; // +1 for "Other"
  const otherOptionIdx = current?.options.length ?? 0;

  const handleSubmit = useCallback(() => {
    if (submittedRef.current) return;
    const submitOption = request.options.find((o) => o.kind === 'allow_once');
    if (!submitOption) return;
    submittedRef.current = true;
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
    onConfirm(request.id, submitOption.id, result);
  }, [questions, selectedMulti, customInputs, answers, request, onConfirm]);

  const submitWithAnswer = useCallback(
    (questionIdx: number, answer: string) => {
      if (submittedRef.current) return;
      const submitOption = request.options.find((o) => o.kind === 'allow_once');
      if (!submitOption) return;
      submittedRef.current = true;
      const result: Record<string, string> = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q) continue;
        if (i === questionIdx) {
          result[q.question] = answer;
        } else if (q.multiSelect) {
          const multi = selectedMulti[i] || [];
          const custom = customInputs[i];
          const all = custom ? [...multi, custom] : multi;
          result[q.question] = all.join(', ');
        } else {
          result[q.question] = answers[i] || customInputs[i] || '';
        }
      }
      onConfirm(request.id, submitOption.id, result);
    },
    [questions, selectedMulti, customInputs, answers, request, onConfirm],
  );

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
      if (questions.length <= 1) return;
      setCurrentIdx((idx) => {
        const next = (idx + direction + questions.length) % questions.length;
        const nextQuestion = questions[next];
        setSelectedIdx(0);
        setCustomFocused(false);
        return nextQuestion ? next : idx;
      });
    },
    [questions],
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
        setAnswers({ ...answers, [currentIdx]: label });
        // Auto-advance or submit
        if (questions.length > 1 && currentIdx < questions.length - 1) {
          setCurrentIdx(currentIdx + 1);
          setSelectedIdx(0);
        } else {
          submitWithAnswer(currentIdx, label);
        }
      }
    },
    [
      current,
      currentIdx,
      isMulti,
      selectedMulti,
      answers,
      questions,
      submitWithAnswer,
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
      } else if (e.key === 'Enter') {
        claimKey(e);
        handleSelectOption(selectedIdx);
      } else if (e.key === 'Escape') {
        claimKey(e);
        handleCancel();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < totalOptions) {
          claimKey(e);
          setSelectedIdx(idx);
          handleSelectOption(idx);
        }
      } else if (
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
    handleSelectOption,
    handleCancel,
    switchQuestion,
    focusCustomInput,
  ]);

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const val = customInputs[currentIdx];
      if (val) {
        if (!isMulti) {
          setAnswers({ ...answers, [currentIdx]: val });
          if (questions.length <= 1 || currentIdx === questions.length - 1) {
            submitWithAnswer(currentIdx, val);
            return;
          }
          setCurrentIdx(currentIdx + 1);
          setSelectedIdx(0);
          setCustomFocused(false);
          return;
        }
        setCustomFocused(false);
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setCustomFocused(false);
    }
  };

  if (questions.length === 0 || !current) return null;

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

      {/* Tabs for multi-question */}
      {questions.length > 1 && (
        <div className={styles.tabs}>
          {questions.map((q, i) => (
            <button
              key={i}
              className={`${styles.tab} ${
                i === currentIdx ? styles.tabActive : ''
              }`}
              onClick={() => {
                setCurrentIdx(i);
                setSelectedIdx(0);
                setCustomFocused(false);
              }}
            >
              {q.header}
            </button>
          ))}
        </div>
      )}

      {/* Header label */}
      <div className={styles.header}>{current.header}</div>

      {/* Question text */}
      <p className={styles.text}>{current.question}</p>

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
                handleSelectOption(i);
              }}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className={styles.pointer}>{isActive ? '›' : ' '}</span>
              <span className={styles.optionNum}>{i + 1}.</span>
              <span className={styles.optionContent}>
                <span className={styles.optionLabel}>{opt.label}</span>
                {opt.description && (
                  <span className={styles.optionDesc}>{opt.description}</span>
                )}
              </span>
              {isMulti && (
                <span className={styles.check}>{isSelected ? '☑' : '☐'}</span>
              )}
            </div>
          );
        })}

        {/* Other / custom input option */}
        <div
          className={`${styles.option} ${
            selectedIdx === current.options.length ? styles.optionActive : ''
          }`}
          onClick={() => {
            setSelectedIdx(current.options.length);
            focusCustomInput();
          }}
          onMouseEnter={() => setSelectedIdx(current.options.length)}
        >
          <span className={styles.pointer}>
            {selectedIdx === current.options.length ? '›' : ' '}
          </span>
          <span className={styles.optionNum}>
            {current.options.length + 1}.
          </span>
          {customFocused ? (
            <input
              type="text"
              className={styles.customInput}
              placeholder="Type something..."
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
              className={`${styles.optionLabel} ${styles.optionPlaceholder}`}
            >
              Type something...
            </span>
          )}
        </div>
      </div>

      {/* Multi-select actions */}
      {isMulti && (
        <div className={styles.actions}>
          <button
            className={`${styles.button} ${styles.submitButton}`}
            onClick={handleSubmit}
          >
            {t('askUser.submit')}
          </button>
        </div>
      )}

      {/* Footer hint */}
      <div className={styles.footer}>{t('askUser.footer')}</div>
    </div>
  );
}
