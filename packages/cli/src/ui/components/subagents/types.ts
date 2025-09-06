/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SubagentLevel, Config } from '@qwen-code/qwen-code-core';

/**
 * State management for the subagent creation wizard.
 */
export interface CreationWizardState {
  /** Current step in the wizard (1-6) */
  currentStep: number;

  /** Storage location for the subagent */
  location: SubagentLevel;

  /** Generation method selection */
  generationMethod: 'qwen' | 'manual';

  /** User's description input for the subagent */
  userDescription: string;

  /** LLM-generated system prompt */
  generatedSystemPrompt: string;

  /** LLM-generated refined description */
  generatedDescription: string;

  /** Generated subagent name */
  generatedName: string;

  /** Selected tools for the subagent */
  selectedTools: string[];

  /** Background color for runtime display */
  backgroundColor: string;

  /** Whether LLM generation is in progress */
  isGenerating: boolean;

  /** Validation errors for current step */
  validationErrors: string[];

  /** Whether the wizard can proceed to next step */
  canProceed: boolean;
}

/**
 * Tool categories for organized selection.
 */
export interface ToolCategory {
  id: string;
  name: string;
  tools: string[];
}

/**
 * Predefined color options for subagent display.
 */
export interface ColorOption {
  id: string;
  name: string;
  value: string;
}

/**
 * Actions that can be dispatched to update wizard state.
 */
export type WizardAction =
  | { type: 'SET_STEP'; step: number }
  | { type: 'SET_LOCATION'; location: SubagentLevel }
  | { type: 'SET_GENERATION_METHOD'; method: 'qwen' | 'manual' }
  | { type: 'SET_USER_DESCRIPTION'; description: string }
  | {
      type: 'SET_GENERATED_CONTENT';
      name: string;
      description: string;
      systemPrompt: string;
    }
  | { type: 'SET_TOOLS'; tools: string[] }
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
  config: Config | null;
}

/**
 * Result of the wizard completion.
 */
export interface WizardResult {
  name: string;
  description: string;
  systemPrompt: string;
  location: SubagentLevel;
  tools?: string[];
  backgroundColor: string;
}

export const MANAGEMENT_STEPS = {
  AGENT_SELECTION: 'agent-selection',
  ACTION_SELECTION: 'action-selection',
  AGENT_VIEWER: 'agent-viewer',
  EDIT_OPTIONS: 'edit-options',
  EDIT_TOOLS: 'edit-tools',
  EDIT_COLOR: 'edit-color',
  DELETE_CONFIRMATION: 'delete-confirmation',
} as const;

/**
 * Common props for step navigation.
 */
export interface StepNavigationProps {
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}
