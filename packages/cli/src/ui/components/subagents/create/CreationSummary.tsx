/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { WizardStepProps } from '../types.js';
import type {
  SubagentManager,
  SubagentConfig,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { shouldShowColor, getColorForDisplay } from '../utils.js';
import { useLaunchEditor } from '../../../hooks/useLaunchEditor.js';
import { useKeypress } from '../../../hooks/useKeypress.js';

/**
 * Step 6: Final confirmation and actions.
 */
export function CreationSummary({
  state,
  onPrevious: _onPrevious,
  onCancel,
  config,
}: WizardStepProps) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const launchEditor = useLaunchEditor();

  const truncateText = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  };

  // Check for warnings
  useEffect(() => {
    const checkWarnings = async () => {
      if (!config || !state.generatedName) return;

      const allWarnings: string[] = [];

      try {
        // Get project root from config
        const subagentManager = config.getSubagentManager();

        // Check for name conflicts
        const isAvailable = await subagentManager.isNameAvailable(
          state.generatedName,
        );
        if (!isAvailable) {
          const existing = await subagentManager.loadSubagent(
            state.generatedName,
          );
          if (existing) {
            const conflictLevel =
              existing.level === 'project' ? 'project' : 'user';
            const targetLevel = state.location;

            if (conflictLevel === targetLevel) {
              allWarnings.push(
                `Name "${state.generatedName}" already exists at ${conflictLevel} level - will overwrite existing subagent`,
              );
            } else if (targetLevel === 'project') {
              allWarnings.push(
                `Name "${state.generatedName}" exists at user level - project level will take precedence`,
              );
            } else {
              allWarnings.push(
                `Name "${state.generatedName}" exists at project level - existing subagent will take precedence`,
              );
            }
          }
        }
      } catch (error) {
        // Silently handle errors in warning checks
        console.warn('Error checking subagent name availability:', error);
      }

      // Check length warnings
      if (state.generatedDescription.length > 300) {
        allWarnings.push(
          `Description is over ${state.generatedDescription.length} characters`,
        );
      }
      if (state.generatedSystemPrompt.length > 10000) {
        allWarnings.push(
          `System prompt is over ${state.generatedSystemPrompt.length} characters`,
        );
      }

      setWarnings(allWarnings);
    };

    checkWarnings();
  }, [
    config,
    state.generatedName,
    state.generatedDescription,
    state.generatedSystemPrompt,
    state.location,
  ]);

  // If no tools explicitly selected, it means "all tools" for this agent
  const toolsDisplay =
    state.selectedTools.length === 0 ? '*' : state.selectedTools.join(', ');

  // Common method to save subagent configuration
  const saveSubagent = useCallback(async (): Promise<SubagentManager> => {
    // Create SubagentManager instance
    if (!config) {
      throw new Error('Configuration not available');
    }
    const subagentManager = config.getSubagentManager();

    // Build subagent configuration
    const subagentConfig: SubagentConfig = {
      name: state.generatedName,
      description: state.generatedDescription,
      systemPrompt: state.generatedSystemPrompt,
      level: state.location,
      filePath: '', // Will be set by manager
      tools: Array.isArray(state.selectedTools)
        ? state.selectedTools
        : undefined,
      color: state.color,
    };

    // Create the subagent
    await subagentManager.createSubagent(subagentConfig, {
      level: state.location,
      overwrite: true,
    });

    return subagentManager;
  }, [state, config]);

  // Common method to show success and auto-close
  const showSuccessAndClose = useCallback(() => {
    setSaveSuccess(true);
    // Auto-close after successful save
    setTimeout(() => {
      onCancel();
    }, 2000);
  }, [onCancel]);

  const handleSave = useCallback(async () => {
    setSaveError(null);

    try {
      await saveSubagent();
      showSuccessAndClose();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'Unknown error occurred',
      );
    }
  }, [saveSubagent, showSuccessAndClose]);

  const handleEdit = useCallback(async () => {
    // Clear any previous error messages
    setSaveError(null);

    try {
      // Save the subagent to file first using shared logic
      const subagentManager = await saveSubagent();

      // Get the file path of the created subagent
      const subagentFilePath = subagentManager.getSubagentPath(
        state.generatedName,
        state.location,
      );

      // Launch editor with the actual subagent file
      await launchEditor(subagentFilePath);

      // Show success UI and auto-close after successful edit
      showSuccessAndClose();
    } catch (error) {
      setSaveError(
        `Failed to save and edit subagent: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }, [
    saveSubagent,
    showSuccessAndClose,
    state.generatedName,
    state.location,
    launchEditor,
  ]);

  // Handle keyboard input
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
            ✅ Subagent Created Successfully!
          </Text>
        </Box>
        <Box>
          <Text>
            Subagent &quot;{state.generatedName}&quot; has been saved to{' '}
            {state.location} level.
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>Name: </Text>
          <Text color={getColorForDisplay(state.color)}>
            {state.generatedName}
          </Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>Location: </Text>
          <Text>
            {state.location === 'project'
              ? 'Project Level (.qwen/agents/)'
              : 'User Level (~/.qwen/agents/)'}
          </Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>Tools: </Text>
          <Text>{toolsDisplay}</Text>
        </Box>

        {shouldShowColor(state.color) && (
          <Box>
            <Text color={theme.text.primary}>Color: </Text>
            <Text color={getColorForDisplay(state.color)}>{state.color}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={theme.text.primary}>Description:</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">
            {truncateText(state.generatedDescription, 250)}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>System Prompt:</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">
            {truncateText(state.generatedSystemPrompt, 250)}
          </Text>
        </Box>
      </Box>

      {saveError && (
        <Box flexDirection="column">
          <Text bold color={theme.status.error}>
            ❌ Error saving subagent:
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
            Warnings:
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
