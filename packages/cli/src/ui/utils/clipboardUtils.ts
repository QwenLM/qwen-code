/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@qwen-code/qwen-code-core';

const MACOS_CLIPBOARD_TIMEOUT_MS = 1500;

/**
 * Checks if the system clipboard contains an image
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      // Use osascript to check clipboard type
      const { stdout } = await execCommand(
        'osascript',
        ['-e', 'clipboard info'],
        {
          timeout: MACOS_CLIPBOARD_TIMEOUT_MS,
        },
      );
      // Support common image formats: PNG, JPEG, TIFF, GIF, WebP, BMP, HEIC/HEIF
      const imageRegex =
        /«class PNGf»|«class JPEG»|«class JPEGffffff»|«class TIFF»|«class GIFf»|«class WEBP»|«class BMPf»|«class heic»|«class heif»|TIFF picture|JPEG picture|GIF picture|PNG picture|public.heic|public.heif/;
      return imageRegex.test(stdout);
    } else if (process.platform === 'win32') {
      // On Windows, use System.Windows.Forms.Clipboard (more reliable than PresentationCore)
      try {
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
      } catch {
        // If PowerShell or .NET Forms is not available, return false
        return false;
      }
    } else if (process.platform === 'linux') {
      // On Linux, check if xclip or wl-clipboard is available and has image data
      try {
        // Try xclip first (X11) - check for multiple image formats
        await execCommand('which', ['xclip']);
        const imageFormats = [
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/bmp',
          'image/webp',
          'image/tiff',
        ];
        for (const format of imageFormats) {
          try {
            const { stdout: xclipOut } = await execCommand('xclip', [
              '-selection',
              'clipboard',
              '-t',
              format,
              '-o',
            ]);
            if (xclipOut.length > 0) {
              return true;
            }
          } catch {
            // This format is not available, try next
            continue;
          }
        }
        return false;
      } catch {
        try {
          // Try xsel as fallback (X11) - check TARGETS to see if image data exists
          await execCommand('which', ['xsel']);
          try {
            // Check available clipboard targets
            const { stdout: targets } = await execCommand('xsel', ['-b', '-t']);
            // Check if any image MIME type is in the targets
            return /image\/(png|jpeg|jpg|gif|bmp|webp|tiff)/i.test(targets);
          } catch {
            return false;
          }
        } catch {
          try {
            // Try wl-clipboard as fallback (Wayland)
            await execCommand('which', ['wl-paste']);
            const { stdout: wlOut } = await execCommand('wl-paste', [
              '--list-types',
            ]);
            // Check for image MIME types (must start with image/)
            return /^image\//m.test(wlOut);
          } catch {
            return false;
          }
        }
      }
    }
    return false;
  } catch (error) {
    // Log error for debugging but don't throw
    if (process.env['DEBUG']) {
      console.error('Error checking clipboard for image:', error);
    }
    return false;
  }
}

/**
 * Saves the image from clipboard to a temporary file
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
    const tempDir = path.join(baseDir, 'clipboard');
    await fs.mkdir(tempDir, { recursive: true });

    // Generate a unique filename with timestamp
    const timestamp = new Date().getTime();

    if (process.platform === 'darwin') {
      return await saveMacOSClipboardImage(tempDir, timestamp);
    } else if (process.platform === 'win32') {
      return await saveWindowsClipboardImage(tempDir, timestamp);
    } else if (process.platform === 'linux') {
      return await saveLinuxClipboardImage(tempDir, timestamp);
    }

    return null;
  } catch (error) {
    if (process.env['DEBUG']) {
      console.error('Error saving clipboard image:', error);
    }
    return null;
  }
}

/**
 * Saves clipboard image on macOS using osascript
 */
async function saveMacOSClipboardImage(
  tempDir: string,
  timestamp: number,
): Promise<string | null> {
  // Try different image formats in order of preference
  const formats = [
    { class: 'PNGf', extension: 'png' },
    { class: 'JPEG', extension: 'jpg' },
    { class: 'WEBP', extension: 'webp' },
    { class: 'heic', extension: 'heic' },
    { class: 'heif', extension: 'heif' },
    { class: 'TIFF', extension: 'tiff' },
    { class: 'GIFf', extension: 'gif' },
    { class: 'BMPf', extension: 'bmp' },
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

    try {
      const { stdout } = await execCommand('osascript', ['-e', script], {
        timeout: MACOS_CLIPBOARD_TIMEOUT_MS,
      });

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
    } catch {
      // This format failed, try next
    }

    // Clean up failed attempt
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Ignore cleanup errors
    }
  }

  return null;
}

