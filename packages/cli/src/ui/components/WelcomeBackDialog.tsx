/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type ProjectSummaryInfo } from '@qwen-code/qwen-code-core';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface WelcomeBackDialogProps {
  welcomeBackInfo: ProjectSummaryInfo;
  onSelect: (choice: 'restart' | 'continue') => void;
  onClose: () => void;
}

export function WelcomeBackDialog({
  welcomeBackInfo,
  onSelect,
  onClose,
}: WelcomeBackDialogProps) {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: true },
  );

  const options: Array<RadioSelectItem<'restart' | 'continue'>> = [
    {
      key: 'restart',
      label: 'Start new chat session',
      value: 'restart',
    },
    {
      key: 'continue',
      label: 'Continue previous conversation',
      value: 'continue',
    },
  ];

  // Extract data from welcomeBackInfo
  const {
    timeAgo,
    goalContent,
    totalTasks = 0,
    doneCount = 0,
    inProgressCount = 0,
    pendingTasks = [],
  } = welcomeBackInfo;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={Colors.AccentBlue} bold>
          👋 Welcome back! (Last updated: {timeAgo})
        </Text>
      </Box>

      {/* Overall Goal Section */}
      {goalContent && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={Colors.Foreground} bold>
            🎯 Overall Goal:
          </Text>
          <Box marginTop={1} paddingLeft={2}>
            <Text color={Colors.Gray}>{goalContent}</Text>
          </Box>
        </Box>
      )}

      {/* Current Plan Section */}
      {totalTasks > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={Colors.Foreground} bold>
            📋 Current Plan:
          </Text>
          <Box marginTop={1} paddingLeft={2}>
            <Text color={Colors.Gray}>
              Progress: {doneCount}/{totalTasks} tasks completed
              {inProgressCount > 0 && `, ${inProgressCount} in progress`}
            </Text>
          </Box>

          {pendingTasks.length > 0 && (
            <Box flexDirection="column" marginTop={1} paddingLeft={2}>
              <Text color={Colors.Foreground} bold>
                Pending Tasks:
              </Text>
              {pendingTasks.map((task: string, index: number) => (
                <Text key={index} color={Colors.Gray}>
                  • {task}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {/* Action Selection */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>What would you like to do?</Text>
        <Text>Choose how to proceed with your session:</Text>
      </Box>

      <Box marginTop={1}>
        <RadioButtonSelect items={options} onSelect={onSelect} isFocused />
      </Box>
    </Box>
  );
}
