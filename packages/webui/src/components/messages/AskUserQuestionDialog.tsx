/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * AskUserQuestionDialog component for displaying questions to the user
 * and collecting their responses in the WebView
 */

import type { FC } from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionDialogProps {
  questions: Question[];
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}

interface AnswerState {
  selectedOption?: string;
  customInput?: string;
  multiSelectedOptions?: string[];
  customInputChecked?: boolean;
}

export const AskUserQuestionDialog: FC<AskUserQuestionDialogProps> = ({
  questions,
  onSubmit,
  onCancel,
}) => {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, AnswerState>>({});
  const [showCustomInput, setShowCustomInput] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  const hasMultipleQuestions = questions.length > 1;
  const totalTabs = hasMultipleQuestions
    ? questions.length + 1
    : questions.length;
  const isSubmitTab =
    hasMultipleQuestions && currentQuestionIndex === totalTabs - 1;

  const currentQuestion = isSubmitTab ? null : questions[currentQuestionIndex];
  const isMultiSelect = currentQuestion?.multiSelect ?? false;

  // Get current answer state
  const currentAnswer = answers[currentQuestionIndex] || {};

  // Get answer for a specific question
  const getAnswerForQuestion = useCallback(
    (idx: number): string | undefined => {
      const q = questions[idx];
      const answerState = answers[idx];
      if (!answerState) {
        return undefined;
      }

      if (q?.multiSelect) {
        const selections = [...(answerState.multiSelectedOptions || [])];
        const customValue = (answerState.customInput || '').trim();
        if (answerState.customInputChecked && customValue) {
          selections.push(customValue);
        }
        return selections.length > 0 ? selections.join(', ') : undefined;
      }

      // Check if custom input was used (value doesn't match any option)
      if (answerState.customInput && answerState.customInput.trim()) {
        const matchesOption = q?.options.some(
          (opt) => opt.label === answerState.customInput?.trim(),
        );
        if (!matchesOption) {
          return answerState.customInput.trim();
        }
      }

      return answerState.selectedOption;
    },
    [questions, answers],
  );

  // Handle submitting all answers
  const handleSubmit = useCallback(() => {
    const answersRecord: Record<string, string> = {};
    questions.forEach((_, idx) => {
      const answer = getAnswerForQuestion(idx);
      if (answer !== undefined) {
        answersRecord[idx] = answer;
      }
    });
    onSubmit(answersRecord);
  }, [questions, onSubmit, getAnswerForQuestion]);

  // Handle confirming multi-select for current question
  const handleMultiSelectConfirm = useCallback(() => {
    if (!currentQuestion) {
      return;
    }

    const answerState = answers[currentQuestionIndex] || {};
    const selections = [...(answerState.multiSelectedOptions || [])];
    const customValue = (answerState.customInput || '').trim();
    if (answerState.customInputChecked && customValue) {
      selections.push(customValue);
    }
    if (selections.length === 0) {
      return;
    }

    const value = selections.join(', ');

    const updatedAnswers = {
      ...answers,
      [currentQuestionIndex]: {
        ...answerState,
        selectedOption: value,
      },
    };
    setAnswers(updatedAnswers);

    if (!hasMultipleQuestions) {
      onSubmit({ [currentQuestionIndex]: value });
    } else if (currentQuestionIndex < totalTabs - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setShowCustomInput(false);
    }
  }, [
    currentQuestion,
    answers,
    currentQuestionIndex,
    hasMultipleQuestions,
    totalTabs,
    onSubmit,
  ]);

  // Handle option selection
  const handleOptionSelect = useCallback(
    (optionIndex: number) => {
      if (!currentQuestion) {
        return;
      }

      if (isMultiSelect) {
        const answerState = answers[currentQuestionIndex] || {};
        const current = answerState.multiSelectedOptions || [];
        const option = currentQuestion.options[optionIndex];
        const isChecked = current.includes(option.label);
        const updated = isChecked
          ? current.filter((l) => l !== option.label)
          : [...current, option.label];

        setAnswers({
          ...answers,
          [currentQuestionIndex]: {
            ...answerState,
            multiSelectedOptions: updated,
          },
        });
      } else {
        const option = currentQuestion.options[optionIndex];
        const answerState = answers[currentQuestionIndex] || {};
        const updated = {
          ...answerState,
          selectedOption: option.label,
        };
        setAnswers({ ...answers, [currentQuestionIndex]: updated });

        if (!hasMultipleQuestions) {
          onSubmit({ [currentQuestionIndex]: option.label });
        } else if (currentQuestionIndex < totalTabs - 1) {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setShowCustomInput(false);
        }
      }
    },
    [
      currentQuestion,
      isMultiSelect,
      answers,
      currentQuestionIndex,
      hasMultipleQuestions,
      totalTabs,
      onSubmit,
    ],
  );

  // Handle custom input change
  const handleCustomInputChange = (value: string) => {
    const answerState = answers[currentQuestionIndex] || {};
    setAnswers({
      ...answers,
      [currentQuestionIndex]: {
        ...answerState,
        customInput: value,
        customInputChecked: isMultiSelect && value.trim().length > 0,
      },
    });
  };

  // Handle custom input submit
  const handleCustomInputSubmit = () => {
    const value = currentAnswer.customInput?.trim() || '';
    if (!value) {
      return;
    }

    if (isMultiSelect) {
      const answerState = answers[currentQuestionIndex] || {};
      setAnswers({
        ...answers,
        [currentQuestionIndex]: {
          ...answerState,
          customInputChecked: !answerState.customInputChecked,
        },
      });
    } else {
      const answerState = answers[currentQuestionIndex] || {};
      const updated = {
        ...answerState,
        selectedOption: value,
      };
      setAnswers({ ...answers, [currentQuestionIndex]: updated });

      if (!hasMultipleQuestions) {
        onSubmit({ [currentQuestionIndex]: value });
      } else if (currentQuestionIndex < totalTabs - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
        setShowCustomInput(false);
      }
    }
  };

  // Escape to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  // Focus custom input when shown
  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [showCustomInput]);

  // Reset custom input visibility when switching tabs
  useEffect(() => {
    setShowCustomInput(false);
  }, [currentQuestionIndex]);

  // Shared tab bar renderer
  const renderTabs = () => (
    <div className="flex gap-2 mb-4 overflow-x-auto">
      {questions.map((q, idx) => {
        const isAnswered = getAnswerForQuestion(idx) !== undefined;
        const isActive = idx === currentQuestionIndex;
        return (
          <button
            key={idx}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm whitespace-nowrap cursor-pointer transition-colors border-none ${
              isActive
                ? 'bg-[var(--app-button-background)] text-[var(--app-button-foreground)] font-bold'
                : 'bg-[var(--app-button-secondary-background)] text-[var(--app-secondary-foreground)] hover:opacity-80'
            }`}
            onClick={() => setCurrentQuestionIndex(idx)}
          >
            <span>{q.header}</span>
            {isAnswered && <span className="text-green-500">✓</span>}
          </button>
        );
      })}
      <button
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm whitespace-nowrap cursor-pointer transition-colors border-none ${
          isSubmitTab
            ? 'bg-[var(--app-button-background)] text-[var(--app-button-foreground)] font-bold'
            : 'bg-[var(--app-button-secondary-background)] text-[var(--app-secondary-foreground)] opacity-60 hover:opacity-80'
        }`}
        onClick={() => setCurrentQuestionIndex(totalTabs - 1)}
      >
        <span>Submit</span>
      </button>
    </div>
  );

  // Container style
  const containerStyle = {
    backgroundColor: 'var(--app-input-secondary-background)',
    borderColor: 'var(--app-input-border)',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  };

  // Render submit tab
  if (isSubmitTab) {
    return (
      <div
        ref={containerRef}
        className="fixed inset-x-4 bottom-4 z-[1000] rounded-lg border p-4 outline-none animate-slide-up"
        style={containerStyle}
      >
        {renderTabs()}

        {/* Show selected answers */}
        <div className="mb-4">
          <div className="font-bold text-[var(--app-primary-foreground)] mb-2">
            Your answers:
          </div>
          {questions.map((q, idx) => {
            const answer = getAnswerForQuestion(idx);
            return (
              <div
                key={idx}
                className="ml-2 mb-1 text-[var(--app-secondary-foreground)]"
              >
                <span className="font-semibold">{q.header}:</span>{' '}
                {answer ? (
                  <span style={{ color: 'var(--app-link-color)' }}>
                    {answer}
                  </span>
                ) : (
                  <span className="opacity-60">(not answered)</span>
                )}
              </div>
            );
          })}
        </div>

        {/* Submit/Cancel buttons */}
        <div className="flex gap-2 mt-4">
          <button
            className="px-4 py-2 rounded-md font-medium transition-colors cursor-pointer border-none"
            style={{
              backgroundColor: 'var(--app-button-background)',
              color: 'var(--app-button-foreground)',
            }}
            onClick={handleSubmit}
          >
            Submit
          </button>
          <button
            className="px-4 py-2 rounded-md font-medium transition-colors cursor-pointer border-none hover:opacity-80"
            style={{
              backgroundColor: 'var(--app-button-secondary-background)',
              color: 'var(--app-primary-foreground)',
            }}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Render question tab
  return (
    <div
      ref={containerRef}
      className="fixed inset-x-4 bottom-4 z-[1000] rounded-lg border p-4 outline-none animate-slide-up"
      style={containerStyle}
    >
      {/* Tabs for multiple questions */}
      {hasMultipleQuestions && renderTabs()}

      {/* Question */}
      <div className="mb-4">
        {!hasMultipleQuestions && (
          <div className="mb-2">
            <span
              className="font-bold text-lg"
              style={{ color: 'var(--app-link-color)' }}
            >
              {currentQuestion!.header}
            </span>
          </div>
        )}
        <div className="text-[var(--app-primary-foreground)] text-base">
          {currentQuestion!.question}
        </div>
      </div>

      {/* Options */}
      <div className="flex flex-col gap-2 mb-3">
        {currentQuestion!.options.map((opt, index) => {
          const isSelected =
            !isMultiSelect && currentAnswer.selectedOption === opt.label;
          const isMultiChecked =
            isMultiSelect &&
            currentAnswer.multiSelectedOptions?.includes(opt.label);

          return (
            <div key={index} className="flex flex-col">
              <button
                className={`flex items-center gap-2 px-3 py-2 text-left w-full rounded-md border transition-colors duration-150 cursor-pointer ${
                  isSelected || isMultiChecked
                    ? 'bg-[var(--app-list-active-background)] text-[var(--app-list-active-foreground)]'
                    : 'bg-[var(--app-button-secondary-background)] text-[var(--app-primary-foreground)] hover:bg-[var(--app-list-active-background)] hover:text-[var(--app-list-active-foreground)]'
                }`}
                onClick={() => handleOptionSelect(index)}
              >
                {isMultiSelect ? (
                  <span className="min-w-[18px]">
                    {isMultiChecked ? '☑' : '☐'}
                  </span>
                ) : (
                  <span className="min-w-[18px]">{isSelected ? '●' : '○'}</span>
                )}
                <span className="flex-1">{opt.label}</span>
              </button>
              {opt.description && (
                <div
                  className="ml-8 mt-1 text-sm opacity-70"
                  style={{ color: 'var(--app-secondary-foreground)' }}
                >
                  {opt.description}
                </div>
              )}
            </div>
          );
        })}

        {/* Custom input ("Other") */}
        <div className="flex flex-col">
          {showCustomInput ? (
            <div className="flex items-center gap-2">
              {isMultiSelect && (
                <span
                  className="min-w-[18px] cursor-pointer"
                  onClick={() => {
                    const answerState = answers[currentQuestionIndex] || {};
                    setAnswers({
                      ...answers,
                      [currentQuestionIndex]: {
                        ...answerState,
                        customInputChecked: !answerState.customInputChecked,
                      },
                    });
                  }}
                >
                  {currentAnswer.customInputChecked ? '☑' : '☐'}
                </span>
              )}
              <input
                ref={customInputRef}
                type="text"
                className="flex-1 px-3 py-2 rounded-md border focus:outline-none focus:ring-1"
                style={{
                  backgroundColor: 'var(--app-input-background)',
                  borderColor: 'var(--app-input-border)',
                  color: 'var(--app-primary-foreground)',
                }}
                value={currentAnswer.customInput || ''}
                onChange={(e) => handleCustomInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCustomInputSubmit();
                  }
                }}
                placeholder="Type your answer..."
              />
            </div>
          ) : (
            <button
              className="flex items-center gap-2 px-3 py-2 text-left w-full rounded-md border transition-colors duration-150 cursor-pointer
                bg-[var(--app-button-secondary-background)] text-[var(--app-secondary-foreground)] hover:bg-[var(--app-list-active-background)] hover:text-[var(--app-list-active-foreground)]"
              onClick={() => setShowCustomInput(true)}
            >
              <span className="min-w-[18px]">✎</span>
              <span className="flex-1 opacity-70">
                {currentAnswer.customInput || 'Other...'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mt-3">
        {isMultiSelect && (
          <button
            className="px-4 py-2 rounded-md font-medium transition-colors cursor-pointer border-none"
            style={{
              backgroundColor: 'var(--app-button-background)',
              color: 'var(--app-button-foreground)',
            }}
            onClick={handleMultiSelectConfirm}
          >
            Confirm
          </button>
        )}
        <button
          className="px-4 py-2 rounded-md font-medium transition-colors cursor-pointer border-none hover:opacity-80"
          style={{
            backgroundColor: 'var(--app-button-secondary-background)',
            color: 'var(--app-primary-foreground)',
          }}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
