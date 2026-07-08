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

// Custom providers can use the @provider:item shape, but user messages only
// persist serialized text. Without provider metadata, default rendering should
// leave those references as text instead of guessing they are file chips.
function isCustomProviderReference(raw: string): boolean {
  const value = raw.slice(1);
  const colonIndex = value.indexOf(':');
  if (colonIndex <= 0) return false;
  const prefix = value.slice(0, colonIndex);
  if (prefix === 'ext' || prefix === 'mcp') return false;
  if (prefix.length === 1 && value[colonIndex + 1] === '/') return false;
  return /^[\p{L}\p{N}_-]+$/u.test(prefix);
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
  if (isCustomProviderReference(raw)) return null;
  return {
    id: `file:${raw}`,
    kind: 'file',
    value: getReferenceDisplay(raw, ''),
    serialized: raw,
  };
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
    const tag = createComposerTagFromReference(content.slice(index, end));
    if (!tag) continue;
    if (cursor < index) {
      segments.push({ type: 'text', text: content.slice(cursor, index) });
    }
    segments.push({
      type: 'reference',
      tag,
    });
    cursor = end;
    index = end - 1;
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
  return {
    tagLabel: tag.kind ? '' : rawTagLabel,
    tagValue,
    fallback: tag.id,
    iconUrl: getComposerTagIconUrl(tag.kind, composerTagIcons),
  };
}
