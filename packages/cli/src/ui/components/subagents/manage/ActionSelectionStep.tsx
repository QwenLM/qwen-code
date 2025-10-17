/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box } from 'ink';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { MANAGEMENT_STEPS } from '../types.js';
import { type SubagentConfig } from '@qwen-code/qwen-code-core';

interface ActionSelectionStepProps {
  selectedAgent: SubagentConfig | null;
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}

export const ActionSelectionStep = ({
  selectedAgent,
  onNavigateToStep,
  onNavigateBack,
}: ActionSelectionStepProps) => {
  const [selectedAction, setSelectedAction] = useState<
    'view' | 'edit' | 'delete' | null
  >(null);

  // Filter actions based on whether the agent is built-in
  const allActions = [
    { key: 'view', label: 'View Agent', value: 'view' as const },
    { key: 'edit', label: 'Edit Agent', value: 'edit' as const },
    { key: 'delete', label: 'Delete Agent', value: 'delete' as const },
    { key: 'back', label: 'Back', value: 'back' as const },
  ];

  const actions = selectedAgent?.isBuiltin
    ? allActions.filter(
        (action) => action.value === 'view' || action.value === 'back',
      )
    : allActions;

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
