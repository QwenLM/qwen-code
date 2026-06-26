import type { ContentBadge, MessageTextElement } from '../types/message.ts';

function definedMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

/**
 * Convert a JavaScript UTF-16 string index into a UTF-8 byte offset.
 *
 * Message text elements intentionally use byte offsets to match Codex's
 * persisted session shape. Rendering code can convert back to UTF-16 indices
 * when slicing strings for React.
 */
export function utf16IndexToByteOffset(text: string, index: number): number {
  const boundedIndex = Math.max(0, Math.min(index, text.length));
  return utf8ByteLength(text.slice(0, boundedIndex));
}

/**
 * Convert a UTF-8 byte offset into a JavaScript UTF-16 string index.
 *
 * If the byte offset lands inside a multi-byte character, this returns the
 * closest following UTF-16 boundary so callers never split a surrogate pair.
 */
export function byteOffsetToUtf16Index(text: string, byteOffset: number): number {
  const boundedOffset = Math.max(0, byteOffset);
  let bytes = 0;
  let index = 0;

  for (const char of text) {
    if (bytes >= boundedOffset) return index;
    bytes += utf8ByteLength(char);
    index += char.length;
  }

  return text.length;
}

function badgeTarget(badge: ContentBadge): string | undefined {
  if (badge.filePath) return badge.filePath;

  const bracketMatch = /^\[(source|skill|file|folder):([^\]]+)\]$/.exec(badge.rawText);
  if (bracketMatch?.[2]) return bracketMatch[2].trim();

  if (badge.type === 'command') return badge.label.replace(/^\/+/, '').trim() || undefined;
  return undefined;
}

export function contentBadgeToTextElement(content: string, badge: ContentBadge): MessageTextElement {
  const target = badgeTarget(badge);
  const type = badge.type === 'command' ? 'slash_command' : badge.type;
  const metadata = definedMetadata({
    ...(badge.iconDataUrl ? { iconDataUrl: badge.iconDataUrl } : {}),
    ...(badge.collapsedLabel ? { collapsedLabel: badge.collapsedLabel } : {}),
  });

  return {
    type,
    byte_range: {
      start: utf16IndexToByteOffset(content, badge.start),
      end: utf16IndexToByteOffset(content, badge.end),
    },
    placeholder: badge.rawText || content.slice(badge.start, badge.end),
    ...(badge.label ? { label: badge.label } : {}),
    ...(target ? { target } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function contentBadgesToTextElements(content: string, badges?: ContentBadge[]): MessageTextElement[] | undefined {
  if (!badges?.length) return undefined;
  return badges.map((badge) => contentBadgeToTextElement(content, badge));
}

function metadataString(element: MessageTextElement, key: string): string | undefined {
  const value = element.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function textElementToContentBadge(content: string, element: MessageTextElement): ContentBadge {
  const start = byteOffsetToUtf16Index(content, element.byte_range.start);
  const end = byteOffsetToUtf16Index(content, element.byte_range.end);
  const rawText = element.placeholder || content.slice(start, end);
  const label = element.label || element.target || rawText;
  const filePath = element.type === 'file' || element.type === 'folder'
    ? element.target
    : undefined;
  const iconDataUrl = metadataString(element, 'iconDataUrl');
  const collapsedLabel = metadataString(element, 'collapsedLabel');
  const type = element.type === 'slash_command' ? 'command' : element.type;

  return {
    type,
    label,
    rawText,
    start,
    end,
    ...(iconDataUrl ? { iconDataUrl } : {}),
    ...(collapsedLabel ? { collapsedLabel } : {}),
    ...(filePath ? { filePath } : {}),
  };
}

export function textElementsToContentBadges(content: string, textElements?: MessageTextElement[]): ContentBadge[] | undefined {
  if (!textElements?.length) return undefined;
  return textElements.map((element) => textElementToContentBadge(content, element));
}
