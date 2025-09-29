/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';

export enum VisionSwitchOutcome {
  SwitchOnce = 'once',
  SwitchSessionToVL = 'session',
  ContinueWithCurrentModel = 'persist',
}

export interface ModelSwitchDialogProps {
  onSelect: (outcome: VisionSwitchOutcome) => void;
}

export const ModelSwitchDialog: React.FC<ModelSwitchDialogProps> = ({
  onSelect,
}) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(VisionSwitchOutcome.ContinueWithCurrentModel);
      }
    },
    { isActive: true },
  );

  const options: Array<RadioSelectItem<VisionSwitchOutcome>> = [
    {
      label: 'Switch for this request only',
      value: VisionSwitchOutcome.SwitchOnce,
    },
    {
      label: 'Switch session to vision model',
      value: VisionSwitchOutcome.SwitchSessionToVL,
    },
    {
      label: 'Continue with current model',
      value: VisionSwitchOutcome.ContinueWithCurrentModel,
    },
  ];

  const handleSelect = (outcome: VisionSwitchOutcome) => {
    onSelect(outcome);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentYellow}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Vision Model Switch Required</Text>
        <Text>
          Your message contains an image, but the current model doesn&apos;t
          support vision.
        </Text>
        <Text>How would you like to proceed?</Text>
      </Box>

      <Box marginBottom={1}>
        <RadioButtonSelect
          items={options}
          initialIndex={0}
          onSelect={handleSelect}
          isFocused
        />
      </Box>

      <Box>
        <Text color={Colors.Gray}>Press Enter to select, Esc to cancel</Text>
      </Box>
    </Box>
  );
};
