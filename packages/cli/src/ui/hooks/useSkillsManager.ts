/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import type { Config, Skill } from '@qwen-code/qwen-code-core';

export interface UseSkillsManagerReturn {
  skills: Skill[];
  refreshSkills: () => void;
}

export const useSkillsManager = (
  config: Config | null,
): UseSkillsManagerReturn => {
  const [skills, setSkills] = useState<Skill[]>([]);

  const refreshSkills = useCallback(async () => {
    const skillManager = config?.getSkillManager();
    if (skillManager && config) {
      const allSkills = await skillManager.listSkills({ force: true });
      setSkills(allSkills);
    }
  }, [config]);

  useEffect(() => {
    refreshSkills();
  }, [refreshSkills]);

  return {
    skills,
    refreshSkills,
  };
};
