/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { wizardReducer, initialWizardState } from '../reducers.js';
import { LocationSelector } from './LocationSelector.js';
import { GenerationMethodSelector } from './GenerationMethodSelector.js';
import { DescriptionInput } from './DescriptionInput.js';
import { ToolSelector } from './ToolSelector.js';
import { ColorSelector } from './ColorSelector.js';
import { CreationSummary } from './CreationSummary.js';
import { type WizardStepProps } from '../types.js';
import { WIZARD_STEPS } from '../constants.js';
import { getStepKind } from '../utils.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { TextEntryStep } from './TextEntryStep.js';
import { useKeypress } from '../../../hooks/useKeypress.js';

interface AgentCreationWizardProps {
  onClose: () => void;
  config: Config | null;
}

/**
 * Main orchestrator component for the subagent creation wizard.
 */
export function AgentCreationWizard({
  onClose,
  config,
}: AgentCreationWizardProps) {
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
  useKeypress(
    (key) => {
      if (key.name !== 'escape') {
        return;
      }

      // LLM DescriptionInput handles its own ESC logic when generating
      const kind = getStepKind(state.generationMethod, state.currentStep);
      if (kind === 'LLM_DESC' && state.isGenerating) {
        return; // Let DescriptionInput handle it
      }

      if (state.currentStep === WIZARD_STEPS.LOCATION_SELECTION) {
        // On first step, ESC cancels the entire wizard
        handleCancel();
      } else {
        // On other steps, ESC goes back to previous step
        handlePrevious();
      }
    },
    { isActive: true },
  );

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
      const kind = getStepKind(state.generationMethod, state.currentStep);
      const n = state.currentStep;
      switch (kind) {
        case 'LOCATION':
          return `Step ${n}: Choose Location`;
        case 'GEN_METHOD':
          return `Step ${n}: Choose Generation Method`;
        case 'LLM_DESC':
          return `Step ${n}: Describe Your Subagent`;
        case 'MANUAL_NAME':
          return `Step ${n}: Enter Subagent Name`;
        case 'MANUAL_PROMPT':
          return `Step ${n}: Enter System Prompt`;
        case 'MANUAL_DESC':
          return `Step ${n}: Enter Description`;
        case 'TOOLS':
          return `Step ${n}: Select Tools`;
        case 'COLOR':
          return `Step ${n}: Choose Background Color`;
        case 'FINAL':
          return `Step ${n}: Confirm and Save`;
        default:
          return 'Unknown Step';
      }
    };

    return (
      <Box>
        <Text bold>{getStepHeaderText()}</Text>
      </Box>
    );
  }, [state.currentStep, state.generationMethod]);

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
          <Text color={theme.text.secondary}>Step: {state.currentStep}</Text>
          <Text color={theme.text.secondary}>
            Can Proceed: {state.canProceed ? 'Yes' : 'No'}
          </Text>
          <Text color={theme.text.secondary}>
            Generating: {state.isGenerating ? 'Yes' : 'No'}
          </Text>
          <Text color={theme.text.secondary}>Location: {state.location}</Text>
          <Text color={theme.text.secondary}>
            Method: {state.generationMethod}
          </Text>
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
      const kind = getStepKind(state.generationMethod, state.currentStep);
      if (kind === 'LLM_DESC' && state.isGenerating) {
        return 'Esc to cancel';
      }

      if (getStepKind(state.generationMethod, state.currentStep) === 'FINAL') {
        return 'Press Enter to save, e to save and edit, Esc to go back';
      }

      // Steps that have ↑↓ navigation (RadioButtonSelect components)
      const kindForNav = getStepKind(state.generationMethod, state.currentStep);
      const hasNavigation =
        kindForNav === 'LOCATION' ||
        kindForNav === 'GEN_METHOD' ||
        kindForNav === 'TOOLS' ||
        kindForNav === 'COLOR';
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
  }, [state.currentStep, state.isGenerating, state.generationMethod]);

  const renderStepContent = useCallback(() => {
    const kind = getStepKind(state.generationMethod, state.currentStep);
    switch (kind) {
      case 'LOCATION':
        return <LocationSelector {...stepProps} />;
      case 'GEN_METHOD':
        return <GenerationMethodSelector {...stepProps} />;
      case 'LLM_DESC':
        return <DescriptionInput {...stepProps} />;
      case 'MANUAL_NAME':
        return (
          <TextEntryStep
            key="manual-name"
            state={state}
            dispatch={dispatch}
            onNext={handleNext}
            description="Enter a clear, unique name for this subagent."
            placeholder="e.g., Code Reviewer"
            height={1}
            initialText={state.generatedName}
            onChange={(t) => {
              const value = t; // keep raw, trim later when validating
              dispatch({ type: 'SET_GENERATED_NAME', name: value });
            }}
            validate={(t) =>
              t.trim().length === 0 ? 'Name cannot be empty.' : null
            }
          />
        );
      case 'MANUAL_PROMPT':
        return (
          <TextEntryStep
            key="manual-prompt"
            state={state}
            dispatch={dispatch}
            onNext={handleNext}
            description="Write the system prompt that defines this subagent's behavior. Be comprehensive for best results."
            placeholder="e.g., You are an expert code reviewer..."
            height={10}
            initialText={state.generatedSystemPrompt}
            onChange={(t) => {
              dispatch({
                type: 'SET_GENERATED_SYSTEM_PROMPT',
                systemPrompt: t,
              });
            }}
            validate={(t) =>
              t.trim().length === 0 ? 'System prompt cannot be empty.' : null
            }
          />
        );
      case 'MANUAL_DESC':
        return (
          <TextEntryStep
            key="manual-desc"
            state={state}
            dispatch={dispatch}
            onNext={handleNext}
            description="Describe when and how this subagent should be used."
            placeholder="e.g., Reviews code for best practices and potential bugs."
            height={6}
            initialText={state.generatedDescription}
            onChange={(t) => {
              dispatch({ type: 'SET_GENERATED_DESCRIPTION', description: t });
            }}
            validate={(t) =>
              t.trim().length === 0 ? 'Description cannot be empty.' : null
            }
          />
        );
      case 'TOOLS':
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
      case 'COLOR':
        return (
          <ColorSelector
            color={state.color}
            agentName={state.generatedName}
            onSelect={(color) => {
              dispatch({ type: 'SET_BACKGROUND_COLOR', color });
              handleNext();
            }}
          />
        );
      case 'FINAL':
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
  }, [stepProps, state, config, handleNext, dispatch]);

  return (
    <Box flexDirection="column">
      {/* Main content wrapped in bounding box */}
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
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
