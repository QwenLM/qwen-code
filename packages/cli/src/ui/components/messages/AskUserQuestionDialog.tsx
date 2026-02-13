/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import {
  type ToolAskUserQuestionConfirmationDetails,
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { TextInput } from '../shared/TextInput.js';

interface AskUserQuestionDialogProps {
  confirmationDetails: ToolAskUserQuestionConfirmationDetails;
  isFocused?: boolean;
  onConfirm: (
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => Promise<void>;
}

export const AskUserQuestionDialog: React.FC<AskUserQuestionDialogProps> = ({
  confirmationDetails,
  isFocused = true,
  onConfirm,
}) => {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<
    Record<number, string>
  >({});
  const [customInputValues, setCustomInputValues] = useState<
    Record<number, string>
  >({});
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [multiSelectedOptions, setMultiSelectedOptions] = useState<
    Record<number, string[]>
  >({});
  const [customInputChecked, setCustomInputChecked] = useState<
    Record<number, boolean>
  >({});

  const hasMultipleQuestions = confirmationDetails.questions.length > 1;
  const totalTabs = hasMultipleQuestions
    ? confirmationDetails.questions.length + 1
    : confirmationDetails.questions.length; // +1 for Submit tab
  const isSubmitTab =
    hasMultipleQuestions && currentQuestionIndex === totalTabs - 1;

  const currentQuestion = isSubmitTab
    ? null
    : confirmationDetails.questions[currentQuestionIndex];
  const isMultiSelect = currentQuestion?.multiSelect ?? false;
  // Multi-select: options + custom input + submit; Single-select: options + custom input
  const totalOptions = currentQuestion
    ? currentQuestion.options.length + (isMultiSelect ? 2 : 1)
    : 2;
  const submitOptionIndex = currentQuestion
    ? currentQuestion.options.length + 1
    : -1;

  // Check if the custom input option is selected
  const isCustomInputSelected =
    !isSubmitTab &&
    currentQuestion &&
    selectedIndex === currentQuestion.options.length;

  const currentCustomInputValue = customInputValues[currentQuestionIndex] ?? '';
  const isCustomInputAnswer =
    !isSubmitTab &&
    currentQuestion &&
    !isMultiSelect &&
    selectedOptions[currentQuestionIndex] !== undefined &&
    !currentQuestion.options.some(
      (opt) => opt.label === selectedOptions[currentQuestionIndex],
    );

  // Compute the current answer for a question, considering multi-select state
  const getAnswerForQuestion = (idx: number): string | undefined => {
    const q = confirmationDetails.questions[idx];
    if (q?.multiSelect) {
      const selections = [...(multiSelectedOptions[idx] ?? [])];
      const customValue = (customInputValues[idx] ?? '').trim();
      if (customInputChecked[idx] && customValue) {
        selections.push(customValue);
      }
      return selections.length > 0 ? selections.join(', ') : undefined;
    }
    return selectedOptions[idx];
  };

  const handleSubmit = async () => {
    const answers: Record<string, string> = {};
    confirmationDetails.questions.forEach((_, idx) => {
      const answer = getAnswerForQuestion(idx);
      if (answer !== undefined) {
        answers[idx] = answer;
      }
    });

    await onConfirm(ToolConfirmationOutcome.ProceedOnce, { answers });
  };

  const handleMultiSelectSubmit = () => {
    if (!currentQuestion) return;
    const selections = [...(multiSelectedOptions[currentQuestionIndex] ?? [])];
    const customValue = currentCustomInputValue.trim();
    if (customInputChecked[currentQuestionIndex] && customValue) {
      selections.push(customValue);
    }
    if (selections.length === 0) return;

    const value = selections.join(', ');
    const updated = { ...selectedOptions, [currentQuestionIndex]: value };
    setSelectedOptions(updated);

    if (!hasMultipleQuestions) {
      void onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { [currentQuestionIndex]: value },
      });
    } else {
      if (currentQuestionIndex < totalTabs - 1) {
        setTimeout(() => {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setSelectedIndex(0);
        }, 150);
      }
    }
  };

  const handleCustomInputSubmit = () => {
    const trimmedValue = currentCustomInputValue.trim();

    if (isMultiSelect) {
      // Toggle custom input checked state
      if (!trimmedValue) return;
      setCustomInputChecked((prev) => ({
        ...prev,
        [currentQuestionIndex]: !prev[currentQuestionIndex],
      }));
      return;
    }

    if (!trimmedValue) return;

    const updated = {
      ...selectedOptions,
      [currentQuestionIndex]: trimmedValue,
    };
    setSelectedOptions(updated);

    // If single question, submit immediately
    if (!hasMultipleQuestions) {
      void onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: {
          [currentQuestionIndex]: trimmedValue,
        },
      });
    } else {
      // Auto-advance to next tab
      if (currentQuestionIndex < totalTabs - 1) {
        setTimeout(() => {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setSelectedIndex(0);
        }, 150);
      }
    }
  };

  // Handle navigation and selection
  useKeypress(
    (key) => {
      if (!isFocused) return;

      // When custom input is focused, still allow up/down navigation, tab switch and escape
      if (isCustomInputSelected) {
        if (key.name === 'up') {
          setSelectedIndex(Math.max(0, selectedIndex - 1));
          return;
        }
        if (key.name === 'down') {
          setSelectedIndex(Math.min(totalOptions - 1, selectedIndex + 1));
          return;
        }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          void onConfirm(ToolConfirmationOutcome.Cancel);
          return;
        }
        return;
      }

      const input = key.sequence;

      // Tab navigation (left/right arrows)
      if (key.name === 'left' && hasMultipleQuestions) {
        if (currentQuestionIndex > 0) {
          setCurrentQuestionIndex(currentQuestionIndex - 1);
          setSelectedIndex(0);
        }
        return;
      }
      if (key.name === 'right' && hasMultipleQuestions) {
        if (currentQuestionIndex < totalTabs - 1) {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setSelectedIndex(0);
        }
        return;
      }

      // Option navigation (up/down arrows)
      if (key.name === 'up') {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
        return;
      }
      if (key.name === 'down') {
        setSelectedIndex(Math.min(totalOptions - 1, selectedIndex + 1));
        return;
      }

      // Number key selection
      const numKey = parseInt(input || '', 10);
      if (!isNaN(numKey) && numKey >= 1 && numKey <= totalOptions) {
        setSelectedIndex(numKey - 1);
        return;
      }

      // Space to toggle multi-select
      if (key.name === 'space' && isMultiSelect && currentQuestion) {
        if (selectedIndex < currentQuestion.options.length) {
          const option = currentQuestion.options[selectedIndex];
          if (option) {
            const current = multiSelectedOptions[currentQuestionIndex] ?? [];
            const isChecked = current.includes(option.label);
            const updated = isChecked
              ? current.filter((l) => l !== option.label)
              : [...current, option.label];
            setMultiSelectedOptions((prev) => ({
              ...prev,
              [currentQuestionIndex]: updated,
            }));
          }
        }
        if (selectedIndex === submitOptionIndex) {
          handleMultiSelectSubmit();
        }
        return;
      }

      // Enter to select
      if (key.name === 'return') {
        // Handle Submit tab
        if (isSubmitTab) {
          if (selectedIndex === 0) {
            // Submit
            void handleSubmit();
          } else {
            // Cancel
            void onConfirm(ToolConfirmationOutcome.Cancel);
          }
          return;
        }

        // Handle multi-select
        if (isMultiSelect && currentQuestion) {
          // Custom input is handled by TextInput's onSubmit
          if (selectedIndex === currentQuestion.options.length) {
            return;
          }
          // Submit option
          if (selectedIndex === submitOptionIndex) {
            handleMultiSelectSubmit();
            return;
          }
          // Toggle predefined option (same as Space)
          if (selectedIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[selectedIndex];
            if (option) {
              const current = multiSelectedOptions[currentQuestionIndex] ?? [];
              const isChecked = current.includes(option.label);
              const updated = isChecked
                ? current.filter((l) => l !== option.label)
                : [...current, option.label];
              setMultiSelectedOptions((prev) => ({
                ...prev,
                [currentQuestionIndex]: updated,
              }));
            }
          }
          return;
        }

        // Handle question options (not custom input - that's handled by TextInput)
        if (currentQuestion && selectedIndex < currentQuestion.options.length) {
          const option = currentQuestion.options[selectedIndex];
          if (option) {
            const updated = {
              ...selectedOptions,
              [currentQuestionIndex]: option.label,
            };
            setSelectedOptions(updated);

            // If single question, submit immediately
            if (!hasMultipleQuestions) {
              void onConfirm(ToolConfirmationOutcome.ProceedOnce, {
                answers: { [currentQuestionIndex]: option.label },
              });
            } else {
              // Auto-advance to next tab after selection
              if (currentQuestionIndex < totalTabs - 1) {
                setTimeout(() => {
                  setCurrentQuestionIndex(currentQuestionIndex + 1);
                  setSelectedIndex(0);
                }, 150);
              }
            }
          }
        }
        return;
      }

      // Cancel
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        void onConfirm(ToolConfirmationOutcome.Cancel);
        return;
      }
    },
    { isActive: isFocused },
  );

  // Submit tab (for multiple questions)
  if (isSubmitTab) {
    return (
      <Box flexDirection="column" padding={1}>
        {/* Tabs */}
        <Box marginBottom={1} flexDirection="row" gap={1}>
          {confirmationDetails.questions.map((q, idx) => {
            const isAnswered = getAnswerForQuestion(idx) !== undefined;
            return (
              <Box key={idx}>
                <Text dimColor>
                  {isAnswered ? '  ' : '  '}
                  {q.header}
                  {isAnswered ? ' ✓' : ''}
                </Text>
              </Box>
            );
          })}
          <Box>
            <Text color={theme.text.link} bold>
              ▸ Submit
            </Text>
          </Box>
        </Box>

        {/* Show selected answers */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Your answers:</Text>
          {confirmationDetails.questions.map((q, idx) => {
            const answer = getAnswerForQuestion(idx);
            return (
              <Box key={idx} marginLeft={2}>
                <Text>
                  {q.header}:{' '}
                  {answer ? (
                    <Text color={theme.text.link}>{answer}</Text>
                  ) : (
                    <Text dimColor>(not answered)</Text>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1} marginBottom={1}>
          <Text>Ready to submit your answers?</Text>
        </Box>

        {/* Submit/Cancel options */}
        <Box flexDirection="column">
          <Box>
            <Text
              color={selectedIndex === 0 ? theme.text.link : theme.text.primary}
              bold={selectedIndex === 0}
            >
              {selectedIndex === 0 ? '❯ ' : '  '}1. Submit answers
            </Text>
          </Box>
          <Box>
            <Text
              color={selectedIndex === 1 ? theme.text.link : theme.text.primary}
              bold={selectedIndex === 1}
            >
              {selectedIndex === 1 ? '❯ ' : '  '}2. Cancel
            </Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>↑/↓: Navigate | ←/→: Switch tabs | Enter: Select</Text>
        </Box>
      </Box>
    );
  }

  // Question tab
  return (
    <Box flexDirection="column" padding={1}>
      {/* Tabs for multiple questions */}
      {hasMultipleQuestions && (
        <Box marginBottom={1} flexDirection="row" gap={1}>
          {confirmationDetails.questions.map((q, idx) => {
            const isAnswered = getAnswerForQuestion(idx) !== undefined;
            return (
              <Box key={idx}>
                <Text
                  color={
                    idx === currentQuestionIndex
                      ? theme.text.link
                      : theme.text.primary
                  }
                  bold={idx === currentQuestionIndex}
                  dimColor={idx !== currentQuestionIndex}
                >
                  {idx === currentQuestionIndex ? '▸ ' : '  '}
                  {q.header}
                  {isAnswered ? ' ✓' : ''}
                </Text>
              </Box>
            );
          })}
          <Box>
            <Text dimColor> Submit</Text>
          </Box>
        </Box>
      )}

      {/* Question */}
      <Box marginBottom={1}>
        {!hasMultipleQuestions && (
          <Box marginBottom={1}>
            <Text color={theme.text.link} bold>
              {currentQuestion!.header}
            </Text>
          </Box>
        )}
        <Text>{currentQuestion!.question}</Text>
      </Box>

      {/* Options */}
      <Box flexDirection="column" marginBottom={1}>
        {currentQuestion!.options.map((opt, index) => {
          const isSelected = selectedIndex === index;
          const isMultiChecked =
            isMultiSelect &&
            (multiSelectedOptions[currentQuestionIndex] ?? []).includes(
              opt.label,
            );
          const isAnswered =
            !isMultiSelect &&
            selectedOptions[currentQuestionIndex] === opt.label;
          const isHighlighted = isSelected || isAnswered || isMultiChecked;
          return (
            <Box key={index} flexDirection="column">
              <Box>
                <Text
                  color={isHighlighted ? theme.text.link : theme.text.primary}
                  bold={isHighlighted}
                >
                  {isSelected ? '❯ ' : '  '}
                  {isMultiSelect ? (isMultiChecked ? '[✓] ' : '[ ] ') : ''}
                  {index + 1}. {opt.label}
                  {isAnswered ? ' ✓' : ''}
                </Text>
              </Box>
              {opt.description && (
                <Box marginLeft={4}>
                  <Text dimColor>{opt.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}

        {/* Type something option/input */}
        <Box flexDirection="column">
          {isCustomInputSelected ? (
            // Inline TextInput replaces the option text
            <Box>
              <Text color={theme.text.link} bold>
                ❯{' '}
                {isMultiSelect
                  ? customInputChecked[currentQuestionIndex]
                    ? '[✓] '
                    : '[ ] '
                  : ''}
                {currentQuestion!.options.length + 1}.{' '}
              </Text>
              <TextInput
                value={currentCustomInputValue}
                initialCursorOffset={currentCustomInputValue.length}
                onChange={(value: string) => {
                  const oldValue =
                    customInputValues[currentQuestionIndex] ?? '';
                  if (isMultiSelect && value !== oldValue) {
                    setCustomInputChecked((prevChecked) => ({
                      ...prevChecked,
                      [currentQuestionIndex]: value.trim().length > 0,
                    }));
                  }
                  setCustomInputValues((prev) => ({
                    ...prev,
                    [currentQuestionIndex]: value,
                  }));
                }}
                onSubmit={handleCustomInputSubmit}
                placeholder="Type something..."
                isActive={true}
                inputWidth={50}
              />
            </Box>
          ) : (
            // Show typed value or placeholder when not selected
            <Box>
              <Text
                color={
                  isCustomInputAnswer ||
                  customInputChecked[currentQuestionIndex]
                    ? theme.text.link
                    : theme.text.primary
                }
                bold={
                  !!(
                    isCustomInputAnswer ||
                    customInputChecked[currentQuestionIndex]
                  )
                }
                dimColor={
                  !currentCustomInputValue &&
                  !isCustomInputAnswer &&
                  !customInputChecked[currentQuestionIndex]
                }
              >
                {'  '}
                {isMultiSelect
                  ? customInputChecked[currentQuestionIndex]
                    ? '[✓] '
                    : '[ ] '
                  : ''}
                {currentQuestion!.options.length + 1}.{' '}
                {currentCustomInputValue || 'Type something...'}
                {isCustomInputAnswer ? ' ✓' : ''}
              </Text>
            </Box>
          )}
        </Box>

        {/* Submit option for multi-select */}
        {isMultiSelect && (
          <Box>
            <Text
              color={
                selectedIndex === submitOptionIndex
                  ? theme.text.link
                  : theme.text.primary
              }
              bold={selectedIndex === submitOptionIndex}
            >
              {selectedIndex === submitOptionIndex ? '❯ ' : '  '}
              {submitOptionIndex + 1}. Submit
            </Text>
          </Box>
        )}
      </Box>

      {/* Help text */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text dimColor>
            ↑/↓: Navigate {hasMultipleQuestions ? '| ←/→: Switch tabs ' : ''}|
            {isMultiSelect ? ' Space/Enter: Toggle | ' : ' Enter: Select | '}
            Esc: Cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
