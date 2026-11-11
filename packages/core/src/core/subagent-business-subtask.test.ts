/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_SUBAGENT_BUSINESS_SUB_TASK,
  resolveSubagentBusinessSubTask,
} from './subagent-business-subtask.js';

describe('resolveSubagentBusinessSubTask', () => {
  it.each([
    ['general-purpose', 'agent_sub_general_purpose'],
    ['Explore', 'agent_sub_explore'],
    [' explore ', 'agent_sub_explore'],
    ['Plan', 'agent_sub_plan'],
    ['qoder-guide', 'agent_sub_qoder_guide'],
    ['statusline-setup', 'agent_sub_statusline_setup'],
    ['workflow-subagent', 'agent_sub_workflow'],
    ['team-lead', 'agent_sub_team_lead'],
    ['compact', 'agent_sub_compact'],
    ['partial-compact', 'agent_sub_partial_compact'],
    ['session_memory', 'agent_sub_session_memory'],
    ['memory-fork', 'agent_sub_memory_extraction'],
    ['auto_dream', 'agent_sub_auto_dream'],
    ['skill-evolution-fork', 'agent_sub_skill_evolution'],
  ])('maps the built-in agent %s to %s', (agentType, expected) => {
    expect(resolveSubagentBusinessSubTask(agentType)).toBe(expected);
  });

  it.each([undefined, '', '   ', 'Reviewer', 'plugin:security:reviewer'])(
    'maps the custom agent %s to one bounded label',
    (agentType) => {
      expect(resolveSubagentBusinessSubTask(agentType)).toBe(
        CUSTOM_SUBAGENT_BUSINESS_SUB_TASK,
      );
    },
  );
});
