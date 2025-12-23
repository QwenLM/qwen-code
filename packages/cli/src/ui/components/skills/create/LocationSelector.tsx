/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import type { WizardStepProps } from '../types.js';
import { t } from '../../../../i18n/index.js';

interface LocationOption {
  label: string;
  value: 'project' | 'user';
}

/**
 * Step 1: Location selection for skill storage.
 */
export function LocationSelector({ state, dispatch, onNext }: WizardStepProps) {
  const handleSelect = (selectedValue: string) => {
    const location = selectedValue as 'project' | 'user';
    dispatch({ type: 'SET_LOCATION', location });
    onNext();
  };

  const locationOptions: LocationOption[] = [
    {
      label: t('skills.create.projectLevel'),
      value: 'project',
    },
    {
      label: t('skills.create.userLevel'),
      value: 'user',
    },
  ];
  return (
    <Box flexDirection="column">
      <RadioButtonSelect
        items={locationOptions.map((option) => ({
          key: option.value,
          label: option.label,
          value: option.value,
        }))}
        initialIndex={locationOptions.findIndex(
          (opt) => opt.value === state.location,
        )}
        onSelect={handleSelect}
        isFocused={true}
      />
    </Box>
  );
}
