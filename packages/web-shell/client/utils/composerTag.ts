import extensionIconUrl from '../assets/icons/at-extension.svg';
import fileIconUrl from '../assets/icons/at-file.svg';
import mcpIconUrl from '../assets/icons/at-mcp.svg';
import skillIconUrl from '../assets/icons/at-skill.svg';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
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
    const { start, end, reference, text } = annotation;
    if (
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
