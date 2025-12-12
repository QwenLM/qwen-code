/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { type SubagentConfig } from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';

interface NavigationState {
  currentBlock: 'project' | 'user' | 'builtin';
  projectIndex: number;
  userIndex: number;
  builtinIndex: number;
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
    builtinIndex: 0,
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
  const builtinAgents = useMemo(
    () => availableAgents.filter((agent) => agent.level === 'builtin'),
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
    } else if (builtinAgents.length > 0) {
      setNavigation((prev) => ({ ...prev, currentBlock: 'builtin' }));
    }
  }, [projectAgents, userAgents, builtinAgents]);

  // Custom keyboard navigation
  useKeypress(
    (key) => {
      const { name } = key;

      if (name === 'up' || name === 'k') {
        setNavigation((prev) => {
          if (prev.currentBlock === 'project') {
            if (prev.projectIndex > 0) {
              return { ...prev, projectIndex: prev.projectIndex - 1 };
            } else if (builtinAgents.length > 0) {
              // Move to last item in builtin block
              return {
                ...prev,
                currentBlock: 'builtin',
                builtinIndex: builtinAgents.length - 1,
              };
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
          } else if (prev.currentBlock === 'user') {
            if (prev.userIndex > 0) {
              return { ...prev, userIndex: prev.userIndex - 1 };
            } else if (projectAgents.length > 0) {
              // Move to last item in project block
              return {
                ...prev,
                currentBlock: 'project',
                projectIndex: projectAgents.length - 1,
              };
            } else if (builtinAgents.length > 0) {
              // Move to last item in builtin block
              return {
                ...prev,
                currentBlock: 'builtin',
                builtinIndex: builtinAgents.length - 1,
              };
            } else {
              // Wrap to last item in user block
              return { ...prev, userIndex: userAgents.length - 1 };
            }
          } else {
            // builtin block
            if (prev.builtinIndex > 0) {
              return { ...prev, builtinIndex: prev.builtinIndex - 1 };
            } else if (userAgents.length > 0) {
              // Move to last item in user block
              return {
                ...prev,
                currentBlock: 'user',
                userIndex: userAgents.length - 1,
              };
            } else if (projectAgents.length > 0) {
              // Move to last item in project block
              return {
                ...prev,
                currentBlock: 'project',
                projectIndex: projectAgents.length - 1,
              };
            } else {
              // Wrap to last item in builtin block
              return { ...prev, builtinIndex: builtinAgents.length - 1 };
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
            } else if (builtinAgents.length > 0) {
              // Move to first item in builtin block
              return { ...prev, currentBlock: 'builtin', builtinIndex: 0 };
            } else {
              // Wrap to first item in project block
              return { ...prev, projectIndex: 0 };
            }
          } else if (prev.currentBlock === 'user') {
            if (prev.userIndex < userAgents.length - 1) {
              return { ...prev, userIndex: prev.userIndex + 1 };
            } else if (builtinAgents.length > 0) {
              // Move to first item in builtin block
              return { ...prev, currentBlock: 'builtin', builtinIndex: 0 };
            } else if (projectAgents.length > 0) {
              // Move to first item in project block
              return { ...prev, currentBlock: 'project', projectIndex: 0 };
            } else {
              // Wrap to first item in user block
              return { ...prev, userIndex: 0 };
            }
          } else {
            // builtin block
            if (prev.builtinIndex < builtinAgents.length - 1) {
              return { ...prev, builtinIndex: prev.builtinIndex + 1 };
            } else if (projectAgents.length > 0) {
              // Move to first item in project block
              return { ...prev, currentBlock: 'project', projectIndex: 0 };
            } else if (userAgents.length > 0) {
              // Move to first item in user block
              return { ...prev, currentBlock: 'user', userIndex: 0 };
            } else {
              // Wrap to first item in builtin block
              return { ...prev, builtinIndex: 0 };
            }
          }
        });
      } else if (name === 'return' || name === 'space') {
        // Calculate global index and select current item
        let globalIndex: number;
        if (navigation.currentBlock === 'project') {
          globalIndex = navigation.projectIndex;
        } else if (navigation.currentBlock === 'user') {
          // User agents come after project agents in the availableAgents array
          globalIndex = projectAgents.length + navigation.userIndex;
        } else {
          // builtin block
          // Builtin agents come after project and user agents in the availableAgents array
          globalIndex =
            projectAgents.length + userAgents.length + navigation.builtinIndex;
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
        <Text color={theme.text.secondary}>{t('No subagents found.')}</Text>
        <Text color={theme.text.secondary}>
          {t("Use '/agents create' to create your first subagent.")}
        </Text>
      </Box>
    );
  }

  // Render custom radio button items
  const renderAgentItem = (
    agent: {
      name: string;
      level: 'project' | 'user' | 'builtin' | 'session';
      isBuiltin?: boolean;
    },
    index: number,
    isSelected: boolean,
  ) => {
    const textColor = isSelected ? theme.text.accent : theme.text.primary;

    return (
      <Box key={`${agent.name}-${agent.level}`} alignItems="center">
        <Box minWidth={2} flexShrink={0}>
          <Text color={isSelected ? theme.text.accent : theme.text.primary}>
            {isSelected ? '●' : ' '}
          </Text>
        </Box>
        <Text color={textColor} wrap="truncate">
          {agent.name}
          {agent.isBuiltin && (
            <Text color={isSelected ? theme.text.accent : theme.text.secondary}>
              {' '}
              {t('(built-in)')}
            </Text>
          )}
          {agent.level === 'user' && projectNames.has(agent.name) && (
            <Text
              color={isSelected ? theme.status.warning : theme.text.secondary}
            >
              {' '}
              {t('(overridden by project level agent)')}
            </Text>
          )}
        </Text>
      </Box>
    );
  };

  // Calculate enabled agents count (excluding conflicted user-level agents)
  const enabledAgentsCount =
    projectAgents.length +
    userAgents.filter((agent) => !projectNames.has(agent.name)).length +
    builtinAgents.length;

  return (
    <Box flexDirection="column">
      {/* Project Level Agents */}
      {projectAgents.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.text.primary} bold>
            {t('Project Level ({{path}})', {
              path: projectAgents[0].filePath?.replace(/\/[^/]+$/, '') || '',
            })}
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
        <Box
          flexDirection="column"
          marginBottom={builtinAgents.length > 0 ? 1 : 0}
        >
          <Text color={theme.text.primary} bold>
            {t('User Level ({{path}})', {
              path: userAgents[0].filePath?.replace(/\/[^/]+$/, '') || '',
            })}
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

      {/* Built-in Agents */}
      {builtinAgents.length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {t('Built-in Agents')}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {builtinAgents.map((agent, index) => {
              const isSelected =
                navigation.currentBlock === 'builtin' &&
                navigation.builtinIndex === index;
              return renderAgentItem(agent, index, isSelected);
            })}
          </Box>
        </Box>
      )}

      {/* Agent count summary */}
      {(projectAgents.length > 0 ||
        userAgents.length > 0 ||
        builtinAgents.length > 0) && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Using: {{count}} agents', {
              count: enabledAgentsCount.toString(),
            })}
          </Text>
        </Box>
      )}
    </Box>
  );
};
