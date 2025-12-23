/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import type { SkillWithScope } from '../types.js';
import { t } from '../../../../i18n/index.js';

interface NavigationState {
  currentBlock: 'project' | 'user' | 'builtin';
  projectIndex: number;
  userIndex: number;
  builtinIndex: number;
}

interface SkillSelectionStepProps {
  availableSkills: SkillWithScope[];
  onSkillSelect: (skillIndex: number) => void;
}

export const SkillSelectionStep = ({
  availableSkills,
  onSkillSelect,
}: SkillSelectionStepProps) => {
  const [navigation, setNavigation] = useState<NavigationState>({
    currentBlock: 'project',
    projectIndex: 0,
    userIndex: 0,
    builtinIndex: 0,
  });

  // Group skills by scope
  const projectSkills = useMemo(
    () => availableSkills.filter((skill) => skill.scope === '[project]'),
    [availableSkills],
  );
  const userSkills = useMemo(
    () => availableSkills.filter((skill) => skill.scope === '[global]'),
    [availableSkills],
  );
  const builtinSkills = useMemo(
    () => availableSkills.filter((skill) => skill.scope === '[builtin]'),
    [availableSkills],
  );
  const projectNames = useMemo(
    () => new Set(projectSkills.map((skill) => skill.metadata.name)),
    [projectSkills],
  );

  // Initialize navigation state when skills are loaded
  useEffect(() => {
    if (projectSkills.length > 0) {
      setNavigation((prev) => ({ ...prev, currentBlock: 'project' }));
    } else if (userSkills.length > 0) {
      setNavigation((prev) => ({ ...prev, currentBlock: 'user' }));
    } else if (builtinSkills.length > 0) {
      setNavigation((prev) => ({ ...prev, currentBlock: 'builtin' }));
    }
  }, [projectSkills, userSkills, builtinSkills]);

  // Keyboard navigation
  useKeypress(
    (key) => {
      const { name } = key;

      if (name === 'up' || name === 'k') {
        setNavigation((prev) => {
          if (prev.currentBlock === 'project') {
            if (prev.projectIndex > 0) {
              return { ...prev, projectIndex: prev.projectIndex - 1 };
            } else if (builtinSkills.length > 0) {
              return {
                ...prev,
                currentBlock: 'builtin',
                builtinIndex: builtinSkills.length - 1,
              };
            } else if (userSkills.length > 0) {
              return {
                ...prev,
                currentBlock: 'user',
                userIndex: userSkills.length - 1,
              };
            } else {
              return { ...prev, projectIndex: projectSkills.length - 1 };
            }
          } else if (prev.currentBlock === 'user') {
            if (prev.userIndex > 0) {
              return { ...prev, userIndex: prev.userIndex - 1 };
            } else if (projectSkills.length > 0) {
              return {
                ...prev,
                currentBlock: 'project',
                projectIndex: projectSkills.length - 1,
              };
            } else if (builtinSkills.length > 0) {
              return {
                ...prev,
                currentBlock: 'builtin',
                builtinIndex: builtinSkills.length - 1,
              };
            } else {
              return { ...prev, userIndex: userSkills.length - 1 };
            }
          } else {
            // builtin block
            if (prev.builtinIndex > 0) {
              return { ...prev, builtinIndex: prev.builtinIndex - 1 };
            } else if (userSkills.length > 0) {
              return {
                ...prev,
                currentBlock: 'user',
                userIndex: userSkills.length - 1,
              };
            } else if (projectSkills.length > 0) {
              return {
                ...prev,
                currentBlock: 'project',
                projectIndex: projectSkills.length - 1,
              };
            } else {
              return { ...prev, builtinIndex: builtinSkills.length - 1 };
            }
          }
        });
      } else if (name === 'down' || name === 'j') {
        setNavigation((prev) => {
          if (prev.currentBlock === 'project') {
            if (prev.projectIndex < projectSkills.length - 1) {
              return { ...prev, projectIndex: prev.projectIndex + 1 };
            } else if (userSkills.length > 0) {
              return { ...prev, currentBlock: 'user', userIndex: 0 };
            } else if (builtinSkills.length > 0) {
              return { ...prev, currentBlock: 'builtin', builtinIndex: 0 };
            } else {
              return { ...prev, projectIndex: 0 };
            }
          } else if (prev.currentBlock === 'user') {
            if (prev.userIndex < userSkills.length - 1) {
              return { ...prev, userIndex: prev.userIndex + 1 };
            } else if (builtinSkills.length > 0) {
              return { ...prev, currentBlock: 'builtin', builtinIndex: 0 };
            } else if (projectSkills.length > 0) {
              return { ...prev, currentBlock: 'project', projectIndex: 0 };
            } else {
              return { ...prev, userIndex: 0 };
            }
          } else {
            // builtin block
            if (prev.builtinIndex < builtinSkills.length - 1) {
              return { ...prev, builtinIndex: prev.builtinIndex + 1 };
            } else if (projectSkills.length > 0) {
              return { ...prev, currentBlock: 'project', projectIndex: 0 };
            } else if (userSkills.length > 0) {
              return { ...prev, currentBlock: 'user', userIndex: 0 };
            } else {
              return { ...prev, builtinIndex: 0 };
            }
          }
        });
      } else if (name === 'return' || name === 'space') {
        let globalIndex: number;
        if (navigation.currentBlock === 'project') {
          globalIndex = navigation.projectIndex;
        } else if (navigation.currentBlock === 'user') {
          globalIndex = projectSkills.length + navigation.userIndex;
        } else {
          globalIndex =
            projectSkills.length + userSkills.length + navigation.builtinIndex;
        }

        if (globalIndex >= 0 && globalIndex < availableSkills.length) {
          onSkillSelect(globalIndex);
        }
      }
    },
    { isActive: true },
  );

  if (availableSkills.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>{t('skills.noSkills')}</Text>
        <Text color={theme.text.secondary}>{t('skills.createPrompt')}</Text>
      </Box>
    );
  }

  const renderSkillItem = (
    skill: SkillWithScope,
    _index: number,
    isSelected: boolean,
  ) => {
    const textColor = isSelected ? theme.text.accent : theme.text.primary;

    return (
      <Box key={`${skill.metadata.name}-${skill.scope}`}>
        <Box minWidth={2} flexShrink={0}>
          <Text color={isSelected ? theme.text.accent : theme.text.primary}>
            {isSelected ? '●' : ' '}
          </Text>
        </Box>
        <Text color={textColor} wrap="truncate">
          {skill.metadata.name}
          {skill.isBuiltin && (
            <Text color={isSelected ? theme.text.accent : theme.text.secondary}>
              {' '}
              {t('(built-in)')}
            </Text>
          )}
          {skill.scope === '[global]' &&
            projectNames.has(skill.metadata.name) && (
              <Text
                color={isSelected ? theme.status.warning : theme.text.secondary}
              >
                {' '}
                {t('skills.overridden')}
              </Text>
            )}
        </Text>
      </Box>
    );
  };

  const enabledSkillsCount =
    projectSkills.length +
    userSkills.filter((skill) => !projectNames.has(skill.metadata.name))
      .length +
    builtinSkills.length;

  return (
    <Box flexDirection="column">
      {projectSkills.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.text.primary} bold>
            {t('skills.projectLevel', {
              path: projectSkills[0].path.replace(/\/[^/]+$/, ''),
            })}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {projectSkills.map((skill, index) => {
              const isSelected =
                navigation.currentBlock === 'project' &&
                navigation.projectIndex === index;
              return renderSkillItem(skill, index, isSelected);
            })}
          </Box>
        </Box>
      )}

      {userSkills.length > 0 && (
        <Box
          flexDirection="column"
          marginBottom={builtinSkills.length > 0 ? 1 : 0}
        >
          <Text color={theme.text.primary} bold>
            {t('skills.globalLevel', {
              path: userSkills[0].path.replace(/\/[^/]+$/, ''),
            })}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {userSkills.map((skill, index) => {
              const isSelected =
                navigation.currentBlock === 'user' &&
                navigation.userIndex === index;
              return renderSkillItem(skill, index, isSelected);
            })}
          </Box>
        </Box>
      )}

      {builtinSkills.length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {t('skills.builtin')}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {builtinSkills.map((skill, index) => {
              const isSelected =
                navigation.currentBlock === 'builtin' &&
                navigation.builtinIndex === index;
              return renderSkillItem(skill, index, isSelected);
            })}
          </Box>
        </Box>
      )}

      {(projectSkills.length > 0 ||
        userSkills.length > 0 ||
        builtinSkills.length > 0) && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('skills.usingCount', {
              count: enabledSkillsCount.toString(),
            })}
          </Text>
        </Box>
      )}
    </Box>
  );
};
