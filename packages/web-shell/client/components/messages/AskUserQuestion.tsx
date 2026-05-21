import { useState, useEffect, useCallback, useMemo } from 'react';
import type { PermissionRequest } from '../../adapters/types';

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

  const current = questions[currentIdx];
  const isMulti = current?.multiSelect ?? false;
  const totalOptions = (current?.options.length ?? 0) + 1; // +1 for "Other"

  const handleSubmit = useCallback(() => {
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
    const submitOption = request.options.find((o) => o.kind === 'allow_once');
    onConfirm(
      request.id,
      submitOption?.id || request.options[0]?.id || '',
      result,
    );
  }, [questions, selectedMulti, customInputs, answers, request, onConfirm]);

  const submitWithAnswer = useCallback(
    (questionIdx: number, answer: string) => {
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
      const submitOption = request.options.find((o) => o.kind === 'allow_once');
      onConfirm(
        request.id,
        submitOption?.id || request.options[0]?.id || '',
        result,
      );
    },
    [questions, selectedMulti, customInputs, answers, request, onConfirm],
  );

  const handleCancel = useCallback(() => {
    const cancelOption = request.options.find((o) => o.kind === 'reject_once');
    onConfirm(request.id, cancelOption?.id || '', undefined);
  }, [request, onConfirm]);

  const handleSelectOption = useCallback(
    (idx: number) => {
      if (!current) return;
      const isOther = idx === current.options.length;
      if (isOther) {
        setCustomFocused(true);
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
    ],
  );

  useEffect(() => {
    if (customFocused) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, totalOptions - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSelectOption(selectedIdx);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < totalOptions) {
          e.preventDefault();
          setSelectedIdx(idx);
          handleSelectOption(idx);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    customFocused,
    totalOptions,
    selectedIdx,
    handleSelectOption,
    handleCancel,
  ]);

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = customInputs[currentIdx];
      if (val) {
        if (!isMulti) {
          setAnswers({ ...answers, [currentIdx]: val });
          if (questions.length <= 1 || currentIdx === questions.length - 1) {
            submitWithAnswer(currentIdx, val);
            return;
          }
        }
        setCustomFocused(false);
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCustomFocused(false);
    }
  };

  if (questions.length === 0 || !current) return null;

  return (
    <div className="ask-question">
      {/* Header line like CLI */}
      <div className="ask-question-title-line">
        <span className="ask-question-icon">?</span>
        <span className="ask-question-tool-name">AskUserQuestion</span>
        <span className="ask-question-tool-desc">
          Ask user {questions.length} question{questions.length > 1 ? 's' : ''}{' '}
          ←
        </span>
      </div>

      {/* Tabs for multi-question */}
      {questions.length > 1 && (
        <div className="ask-question-tabs">
          {questions.map((q, i) => (
            <button
              key={i}
              className={`ask-question-tab ${i === currentIdx ? 'active' : ''}`}
              onClick={() => {
                setCurrentIdx(i);
                setSelectedIdx(0);
              }}
            >
              {q.header}
            </button>
          ))}
        </div>
      )}

      {/* Header label */}
      <div className="ask-question-header">{current.header}</div>

      {/* Question text */}
      <p className="ask-question-text">{current.question}</p>

      {/* Options list */}
      <div className="ask-question-options">
        {current.options.map((opt, i) => {
          const isActive = i === selectedIdx;
          const isSelected = isMulti
            ? (selectedMulti[currentIdx] || []).includes(opt.label)
            : answers[currentIdx] === opt.label;

          return (
            <div
              key={opt.label}
              className={`ask-question-option ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={() => {
                setSelectedIdx(i);
                handleSelectOption(i);
              }}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className="ask-question-pointer">
                {isActive ? '›' : ' '}
              </span>
              <span className="ask-question-option-num">{i + 1}.</span>
              <span className="ask-question-option-content">
                <span className="ask-question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="ask-question-option-desc">
                    {opt.description}
                  </span>
                )}
              </span>
              {isMulti && (
                <span className="ask-question-check">
                  {isSelected ? '☑' : '☐'}
                </span>
              )}
            </div>
          );
        })}

        {/* Other / custom input option */}
        <div
          className={`ask-question-option ${selectedIdx === current.options.length ? 'active' : ''}`}
          onClick={() => {
            setSelectedIdx(current.options.length);
            setCustomFocused(true);
          }}
          onMouseEnter={() => setSelectedIdx(current.options.length)}
        >
          <span className="ask-question-pointer">
            {selectedIdx === current.options.length ? '›' : ' '}
          </span>
          <span className="ask-question-option-num">
            {current.options.length + 1}.
          </span>
          {customFocused ? (
            <input
              type="text"
              className="ask-question-custom-input"
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
            <span className="ask-question-option-label ask-question-option-placeholder">
              Type something...
            </span>
          )}
        </div>
      </div>

      {/* Multi-select actions */}
      {isMulti && (
        <div className="ask-question-actions">
          <button
            className="ask-question-btn ask-question-btn-submit"
            onClick={handleSubmit}
          >
            Submit
          </button>
        </div>
      )}

      {/* Footer hint */}
      <div className="ask-question-footer">
        ↑/↓: Navigate | Enter: Select | Esc: Cancel
      </div>
    </div>
  );
}
