/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';

function formatFunctionSchemaBlock(schema: FunctionDeclaration): string {
  // Escape `<` in the JSON-stringified schema so any `</function>` (or
  // `</functions>`) substring inside descriptions / enum values / examples
  // cannot prematurely close the pseudo-XML wrapper. The JSON unicode escape
  // still decodes back to `<` semantically, but as raw wrapper text it is no
  // longer parsed as a closing tag.
  return `<function>${JSON.stringify(schema).replace(/</g, '\\u003c')}</function>`;
}

export function formatFunctionSchemaBlocks(
  schemas: readonly FunctionDeclaration[],
): string {
  return `<functions>\n${schemas.map(formatFunctionSchemaBlock).join('\n')}\n</functions>`;
}
