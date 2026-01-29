/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@qwen-code/qwen-code-core';

/**
 * Checks if the system clipboard contains an image (cross-platform)
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      // Use osascript to check clipboard type on macOS
      const { stdout } = await execCommand('osascript', [
        '-e',
        'clipboard info',
      ]);
      const imageRegex =
        /«class PNGf»|TIFF picture|JPEG picture|GIF picture|«class JPEG»|«class TIFF»/;
      return imageRegex.test(stdout);
    } else if (process.platform === 'win32') {
      // On Windows, use System.Windows.Forms.Clipboard (more reliable than PresentationCore)
      const { stdout } = await execCommand('powershell', [
        '-noprofile',
        '-noninteractive',
        '-nologo',
        '-sta',
        '-executionpolicy',
        'unrestricted',
        '-windowstyle',
        'hidden',
        '-command',
        'Add-Type -Assembly System.Windows.Forms; [System.Windows.Forms.Clipboard]::ContainsImage()',
      ]);
      return stdout.trim() === 'True';
    } else if (process.platform === 'linux') {
      // On Linux, check if xclip or wl-clipboard is available and has image data
      try {
        // Try xclip first (X11)
        await execCommand('which', ['xclip']);
        const { stdout: xclipOut } = await execCommand('xclip', [
          '-selection',
          'clipboard',
          '-t',
          'image/png',
          '-o',
        ]);
        return xclipOut.length > 0;
      } catch {
        try {
          // Try xsel as fallback (X11)
          await execCommand('which', ['xsel']);
          const { stdout: xselOut } = await execCommand('xsel', ['-b', '-o']);
          return xselOut.length > 0;
        } catch {
          try {
            // Try wl-clipboard as fallback (Wayland)
            await execCommand('which', ['wl-paste']);
            const { stdout: wlOut } = await execCommand('wl-paste', [
              '--mime-type',
            ]);
            return wlOut.includes('image/');
          } catch {
            return false;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Saves the image from clipboard to a temporary file (cross-platform)
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
    const tempDir = path.join(baseDir, '.qwen-clipboard');
    await fs.mkdir(tempDir, { recursive: true });

    // Generate a unique filename with timestamp
    const timestamp = new Date().getTime();

    if (process.platform === 'darwin') {
      // macOS implementation using AppleScript
      // Try different image formats in order of preference
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

        // Try to save clipboard as this format
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
          // Verify the file was created and has content
          try {
            const stats = await fs.stat(tempFilePath);
            if (stats.size > 0) {
              return tempFilePath;
            }
          } catch {
            // File doesn't exist, continue to next format
          }
        }

        // Clean up failed attempt
        try {
          await fs.unlink(tempFilePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } else if (process.platform === 'win32') {
      // Windows implementation using PowerShell with System.Windows.Forms
      const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);
      // Escape backslashes for PowerShell
      const escapedPath = tempFilePath.replace(/\\/g, '\\\\');

      const psScript = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
  $img.Save("${escapedPath}", [System.Drawing.Imaging.ImageFormat]::Png)
  $img.Dispose()
  Write-Host "success"
} else {
  Write-Host "error"
}
      `.trim();

      const { stdout } = await execCommand('powershell', [
        '-noprofile',
        '-noninteractive',
        '-nologo',
        '-sta',
        '-executionpolicy',
        'unrestricted',
        '-windowstyle',
        'hidden',
        '-command',
        psScript,
      ]);

      if (stdout.trim() === 'success') {
        try {
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            return tempFilePath;
          }
        } catch {
          // File doesn't exist
        }
      }
    } else if (process.platform === 'linux') {
      // Linux implementation using xclip, xsel, or wl-clipboard
      const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);

      try {
        // Try xclip first (X11)
        await execCommand('which', ['xclip']);
        const { stdout } = await execCommand('xclip', [
          '-selection',
          'clipboard',
          '-t',
          'image/png',
          '-o',
        ]);

        if (stdout.length > 0) {
          await fs.writeFile(tempFilePath, stdout);
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            return tempFilePath;
          }
        }
      } catch {
        try {
          // Try xsel as fallback (X11)
          await execCommand('which', ['xsel']);
          const { stdout } = await execCommand('xsel', ['-b', '-o']);

          if (stdout.length > 0) {
            await fs.writeFile(tempFilePath, stdout);
            const stats = await fs.stat(tempFilePath);
            if (stats.size > 0) {
              return tempFilePath;
            }
          }
        } catch {
          try {
            // Try wl-clipboard as fallback (Wayland)
            await execCommand('which', ['wl-paste']);
            const { stdout } = await execCommand('wl-paste', [
              '--type=image/*',
            ]);

            if (stdout.length > 0) {
              await fs.writeFile(tempFilePath, stdout);
              const stats = await fs.stat(tempFilePath);
              if (stats.size > 0) {
                return tempFilePath;
              }
            }
          } catch {
            return null;
          }
        }
      }
    }

    // No image found or error occurred
    return null;
  } catch (error) {
    console.error('Error saving clipboard image:', error);
    return null;
  }
}

/**
 * Cleans up old temporary clipboard image files
 * Removes files older than 5 minutes (shorter TTL for security/privacy)
 * @param targetDir The target directory where temp files are stored
 */
export async function cleanupOldClipboardImages(
  targetDir?: string,
): Promise<void> {
  try {
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, '.qwen-clipboard');

    // Check if temp directory exists
    try {
      await fs.access(tempDir);
    } catch {
      // Directory doesn't exist, nothing to clean up
      return;
    }

    const files = await fs.readdir(tempDir);
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000; // 5 minutes in milliseconds

    for (const file of files) {
      if (
        file.startsWith('clipboard-') &&
        (file.endsWith('.png') ||
          file.endsWith('.jpg') ||
          file.endsWith('.jpeg') ||
          file.endsWith('.tiff') ||
          file.endsWith('.gif') ||
          file.endsWith('.bmp') ||
          file.endsWith('.webp'))
      ) {
        const filePath = path.join(tempDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < fiveMinutesAgo) {
            await fs.unlink(filePath);
            console.log(`🗑️  Cleaned up old clipboard image: ${file}`);
          }
        } catch (error) {
          // File may have been deleted by another process, continue
          console.debug(
            `⚠️  Could not clean up clipboard image ${file}:`,
            error,
          );
        }
      }
    }
  } catch (error) {
    // Silently ignore errors during cleanup unless debugging
    if (process.env['DEBUG']) {
      console.debug('⚠️  Error during clipboard image cleanup:', error);
    }
  }
}
