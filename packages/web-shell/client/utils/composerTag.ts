import extensionIconUrl from '../assets/icons/at-extension.svg';
import fileIconUrl from '../assets/icons/at-file.svg';
import mcpIconUrl from '../assets/icons/at-mcp.svg';
import skillIconUrl from '../assets/icons/at-skill.svg';
import type {
  WebShellBuiltinComposerTagKind,
  WebShellComposerTag,
  WebShellComposerTagIconMap,
  WebShellComposerTagKind,
} from '../customization';

// Shared UI-facing shape for composer tags across React and CodeMirror.
export interface ComposerTagViewModel {
  tagLabel: string;
  tagValue: string;
  fallback: string;
  iconUrl?: string;
}

export type ComposerTagContentSegment =
  | { type: 'text'; text: string }
  | { type: 'reference'; tag: WebShellComposerTag };

// Resolves tag kind metadata to asset URLs; it does not render icon components.
const builtinTagIconUrls: Record<WebShellBuiltinComposerTagKind, string> = {
  extension: extensionIconUrl,
  file: fileIconUrl,
  mcp: mcpIconUrl,
  skill: skillIconUrl,
};

const AT_REFERENCE_CHAR_RE = /[\p{L}\p{N}_./:-]/u;
const WINDOWS_DRIVE_REFERENCE_RE = /^[A-Za-z]:/;

function getOwnIconUrl(
  iconUrls: WebShellComposerTagIconMap | undefined,
  kind: string,
): string | undefined {
  if (!iconUrls || !Object.prototype.hasOwnProperty.call(iconUrls, kind)) {
    return undefined;
  }
  const iconUrl = iconUrls[kind];
  return typeof iconUrl === 'string' ? iconUrl : undefined;
}

function isAtReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s([{'"]/.test(char);
}

function readAtReferenceEnd(content: string, start: number): number {
  let index = start + 1;
  while (index < content.length) {
    const char = content[index];
    if (char === '\\' && index + 1 < content.length) {
      const escapedCodePoint = content.codePointAt(index + 1);
      index += 1 + (escapedCodePoint && escapedCodePoint > 0xffff ? 2 : 1);
      continue;
    }
    if (!AT_REFERENCE_CHAR_RE.test(char)) break;
    index += 1;
  }
  return index;
}

function trimReferenceTrailingPunctuation(
  content: string,
  end: number,
): number {
  let nextEnd = end;
  while (nextEnd > 0) {
    const last = content[nextEnd - 1];
    if (
      (last !== '.' && last !== ':') ||
      !isAtReferenceBoundary(content[nextEnd])
    ) {
      break;
    }
    nextEnd -= 1;
  }
  return nextEnd;
}

function getReferenceDisplay(raw: string, prefix: string) {
  const withoutAt = raw.slice(1);
  const value = prefix ? withoutAt.slice(prefix.length) : withoutAt;
  return value.replace(/\\(.)/gu, '$1') || raw;
}

// MCP resources are serialized as @server\:uri, with the server/URI delimiter
// escaped by the composer. That is the only provider-prefixed form this parser
// can recover without persisted composer tag metadata.
function isEscapedMcpResourceReference(raw: string): boolean {
  const value = raw.slice(1);
  const escapedDelimiterIndex = value.indexOf('\\:');
  if (escapedDelimiterIndex <= 0) return false;
  const unescaped = getReferenceDisplay(raw, '');
  const delimiterIndex = unescaped.indexOf(':');
  if (delimiterIndex <= 0) return false;
  return unescaped.slice(delimiterIndex + 1).includes(':');
}

// User messages persist only text, so ambiguous mentions like @alice or
// @types/node must remain text. Only chipify file references with path cues.
function isBuiltInFileReference(raw: string): boolean {
  const value = getReferenceDisplay(raw, '');
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('.') ||
    WINDOWS_DRIVE_REFERENCE_RE.test(value)
  );
}

function createComposerTagFromReference(
  raw: string,
): WebShellComposerTag | null {
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
  if (isEscapedMcpResourceReference(raw)) {
    return {
      id: `mcp:${raw}`,
      kind: 'mcp',
      value: getReferenceDisplay(raw, ''),
      serialized: raw,
    };
  }
  if (isBuiltInFileReference(raw)) {
    return {
      id: `file:${raw}`,
      kind: 'file',
      value: getReferenceDisplay(raw, ''),
      serialized: raw,
    };
  }
  return null;
}

export function getComposerTagIconUrl(
  kind: WebShellComposerTagKind | undefined,
  customIconUrls?: WebShellComposerTagIconMap,
): string | undefined {
  if (!kind) return undefined;
  return (
    getOwnIconUrl(customIconUrls, kind) ??
    getOwnIconUrl(builtinTagIconUrls, kind)
  );
}

// Sent user messages persist serialized prompt text, so reference chips must be
// reconstructed from @ references when rendering the transcript.
export function splitComposerTagContent(
  content: string,
): ComposerTagContentSegment[] {
  const segments: ComposerTagContentSegment[] = [];
  let cursor = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '@' || !isAtReferenceBoundary(content[index - 1])) {
      continue;
    }
    const end = readAtReferenceEnd(content, index);
    if (end === index + 1) continue;
    const referenceEnd = trimReferenceTrailingPunctuation(content, end);
    if (referenceEnd === index + 1) continue;
    const tag = createComposerTagFromReference(
      content.slice(index, referenceEnd),
    );
    if (!tag) continue;
    if (cursor < index) {
      segments.push({ type: 'text', text: content.slice(cursor, index) });
    }
    segments.push({
      type: 'reference',
      tag,
    });
    cursor = referenceEnd;
    index = referenceEnd - 1;
  }
  if (cursor < content.length) {
    segments.push({ type: 'text', text: content.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', text: content }];
}

// Normalizes display fields so each renderer can keep its own shell and styles.
export function getComposerTagViewModel(
  tag: WebShellComposerTag,
  composerTagIcons?: WebShellComposerTagIconMap,
): ComposerTagViewModel {
  const rawTagLabel = tag.label?.trim() ?? '';
  const tagValue = tag.value?.trim() ?? '';
  const isBuiltinTag = tag.kind
    ? getOwnIconUrl(builtinTagIconUrls, tag.kind)
    : undefined;
  return {
    tagLabel: isBuiltinTag ? '' : rawTagLabel,
    tagValue,
    fallback: tag.id,
    iconUrl: getComposerTagIconUrl(tag.kind, composerTagIcons),
  };
}
