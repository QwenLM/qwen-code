/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { Colors } from '../../colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { SubagentConfig } from '@qwen-code/qwen-code-core';

interface NavigationState {
  currentBlock: 'project' | 'user';
  projectIndex: number;
  userIndex: number;
}

interface AgentSelectionStepProps {
  availableAgents: SubagentConfig[];
  onAgentSelect: (agentIndex: number) => void;
}

export const AgentSelectionStep = ({
  availableAgents,
  onAgentSelect,
}: AgentSelectionStepProps) => {
  const [navigation, setNavigation] = useState<NavigationState>({
    currentBlock: 'project',
    projectIndex: 0,
    userIndex: 0,
  });

  // Group agents by level
  const projectAgents = useMemo(
    () => availableAgents.filter((agent) => agent.level === 'project'),
    [availableAgents],
  );
  const userAgents = useMemo(
    () => availableAgents.filter((agent) => agent.level === 'user'),
    [availableAgents],
  );
  const projectNames = useMemo(
    () => new Set(projectAgents.map((agent) => agent.name)),
    [projectAgents],
  );

  // Initialize navigation state when agents are loaded (only once)
  useEffect(() => {
    if (projectAgents.length > 0) {
      setNavigation((prev) => ({ ...prev, currentBlock: 'project' }));
    } else if (userAgents.length > 0) {
      setNavigation((prev) => ({ ...prev, currentBlock: 'user' }));
    }
  }, [projectAgents, userAgents]);

  // Custom keyboard navigation
  useKeypress(
    (key) => {
      const { name } = key;

      if (name === 'up' || name === 'k') {
        setNavigation((prev) => {
          if (prev.currentBlock === 'project') {
            if (prev.projectIndex > 0) {
              return { ...prev, projectIndex: prev.projectIndex - 1 };
            } else if (userAgents.length > 0) {
              // Move to last item in user block
              return {
                ...prev,
                currentBlock: 'user',
                userIndex: userAgents.length - 1,
              };
            } else {
              // Wrap to last item in project block
              return { ...prev, projectIndex: projectAgents.length - 1 };
            }
          } else {
            if (prev.userIndex > 0) {
              return { ...prev, userIndex: prev.userIndex - 1 };
            } else if (projectAgents.length > 0) {
              // Move to last item in project block
              return {
                ...prev,
                currentBlock: 'project',
                projectIndex: projectAgents.length - 1,
              };
            } else {
              // Wrap to last item in user block
              return { ...prev, userIndex: userAgents.length - 1 };
            }
          }
        });
      } else if (name === 'down' || name === 'j') {
        setNavigation((prev) => {
          if (prev.currentBlock === 'project') {
            if (prev.projectIndex < projectAgents.length - 1) {
              return { ...prev, projectIndex: prev.projectIndex + 1 };
            } else if (userAgents.length > 0) {
              // Move to first item in user block
              return { ...prev, currentBlock: 'user', userIndex: 0 };
            } else {
              // Wrap to first item in project block
              return { ...prev, projectIndex: 0 };
            }
          } else {
            if (prev.userIndex < userAgents.length - 1) {
              return { ...prev, userIndex: prev.userIndex + 1 };
            } else if (projectAgents.length > 0) {
              // Move to first item in project block
              return { ...prev, currentBlock: 'project', projectIndex: 0 };
            } else {
              // Wrap to first item in user block
              return { ...prev, userIndex: 0 };
            }
          }
        });
      } else if (name === 'return' || name === 'space') {
        // Calculate global index and select current item
        let globalIndex: number;
        if (navigation.currentBlock === 'project') {
          globalIndex = navigation.projectIndex;
        } else {
          // User agents come after project agents in the availableAgents array
          globalIndex = projectAgents.length + navigation.userIndex;
        }

        if (globalIndex >= 0 && globalIndex < availableAgents.length) {
          onAgentSelect(globalIndex);
        }
      }
    },
    { isActive: true },
  );

  if (availableAgents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>No subagents found.</Text>
        <Text color={theme.text.secondary}>
          Use &apos;/agents create&apos; to create your first subagent.
        </Text>
      </Box>
    );
  }

  // Render custom radio button items
  const renderAgentItem = (
    agent: { name: string; level: 'project' | 'user' },
    index: number,
    isSelected: boolean,
  ) => {
    const textColor = isSelected ? theme.text.accent : theme.text.primary;

    return (
      <Box key={agent.name} alignItems="center">
        <Box minWidth={2} flexShrink={0}>
          <Text color={isSelected ? theme.text.accent : theme.text.primary}>
            {isSelected ? '●' : ' '}
          </Text>
        </Box>
        <Text color={textColor} wrap="truncate">
          {agent.name}
          {agent.level === 'user' && projectNames.has(agent.name) && (
            <Text color={isSelected ? theme.status.warning : Colors.Gray}>
              {' '}
              (overridden by project level agent)
            </Text>
          )}
        </Text>
      </Box>
    );
  };

  // Calculate enabled agents count (excluding conflicted user-level agents)
  const enabledAgentsCount =
    projectAgents.length +
    userAgents.filter((agent) => !projectNames.has(agent.name)).length;

  return (
    <Box flexDirection="column">
      {/* Project Level Agents */}
      {projectAgents.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.text.primary} bold>
            Project Level ({projectAgents[0].filePath.replace(/\/[^/]+$/, '')})
          </Text>
          <Box marginTop={1} flexDirection="column">
            {projectAgents.map((agent, index) => {
              const isSelected =
                navigation.currentBlock === 'project' &&
                navigation.projectIndex === index;
              return renderAgentItem(agent, index, isSelected);
            })}
          </Box>
        </Box>
      )}

      {/* User Level Agents */}
      {userAgents.length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            User Level ({userAgents[0].filePath.replace(/\/[^/]+$/, '')})
          </Text>
          <Box marginTop={1} flexDirection="column">
            {userAgents.map((agent, index) => {
              const isSelected =
                navigation.currentBlock === 'user' &&
                navigation.userIndex === index;
              return renderAgentItem(agent, index, isSelected);
            })}
          </Box>
        </Box>
      )}

      {/* Agent count summary */}
      {(projectAgents.length > 0 || userAgents.length > 0) && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            Using: {enabledAgentsCount} agents
          </Text>
        </Box>
      )}
    </Box>
  );
};
