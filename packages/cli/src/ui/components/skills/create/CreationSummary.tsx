/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { WizardStepProps } from '../types.js';
import { theme } from '../../../semantic-colors.js';
import { t } from '../../../../i18n/index.js';
import { useLaunchEditor } from '../../../hooks/useLaunchEditor.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import type { SkillManager, SkillMetadata } from '@qwen-code/qwen-code-core';

/**
 * Final step: Confirmation and actions.
 */
export function CreationSummary({ state, onSuccess, config }: WizardStepProps) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const launchEditor = useLaunchEditor();

  useEffect(() => {
    const checkWarnings = async () => {
      if (!config || !state.generatedName) return;

      const allWarnings: string[] = [];

      try {
        const skillManager = config.getSkillManager();
        if (!skillManager) return;

        const isAvailable = skillManager.isNameAvailable(state.generatedName);
        if (!isAvailable) {
          const projectRoot = config.getProjectRoot();
          if (!projectRoot) return;
          const existing = await skillManager.loadSkill(state.generatedName);
          if (existing) {
            const conflictLevel = existing.path.startsWith(projectRoot)
              ? 'project'
              : 'user';
            const targetLevel = state.location;

            if (conflictLevel === targetLevel) {
              allWarnings.push(
                t('skills.create.warn.overwrite', {
                  name: state.generatedName,
                  level: conflictLevel,
                }),
              );
            } else if (targetLevel === 'project') {
              allWarnings.push(
                t('skills.create.warn.userPrecedence', {
                  name: state.generatedName,
                }),
              );
            } else {
              allWarnings.push(
                t('skills.create.warn.projectPrecedence', {
                  name: state.generatedName,
                }),
              );
            }
          }
        }
      } catch (error) {
        // Silently handle errors in warning checks
        console.warn('Error checking skill name availability:', error);
      }

      if (state.generatedDescription.length > 300) {
        allWarnings.push(
          t('skills.create.warn.descLength', {
            length: state.generatedDescription.length.toString(),
          }),
        );
      }

      setWarnings(allWarnings);
    };

    checkWarnings();
  }, [config, state.generatedName, state.generatedDescription, state.location]);

  const saveSkill = useCallback(async (): Promise<SkillManager> => {
    if (!config) {
      throw new Error(t('skills.create.error.config'));
    }
    const projectRoot = config.getProjectRoot();
    if (!projectRoot) {
      throw new Error(t('skills.create.error.projectRoot'));
    }
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      throw new Error(t('skills.create.error.skillManager'));
    }

    const skillMetadata: SkillMetadata & { instructions: string } = {
      name: state.generatedName,
      description: state.generatedDescription,
      instructions: state.instructions,
    };

    await skillManager.createSkill(skillMetadata, {
      level: state.location,
      overwrite: true,
      projectRoot,
    });

    return skillManager;
  }, [state, config]);

  const showSuccessAndClose = useCallback(() => {
    setSaveSuccess(true);
    setTimeout(() => {
      onSuccess();
    }, 2000);
  }, [onSuccess]);

  const handleSave = useCallback(async () => {
    setSaveError(null);

    try {
      await saveSkill();
      showSuccessAndClose();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Unknown error occurred',
      );
    }
  }, [saveSkill, showSuccessAndClose]);

  const handleEdit = useCallback(async () => {
    setSaveError(null);

    try {
      const skillManager = await saveSkill();
      const projectRoot = config?.getProjectRoot();
      if (!projectRoot) {
        throw new Error(t('skills.create.error.projectRoot'));
      }
      const skillPath = skillManager.getSkillPath(
        state.generatedName,
        state.location,
        projectRoot,
      );
      await launchEditor(skillPath);
      showSuccessAndClose();
    } catch (error) {
      setSaveError(
        t('skills.create.error.saveAndEdit', {
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  }, [
    saveSkill,
    showSuccessAndClose,
    state.generatedName,
    state.location,
    launchEditor,
    config,
  ]);

  useKeypress(
    (key) => {
      if (saveSuccess) return;

      if (key.name === 'return' || key.sequence === 's') {
        handleSave();
        return;
      }

      if (key.sequence === 'e') {
        handleEdit();
        return;
      }
    },
    { isActive: true },
  );

  if (saveSuccess) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold color={theme.status.success}>
            {t('skills.create.success')}
          </Text>
        </Box>
        <Box>
          <Text>
            {t('skills.create.saved', {
              name: state.generatedName,
              level: state.location,
            })}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>{t('Name: ')}</Text>
          <Text>{state.generatedName}</Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>{t('Location: ')}</Text>
          <Text>
            {state.location === 'project'
              ? t('skills.create.projectLevel')
              : t('skills.create.userLevel')}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Description:')}</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{state.generatedDescription}</Text>
        </Box>
      </Box>

      {saveError && (
        <Box flexDirection="column">
          <Text bold color={theme.status.error}>
            {t('skills.create.error.save')}
          </Text>
          <Box flexDirection="column" padding={1} paddingBottom={0}>
            <Text color={theme.status.error} wrap="wrap">
              {saveError}
            </Text>
          </Box>
        </Box>
      )}

      {warnings.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={theme.status.warning}>
            {t('skills.create.warnings')}
          </Text>
          <Box flexDirection="column" padding={1} paddingBottom={0}>
            {warnings.map((warning, index) => (
              <Text key={index} color={theme.status.warning} wrap="wrap">
                • {warning}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
