/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import { getReplaceDescription } from './definitions/tool-prompts/edit.js';
import { getWriteFileDescription } from './definitions/tool-prompts/write-file.js';
import { EDIT_TOOL_NAME, WRITE_FILE_TOOL_NAME } from './tool-names.js';

export interface FileReadRecoverySchemaContext {
  /**
   * Whether the ordinary working-directory read-first line is omitted for
   * this request. This is prompt behavior, not a promise that an individual
   * tool call can recover: the runtime still checks Read availability,
   * Read(path) permission, and the current file baseline.
   */
  readonly preReadLineDropped?: boolean;
}

/**
 * Applies request-scoped Edit/Write wording before declarations enter the wire
 * schema cache. The caller must include `preReadLineDropped` in its cache key.
 */
export function applyFileReadRecoveryDescriptions(
  declarations: FunctionDeclaration[],
  model: string | undefined,
  context?: FileReadRecoverySchemaContext,
): FunctionDeclaration[] {
  if (context?.preReadLineDropped !== true) return declarations;

  const bundle = resolvePromptBundleForModel(model);
  return declarations.map((declaration) => {
    const description =
      declaration.name === EDIT_TOOL_NAME
        ? getReplaceDescription(true, bundle)
        : declaration.name === WRITE_FILE_TOOL_NAME
          ? getWriteFileDescription(true, bundle)
          : undefined;

    return description ? { ...declaration, description } : declaration;
  });
}
