/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EDIT_PARAM_NEW_STRING,
  EDIT_PARAM_OLD_STRING,
  EDIT_PARAM_REPLACE_ALL,
  PARAM_FILE_PATH,
} from './base-declarations.js';

export const EDIT_PARAMETER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    [PARAM_FILE_PATH]: {
      description: 'The absolute path to the file to modify',
      type: 'string',
    },
    [EDIT_PARAM_OLD_STRING]: {
      description: 'The text to replace',
      type: 'string',
    },
    [EDIT_PARAM_NEW_STRING]: {
      description: 'The replacement text (must differ from old_string)',
      type: 'string',
    },
    [EDIT_PARAM_REPLACE_ALL]: {
      description: 'Replace every occurrence of old_string (default false)',
      default: false,
      type: 'boolean',
    },
  },
  required: [PARAM_FILE_PATH, EDIT_PARAM_OLD_STRING, EDIT_PARAM_NEW_STRING],
  additionalProperties: false,
};
