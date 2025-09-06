/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { wizardReducer, initialWizardState } from './reducers.js';
import { LocationSelector } from './LocationSelector.js';
import { GenerationMethodSelector } from './GenerationMethodSelector.js';
import { DescriptionInput } from './DescriptionInput.js';
import { ToolSelector } from './ToolSelector.js';
import { ColorSelector } from './ColorSelector.js';
import { CreationSummary } from './CreationSummary.js';
import { WizardStepProps } from './types.js';
import { WIZARD_STEPS } from './constants.js';
import { Config } from '@qwen-code/qwen-code-core';
import { Colors } from '../../colors.js';
import { theme } from '../../semantic-colors.js';

interface SubagentCreationWizardProps {
  onClose: () => void;
  config: Config | null;
}

/**
 * Main orchestrator component for the subagent creation wizard.
 */
export function SubagentCreationWizard({
  onClose,
  config,
}: SubagentCreationWizardProps) {
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);

  const handleNext = useCallback(() => {
    dispatch({ type: 'GO_TO_NEXT_STEP' });
  }, []);

  const handlePrevious = useCallback(() => {
    dispatch({ type: 'GO_TO_PREVIOUS_STEP' });
  }, []);

  const handleCancel = useCallback(() => {
    dispatch({ type: 'RESET_WIZARD' });
    onClose();
  }, [onClose]);

  // Centralized ESC key handling for the entire wizard
  useInput((input, key) => {
    if (key.escape) {
      // Step 3 (DescriptionInput) handles its own ESC logic when generating
      if (
        state.currentStep === WIZARD_STEPS.DESCRIPTION_INPUT &&
        state.isGenerating
      ) {
        return; // Let DescriptionInput handle it
      }

      if (state.currentStep === WIZARD_STEPS.LOCATION_SELECTION) {
        // On first step, ESC cancels the entire wizard
        handleCancel();
      } else {
        // On other steps, ESC goes back to previous step
        handlePrevious();
      }
    }
  });

  const stepProps: WizardStepProps = useMemo(
    () => ({
      state,
      dispatch,
      onNext: handleNext,
      onPrevious: handlePrevious,
      onCancel: handleCancel,
      config,
    }),
    [state, dispatch, handleNext, handlePrevious, handleCancel, config],
  );

  const renderStepHeader = useCallback(() => {
    const getStepHeaderText = () => {
      switch (state.currentStep) {
        case WIZARD_STEPS.LOCATION_SELECTION:
          return 'Step 1: Choose Location';
        case WIZARD_STEPS.GENERATION_METHOD:
          return 'Step 2: Choose Generation Method';
        case WIZARD_STEPS.DESCRIPTION_INPUT:
          return 'Step 3: Describe Your Subagent';
        case WIZARD_STEPS.TOOL_SELECTION:
          return 'Step 4: Select Tools';
        case WIZARD_STEPS.COLOR_SELECTION:
          return 'Step 5: Choose Background Color';
        case WIZARD_STEPS.FINAL_CONFIRMATION:
          return 'Step 6: Confirm and Save';
        default:
          return 'Unknown Step';
      }
    };

    return (
      <Box>
        <Text bold>{getStepHeaderText()}</Text>
      </Box>
    );
  }, [state.currentStep]);

  const renderDebugContent = useCallback(() => {
    if (process.env['NODE_ENV'] !== 'development') {
      return null;
    }

    return (
      <Box borderStyle="single" borderColor={theme.status.warning} padding={1}>
        <Box flexDirection="column">
          <Text color={theme.status.warning} bold>
            Debug Info:
          </Text>
          <Text color={Colors.Gray}>Step: {state.currentStep}</Text>
          <Text color={Colors.Gray}>
            Can Proceed: {state.canProceed ? 'Yes' : 'No'}
          </Text>
          <Text color={Colors.Gray}>
            Generating: {state.isGenerating ? 'Yes' : 'No'}
          </Text>
          <Text color={Colors.Gray}>Location: {state.location}</Text>
          <Text color={Colors.Gray}>Method: {state.generationMethod}</Text>
          {state.validationErrors.length > 0 && (
            <Text color={theme.status.error}>
              Errors: {state.validationErrors.join(', ')}
            </Text>
          )}
        </Box>
      </Box>
    );
  }, [
    state.currentStep,
    state.canProceed,
    state.isGenerating,
    state.location,
    state.generationMethod,
    state.validationErrors,
  ]);

  const renderStepFooter = useCallback(() => {
    const getNavigationInstructions = () => {
      // Special case: During generation in description input step, only show cancel option
      if (
        state.currentStep === WIZARD_STEPS.DESCRIPTION_INPUT &&
        state.isGenerating
      ) {
        return 'Esc to cancel';
      }

      if (state.currentStep === WIZARD_STEPS.FINAL_CONFIRMATION) {
        return 'Press Enter to save, e to save and edit, Esc to go back';
      }

      // Steps that have ↑↓ navigation (RadioButtonSelect components)
      const stepsWithNavigation = [
        WIZARD_STEPS.LOCATION_SELECTION,
        WIZARD_STEPS.GENERATION_METHOD,
        WIZARD_STEPS.TOOL_SELECTION,
        WIZARD_STEPS.COLOR_SELECTION,
      ] as const;

      const hasNavigation = (stepsWithNavigation as readonly number[]).includes(
        state.currentStep,
      );
      const navigationPart = hasNavigation ? '↑↓ to navigate, ' : '';

      const escAction =
        state.currentStep === WIZARD_STEPS.LOCATION_SELECTION
          ? 'cancel'
          : 'go back';

      return `Press Enter to continue, ${navigationPart}Esc to ${escAction}`;
    };

    return (
      <Box>
        <Text color={theme.text.secondary}>{getNavigationInstructions()}</Text>
      </Box>
    );
  }, [state.currentStep, state.isGenerating]);

  const renderStepContent = useCallback(() => {
    switch (state.currentStep) {
      case WIZARD_STEPS.LOCATION_SELECTION:
        return <LocationSelector {...stepProps} />;
      case WIZARD_STEPS.GENERATION_METHOD:
        return <GenerationMethodSelector {...stepProps} />;
      case WIZARD_STEPS.DESCRIPTION_INPUT:
        return <DescriptionInput {...stepProps} />;
      case WIZARD_STEPS.TOOL_SELECTION:
        return (
          <ToolSelector
            tools={state.selectedTools}
            onSelect={(tools) => {
              dispatch({ type: 'SET_TOOLS', tools });
              handleNext();
            }}
            config={config}
          />
        );
      case WIZARD_STEPS.COLOR_SELECTION:
        return (
          <ColorSelector
            backgroundColor={state.backgroundColor}
            agentName={state.generatedName}
            onSelect={(color) => {
              dispatch({ type: 'SET_BACKGROUND_COLOR', color });
              handleNext();
            }}
          />
        );
      case WIZARD_STEPS.FINAL_CONFIRMATION:
        return <CreationSummary {...stepProps} />;
      default:
        return (
          <Box>
            <Text color={theme.status.error}>
              Invalid step: {state.currentStep}
            </Text>
          </Box>
        );
    }
  }, [
    stepProps,
    state.currentStep,
    state.selectedTools,
    state.backgroundColor,
    state.generatedName,
    config,
    handleNext,
    dispatch,
  ]);

  return (
    <Box flexDirection="column">
      {/* Main content wrapped in bounding box */}
      <Box
        borderStyle="single"
        borderColor={Colors.Gray}
        flexDirection="column"
        padding={1}
        width="100%"
        gap={1}
      >
        {renderStepHeader()}
        {renderStepContent()}
        {renderDebugContent()}
        {renderStepFooter()}
      </Box>
    </Box>
  );
}
