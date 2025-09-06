/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box } from 'ink';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import { MANAGEMENT_STEPS } from './types.js';

interface ActionSelectionStepProps {
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}

export const ActionSelectionStep = ({
  onNavigateToStep,
  onNavigateBack,
}: ActionSelectionStepProps) => {
  const [selectedAction, setSelectedAction] = useState<
    'view' | 'edit' | 'delete' | null
  >(null);
  const actions = [
    { label: 'View Agent', value: 'view' as const },
    { label: 'Edit Agent', value: 'edit' as const },
    { label: 'Delete Agent', value: 'delete' as const },
    { label: 'Back', value: 'back' as const },
  ];

  const handleActionSelect = (value: 'view' | 'edit' | 'delete' | 'back') => {
    if (value === 'back') {
      onNavigateBack();
      return;
    }

    setSelectedAction(value);

    // Navigate to appropriate step based on action
    if (value === 'view') {
      onNavigateToStep(MANAGEMENT_STEPS.AGENT_VIEWER);
    } else if (value === 'edit') {
      onNavigateToStep(MANAGEMENT_STEPS.EDIT_OPTIONS);
    } else if (value === 'delete') {
      onNavigateToStep(MANAGEMENT_STEPS.DELETE_CONFIRMATION);
    }
  };

  const selectedIndex = selectedAction
    ? actions.findIndex((action) => action.value === selectedAction)
    : 0;

  return (
    <Box flexDirection="column">
      <RadioButtonSelect
        items={actions}
        initialIndex={selectedIndex}
        onSelect={handleActionSelect}
        showNumbers={false}
      />
    </Box>
  );
};
