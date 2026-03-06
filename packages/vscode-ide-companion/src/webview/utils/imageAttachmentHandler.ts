/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
    // Get workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.error('[ImageAttachmentHandler] No workspace folder found');
      return null;
    }

    // Create temp directory for images (aligned with CLI)
    const tempDir = path.join(workspaceFolder.uri.fsPath, 'clipboard');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate unique filename (same pattern as CLI)
    const timestamp = Date.now();
    const ext = path.extname(fileName) || '.png';
    const tempFileName = `clipboard-${timestamp}${ext}`;
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

    // Return relative path from workspace root
    const relativePath = path.relative(
      workspaceFolder.uri.fsPath,
      tempFilePath,
    );
    return relativePath;
  } catch (error) {
    console.error('[ImageAttachmentHandler] Failed to save image:', error);
    return null;
  }
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
): Promise<{ formattedText: string; displayText: string }> {
  let formattedText = text;
  let displayText = text;

  // Add image attachments - save to files and reference them
  if (attachments && attachments.length > 0) {
    // Save images as files and add references to the text
    const imageReferences: string[] = [];

    for (const attachment of attachments) {
      // Save image to file
      const imagePath = await saveImageToFile(attachment.data, attachment.name);
      if (imagePath) {
        // Add file reference to the message (like CLI does with @path)
        imageReferences.push(`@${imagePath}`);
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

  return { formattedText, displayText };
}
