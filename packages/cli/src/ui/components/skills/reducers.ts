/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CreationWizardState, type WizardAction } from './types.js';
import { WIZARD_STEPS } from './constants.js';
import { getStepKind, getTotalSteps } from './utils.js';

/**
 * Initial state for the creation wizard.
 */
export const initialWizardState: CreationWizardState = {
  currentStep: WIZARD_STEPS.LOCATION_SELECTION,
  location: 'project',
  generationMethod: 'qwen',
  userDescription: '',
  generatedDescription: '',
  instructions: '',
  generatedName: '',
  color: 'auto',
  isGenerating: false,
  validationErrors: [],
  canProceed: false,
};

/**
 * Reducer for managing wizard state transitions.
 */
export function wizardReducer(
  state: CreationWizardState,
  action: WizardAction,
): CreationWizardState {
  switch (action.type) {
    case 'SET_STEP':
      return {
        ...state,
        currentStep: Math.max(
          WIZARD_STEPS.LOCATION_SELECTION,
          Math.min(getTotalSteps(state.generationMethod), action.step),
        ),
        validationErrors: [],
      };

    case 'SET_LOCATION':
      return {
        ...state,
        location: action.location,
        canProceed: true,
      };

    case 'SET_GENERATION_METHOD':
      return {
        ...state,
        generationMethod: action.method,
        canProceed: true,
      };

    case 'SET_USER_DESCRIPTION':
      return {
        ...state,
        userDescription: action.description,
        canProceed: action.description.trim().length >= 0,
      };

    case 'SET_GENERATED_CONTENT':
      return {
        ...state,
        generatedName: action.name,
        generatedDescription: action.description,
        instructions: action.instructions,
        isGenerating: false,
        canProceed: true,
      };

    case 'SET_GENERATED_NAME':
      return {
        ...state,
        generatedName: action.name,
        canProceed: action.name.trim().length > 0,
      };

    case 'SET_GENERATED_DESCRIPTION':
      return {
        ...state,
        generatedDescription: action.description,
        canProceed: action.description.trim().length > 0,
      };

    case 'SET_INSTRUCTIONS':
      return {
        ...state,
        instructions: action.instructions,
        canProceed: action.instructions.trim().length > 0,
      };

    case 'SET_BACKGROUND_COLOR':
      return {
        ...state,
        color: action.color,
        canProceed: true,
      };

    case 'SET_GENERATING':
      return {
        ...state,
        isGenerating: action.isGenerating,
        canProceed: !action.isGenerating,
      };

    case 'SET_VALIDATION_ERRORS':
      return {
        ...state,
        validationErrors: action.errors,
        canProceed: action.errors.length === 0,
      };

    case 'GO_TO_NEXT_STEP':
      if (
        state.canProceed &&
        state.currentStep < getTotalSteps(state.generationMethod)
      ) {
        return {
          ...state,
          currentStep: state.currentStep + 1,
          validationErrors: [],
          canProceed: validateStep(state.currentStep + 1, state),
        };
      }
      return state;

    case 'GO_TO_PREVIOUS_STEP':
      if (state.currentStep > WIZARD_STEPS.LOCATION_SELECTION) {
        return {
          ...state,
          currentStep: state.currentStep - 1,
          validationErrors: [],
          canProceed: validateStep(state.currentStep - 1, state),
        };
      }
      return state;

    case 'RESET_WIZARD':
      return initialWizardState;

    default:
      return state;
  }
}

/**
 * Validates whether a step can proceed based on current state.
 */
function validateStep(step: number, state: CreationWizardState): boolean {
  const kind = getStepKind(state.generationMethod, step);
  switch (kind) {
    case 'LOCATION':
    case 'GEN_METHOD':
      return true;
    case 'LLM_DESC':
      return state.userDescription.trim().length >= 0;
    case 'MANUAL_NAME':
      return state.generatedName.trim().length > 0;
    case 'MANUAL_DESC':
      return state.generatedDescription.trim().length > 0;
    case 'INSTRUCTIONS_INPUT':
      return state.instructions.trim().length > 0;
    case 'COLOR':
      return true;
    case 'FINAL':
      return (
        state.generatedName.length > 0 &&
        state.generatedDescription.length > 0 &&
        state.instructions.length > 0 &&
        state.color.length > 0
      );
    default:
      return false;
  }
}
