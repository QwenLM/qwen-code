/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import os from 'os';
import path from 'path';
import { SkillSelectionStep } from './SkillSelectionStep.js';
import { ActionSelectionStep } from './ActionSelectionStep.js';
import { SkillViewerStep } from './SkillViewerStep.js';
import { EditOptionsStep } from './SkillEditStep.js';
import { SkillDeleteStep } from './SkillDeleteStep.js';
import { MANAGEMENT_STEPS, type SkillWithScope } from '../types.js';
import { ColorSelector } from '../create/ColorSelector.js';
import { theme } from '../../../semantic-colors.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';

interface SkillsManagerDialogProps {
  onClose: () => void;
  config: Config | null;
}

/**
 * Main orchestrator component for the skills management dialog.
 */
export function SkillsManagerDialog({
  onClose,
  config,
}: SkillsManagerDialogProps) {
  const [availableSkills, setAvailableSkills] = useState<SkillWithScope[]>([]);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState<number>(-1);
  const [navigationStack, setNavigationStack] = useState<string[]>([
    MANAGEMENT_STEPS.SKILL_SELECTION,
  ]);

  const selectedSkill = useMemo(
    () =>
      selectedSkillIndex >= 0 ? availableSkills[selectedSkillIndex] : null,
    [availableSkills, selectedSkillIndex],
  );

  const loadSkills = useCallback(async () => {
    if (!config) return;

    const manager = config.getSkillManager();
    const allSkills = (await manager?.listSkills()) ?? [];

    const projectRoot = config.getProjectRoot();
    const homeDir = os.homedir();

    const skillsWithScope = allSkills.map((skill) => {
      const isProjectSkill = skill.path.startsWith(
        path.join(projectRoot, '.qwen'),
      );
      const isGlobalSkill = skill.path.startsWith(path.join(homeDir, '.qwen'));

      // A simple way to check for builtin, real implementation might differ.
      const isBuiltin = !isProjectSkill && !isGlobalSkill;

      const scope = isProjectSkill
        ? '[project]'
        : isGlobalSkill
          ? '[global]'
          : '[builtin]';

      return { ...skill, scope, isBuiltin };
    });

    setAvailableSkills(skillsWithScope);
  }, [config]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const getCurrentStep = useCallback(
    () =>
      navigationStack[navigationStack.length - 1] ||
      MANAGEMENT_STEPS.SKILL_SELECTION,
    [navigationStack],
  );

  const handleSelectSkill = useCallback((skillIndex: number) => {
    setSelectedSkillIndex(skillIndex);
    setNavigationStack((prev) => [...prev, MANAGEMENT_STEPS.ACTION_SELECTION]);
  }, []);

  const handleNavigateToStep = useCallback((step: string) => {
    setNavigationStack((prev) => [...prev, step]);
  }, []);

  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) {
        return prev;
      }
      return prev.slice(0, -1);
    });
  }, []);

  const handleDeleteSkill = useCallback(
    async (skill: SkillWithScope) => {
      if (!config) return;

      try {
        const skillManager = config.getSkillManager();
        if (skillManager) {
          await skillManager.deleteSkill(skill.path);
        }

        // Reload skills to get updated state
        await loadSkills();

        // Navigate back to skill selection after successful deletion
        setNavigationStack([MANAGEMENT_STEPS.SKILL_SELECTION]);
        setSelectedSkillIndex(-1);
      } catch (error) {
        console.error('Failed to delete skill:', error);
        throw error;
      }
    },
    [config, loadSkills],
  );

  useKeypress(
    (key) => {
      if (key.name !== 'escape') {
        return;
      }

      const currentStep = getCurrentStep();
      if (currentStep === MANAGEMENT_STEPS.SKILL_SELECTION) {
        onClose();
      } else {
        handleNavigateBack();
      }
    },
    { isActive: true },
  );

  const commonProps = useMemo(
    () => ({
      onNavigateToStep: handleNavigateToStep,
      onNavigateBack: handleNavigateBack,
    }),
    [handleNavigateToStep, handleNavigateBack],
  );

  const renderStepHeader = useCallback(() => {
    const currentStep = getCurrentStep();
    const getStepHeaderText = () => {
      switch (currentStep) {
        case MANAGEMENT_STEPS.SKILL_SELECTION:
          return t('skills.title');
        case MANAGEMENT_STEPS.ACTION_SELECTION:
          return t('skills.chooseAction');
        case MANAGEMENT_STEPS.SKILL_VIEWER:
          return selectedSkill?.metadata.name;
        case MANAGEMENT_STEPS.EDIT_OPTIONS:
          return t('skills.edit', {
            name: selectedSkill?.metadata.name ?? '',
          });
        case MANAGEMENT_STEPS.DELETE_CONFIRMATION:
          return t('skills.delete', {
            name: selectedSkill?.metadata.name ?? '',
          });
        default:
          return t('skills.unknownStep');
      }
    };

    return (
      <Box>
        <Text bold>{getStepHeaderText()}</Text>
      </Box>
    );
  }, [getCurrentStep, selectedSkill]);

  const renderStepFooter = useCallback(() => {
    const currentStep = getCurrentStep();
    const getNavigationInstructions = () => {
      if (currentStep === MANAGEMENT_STEPS.SKILL_SELECTION) {
        if (availableSkills.length === 0) {
          return t('skills.escToClose');
        }
        return t('skills.nav.select');
      }

      if (currentStep === MANAGEMENT_STEPS.SKILL_VIEWER) {
        return t('skills.nav.back');
      }

      if (currentStep === MANAGEMENT_STEPS.DELETE_CONFIRMATION) {
        return t('skills.nav.confirm');
      }

      return t('skills.nav.selectAndBack');
    };

    return (
      <Box>
        <Text color={theme.text.secondary}>{getNavigationInstructions()}</Text>
      </Box>
    );
  }, [getCurrentStep, availableSkills]);

  const renderStepContent = useCallback(() => {
    const currentStep = getCurrentStep();
    switch (currentStep) {
      case MANAGEMENT_STEPS.SKILL_SELECTION:
        return (
          <SkillSelectionStep
            availableSkills={availableSkills}
            onSkillSelect={handleSelectSkill}
            {...commonProps}
          />
        );
      case MANAGEMENT_STEPS.ACTION_SELECTION:
        return (
          <ActionSelectionStep selectedSkill={selectedSkill} {...commonProps} />
        );
      case MANAGEMENT_STEPS.SKILL_VIEWER:
        return (
          <SkillViewerStep selectedSkill={selectedSkill} {...commonProps} />
        );
      case MANAGEMENT_STEPS.EDIT_OPTIONS:
        return (
          <EditOptionsStep selectedSkill={selectedSkill} {...commonProps} />
        );
      case MANAGEMENT_STEPS.DELETE_CONFIRMATION:
        return (
          <SkillDeleteStep
            selectedSkill={selectedSkill}
            onDelete={handleDeleteSkill}
            {...commonProps}
          />
        );
      case MANAGEMENT_STEPS.EDIT_COLOR:
        return (
          <ColorSelector
            skillName={selectedSkill?.metadata.name}
            color={selectedSkill?.metadata.color}
            onSelect={async (color: string) => {
              if (selectedSkill) {
                await config
                  ?.getSkillManager()
                  ?.updateSkill(selectedSkill.metadata.name, { color });
                await loadSkills();
                handleNavigateBack();
              }
            }}
          />
        );
      default:
        return (
          <Box>
            <Text color={theme.status.error}>
              {t('skills.error.invalidStep', { step: currentStep })}
            </Text>
          </Box>
        );
    }
  }, [
    getCurrentStep,
    availableSkills,
    selectedSkill,
    commonProps,
    handleSelectSkill,
    handleDeleteSkill,
    config,
    handleNavigateBack,
    loadSkills,
  ]);

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
