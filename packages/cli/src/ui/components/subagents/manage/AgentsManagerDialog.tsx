/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import { AgentSelectionStep } from './AgentSelectionStep.js';
import { ActionSelectionStep } from './ActionSelectionStep.js';
import { AgentViewerStep } from './AgentViewerStep.js';
import { EditOptionsStep } from './AgentEditStep.js';
import { AgentDeleteStep } from './AgentDeleteStep.js';
import { ToolSelector } from '../create/ToolSelector.js';
import { ColorSelector } from '../create/ColorSelector.js';
import { MANAGEMENT_STEPS } from '../types.js';
import { Colors } from '../../../colors.js';
import { theme } from '../../../semantic-colors.js';
import { getColorForDisplay, shouldShowColor } from '../utils.js';
import type { SubagentConfig, Config } from '@qwen-code/qwen-code-core';
import { useKeypress } from '../../../hooks/useKeypress.js';

interface AgentsManagerDialogProps {
  onClose: () => void;
  config: Config | null;
}

/**
 * Main orchestrator component for the agents management dialog.
 */
export function AgentsManagerDialog({
  onClose,
  config,
}: AgentsManagerDialogProps) {
  // Simple state management with useState hooks
  const [availableAgents, setAvailableAgents] = useState<SubagentConfig[]>([]);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState<number>(-1);
  const [navigationStack, setNavigationStack] = useState<string[]>([
    MANAGEMENT_STEPS.AGENT_SELECTION,
  ]);

  // Memoized selectedAgent based on index
  const selectedAgent = useMemo(
    () =>
      selectedAgentIndex >= 0 ? availableAgents[selectedAgentIndex] : null,
    [availableAgents, selectedAgentIndex],
  );

  // Function to load agents
  const loadAgents = useCallback(async () => {
    if (!config) return;

    const manager = config.getSubagentManager();

    // Load agents from all levels separately to show all agents including conflicts
    const allAgents = await manager.listSubagents();

    setAvailableAgents(allAgents);
  }, [config]);

  // Load agents when component mounts or config changes
  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Helper to get current step
  const getCurrentStep = useCallback(
    () =>
      navigationStack[navigationStack.length - 1] ||
      MANAGEMENT_STEPS.AGENT_SELECTION,
    [navigationStack],
  );

  const handleSelectAgent = useCallback((agentIndex: number) => {
    setSelectedAgentIndex(agentIndex);
    setNavigationStack((prev) => [...prev, MANAGEMENT_STEPS.ACTION_SELECTION]);
  }, []);

  const handleNavigateToStep = useCallback((step: string) => {
    setNavigationStack((prev) => [...prev, step]);
  }, []);

  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) {
        return prev; // Can't go back from root step
      }
      return prev.slice(0, -1);
    });
  }, []);

  const handleDeleteAgent = useCallback(
    async (agent: SubagentConfig) => {
      if (!config) return;

      try {
        const subagentManager = config.getSubagentManager();
        await subagentManager.deleteSubagent(agent.name, agent.level);

        // Reload agents to get updated state
        await loadAgents();

        // Navigate back to agent selection after successful deletion
        setNavigationStack([MANAGEMENT_STEPS.AGENT_SELECTION]);
        setSelectedAgentIndex(-1);
      } catch (error) {
        console.error('Failed to delete agent:', error);
        throw error; // Re-throw to let the component handle the error state
      }
    },
    [config, loadAgents],
  );

  // Centralized ESC key handling for the entire dialog
  useKeypress(
    (key) => {
      if (key.name !== 'escape') {
        return;
      }

      const currentStep = getCurrentStep();
      if (currentStep === MANAGEMENT_STEPS.AGENT_SELECTION) {
        // On first step, ESC cancels the entire dialog
        onClose();
      } else {
        // On other steps, ESC goes back to previous step in navigation stack
        handleNavigateBack();
      }
    },
    { isActive: true },
  );

  // Props for child components - now using direct state and callbacks
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
        case MANAGEMENT_STEPS.AGENT_SELECTION:
          return 'Agents';
        case MANAGEMENT_STEPS.ACTION_SELECTION:
          return 'Choose Action';
        case MANAGEMENT_STEPS.AGENT_VIEWER:
          return selectedAgent?.name;
        case MANAGEMENT_STEPS.EDIT_OPTIONS:
          return `Edit ${selectedAgent?.name}`;
        case MANAGEMENT_STEPS.EDIT_TOOLS:
          return `Edit Tools: ${selectedAgent?.name}`;
        case MANAGEMENT_STEPS.EDIT_COLOR:
          return `Edit Color: ${selectedAgent?.name}`;
        case MANAGEMENT_STEPS.DELETE_CONFIRMATION:
          return `Delete ${selectedAgent?.name}`;
        default:
          return 'Unknown Step';
      }
    };

    // Use agent color for the Agent Viewer header
    const headerColor =
      currentStep === MANAGEMENT_STEPS.AGENT_VIEWER &&
      selectedAgent &&
      shouldShowColor(selectedAgent.color)
        ? getColorForDisplay(selectedAgent.color)
        : undefined;

    return (
      <Box>
        <Text bold color={headerColor}>
          {getStepHeaderText()}
        </Text>
      </Box>
    );
  }, [getCurrentStep, selectedAgent]);

  const renderStepFooter = useCallback(() => {
    const currentStep = getCurrentStep();
    const getNavigationInstructions = () => {
      if (currentStep === MANAGEMENT_STEPS.AGENT_SELECTION) {
        if (availableAgents.length === 0) {
          return 'Esc to close';
        }
        return 'Enter to select, ↑↓ to navigate, Esc to close';
      }

      if (currentStep === MANAGEMENT_STEPS.AGENT_VIEWER) {
        return 'Esc to go back';
      }

      if (currentStep === MANAGEMENT_STEPS.DELETE_CONFIRMATION) {
        return 'Enter to confirm, Esc to cancel';
      }

      return 'Enter to select, ↑↓ to navigate, Esc to go back';
    };

    return (
      <Box>
        <Text color={theme.text.secondary}>{getNavigationInstructions()}</Text>
      </Box>
    );
  }, [getCurrentStep, availableAgents]);

  const renderStepContent = useCallback(() => {
    const currentStep = getCurrentStep();
    switch (currentStep) {
      case MANAGEMENT_STEPS.AGENT_SELECTION:
        return (
          <AgentSelectionStep
            availableAgents={availableAgents}
            onAgentSelect={handleSelectAgent}
            {...commonProps}
          />
        );
      case MANAGEMENT_STEPS.ACTION_SELECTION:
        return (
          <ActionSelectionStep selectedAgent={selectedAgent} {...commonProps} />
        );
      case MANAGEMENT_STEPS.AGENT_VIEWER:
        return (
          <AgentViewerStep selectedAgent={selectedAgent} {...commonProps} />
        );
      case MANAGEMENT_STEPS.EDIT_OPTIONS:
        return (
          <EditOptionsStep selectedAgent={selectedAgent} {...commonProps} />
        );
      case MANAGEMENT_STEPS.EDIT_TOOLS:
        return (
          <Box flexDirection="column" gap={1}>
            <ToolSelector
              tools={selectedAgent?.tools || []}
              onSelect={async (tools) => {
                if (selectedAgent && config) {
                  try {
                    // Save the changes using SubagentManager
                    const subagentManager = config.getSubagentManager();
                    await subagentManager.updateSubagent(
                      selectedAgent.name,
                      { tools },
                      selectedAgent.level,
                    );
                    // Reload agents to get updated state
                    await loadAgents();
                    handleNavigateBack();
                  } catch (error) {
                    console.error('Failed to save agent changes:', error);
                  }
                }
              }}
              config={config}
            />
          </Box>
        );
      case MANAGEMENT_STEPS.EDIT_COLOR:
        return (
          <Box flexDirection="column" gap={1}>
            <ColorSelector
              color={selectedAgent?.color || 'auto'}
              agentName={selectedAgent?.name || 'Agent'}
              onSelect={async (color) => {
                // Save changes and reload agents
                if (selectedAgent && config) {
                  try {
                    // Save the changes using SubagentManager
                    const subagentManager = config.getSubagentManager();
                    await subagentManager.updateSubagent(
                      selectedAgent.name,
                      { color },
                      selectedAgent.level,
                    );
                    // Reload agents to get updated state
                    await loadAgents();
                    handleNavigateBack();
                  } catch (error) {
                    console.error('Failed to save color changes:', error);
                  }
                }
              }}
            />
          </Box>
        );
      case MANAGEMENT_STEPS.DELETE_CONFIRMATION:
        return (
          <AgentDeleteStep
            selectedAgent={selectedAgent}
            onDelete={handleDeleteAgent}
            {...commonProps}
          />
        );
      default:
        return (
          <Box>
            <Text color={theme.status.error}>Invalid step: {currentStep}</Text>
          </Box>
        );
    }
  }, [
    getCurrentStep,
    availableAgents,
    selectedAgent,
    commonProps,
    config,
    loadAgents,
    handleNavigateBack,
    handleSelectAgent,
    handleDeleteAgent,
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
        {renderStepFooter()}
      </Box>
    </Box>
  );
}
