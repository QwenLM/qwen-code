/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

export function appendAutoMemoryContext(
  contents: Content[],
  catalog: string,
): Content[] {
  if (!catalog) return contents;
  const last = contents.at(-1);
  const part = { text: catalog };
  return last?.role === 'user'
    ? [
        ...contents.slice(0, -1),
        { ...last, parts: [...(last.parts ?? []), part] },
      ]
    : [...contents, { role: 'user', parts: [part] }];
}
