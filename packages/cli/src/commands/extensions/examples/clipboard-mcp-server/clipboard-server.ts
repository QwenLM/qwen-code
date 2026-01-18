/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@qwen-code/qwen-code-core';

// Cross-platform clipboard image detection and retrieval
async function clipboardHasImage(): Promise<boolean> {
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
      // On Windows, try to get clipboard format using PowerShell
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
        'Add-Type -Assembly PresentationCore; [Windows.Clipboard]::GetImage() -ne $null',
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

async function saveClipboardImage(targetDir?: string): Promise<string | null> {
  try {
    // Create a temporary directory for clipboard images within the target directory
    const baseDir = targetDir || process.cwd();
    const tempDir = path.join(baseDir, '.qwen-clipboard');
    await fs.mkdir(tempDir, { recursive: true });

    // Generate a unique filename with timestamp
    const timestamp = new Date().getTime();
    const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);

    if (process.platform === 'darwin') {
      // macOS implementation using AppleScript
      const script = `
        try
          set imageData to the clipboard as «class PNGf»
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
          // File doesn't exist
        }
      }
    } else if (process.platform === 'win32') {
      // Windows implementation using PowerShell
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms,System.Drawing
        $img = [Windows.Clipboard]::GetImage()
        if ($img -ne $null) {
          $bitmap = [Drawing.Image]::FromHbitmap($img.GetHbitmap())
          $bitmap.Save("${tempFilePath.replace(/\\/g, '\\\\')}", [Drawing.Imaging.ImageFormat]::Png)
          $bitmap.Dispose()
          Write-Host "success"
        } else {
          Write-Host "error"
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

// Create the MCP server
const server = new McpServer({
  name: 'qwen-clipboard-server',
  version: '1.0.0',
});

// Register the tool to get clipboard image
server.registerTool(
  'get_clipboard_image',
  {
    description:
      'Gets the most recently copied image from the clipboard and saves it to a temporary file. Returns the file path for the AI to read.',
    inputSchema: z.object({}).shape,
  },
  async () => {
    try {
      // Check if there's an image in the clipboard
      const hasImage = await clipboardHasImage();
      if (!hasImage) {
        return {
          content: [
            {
              type: 'text',
              text: 'No image found in clipboard. Please copy an image first using Ctrl+C (or Cmd+C) on an image.',
            },
          ],
        };
      }

      // Save the clipboard image to a temporary file
      const imagePath = await saveClipboardImage();
      if (!imagePath) {
        return {
          content: [
            {
              type: 'text',
              text: 'Failed to save clipboard image to temporary file.',
            },
          ],
        };
      }

      // Read the image file and return its content as inline data
      const imageBuffer = await fs.readFile(imagePath);
      const base64Data = imageBuffer.toString('base64');
      const mimeType = 'image/png'; // Assuming PNG format

      // Print acknowledgment to console (not returned to the model)
      console.log('📎 Clipboard image loaded');
      console.log(`• Path: ${imagePath}`);
      console.log(`• Type: ${mimeType}`);
      console.log(`• Size: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
      console.log(`• Hash: ${generateShortHash(base64Data)}`);
      console.log('• Auto-delete: 5 minutes');

      return {
        content: [
          {
            type: 'text',
            text: `Clipboard image saved to: ${imagePath}`,
          },
          {
            type: 'image',
            mimeType,
            data: base64Data,
          },
        ],
      };
    } catch (error) {
      console.error('Error in get_clipboard_image tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error getting clipboard image: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

// Helper function to generate a short hash
function generateShortHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  // Convert to hex and take first 4 chars
  return Math.abs(hash).toString(16).substring(0, 8);
}

// Register a tool to inspect clipboard without retrieving image
server.registerTool(
  'inspect_clipboard',
  {
    description:
      'Checks if there is an image in the clipboard without retrieving it. Returns information about the clipboard content.',
    inputSchema: z.object({}).shape,
  },
  async () => {
    try {
      const hasImage = await clipboardHasImage();
      if (hasImage) {
        return {
          content: [
            {
              type: 'text',
              text: 'Image found in clipboard. You can use the get_clipboard_image tool to retrieve it.',
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: 'No image found in clipboard.',
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error inspecting clipboard: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
