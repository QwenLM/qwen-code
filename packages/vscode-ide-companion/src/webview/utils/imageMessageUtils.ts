/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { unescapePath } from '../../utils/pathEscaping.js';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tiff',
  '.heic',
  '.heif',
  '.gif',
]);

export interface WebViewMessageBase {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: number;
  fileContext?: {
    fileName: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  };
}

export interface WebViewImageMessage extends WebViewMessageBase {
  kind: 'image';
  imagePath: string;
  imageSrc?: string;
  imageMissing?: boolean;
}

export type WebViewMessage = WebViewMessageBase | WebViewImageMessage;

interface ParsedImageReference {
  imagePath: string;
  start: number;
  end: number;
}

function isImageReference(ref: string): boolean {
  const lower = ref.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitMessageContentForImages(content: string): {
  text: string;
  imagePaths: string[];
} {
  if (!content) {
    return { text: '', imagePaths: [] };
  }

  const imageReferences = parseImageReferences(content);

  if (imageReferences.length === 0) {
    return { text: content, imagePaths: [] };
  }

  let cleanedContent = '';
  let lastIndex = 0;

  for (const reference of imageReferences) {
    cleanedContent += content.slice(lastIndex, reference.start);
    lastIndex = reference.end;
  }

  cleanedContent += content.slice(lastIndex);

  const cleaned = normalizeWhitespace(cleanedContent);
  const imagePaths = imageReferences.map((reference) => reference.imagePath);

  return { text: cleaned, imagePaths };
}

function parseImageReferences(content: string): ParsedImageReference[] {
  const references: ParsedImageReference[] = [];
  let currentIndex = 0;

  while (currentIndex < content.length) {
    let atIndex = -1;
    let nextSearchIndex = currentIndex;

    while (nextSearchIndex < content.length) {
      if (
        content[nextSearchIndex] === '@' &&
        (nextSearchIndex === 0 || content[nextSearchIndex - 1] !== '\\')
      ) {
        atIndex = nextSearchIndex;
        break;
      }
      nextSearchIndex += 1;
    }

    if (atIndex === -1) {
      break;
    }

    let pathEndIndex = atIndex + 1;
    let inEscape = false;

    while (pathEndIndex < content.length) {
      const char = content[pathEndIndex];

      if (inEscape) {
        inEscape = false;
      } else if (char === '\\') {
        inEscape = true;
      } else if (/[,\s;!?()[\]{}]/.test(char)) {
        break;
      } else if (char === '.') {
        const nextChar =
          pathEndIndex + 1 < content.length ? content[pathEndIndex + 1] : '';
        if (nextChar === '' || /\s/.test(nextChar)) {
          break;
        }
      }

      pathEndIndex += 1;
    }

    const rawReference = content.slice(atIndex, pathEndIndex);
    const unescapedReference = unescapePath(rawReference);
    const imagePath = unescapedReference.startsWith('@')
      ? unescapedReference.slice(1)
      : unescapedReference;

    if (isImageReference(imagePath)) {
      references.push({
        imagePath,
        start: atIndex,
        end: pathEndIndex,
      });
    }

    currentIndex = pathEndIndex;
  }

  return references;
}

export function expandUserMessageWithImages(message: WebViewMessageBase): {
  messages: WebViewMessage[];
  imagePaths: string[];
} {
  const { text, imagePaths } = splitMessageContentForImages(message.content);
  if (imagePaths.length === 0) {
    return { messages: [message], imagePaths: [] };
  }

  const expanded: WebViewMessage[] = imagePaths.map((imagePath) => ({
    role: 'user',
    content: '',
    timestamp: message.timestamp,
    kind: 'image',
    imagePath,
  }));

  if (text) {
    expanded.push({
      ...message,
      content: text,
    });
  }

  return { messages: expanded, imagePaths };
}

export function applyImageResolution(
  messages: WebViewMessage[],
  resolutions: Map<string, string | null>,
): WebViewMessage[] {
  if (messages.length === 0 || resolutions.size === 0) {
    return messages;
  }

  let changed = false;
  const next = messages.map((message) => {
    if (!('kind' in message) || message.kind !== 'image') {
      return message;
    }

    const resolved = resolutions.get(message.imagePath);
    if (resolved === undefined) {
      return message;
    }

    const imageMissing = resolved === null;
    const imageSrc = resolved ?? undefined;
    if (
      message.imageSrc === imageSrc &&
      message.imageMissing === imageMissing
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      imageSrc,
      imageMissing,
    };
  });

  return changed ? next : messages;
}
