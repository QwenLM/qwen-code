/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { REATTACH_BOUNDARY_METADATA } from '../services/image-payload-references.js';

export function appendAutoMemoryContext(
  contents: Content[],
  catalog: string,
): Content[] {
  if (!catalog) return contents;
  const last = contents.at(-1);
  // The catalog is request-only: stored history never reproduces it. Mark it
  // as a trailing volatile part so the provider cache passes anchor their
  // per-turn breakpoint *before* it — a breakpoint on a block no later request
  // contains can never be read back (issue #11627's invariant).
  const part: Part = {
    text: catalog,
    partMetadata: { [REATTACH_BOUNDARY_METADATA]: true },
  };
  return last?.role === 'user'
    ? [
        ...contents.slice(0, -1),
        { ...last, parts: [...(last.parts ?? []), part] },
      ]
    : [...contents, { role: 'user', parts: [part] }];
}
