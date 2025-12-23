/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, Skill } from '@qwen-code/qwen-code-core';

type SkillLevel = 'project' | 'user' | 'builtin';

/**
 * State management for the skill creation wizard.
 */
export interface CreationWizardState {
  /** Current step in the wizard */
  currentStep: number;

  /** Storage location for the skill */
  location: SkillLevel;

  /** Generation method selection */
  generationMethod: 'qwen' | 'manual';

  /** User's description input for the skill */
  userDescription: string;

  /** LLM-generated refined description */
  generatedDescription: string;

  /** Markdown instructions */
  instructions: string;

  /** Generated skill name */
  generatedName: string;

  /** Whether LLM generation is in progress */
  isGenerating: boolean;

  /** Color for runtime display */
  color: string;

  /** Validation errors for current step */
  validationErrors: string[];

  /** Whether the wizard can proceed to next step */
  canProceed: boolean;
}

/**
 * Actions that can be dispatched to update wizard state.
 */
export type WizardAction =
  | { type: 'SET_STEP'; step: number }
  | { type: 'SET_LOCATION'; location: SkillLevel }
  | { type: 'SET_GENERATION_METHOD'; method: 'qwen' | 'manual' }
  | { type: 'SET_USER_DESCRIPTION'; description: string }
  | { type: 'SET_GENERATED_NAME'; name: string }
  | { type: 'SET_GENERATED_DESCRIPTION'; description: string }
  | { type: 'SET_INSTRUCTIONS'; instructions: string }
  | {
      type: 'SET_GENERATED_CONTENT';
      name: string;
      description: string;
      instructions: string;
    }
  | { type: 'SET_BACKGROUND_COLOR'; color: string }
  | { type: 'SET_GENERATING'; isGenerating: boolean }
  | { type: 'SET_VALIDATION_ERRORS'; errors: string[] }
  | { type: 'RESET_WIZARD' }
  | { type: 'GO_TO_PREVIOUS_STEP' }
  | { type: 'GO_TO_NEXT_STEP' };

/**
 * Props for wizard step components.
 */
export interface WizardStepProps {
  state: CreationWizardState;
  dispatch: (action: WizardAction) => void;
  onNext: () => void;
  onPrevious: () => void;
  onCancel: () => void;
  onSuccess: () => void;
  config: Config | null;
}

/**
 * Result of the wizard completion.
 */
export interface WizardResult {
  name: string;
  description: string;
  location: SkillLevel;
}

export type SkillWithScope = Skill & { scope: string; isBuiltin: boolean };

export const MANAGEMENT_STEPS = {
  SKILL_SELECTION: 'skill-selection',
  ACTION_SELECTION: 'action-selection',
  SKILL_VIEWER: 'skill-viewer',
  EDIT_OPTIONS: 'edit-options',
  DELETE_CONFIRMATION: 'delete-confirmation',
  EDIT_COLOR: 'edit-color',
} as const;

/**
 * Common props for step navigation.
 */
export interface StepNavigationProps {
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}

/**
 * Predefined color options for skill display.
 */
export interface ColorOption {
  id: string;
  name: string;
  value: string;
}
