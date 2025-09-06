/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { CreationWizardState, WizardAction } from './types.js';
import { WIZARD_STEPS, TOTAL_WIZARD_STEPS } from './constants.js';

/**
 * Initial state for the creation wizard.
 */
export const initialWizardState: CreationWizardState = {
  currentStep: WIZARD_STEPS.LOCATION_SELECTION,
  location: 'project',
  generationMethod: 'qwen',
  userDescription: '',
  generatedSystemPrompt: '',
  generatedDescription: '',
  generatedName: '',
  selectedTools: [],
  backgroundColor: 'auto',
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
          Math.min(TOTAL_WIZARD_STEPS, action.step),
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
        generatedSystemPrompt: action.systemPrompt,
        isGenerating: false,
        canProceed: true,
      };

    case 'SET_TOOLS':
      return {
        ...state,
        selectedTools: action.tools,
        canProceed: true,
      };

    case 'SET_BACKGROUND_COLOR':
      return {
        ...state,
        backgroundColor: action.color,
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
      if (state.canProceed && state.currentStep < TOTAL_WIZARD_STEPS) {
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
  switch (step) {
    case WIZARD_STEPS.LOCATION_SELECTION: // Location selection
      return true; // Always can proceed from location selection

    case WIZARD_STEPS.GENERATION_METHOD: // Generation method
      return true; // Always can proceed from method selection

    case WIZARD_STEPS.DESCRIPTION_INPUT: // Description input
      return state.userDescription.trim().length >= 0;

    case WIZARD_STEPS.TOOL_SELECTION: // Tool selection
      return (
        state.generatedName.length > 0 &&
        state.generatedDescription.length > 0 &&
        state.generatedSystemPrompt.length > 0
      );

    case WIZARD_STEPS.COLOR_SELECTION: // Color selection
      return true; // Always can proceed from tool selection

    case WIZARD_STEPS.FINAL_CONFIRMATION: // Final confirmation
      return state.backgroundColor.length > 0;

    default:
      return false;
  }
}
