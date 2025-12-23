/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Constants for the skill creation wizard.
 */

// Wizard step numbers
export const WIZARD_STEPS = {
  LOCATION_SELECTION: 1,
  GENERATION_METHOD: 2,
  DESCRIPTION_INPUT: 3,
  MANUAL_NAME: 4,
  MANUAL_DESC: 5,
  INSTRUCTIONS_INPUT: 6,
  COLOR_SELECTION: 7,
  FINAL_CONFIRMATION: 8,
} as const;

// Total number of wizard steps
export const TOTAL_WIZARD_STEPS = 6;

// Step names for display
export const STEP_NAMES: Record<number, string> = {
  [WIZARD_STEPS.LOCATION_SELECTION]: 'Location Selection',
  [WIZARD_STEPS.GENERATION_METHOD]: 'Generation Method',
  [WIZARD_STEPS.DESCRIPTION_INPUT]: 'Description Input',
  [WIZARD_STEPS.MANUAL_NAME]: 'Name Input',
  [WIZARD_STEPS.MANUAL_DESC]: 'Description Input',
  [WIZARD_STEPS.INSTRUCTIONS_INPUT]: 'Instructions Input',
  [WIZARD_STEPS.COLOR_SELECTION]: 'Color Selection',
  [WIZARD_STEPS.FINAL_CONFIRMATION]: 'Final Confirmation',
};

// Color options for skill display
export const COLOR_OPTIONS = [
  {
    id: 'auto',
    name: 'Automatic Color',
    value: 'auto',
  },
  {
    id: 'blue',
    name: 'Blue',
    value: '#3b82f6',
  },
  {
    id: 'green',
    name: 'Green',
    value: '#10b981',
  },
  {
    id: 'purple',
    name: 'Purple',
    value: '#8b5cf6',
  },
  {
    id: 'orange',
    name: 'Orange',
    value: '#f59e0b',
  },
  {
    id: 'red',
    name: 'Red',
    value: '#ef4444',
  },
  {
    id: 'cyan',
    name: 'Cyan',
    value: '#06b6d4',
  },
];
