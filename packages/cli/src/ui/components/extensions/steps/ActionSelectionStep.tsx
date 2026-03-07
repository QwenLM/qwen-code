/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import { Box } from 'ink';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { type Extension } from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';
import { type ExtensionAction } from '../types.js';

interface ActionSelectionStepProps {
  selectedExtension: Extension | null;
  hasUpdateAvailable: boolean;
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
  onActionSelect: (action: ExtensionAction) => void;
}

export const ActionSelectionStep = ({
  selectedExtension,
  hasUpdateAvailable,
  onNavigateBack,
  onActionSelect,
}: ActionSelectionStepProps) => {
  const [selectedAction, setSelectedAction] = useState<ExtensionAction | null>(
    null,
  );

  const isActive = selectedExtension?.isActive ?? false;

  // Build action list based on extension state
  const actions = useMemo(() => {
    const allActions = [
      {
        key: 'view',
        get label() {
          return t('View Details');
        },
        value: 'view' as const,
      },
      ...(hasUpdateAvailable
        ? [
            {
              key: 'update',
              get label() {
                return t('Update Extension');
              },
              value: 'update' as const,
            },
          ]
        : []),
      ...(isActive
        ? [
            {
              key: 'disable',
              get label() {
                return t('Disable Extension');
              },
              value: 'disable' as const,
            },
          ]
        : [
            {
              key: 'enable',
              get label() {
                return t('Enable Extension');
              },
              value: 'enable' as const,
            },
          ]),
      {
        key: 'uninstall',
        get label() {
          return t('Uninstall Extension');
        },
        value: 'uninstall' as const,
      },
      {
        key: 'back',
        get label() {
          return t('Back');
        },
        value: 'back' as const,
      },
    ];
    return allActions;
  }, [hasUpdateAvailable, isActive]);

  const handleActionSelect = (value: ExtensionAction) => {
    if (value === 'back') {
      onNavigateBack();
      return;
    }

    setSelectedAction(value);
    onActionSelect(value);
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
