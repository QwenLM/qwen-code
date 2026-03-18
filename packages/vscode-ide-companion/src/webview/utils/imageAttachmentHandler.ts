/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { Storage, escapePath } from '@qwen-code/qwen-code-core';
import type {
  ImageAttachment,
  SavedImageAttachment,
} from '../../types/imageAttachment.js';
import {
  MAX_IMAGE_SIZE,
  MAX_TOTAL_IMAGE_SIZE,
} from '../../utils/imageAttachmentLimits.js';
import { getImageExtensionForMimeType } from '../../utils/imageFormats.js';
import { normalizeImageAttachment } from '../../utils/imageAttachmentValidation.js';

const CLIPBOARD_DIR_NAME = 'clipboard';
const MAX_CLIPBOARD_IMAGES = 100;

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
    const tempDir = path.join(Storage.getGlobalTempDir(), CLIPBOARD_DIR_NAME);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const ext = getImageExtensionForMimeType(mimeType);
    const tempFileName = `clipboard-${timestamp}-${randomUUID()}${ext}`;
    const tempFilePath = path.join(tempDir, tempFileName);

    let pureBase64 = base64Data;
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      pureBase64 = dataUrlMatch[1];
    }

    const buffer = Buffer.from(pureBase64, 'base64');
    fs.writeFileSync(tempFilePath, buffer);

    pruneClipboardImages(tempDir);

    return tempFilePath;
  } catch (error) {
    console.error('[ImageAttachmentHandler] Failed to save image:', error);
    return null;
  }
}

function pruneClipboardImages(tempDir: string): void {
  const clipboardImages = fs
    .readdirSync(tempDir)
    .filter((file) => file.startsWith('clipboard-'))
    .map((file) => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      return {
        filePath,
        mtimeMs: stats.mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  clipboardImages
    .slice(MAX_CLIPBOARD_IMAGES)
    .forEach(({ filePath }) => fs.rmSync(filePath, { force: true }));
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
