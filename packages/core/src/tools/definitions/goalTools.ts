/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FunctionDeclaration } from '@google/genai';
import {
  GET_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
} from '../tool-names.js';

export const GET_GOAL_DECLARATION: FunctionDeclaration = {
  name: GET_GOAL_TOOL_NAME,
  description:
    'Retrieve the current active goal, including its objective, status, and turn usage.',
  parametersJsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export const CREATE_GOAL_DECLARATION: FunctionDeclaration = {
  name: CREATE_GOAL_TOOL_NAME,
  description:
    'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set max_turns only when an explicit turn budget is requested. Do NOT call this when a goal already exists — a goal set via /goal is already registered and is surfaced to you in a goal system-reminder. Fails if a non-completed goal already exists.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The objective to achieve.',
      },
      max_turns: {
        type: 'integer',
        description:
          'Optional maximum number of interaction turns for this goal. Omit unless explicitly requested.',
      },
    },
    required: ['objective'],
    additionalProperties: false,
  },
};

export const UPDATE_GOAL_DECLARATION: FunctionDeclaration = {
  name: UPDATE_GOAL_TOOL_NAME,
  description:
    `Update the current goal status. Set to "complete" only when the objective is achieved and no required work remains. Set to "blocked" only after the same blocking condition has recurred for at least three consecutive goal turns and you cannot make meaningful progress without user input or an external-state change; after a previously blocked goal is resumed, the resumed run starts a fresh blocked audit. Resuming a stopped goal is the user's job — never try to revive it yourself.`,
  parametersJsonSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['complete', 'blocked'],
        description:
          'The new status for the goal: "complete" to finish it, "blocked" when at an impasse per the three-turn rule.',
      },
    },
    required: ['status'],
    additionalProperties: false,
  },
};
