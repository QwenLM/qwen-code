import extensionIconUrl from '../assets/icons/at-extension.svg';
import fileIconUrl from '../assets/icons/at-file.svg';
import mcpIconUrl from '../assets/icons/at-mcp.svg';
import skillIconUrl from '../assets/icons/at-skill.svg';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import type {
  UserMessageContentParser,
  WebShellBuiltinComposerTagKind,
  WebShellComposerTag,
  WebShellComposerTagIconMap,
  WebShellComposerTagKind,
  WebShellUserMessagePart,
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

function isValidComposerTag(tag: unknown): tag is WebShellComposerTag {
  if (!tag || typeof tag !== 'object') return false;
  const candidate = tag as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    (candidate.label === undefined || typeof candidate.label === 'string') &&
    (candidate.value === undefined || typeof candidate.value === 'string') &&
    (candidate.removable === undefined ||
      typeof candidate.removable === 'boolean') &&
    (candidate.kind === undefined || typeof candidate.kind === 'string') &&
    (candidate.icon === undefined || typeof candidate.icon === 'string') &&
    (candidate.serialized === undefined ||
      typeof candidate.serialized === 'string')
  );
}

function isValidUserMessagePart(
  part: unknown,
): part is WebShellUserMessagePart {
  if (!part || typeof part !== 'object') return false;
  const candidate = part as Record<string, unknown>;
  if (candidate.type === 'text') return typeof candidate.text === 'string';
  if (candidate.type !== 'tag') return false;
  return isValidComposerTag(candidate.tag);
}

export interface ParseUserMessageContentOptions {
  requireSourcePreservation?: boolean;
}

export function parseUserMessageContentSafely(
  content: string,
  parser: UserMessageContentParser | undefined,
  warning: string,
  options: ParseUserMessageContentOptions = {},
): readonly WebShellUserMessagePart[] | null {
  if (!parser) return null;
  try {
    const parts = parser(content);
    if (
      !Array.isArray(parts) ||
      parts.length === 0 ||
      !parts.every(isValidUserMessagePart)
    ) {
      return null;
    }
    if (
      options.requireSourcePreservation &&
      parts
        .map((part) =>
          part.type === 'text' ? part.text : getComposerTagSerialized(part.tag),
        )
        .join('') !== content
    ) {
      return null;
    }
    return parts;
  } catch (error) {
    console.warn(warning, error);
    return null;
  }
}

// Resolves tag kind metadata to asset URLs; it does not render icon components.
const builtinTagIconUrls: Record<WebShellBuiltinComposerTagKind, string> = {
  extension: extensionIconUrl,
  file: fileIconUrl,
  mcp: mcpIconUrl,
  skill: skillIconUrl,
};
const builtinTagIconUrlSet = new Set(Object.values(builtinTagIconUrls));

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

export function getComposerTagSerialized(tag: WebShellComposerTag): string {
  return (
    tag.serialized?.trim() || tag.value?.trim() || tag.label?.trim() || tag.id
  );
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

export function isBuiltinComposerTagIconUrl(
  iconUrl: string | undefined,
): boolean {
  return iconUrl !== undefined && builtinTagIconUrlSet.has(iconUrl);
}

export function createInputAnnotationsFromComposerTags(
  content: string,
  tags: readonly WebShellComposerTag[],
): DaemonInputAnnotation[] {
  const annotations: DaemonInputAnnotation[] = [];
  let cursor = 0;
  for (const tag of tags) {
    const serialized = getComposerTagSerialized(tag);
    if (!serialized) continue;
    const start = content.indexOf(serialized, cursor);
    if (start < 0) continue;
    const end = start + serialized.length;
    annotations.push({
      type: 'reference',
      start,
      end,
      text: serialized,
      reference: {
        id: tag.id,
        ...(tag.kind ? { kind: tag.kind } : {}),
        ...(tag.label ? { label: tag.label } : {}),
        ...(tag.value ? { value: tag.value } : {}),
        ...(tag.serialized ? { serialized: tag.serialized } : {}),
        ...(tag.removable !== undefined ? { removable: tag.removable } : {}),
      },
    });
    cursor = end;
  }
  return annotations;
}

// User messages render chips only from submit-time annotations. Without that
// metadata, the serialized text remains plain text instead of being guessed.
export function splitComposerTagContentByAnnotations(
  content: string,
  inputAnnotations?: readonly DaemonInputAnnotation[],
): ComposerTagContentSegment[] {
  if (!inputAnnotations || inputAnnotations.length === 0) {
    return [{ type: 'text', text: content }];
  }
  const segments: ComposerTagContentSegment[] = [];
  let cursor = 0;
  for (const annotation of inputAnnotations) {
    if (annotation.type !== 'reference') continue;
    const { start, end, text } = annotation;
    const reference: DaemonInputAnnotation['reference'] | undefined =
      annotation.reference;
    if (
      !reference ||
      typeof reference.id !== 'string' ||
      start < cursor ||
      end <= start ||
      end > content.length ||
      content.slice(start, end) !== text
    ) {
      continue;
    }
    if (cursor < start) {
      segments.push({ type: 'text', text: content.slice(cursor, start) });
    }
    segments.push({
      type: 'reference',
      tag: {
        id: reference.id,
        ...(reference.kind ? { kind: reference.kind } : {}),
        ...(reference.label ? { label: reference.label } : {}),
        ...(reference.value ? { value: reference.value } : {}),
        serialized: reference.serialized ?? text,
        ...(reference.removable !== undefined
          ? { removable: reference.removable }
          : {}),
      },
    });
    cursor = end;
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
