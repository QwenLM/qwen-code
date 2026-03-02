/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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

const FILE_REF_PATTERN = /@([^\s]+)/g;

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

  const imagePaths: string[] = [];
  let match: RegExpExecArray | null;

  FILE_REF_PATTERN.lastIndex = 0;
  while ((match = FILE_REF_PATTERN.exec(content)) !== null) {
    const ref = match[1];
    if (isImageReference(ref)) {
      imagePaths.push(ref);
    }
  }

  if (imagePaths.length === 0) {
    return { text: content, imagePaths: [] };
  }

  const cleaned = normalizeWhitespace(
    content.replace(FILE_REF_PATTERN, (full, ref: string) =>
      isImageReference(ref) ? '' : full,
    ),
  );

  return { text: cleaned, imagePaths };
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