/**
 * Saves clipboard image on Windows using PowerShell
 */
async function saveWindowsClipboardImage(
  tempDir: string,
  timestamp: number,
): Promise<string | null> {
  const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);

  try {
    // Use PowerShell to save clipboard image as PNG
    const script = `
      Add-Type -Assembly System.Windows.Forms
      Add-Type -Assembly System.Drawing
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img -ne $null) {
        $img.Save('${tempFilePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output 'success'
      } else {
        Write-Output 'no-image'
      }
    `;

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
      script,
    ]);

    if (stdout.trim() === 'success') {
      // Verify the file was created and has content
      try {
        const stats = await fs.stat(tempFilePath);
        if (stats.size > 0) {
          return tempFilePath;
        }
      } catch {
        // File doesn't exist
      }
    }

    // Clean up failed attempt
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Ignore cleanup errors
    }
  } catch {
    // PowerShell failed
  }

  return null;
}

/**
 * Saves clipboard image on Linux using xclip or wl-paste
 */
async function saveLinuxClipboardImage(
  tempDir: string,
  timestamp: number,
): Promise<string | null> {
  // Try xclip first (X11)
  try {
    await execCommand('which', ['xclip']);

    // Try different image formats
    const formats = [
      { mime: 'image/png', extension: 'png' },
      { mime: 'image/jpeg', extension: 'jpg' },
      { mime: 'image/gif', extension: 'gif' },
      { mime: 'image/bmp', extension: 'bmp' },
      { mime: 'image/webp', extension: 'webp' },
      { mime: 'image/tiff', extension: 'tiff' },
    ];

    for (const format of formats) {
      const tempFilePath = path.join(
        tempDir,
        `clipboard-${timestamp}.${format.extension}`,
      );

      try {
        // Use shell redirection to save binary data
        await execCommand('sh', [
          '-c',
          `xclip -selection clipboard -t ${format.mime} -o > "${tempFilePath}"`,
        ]);

        // Verify the file was created and has content
        try {
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            return tempFilePath;
          }
        } catch {
          // File doesn't exist or is empty
        }

        // Clean up empty file
        try {
          await fs.unlink(tempFilePath);
        } catch {
          // Ignore cleanup errors
        }
      } catch {
        // This format not available, try next
        continue;
      }
    }
  } catch {
    // xclip not available, try wl-paste (Wayland)
    try {
      await execCommand('which', ['wl-paste']);

      // Get list of available types
      const { stdout: types } = await execCommand('wl-paste', ['--list-types']);

      // Find first image type
      const imageTypeMatch = types.match(/^(image\/\w+)$/m);
      if (imageTypeMatch) {
        const mimeType = imageTypeMatch[1];
        const extension = mimeType.split('/')[1] || 'png';
        const tempFilePath = path.join(
          tempDir,
          `clipboard-${timestamp}.${extension}`,
        );

        try {
          // Use shell redirection to save binary data
          await execCommand('sh', [
            '-c',
            `wl-paste --type ${mimeType} > "${tempFilePath}"`,
          ]);

          // Verify the file was created and has content
          try {
            const stats = await fs.stat(tempFilePath);
            if (stats.size > 0) {
              return tempFilePath;
            }
          } catch {
            // File doesn't exist or is empty
          }

          // Clean up empty file
          try {
            await fs.unlink(tempFilePath);
          } catch {
            // Ignore cleanup errors
          }
        } catch {
          // Failed to save image
        }
      }
    } catch {
      // wl-paste not available
    }
  }

  return null;
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
    const tempDir = path.join(baseDir, 'clipboard');
    const files = await fs.readdir(tempDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const file of files) {
      if (
        file.startsWith('clipboard-') &&
        (file.endsWith('.png') ||
          file.endsWith('.jpg') ||
          file.endsWith('.webp') ||
          file.endsWith('.heic') ||
          file.endsWith('.heif') ||
          file.endsWith('.tiff') ||
          file.endsWith('.gif') ||
          file.endsWith('.bmp'))
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
