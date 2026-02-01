/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Temporary file manager for creating and opening temporary files in webview
 */

/**
 * Creates a temporary file with the given content and opens it in VS Code
 * @param content The content to write to the temporary file
 * @param fileName Optional file name (without extension)
 * @param fileExtension Optional file extension (defaults to .txt)
 */
export async function createAndOpenTempFile(
  postMessage: (message: {
    type: string;
    data: Record<string, unknown>;
  }) => void,
  content: string,
  fileName: string = 'temp',
  fileExtension: string = '.txt',
): Promise<void> {
  // Send message to VS Code extension to create and open temp file
  postMessage({
    type: 'createAndOpenTempFile',
    data: {
      content,
      fileName,
      fileExtension,
    },
  });
}
