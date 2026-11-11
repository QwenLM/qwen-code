/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FunctionDeclaration } from '@google/genai';
import { SIMPLE_SYSTEM_PROMPT_ENV } from '../prompts/bundle-resolver.js';
import { getReplaceDescription } from './definitions/tool-prompts/edit.js';
import { getWriteFileDescription } from './definitions/tool-prompts/write-file.js';
import { applyFileReadRecoveryDescriptions } from './file-read-recovery-schemas.js';
import {
  EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from './tool-names.js';

function schema(name: string): FunctionDeclaration {
  return {
    name,
    description: `${name} default description`,
    parametersJsonSchema: { type: 'object' },
  };
}

describe('applyFileReadRecoveryDescriptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the original declarations when the read-first line is retained', () => {
    const schemas = [schema(EDIT_TOOL_NAME), schema(WRITE_FILE_TOOL_NAME)];

    expect(
      applyFileReadRecoveryDescriptions(schemas, 'test-model', {
        preReadLineDropped: false,
      }),
    ).toBe(schemas);
  });

  it.each([
    ['full', 'false'],
    ['lean', 'true'],
  ] as const)(
    'renders recovery descriptions from the %s prompt bundle',
    (bundle, simplePromptSetting) => {
      vi.stubEnv(SIMPLE_SYSTEM_PROMPT_ENV, simplePromptSetting);
      const edit = schema(EDIT_TOOL_NAME);
      const write = schema(WRITE_FILE_TOOL_NAME);
      const shell = schema(SHELL_TOOL_NAME);

      const result = applyFileReadRecoveryDescriptions(
        [edit, write, shell],
        'test-model',
        { preReadLineDropped: true },
      );

      expect(result[0]).not.toBe(edit);
      expect(result[0]?.description).toBe(
        getReplaceDescription(true, bundle),
      );
      expect(result[1]).not.toBe(write);
      expect(result[1]?.description).toBe(
        getWriteFileDescription(true, bundle),
      );
      expect(result[2]).toBe(shell);
      expect(edit.description).toBe('Edit default description');
      expect(write.description).toBe('Write default description');
    },
  );
});
