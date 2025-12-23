/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box } from 'ink';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { MANAGEMENT_STEPS, type SkillWithScope } from '../types.js';
import { t } from '../../../../i18n/index.js';

interface ActionSelectionStepProps {
  selectedSkill: SkillWithScope | null;
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}

export const ActionSelectionStep = ({
  selectedSkill,
  onNavigateToStep,
  onNavigateBack,
}: ActionSelectionStepProps) => {
  const [selectedAction, setSelectedAction] = useState<
    'view' | 'edit' | 'delete' | null
  >(null);

  // Filter actions based on whether the skill is built-in
  const allActions = [
    {
      key: 'view',
      get label() {
        return t('skills.view');
      },
      value: 'view' as const,
    },
    {
      key: 'edit',
      get label() {
        return t('skills.editAction');
      },
      value: 'edit' as const,
    },
    {
      key: 'delete',
      get label() {
        return t('skills.deleteAction');
      },
      value: 'delete' as const,
    },
    {
      key: 'back',
      get label() {
        return t('Back');
      },
      value: 'back' as const,
    },
  ];

  const actions = selectedSkill?.isBuiltin
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
      onNavigateToStep(MANAGEMENT_STEPS.SKILL_VIEWER);
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
