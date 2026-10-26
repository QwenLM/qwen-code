/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { REATTACH_BOUNDARY_METADATA } from '../services/image-payload-references.js';
import { AUTO_MEMORY_SNAPSHOT_METADATA } from '../core/environmentContext.js';

export { AUTO_MEMORY_SNAPSHOT_METADATA } from '../core/environmentContext.js';

/**
 * The newest marked catalog snapshot in `contents`, scanning back to the last
 * entry that carries one. Shared by the live request path and transcript
 * replay so both dedupe against the exact same part.
 */
export function findLatestAutoMemorySnapshot(
  contents: Content[],
): Part | undefined {
  for (let i = contents.length - 1; i >= 0; i--) {
    const latest = contents[i].parts?.findLast(
      (part) => part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] === true,
    );
    if (latest) return latest;
  }
  return undefined;
}

export function getAutoMemorySnapshot(
  contents: Content[],
  catalog: string,
): Part | undefined {
  if (!catalog) return undefined;
  const text =
    'Current memory catalog (full snapshot; supersedes all earlier memory catalogs):\n' +
    catalog;
  if (findLatestAutoMemorySnapshot(contents)?.text === text) return undefined;
  return { text, partMetadata: { [AUTO_MEMORY_SNAPSHOT_METADATA]: true } };
}

export function appendAutoMemorySnapshot(
  contents: Content[],
  snapshot: Part,
): void {
  const last = contents.at(-1);
  if (last?.role === 'user') {
    contents[contents.length - 1] = {
      ...last,
      parts: [...(last.parts ?? []), snapshot],
    };
  } else {
    contents.push({ role: 'user', parts: [snapshot] });
  }
}

export function withoutAutoMemorySnapshots(contents: Content[]): Content[] {
  return contents.flatMap((content) => {
    const parts = content.parts?.filter(
      (part) => part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] !== true,
    );
    if (parts?.length === content.parts?.length) return [content];
    return parts?.length ? [{ ...content, parts }] : [];
  });
}

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
