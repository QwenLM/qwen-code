/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@qwen-code/qwen-code-core';

/**
 * Checks if the system clipboard contains an image (macOS only for now)
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  // Windows implementation
  if (process.platform === 'win32') {
    try {
      const script = `
        Add-Type -AssemblyName System.Windows.Forms;
        [System.Windows.Forms.Clipboard]::ContainsImage()
      `.trim();

      const { stdout } = await execCommand('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);

      return stdout.trim() === 'True';
    } catch {
      return false;
    }
  }

  // macOS implementation
  if (process.platform === 'darwin') {
    try {
      // Use osascript to check clipboard type
      const { stdout } = await execCommand('osascript', [
        '-e',
        'clipboard info',
      ]);
      const imageRegex =
        /«class PNGf»|TIFF picture|JPEG picture|GIF picture|«class JPEG»|«class TIFF»/;
      return imageRegex.test(stdout);
    } catch {
      return false;
    }
  }

  // Unsupported platform
  return false;
}

/**
 * Saves the image from clipboard to a temporary file (macOS only for now)
 * @param targetDir The target directory to create temp files within
 * @returns The path to the saved image file, or null if no image or error
 */
export async function saveClipboardImage(
  targetDir?: string,
): Promise<string | null> {
  try {
    // Create a temporary directory for clipboard images within the target directory
    // This avoids security restrictions on paths outside the target directory
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, '.gemini-clipboard');
    await fs.mkdir(tempDir, { recursive: true });

    // Generate a unique filename with timestamp
    const timestamp = new Date().getTime();

    // Windows implementation
    if (process.platform === 'win32') {
      // Try different image formats in order of preference
      const formats = [
        { name: 'Png', extension: 'png' },
        { name: 'Jpeg', extension: 'jpg' },
        { name: 'Bmp', extension: 'bmp' },
      ];

      for (const format of formats) {
        const outputPath = path.join(
          tempDir,
          `clipboard-${timestamp}.${format.extension}`,
        );

        // Escape backslashes for PowerShell string
        const escapedPath = outputPath.replace(/\\/g, '\\\\');

        const script = `
          try {
            Add-Type -AssemblyName System.Windows.Forms;
            Add-Type -AssemblyName System.Drawing;
            
            $image = [System.Windows.Forms.Clipboard]::GetImage();
            
            if ($null -eq $image) {
              Write-Output "no_image";
              exit 1;
            }
            
            $image.Save("${escapedPath}", [System.Drawing.Imaging.ImageFormat]::${format.name});
            $image.Dispose();
            Write-Output "success";
            exit 0;
          } catch {
            Write-Output "error";
            exit 1;
          }
        `.trim();

        try {
          const { stdout } = await execCommand('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script,
          ]);

          if (stdout.trim() === 'success') {
            // Verify file was created and has content
            try {
              const stats = await fs.stat(outputPath);
              if (stats.size > 0) {
                return outputPath;
              }
            } catch {
              // File doesn't exist, try next format
            }
          }

          // Clean up failed attempt
          try {
            await fs.unlink(outputPath);
          } catch {
            // Ignore cleanup errors
          }
        } catch {
          // PowerShell execution failed, try next format
          continue;
        }
      }

      // No format worked
      return null;
    }

    // macOS implementation
    if (process.platform === 'darwin') {
      const formats = [
        { class: 'PNGf', extension: 'png' },
        { class: 'JPEG', extension: 'jpg' },
        { class: 'TIFF', extension: 'tiff' },
        { class: 'GIFf', extension: 'gif' },
      ];

      for (const format of formats) {
        const tempFilePath = path.join(
          tempDir,
          `clipboard-${timestamp}.${format.extension}`,
        );

        const script = `
          try
            set imageData to the clipboard as «class ${format.class}»
            set fileRef to open for access POSIX file "${tempFilePath}" with write permission
            write imageData to fileRef
            close access fileRef
            return "success"
          on error errMsg
            try
              close access POSIX file "${tempFilePath}"
            end try
            return "error"
          end try
        `;

        const { stdout } = await execCommand('osascript', ['-e', script]);

        if (stdout.trim() === 'success') {
          try {
            const stats = await fs.stat(tempFilePath);
            if (stats.size > 0) {
              return tempFilePath;
            }
          } catch {
            // File doesn't exist, continue to next format
          }
        }

        try {
          await fs.unlink(tempFilePath);
        } catch {
          // Ignore cleanup errors
        }
      }

      return null;
    }

    // Unsupported platform
    return null;
  } catch (error) {
    console.error('Error saving clipboard image:', error);
    return null;
  }
}

/**
 * Cleans up old temporary clipboard image files
 * Removes files older than 1 hour
 * @param targetDir The target directory where temp files are stored
 */
export async function cleanupOldClipboardImages(
  targetDir?: string,
): Promise<void> {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, '.gemini-clipboard');
    const files = await fs.readdir(tempDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const file of files) {
      if (
        file.startsWith('clipboard-') &&
        (file.endsWith('.png') ||
          file.endsWith('.jpg') ||
          file.endsWith('.tiff') ||
          file.endsWith('.gif'))
      ) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < oneHourAgo) {
          await fs.unlink(filePath);
        }
      }
    }
  } catch {
    // Ignore errors in cleanup
  }
}
