/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptContentBlock } from '@qwen-code/sdk/daemon';
import type { DaemonPromptFile, DaemonPromptImage } from './types.js';

export function attachmentUriForName(name: string): string {
  return `attachment:///${name}`;
}

export function daemonPromptImageToBlob(image: DaemonPromptImage): Blob {
  const comma = image.data.indexOf(',');
  const encoded =
    image.data.startsWith('data:') && comma >= 0
      ? image.data.slice(comma + 1)
      : image.data;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {
    type: image.mimeType ?? image.mediaType ?? image.media_type ?? 'image/*',
  });
}

export function toDaemonPromptContent(
  text: string,
  images: readonly DaemonPromptImage[] = [],
  files: readonly DaemonPromptFile[] = [],
): PromptContentBlock[] {
  // Token lines keep a visible trace in the daemon-recorded transcript
  // (which stores text blocks only). Skipped for slash commands: the
  // daemon's slash path drops attachment blocks, so a token would dangle.
  const tokenText = files
    .map((file) => `@${attachmentUriForName(file.name)}`)
    .join('\n');
  const withTokens =
    files.length > 0 && !text.trimStart().startsWith('/')
      ? text.trim().length > 0
        ? `${text.trimEnd()}\n\n${tokenText}`
        : tokenText
      : text;
  const prompt: PromptContentBlock[] = [{ type: 'text', text: withTokens }];

  for (const image of images) {
    const mimeType = image.mimeType ?? image.mediaType ?? image.media_type;
    // Omit 'image/*' (unknown type) to preserve legacy behavior where
    // untyped images are sent without mimeType to the daemon.
    if (mimeType && mimeType !== 'image/*') {
      prompt.push({
        type: 'image',
        data: image.data,
        mimeType,
      });
    } else {
      prompt.push({
        type: 'image',
        data: image.data,
      });
    }
  }

  for (const file of files) {
    const mimeType = file.mimeType ?? file.mediaType ?? file.media_type;
    prompt.push({
      type: 'resource',
      resource: {
        uri: attachmentUriForName(file.name),
        ...(mimeType ? { mimeType } : {}),
        text: file.text,
      },
    });
  }

  return prompt;
}
