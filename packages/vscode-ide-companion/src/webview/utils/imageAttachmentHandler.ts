/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  saveImageBufferToClipboardDir,
  pruneClipboardImages,
} from '@qwen-code/qwen-code-core';
import type {
  ImageAttachment,
  SavedImageAttachment,
} from '../../types/imageAttachment.js';
import {
  MAX_IMAGE_SIZE,
  MAX_TOTAL_IMAGE_SIZE,
} from '../../utils/imageAttachmentLimits.js';
import { getImageExtensionForMimeType } from '../../utils/imageFormats.js';
import { escapePath } from '../../utils/pathEscaping.js';
import { normalizeImageAttachment } from '../../utils/imageAttachmentValidation.js';

export function appendImageReferences(
  text: string,
  imageReferences: string[],
): string {
  if (imageReferences.length === 0) {
    return text;
  }
  const imageText = imageReferences.join(' ');
  if (!text.trim()) {
    return imageText;
  }
  return `${text}\n\n${imageText}`;
}

export async function saveImageToFile(
  base64Data: string,
  mimeType: string,
): Promise<string | null> {
  try {
    let pureBase64 = base64Data;
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      pureBase64 = dataUrlMatch[1];
    }

    const buffer = Buffer.from(pureBase64, 'base64');
    const timestamp = Date.now();
    const ext = getImageExtensionForMimeType(mimeType);
    const fileName = `clipboard-${timestamp}-${randomUUID()}${ext}`;

    const filePath = await saveImageBufferToClipboardDir(buffer, fileName);
    await pruneClipboardImages();
    return filePath;
  } catch (error) {
    console.error('[ImageAttachmentHandler] Failed to save image:', error);
    return null;
  }
}

export async function processImageAttachments(
  text: string,
  attachments?: ImageAttachment[],
): Promise<{
  formattedText: string;
  displayText: string;
  savedImageCount: number;
  promptImages: SavedImageAttachment[];
}> {
  let formattedText = text;
  let displayText = text;
  let savedImageCount = 0;
  let remainingBytes = MAX_TOTAL_IMAGE_SIZE;
  const promptImages: SavedImageAttachment[] = [];

  if (attachments && attachments.length > 0) {
    const imageReferences: string[] = [];

    for (const attachment of attachments) {
      const normalizedAttachment = normalizeImageAttachment(attachment, {
        maxBytes: Math.min(MAX_IMAGE_SIZE, remainingBytes),
      });
      if (!normalizedAttachment) {
        console.warn(
          '[ImageAttachmentHandler] Rejected invalid image attachment:',
          attachment.name,
        );
        continue;
      }

      const imagePath = await saveImageToFile(
        normalizedAttachment.data,
        normalizedAttachment.type,
      );
      if (imagePath) {
        imageReferences.push(`@${escapePath(imagePath)}`);
        promptImages.push({
          path: imagePath,
          name: normalizedAttachment.name,
          mimeType: normalizedAttachment.type,
        });
        remainingBytes -= normalizedAttachment.size;
        savedImageCount += 1;
      } else {
        console.warn(
          '[ImageAttachmentHandler] Failed to save image:',
          attachment.name,
        );
      }
    }

    if (imageReferences.length > 0) {
      formattedText = appendImageReferences(formattedText, imageReferences);
      displayText = appendImageReferences(displayText, imageReferences);
    }
  }

  return { formattedText, displayText, savedImageCount, promptImages };
}
