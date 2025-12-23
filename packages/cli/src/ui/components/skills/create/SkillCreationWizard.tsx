/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { wizardReducer, initialWizardState } from '../reducers.js';
import { LocationSelector } from './LocationSelector.js';
import { ColorSelector } from './ColorSelector.js';
import { CreationSummary } from './CreationSummary.js';
import { GenerationMethodSelector } from './GenerationMethodSelector.js';
import { DescriptionInput } from './DescriptionInput.js';
import { type WizardStepProps } from '../types.js';
import { WIZARD_STEPS } from '../constants.js';
import {
  getStepKind,
  validateSkillName,
  validateSkillDescription,
} from '../utils.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { TextEntryStep } from './TextEntryStep.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';

interface SkillCreationWizardProps {
  onClose: () => void;
  onSuccess: () => void;
  config: Config | null;
}

/**
 * Main orchestrator component for the skill creation wizard.
 */
export function SkillCreationWizard({
  onClose,
  onSuccess,
  config,
}: SkillCreationWizardProps) {
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

  useKeypress(
    (key) => {
      if (key.name !== 'escape') {
        return;
      }

      if (state.currentStep === WIZARD_STEPS.LOCATION_SELECTION) {
        handleCancel();
      } else {
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
      onSuccess,
      config,
    }),
    [
      state,
      dispatch,
      handleNext,
      handlePrevious,
      handleCancel,
      onSuccess,
      config,
    ],
  );

  const renderStepHeader = useCallback(() => {
    const getStepHeaderText = () => {
      const kind = getStepKind(state.generationMethod, state.currentStep);
      const n = state.currentStep;
      switch (kind) {
        case 'LOCATION':
          return t('skills.create.step.location', { n: n.toString() });
        case 'GEN_METHOD':
          return t('skills.create.step.method', { n: n.toString() });
        case 'LLM_DESC':
          return t('skills.create.step.description', { n: n.toString() });
        case 'MANUAL_NAME':
          return t('skills.create.step.name', { n: n.toString() });
        case 'MANUAL_DESC':
          return t('skills.create.step.description', { n: n.toString() });
        case 'INSTRUCTIONS_INPUT':
          return t('skills.create.step.instructions', { n: n.toString() });
        case 'COLOR':
          return t('skills.create.step.color', { n: n.toString() });
        case 'FINAL':
          return t('skills.create.step.confirm', { n: n.toString() });
        default:
          return t('skills.unknownStep');
      }
    };

    return (
      <Box>
        <Text bold>{getStepHeaderText()}</Text>
      </Box>
    );
  }, [state.currentStep, state.generationMethod]);

  const renderStepFooter = useCallback(() => {
    const getNavigationInstructions = () => {
      if (getStepKind(state.generationMethod, state.currentStep) === 'FINAL') {
        return t('skills.create.nav.save');
      }

      const kindForNav = getStepKind(state.generationMethod, state.currentStep);
      const hasNavigation = kindForNav === 'LOCATION';
      const navigationPart = hasNavigation ? t('skills.create.nav.arrows') : '';

      const escAction =
        state.currentStep === WIZARD_STEPS.LOCATION_SELECTION
          ? t('skills.create.cancel')
          : t('skills.create.goBack');

      return t('skills.create.nav.continue', {
        navigation: navigationPart,
        action: escAction,
      });
    };

    return (
      <Box>
        <Text color={theme.text.secondary}>{getNavigationInstructions()}</Text>
      </Box>
    );
  }, [state.currentStep, state.generationMethod]);

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
            description={t('skills.create.prompt.name')}
            placeholder={t('skills.create.placeholder.name')}
            height={1}
            initialText={state.generatedName}
            onChange={(text) => {
              const value = text; // keep raw, trim later when validating
              dispatch({ type: 'SET_GENERATED_NAME', name: value });
            }}
            validate={(text) => {
              const errorKey = validateSkillName(text);
              return errorKey ? t(errorKey) : null;
            }}
          />
        );
      case 'MANUAL_DESC':
        return (
          <TextEntryStep
            key="manual-desc"
            state={state}
            dispatch={dispatch}
            onNext={handleNext}
            description={t('skills.create.prompt.description')}
            placeholder={t('skills.create.placeholder.description')}
            height={6}
            initialText={state.generatedDescription}
            onChange={(text) => {
              dispatch({
                type: 'SET_GENERATED_DESCRIPTION',
                description: text,
              });
            }}
            validate={(text) => {
              const errorKey = validateSkillDescription(text);
              return errorKey ? t(errorKey) : null;
            }}
          />
        );
      case 'INSTRUCTIONS_INPUT':
        return (
          <TextEntryStep
            key="manual-instructions"
            state={state}
            dispatch={dispatch}
            onNext={handleNext}
            description={t('skills.create.prompt.instructions')}
            placeholder={t('skills.create.placeholder.instructions')}
            height={10}
            initialText={state.instructions}
            onChange={(text) => {
              dispatch({ type: 'SET_INSTRUCTIONS', instructions: text });
            }}
            validate={(text) =>
              text.trim().length === 0
                ? t('skills.create.error.instructionsEmpty')
                : null
            }
          />
        );
      case 'COLOR':
        return (
          <ColorSelector
            color={state.color}
            skillName={state.generatedName}
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
              {t('skills.error.invalidStep', {
                step: state.currentStep.toString(),
              })}
            </Text>
          </Box>
        );
    }
  }, [stepProps, state, handleNext, dispatch]);

  return (
    <Box flexDirection="column">
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
        {renderStepFooter()}
      </Box>
    </Box>
  );
}
