/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OutputStyleConfig } from '@qwen-code/resource';
export type {
  OutputStyleConfig,
  OutputStyleSource,
} from '@qwen-code/resource';

/**
 * Subset of `OutputStyleConfig` carried through the session after
 * style resolution. Used by `Config` and the assembler — avoids
 * repeating `{ name, prompt, keepCodingInstructions? }` inline.
 */
export type ResolvedOutputStyle = Pick<
  OutputStyleConfig,
  'name' | 'prompt' | 'keepCodingInstructions'
>;
