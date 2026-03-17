/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { Storage, escapePath } from '@qwen-code/qwen-code-core';

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

/**
 * Save base64 image to a temporary file
 * @param base64Data The base64 encoded image data (with or without data URL prefix)
 * @param fileName Original filename
 * @returns The path to the saved file or null if failed
 */
export async function saveImageToFile(
  base64Data: string,
  fileName: string,
): Promise<string | null> {
  try {
    const tempDir = path.join(Storage.getGlobalTempDir(), CLIPBOARD_DIR_NAME);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate unique filename (same pattern as CLI)
    const timestamp = Date.now();
    const ext = path.extname(fileName) || '.png';
    const tempFileName = `clipboard-${timestamp}-${randomUUID()}${ext}`;
    const tempFilePath = path.join(tempDir, tempFileName);

    // Extract base64 data if it's a data URL
    let pureBase64 = base64Data;
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      pureBase64 = dataUrlMatch[1];
    }

    // Write file
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

/**
 * Process image attachments and add them to message text
 */
export async function processImageAttachments(
  text: string,
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    size: number;
    data: string;
    timestamp: number;
  }>,
): Promise<{
  formattedText: string;
  displayText: string;
  savedImageCount: number;
}> {
  let formattedText = text;
  let displayText = text;
  let savedImageCount = 0;

  // Add image attachments - save to files and reference them
  if (attachments && attachments.length > 0) {
    // Save images as files and add references to the text
    const imageReferences: string[] = [];

    for (const attachment of attachments) {
      // Save image to file
      const imagePath = await saveImageToFile(attachment.data, attachment.name);
      if (imagePath) {
        // Add file reference to the message (like CLI does with @path)
        imageReferences.push(`@${escapePath(imagePath)}`);
        savedImageCount += 1;
      } else {
        console.warn(
          '[ImageAttachmentHandler] Failed to save image:',
          attachment.name,
        );
      }
    }

    // Add image references to the text
    if (imageReferences.length > 0) {
      // Update the formatted text with image references
      formattedText = appendImageReferences(formattedText, imageReferences);
      displayText = appendImageReferences(displayText, imageReferences);
    }
  }

  return { formattedText, displayText, savedImageCount };
}
