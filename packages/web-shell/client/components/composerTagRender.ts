import { useMemo } from 'react';
import type {
  WebShellComposerTag,
  WebShellComposerTagIconMap,
} from '../customization';
import { getComposerTagIconUrl } from './composerTagIcons';

export interface ComposerTagRenderParts {
  tagLabel: string;
  tagValue: string;
  fallback: string;
  iconUrl?: string;
}

export type ComposerTagReferenceSegment =
  | { type: 'text'; text: string }
  | { type: 'reference'; tag: WebShellComposerTag };

const AT_REFERENCE_CHAR_RE = /[\p{L}\p{N}_./:-]/u;

function isAtReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s([{'"]/.test(char);
}

function readAtReferenceEnd(content: string, start: number): number {
  let index = start + 1;
  while (index < content.length) {
    const char = content[index];
    if (char === '\\' && index + 1 < content.length) {
      index += 2;
      continue;
    }
    if (!AT_REFERENCE_CHAR_RE.test(char)) break;
    index += 1;
  }
  return index;
}

function getReferenceDisplay(raw: string, prefix: string) {
  const withoutAt = raw.slice(1);
  const value = prefix ? withoutAt.slice(prefix.length) : withoutAt;
  return value.replace(/\\(.)/g, '$1') || raw;
}

function createComposerTagFromReference(raw: string): WebShellComposerTag {
  if (raw.startsWith('@ext:')) {
    return {
      id: `extension:${raw}`,
      kind: 'extension',
      value: getReferenceDisplay(raw, 'ext:'),
      serialized: raw,
    };
  }
  if (raw.startsWith('@mcp:')) {
    return {
      id: `mcp:${raw}`,
      kind: 'mcp',
      value: getReferenceDisplay(raw, 'mcp:'),
      serialized: raw,
    };
  }
  return {
    id: `file:${raw}`,
    kind: 'file',
    value: getReferenceDisplay(raw, ''),
    serialized: raw,
  };
}

export function splitComposerTagReferences(
  content: string,
): ComposerTagReferenceSegment[] {
  const segments: ComposerTagReferenceSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (
      content[index] !== '@' ||
      !isAtReferenceBoundary(content[index - 1])
    ) {
      continue;
    }
    const end = readAtReferenceEnd(content, index);
    if (end === index + 1) continue;
    if (cursor < index) {
      segments.push({ type: 'text', text: content.slice(cursor, index) });
    }
    segments.push({
      type: 'reference',
      tag: createComposerTagFromReference(content.slice(index, end)),
    });
    cursor = end;
    index = end - 1;
  }
  if (cursor < content.length) {
    segments.push({ type: 'text', text: content.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', text: content }];
}

export function useComposerTagReferences(
  content: string,
): ComposerTagReferenceSegment[] {
  return useMemo(() => splitComposerTagReferences(content), [content]);
}

export function getComposerTagRenderParts(
  tag: WebShellComposerTag,
  composerTagIcons?: WebShellComposerTagIconMap,
): ComposerTagRenderParts {
  const rawTagLabel = tag.label?.trim() ?? '';
  const tagValue = tag.value?.trim() ?? '';
  return {
    tagLabel: tag.kind ? '' : rawTagLabel,
    tagValue,
    fallback: tag.id,
    iconUrl: getComposerTagIconUrl(tag.kind, composerTagIcons),
  };
}
