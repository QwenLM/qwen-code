/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createWriteStream, type Stats } from 'node:fs';
import { Buffer } from 'node:buffer';
import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  runLogger,
  spawnAsync,
  escapePath,
  Storage,
} from '@qwen-code/core';
import {
  hasNativeMacOSClipboardImage,
  readNativeMacOSClipboardImage,
} from './macosClipboardImage.js';

/**
 * Supported image file extensions based on Gemini API.
 * See: https://ai.google.dev/gemini-api/docs/image-understanding
 */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.heic',
  '.heif',
];

/** Matches strings that start with a path prefix (/, ~, ., Windows drive letter, or UNC path) */
const PATH_PREFIX_PATTERN = /^([/~.]|[a-zA-Z]:|\\\\)/;

type LinuxClipboardImageTool = 'wl-paste' | 'xclip';
type LinuxClipboardTextTool = LinuxClipboardImageTool | 'xsel';

// Cache the discovered Linux clipboard tools to avoid re-running `command -v`
// on every paste. Only a *successful* discovery is cached: a negative result is
// not memoized so a tool installed mid-session is picked up without a restart.
// The `warned*` flags keep the not-found warning from spamming the log on each
// re-probe.
let linuxClipboardTool: LinuxClipboardImageTool | undefined = undefined;
let linuxClipboardTextTool: LinuxClipboardTextTool | undefined = undefined;
let warnedNoClipboardImageTool = false;
let warnedNoClipboardTextTool = false;

const windowsPowerShellClipboardArgs = (script: string) => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-STA',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
];

// Helper to check the user's display server and whether they have a compatible clipboard tool installed.
// When XDG_SESSION_TYPE is unset (some desktop environments), try both tools as fallback.
function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getUserLinuxClipboardTool(): LinuxClipboardImageTool | null {
  if (linuxClipboardTool !== undefined) {
    return linuxClipboardTool;
  }

  const displayServer = process.env['XDG_SESSION_TYPE'];

  // Preferred tool based on display server
  const candidates: LinuxClipboardImageTool[] =
    displayServer === 'wayland'
      ? ['wl-paste', 'xclip']
      : displayServer === 'x11'
        ? ['xclip', 'wl-paste']
        : // XDG_SESSION_TYPE not set — try both (xclip first as more widely available)
          ['xclip', 'wl-paste'];

  for (const toolName of candidates) {
    if (commandExists(toolName)) {
      linuxClipboardTool = toolName;
      return toolName;
    }
  }

  if (!warnedNoClipboardImageTool) {
    warnedNoClipboardImageTool = true;
    runLogger.warn(
      'No Linux clipboard image tool found. Please install xclip or wl-clipboard.',
    );
  }
  return null;
}

function getUserLinuxClipboardTextTool(): LinuxClipboardTextTool | null {
  if (linuxClipboardTextTool !== undefined) {
    return linuxClipboardTextTool;
  }

  const displayServer = process.env['XDG_SESSION_TYPE'];
  const candidates: LinuxClipboardTextTool[] =
    displayServer === 'wayland'
      ? ['wl-paste', 'xclip', 'xsel']
      : displayServer === 'x11'
        ? ['xclip', 'xsel', 'wl-paste']
        : ['xclip', 'xsel', 'wl-paste'];

  for (const toolName of candidates) {
    if (commandExists(toolName)) {
      linuxClipboardTextTool = toolName;
      return toolName;
    }
  }

  if (!warnedNoClipboardTextTool) {
    warnedNoClipboardTextTool = true;
    runLogger.warn(
      'No Linux clipboard text tool found. Please install xclip, wl-clipboard, or xsel.',
    );
  }
  return null;
}

/**
 * Helper to save command stdout to a file while preventing shell injections and race conditions
 */
async function saveFromCommand(
  command: string,
  args: string[],
  destination: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    const fileStream = createWriteStream(destination);
    let resolved = false;

    const safeResolve = (value: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    child.stdout.pipe(fileStream);

    child.on('error', (err) => {
      runLogger.debug(`Failed to spawn ${command}:`, err);
      safeResolve(false);
    });

    fileStream.on('error', (err) => {
      runLogger.debug(`File stream error for ${destination}:`, err);
      safeResolve(false);
    });

    child.on('close', async (code) => {
      if (resolved) return;

      if (code !== 0) {
        runLogger.debug(
          `${command} exited with code ${code}. Args: ${args.join(' ')}`,
        );
        safeResolve(false);
        return;
      }

      // Helper to check file size
      const checkFile = async () => {
        try {
          const stats = await fs.stat(destination);
          safeResolve(stats.size > 0);
        } catch (e) {
          runLogger.debug(`Failed to stat output file ${destination}:`, e);
          safeResolve(false);
        }
      };

      if (fileStream.writableFinished) {
        await checkFile();
      } else {
        fileStream.on('finish', checkFile);
        // In case finish never fires due to error (though error handler should catch it)
        fileStream.on('close', async () => {
          if (!resolved) await checkFile();
        });
      }
    });
  });
}

/**
 * Checks if the Wayland clipboard contains an image using wl-paste.
 */
async function checkWlPasteForImage() {
  try {
    const { stdout } = await spawnAsync('wl-paste', ['--list-types']);
    return stdout.includes('image/');
  } catch (e) {
    runLogger.warn('Error checking wl-clipboard for image:', e);
  }
  return false;
}

/**
 * Checks if the X11 clipboard contains an image using xclip.
 */
async function checkXclipForImage() {
  try {
    const { stdout } = await spawnAsync('xclip', [
      '-selection',
      'clipboard',
      '-t',
      'TARGETS',
      '-o',
    ]);
    return stdout.includes('image/');
  } catch (e) {
    runLogger.warn('Error checking xclip for image:', e);
  }
  return false;
}

/**
 * Checks if the system clipboard contains an image (macOS, Windows, and Linux)
 * @returns true if clipboard contains an image
 */
export async function clipboardHasImage(): Promise<boolean> {
  if (process.platform === 'linux') {
    const tool = getUserLinuxClipboardTool();
    if (tool === 'wl-paste') {
      if (await checkWlPasteForImage()) return true;
    } else if (tool === 'xclip') {
      if (await checkXclipForImage()) return true;
    }
    return false;
  }

  if (process.platform === 'win32') {
    try {
      // `Get-Clipboard -Format Image` only recognises images that round-trip
      // through GDI+'s Image type — apps that copy DIB/HBITMAP (e.g. some
      // browsers, screenshot tools) leave it as $null. Fall back to
      // `[Forms.Clipboard]::ContainsImage()` and then raw PNG/JPEG/GIF
      // clipboard formats used by browsers and screenshot tools. Run in STA:
      // Windows Forms clipboard APIs require a single-threaded apartment.
      const { stdout } = await spawnAsync(
        'powershell',
        windowsPowerShellClipboardArgs(`
          $ErrorActionPreference = 'SilentlyContinue'
          $hasImage = $false

          if (Get-Command Get-Clipboard -ErrorAction SilentlyContinue) {
            $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue
            if ($img) { $hasImage = $true }
          }

          if (-not $hasImage) {
            Add-Type -AssemblyName System.Windows.Forms
            if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
              $hasImage = $true
            }
          }

          if (-not $hasImage) {
            Add-Type -AssemblyName System.Windows.Forms
            $data = [System.Windows.Forms.Clipboard]::GetDataObject()
            if ($data) {
              foreach ($format in @('PNG', 'image/png', 'JFIF', 'JPEG', 'image/jpeg', 'GIF', 'image/gif')) {
                if ($data.GetDataPresent($format, $false)) {
                  $hasImage = $true
                  break
                }
              }

              if (-not $hasImage -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
                $files = $data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
                foreach ($file in $files) {
                  if ($file -match '\\.(png|jpe?g|gif|bmp)$') {
                    $hasImage = $true
                    break
                  }
                }
              }
            }
          }

          if ($hasImage) { 'True' } else { 'False' }
        `),
      );
      return stdout.trim() === 'True';
    } catch (error) {
      runLogger.warn('Error checking clipboard for image:', error);
      return false;
    }
  }

  if (process.platform !== 'darwin') {
    return false;
  }

  const nativeResult = hasNativeMacOSClipboardImage();
  if (nativeResult !== undefined) {
    return nativeResult;
  }

  try {
    // Use osascript to check clipboard type
    const { stdout } = await spawnAsync('osascript', ['-e', 'clipboard info']);
    const imageRegex =
      /«class PNGf»|TIFF picture|JPEG picture|GIF picture|«class JPEG»|«class TIFF»/;
    return imageRegex.test(stdout);
  } catch (error) {
    runLogger.warn('Error checking clipboard for image:', error);
    return false;
  }
}

/**
 * Cross-platform clipboard text reader.
 *
 * On Windows, uses PowerShell directly (see `readClipboardTextWindows`).
 * On Linux, uses explicit clipboard tools to avoid bundled fallback issues.
 * On other platforms, uses the `clipboardy` library.
 *
 * Returns the clipboard text on success, or `null` on failure.
 */
export async function readClipboardText(): Promise<string | null> {
  if (process.platform === 'win32') {
    return readClipboardTextWindows();
  }
  if (process.platform === 'linux') {
    return readClipboardTextLinux();
  }
  try {
    const clipboardy = await import('clipboardy');
    return await clipboardy.default.read();
  } catch (error) {
    runLogger.warn('Error reading clipboard text:', error);
    return null;
  }
}

/**
 * Reads clipboard text on Linux using explicit system tools.
 *
 * Avoids clipboardy's bundled `xsel` fallback path, which is not always present
 * after single-executable / bundled packaging and produces a confusing error.
 */
export async function readClipboardTextLinux(): Promise<string | null> {
  const tool = getUserLinuxClipboardTextTool();
  if (!tool) {
    return null;
  }

  try {
    if (tool === 'wl-paste') {
      // `--no-newline` suppresses the trailing newline wl-paste appends by
      // default; without it pasted text/paths gain a spurious '\n' that the
      // xclip/xsel branches below do not add.
      const { stdout } = await spawnAsync('wl-paste', ['--no-newline']);
      return stdout;
    }

    if (tool === 'xclip') {
      const { stdout } = await spawnAsync('xclip', [
        '-selection',
        'clipboard',
        '-o',
      ]);
      return stdout;
    }

    const { stdout } = await spawnAsync('xsel', [
      '--clipboard',
      '--output',
    ]);
    return stdout;
  } catch (error) {
    runLogger.warn(`Error reading clipboard text via ${tool}:`, error);
    return null;
  }
}

/**
 * Reads clipboard text on Windows via PowerShell (no native binary required).
 *
 * Avoids the `clipboardy` library on Windows because it ships a native
 * fallback exe (`fallbacks/windows/clipboard_*.exe`) that bun's
 * `--compile` step does not embed — once PowerShell encounters any
 * transient error, clipboardy throws "PowerShell clipboard operation
 * failed and the bundled fallback binary was not found", masking the
 * underlying cause and leaving the user with no working paste path.
 *
 * Returns the clipboard text on success, or `null` if PowerShell is
 * unavailable / fails. Empty string is a valid result.
 */
export async function readClipboardTextWindows(): Promise<string | null> {
  try {
    const { stdout } = await spawnAsync(
      'powershell',
      windowsPowerShellClipboardArgs(
        // -Raw preserves embedded newlines as-is; without it Get-Clipboard
        // emits a string array. SilentlyContinue lets us treat
        // an empty / non-text clipboard via the fallback to "".
        '$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($null -eq $t) { "" } else { [Console]::Out.Write($t) }',
      ),
      { timeout: 2000 },
    );
    return stdout;
  } catch (error) {
    runLogger.warn('Error reading clipboard text via PowerShell:', error);
    return null;
  }
}

/**
 * Saves clipboard content to a file using wl-paste (Wayland).
 * Tries PNG first, then falls back to BMP and JPEG formats.
 */
async function saveFileWithWlPaste(tempFilePath: string) {
  // Try formats in order: PNG (preferred), BMP (Windows/WSL2 common), JPEG
  const formats = ['image/png', 'image/bmp', 'image/jpeg'];
  for (const mimeType of formats) {
    const success = await saveFromCommand(
      'wl-paste',
      ['--no-newline', '--type', mimeType],
      tempFilePath,
    );
    if (success) {
      return true;
    }
  }
  // Cleanup on failure
  try {
    await fs.unlink(tempFilePath);
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Saves clipboard content to a file using xclip (X11).
 * Tries PNG first, then falls back to BMP and JPEG formats.
 */
const saveFileWithXclip = async (tempFilePath: string) => {
  // Try formats in order: PNG (preferred), BMP (Windows/WSL2 common), JPEG
  const formats = ['image/png', 'image/bmp', 'image/jpeg'];
  for (const mimeType of formats) {
    const success = await saveFromCommand(
      'xclip',
      ['-selection', 'clipboard', '-t', mimeType, '-o'],
      tempFilePath,
    );
    if (success) {
      return true;
    }
  }
  // Cleanup on failure
  try {
    await fs.unlink(tempFilePath);
  } catch {
    /* ignore */
  }
  return false;
};

/**
 * Gets the directory where clipboard images should be stored for a specific project.
 *
 * This uses the global temporary directory but creates a project-specific subdirectory
 * based on the hash of the project path (via `Storage.getProjectTempDir()`).
 * This prevents path conflicts between different projects while keeping the images
 * outside of the user's project directory.
 *
 * @param targetDir The root directory of the current project.
 * @returns The absolute path to the images directory.
 */
async function getProjectClipboardImagesDir(
  targetDir: string,
): Promise<string> {
  const storage = new Storage(targetDir);
  await storage.initialize();
  const baseDir = storage.getProjectTempDir();
  return path.join(baseDir, 'images');
}

/**
 * Saves the image from clipboard to a temporary file (macOS, Windows, and Linux)
 * @param targetDir The target directory to create temp files within
 * @returns The path to the saved image file, or null if no image or error
 */
export async function saveClipboardImage(
  targetDir: string,
): Promise<string | null> {
  try {
    const tempDir = await getProjectClipboardImagesDir(targetDir);
    await fs.mkdir(tempDir, { recursive: true });

    // Generate a unique filename with timestamp
    const timestamp = new Date().getTime();

    if (process.platform === 'linux') {
      const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);
      const tool = getUserLinuxClipboardTool();

      if (tool === 'wl-paste') {
        if (await saveFileWithWlPaste(tempFilePath)) return tempFilePath;
        return null;
      }
      if (tool === 'xclip') {
        if (await saveFileWithXclip(tempFilePath)) return tempFilePath;
        return null;
      }
      return null;
    }

    if (process.platform === 'win32') {
      const tempFilePath = path.join(tempDir, `clipboard-${timestamp}.png`);
      // The path is used directly in the PowerShell script.
      const psPath = tempFilePath.replace(/'/g, "''");

      // Combined script: check + save in one PowerShell process to avoid
      // double Add-Type cold start. Try Get-Clipboard cmdlet (PS 5.1+
      // built-in) first, then fall back to Windows Forms and raw formats.
      const script = `
        $ErrorActionPreference = 'Stop'
        $lastFailureStage = ''
        $lastFailureMessage = ''

        function Set-ClipboardImageSaveFailure([string]$stageName, $errorRecord) {
          $script:lastFailureStage = $stageName
          if ($null -ne $errorRecord -and $null -ne $errorRecord.Exception) {
            $message = $errorRecord.Exception.Message
            $script:lastFailureMessage = $message.Replace([char]13, ' ').Replace([char]10, ' ')
          } else {
            $script:lastFailureMessage = ''
          }
        }

        function Write-ClipboardImageSaveFailure([string]$stageName) {
          if ([string]::IsNullOrEmpty($script:lastFailureStage)) {
            $script:lastFailureStage = $stageName
          }
          Write-Output ("image-save-error:" + $script:lastFailureStage + ":" + $script:lastFailureMessage)
        }

        try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop

        function Save-ImageObject($image, [string]$path) {
          if ($null -eq $image) { return $false }
          try {
            $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
            return $true
          } catch {
            Set-ClipboardImageSaveFailure 'save-image-object' $_
            return $false
          } finally {
            if ($image -is [System.IDisposable]) { $image.Dispose() }
          }
        }

        function Get-ClipboardBytes($data) {
          if ($null -eq $data) { return $null }
          if ($data -is [byte[]]) { return ,$data }
          if ($data -is [System.IO.MemoryStream]) { return ,$data.ToArray() }
          if ($data -is [System.IO.Stream]) {
            $memory = New-Object System.IO.MemoryStream
            try {
              $data.CopyTo($memory)
              return ,$memory.ToArray()
            } finally {
              $memory.Dispose()
            }
          }
          return $null
        }

        function Save-EncodedImageData($data, [string]$path) {
          try {
            $rawBytes = Get-ClipboardBytes $data
          } catch {
            Set-ClipboardImageSaveFailure 'read-encoded-image-data' $_
            return $false
          }
          if ($null -eq $rawBytes) { return $false }

          $bytes = [byte[]]$rawBytes
          if ($bytes.Length -eq 0) { return $false }

          try {
            $memory = [System.IO.MemoryStream]::new($bytes)
            try {
              $image = [System.Drawing.Image]::FromStream($memory)
              return (Save-ImageObject $image $path)
            } finally {
              $memory.Dispose()
            }
          } catch {
            $isPng = $bytes.Length -ge 8 -and
              $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and
              $bytes[2] -eq 78 -and $bytes[3] -eq 71
            if ($isPng) {
              try {
                [System.IO.File]::WriteAllBytes($path, $bytes)
                return $true
              } catch {
                Set-ClipboardImageSaveFailure 'write-raw-png-bytes' $_
                return $false
              }
            }
            Set-ClipboardImageSaveFailure 'decode-encoded-image-data' $_
            return $false
          }
        }

        $saved = $false
        if (Get-Command Get-Clipboard -ErrorAction SilentlyContinue) {
          try {
            $img = Get-Clipboard -Format Image -ErrorAction Stop
            $saved = Save-ImageObject $img '${psPath}'
          } catch {
            Set-ClipboardImageSaveFailure 'get-clipboard-image' $_
          }
        }
        if (-not $saved) {
          try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
              $image = [System.Windows.Forms.Clipboard]::GetImage()
              $saved = Save-ImageObject $image '${psPath}'
            }
          } catch {
            Set-ClipboardImageSaveFailure 'windows-forms-image' $_
          }
        }
        if (-not $saved) {
          try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $data = [System.Windows.Forms.Clipboard]::GetDataObject()
            if ($data) {
              foreach ($format in @('PNG', 'image/png', 'JFIF', 'JPEG', 'image/jpeg', 'GIF', 'image/gif')) {
                if ($data.GetDataPresent($format, $false)) {
                  $saved = Save-EncodedImageData ($data.GetData($format, $false)) '${psPath}'
                  if ($saved) { break }
                }
              }

              if (-not $saved -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
                $files = $data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
                foreach ($file in $files) {
                  if ($file -match '\\.(png|jpe?g|gif|bmp)$') {
                    try {
                      $image = [System.Drawing.Image]::FromFile($file)
                      $saved = Save-ImageObject $image '${psPath}'
                      if ($saved) { break }
                    } catch {
                      Set-ClipboardImageSaveFailure 'file-drop-image' $_
                    }
                  }
                }
              }
            }
          } catch {
            Set-ClipboardImageSaveFailure 'raw-clipboard-data' $_
          }
        }
        if ($saved) {
          Write-Output "success"
        } else {
          Write-ClipboardImageSaveFailure 'no-supported-image-format'
        }
        exit 0
        } catch {
          Set-ClipboardImageSaveFailure 'top-level' $_
          Write-ClipboardImageSaveFailure 'top-level'
          exit 0
        }
      `;

      const { stdout } = await spawnAsync(
        'powershell',
        windowsPowerShellClipboardArgs(script),
      );

      const clipboardSaveResult =
        stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .pop() ?? '';

      if (clipboardSaveResult === 'success') {
        try {
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            return tempFilePath;
          }
        } catch {
          // File doesn't exist
        }
      }

      runLogger.warn(
        'Windows clipboard image save failed:',
        clipboardSaveResult || '<empty PowerShell output>',
      );
      return null;
    }

    const nativeImage = await readNativeMacOSClipboardImage();
    if (nativeImage) {
      const tempFilePath = path.join(
        tempDir,
        `clipboard-${timestamp}.png`,
      );
      await fs.writeFile(tempFilePath, nativeImage);
      return tempFilePath;
    }
    if (nativeImage === null) {
      return null;
    }

    // AppleScript clipboard classes to try, in order of preference. This is a
    // compatibility fallback when the native module cannot load or read data.
    // macOS converts clipboard images to these formats (WEBP/HEIC/HEIF not supported by osascript).
    const formats = [
      { class: 'PNGf', extension: 'png' },
      { class: 'JPEG', extension: 'jpg' },
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

      const { stdout } = await spawnAsync('osascript', ['-e', script]);

      if (stdout.trim() === 'success') {
        // Verify the file was created and has content
        try {
          const stats = await fs.stat(tempFilePath);
          if (stats.size > 0) {
            return tempFilePath;
          }
        } catch (e) {
          // File doesn't exist, continue to next format
          runLogger.debug('Clipboard image file not found:', tempFilePath, e);
        }
      }

      // Clean up failed attempt
      try {
        await fs.unlink(tempFilePath);
      } catch (e) {
        // Ignore cleanup errors
        runLogger.debug('Failed to clean up temp file:', tempFilePath, e);
      }
    }

    // No format worked
    return null;
  } catch (error) {
    runLogger.warn('Error saving clipboard image:', error);
    return null;
  }
}

/**
 * Cleans up old temporary clipboard image files
 * Removes files older than 1 hour
 * @param targetDir The target directory where temp files are stored
 */
export async function cleanupOldClipboardImages(
  targetDir: string,
): Promise<void> {
  try {
    const tempDir = await getProjectClipboardImagesDir(targetDir);
    const files = await fs.readdir(tempDir);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (file.startsWith('clipboard-') && IMAGE_EXTENSIONS.includes(ext)) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < oneHourAgo) {
          await fs.unlink(filePath);
        }
      }
    }
  } catch (e) {
    // Ignore errors in cleanup
    runLogger.debug('Failed to clean up old clipboard images:', e);
  }
}
/**
 * Splits a pasted text block up into escaped path segements if it's a legal
 * drag-and-drop string.
 *
 * There are multiple ways drag-and-drop paths might be escaped:
 *  - Bare (only if there are no special chars): /path/to/myfile.png
 *  - Wrapped in double quotes (Windows only): "/path/to/my file~!.png"
 *  - Escaped with backslashes (POSIX only): /path/to/my\ file~!.png
 *  - Wrapped in single quotes: '/path/to/my file~!.png'
 *
 * When wrapped in single quotes, actual single quotes in the filename are
 * escaped with "'\''". For example: '/path/to/my '\''fancy file'\''.png'
 *
 * When wrapped in double quotes, actual double quotes are not an issue becuase
 * windows doesn't allow them in filenames.
 *
 * On all systems, a single drag-and-drop may include both wrapped and bare
 * paths, so we need to handle both simultaneously.
 *
 * @param text
 * @returns An iterable of escaped paths
 */
export function* splitDragAndDropPaths(text: string): Generator<string> {
  let current = '';
  let mode: 'NORMAL' | 'DOUBLE' | 'SINGLE' = 'NORMAL';
  const isWindows = process.platform === 'win32';

  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (mode === 'NORMAL') {
      if (char === ' ') {
        if (current.length > 0) {
          yield current;
          current = '';
        }
      } else if (char === '"') {
        mode = 'DOUBLE';
      } else if (char === "'") {
        mode = 'SINGLE';
      } else if (char === '\\' && !isWindows) {
        // POSIX escape in normal mode
        if (i + 1 < text.length) {
          const next = text[i + 1];
          current += next;
          i++;
        }
      } else {
        current += char;
      }
    } else if (mode === 'DOUBLE') {
      if (char === '"') {
        mode = 'NORMAL';
      } else {
        current += char;
      }
    } else if (mode === 'SINGLE') {
      if (char === "'") {
        mode = 'NORMAL';
      } else {
        current += char;
      }
    }

    i++;
  }

  if (current.length > 0) {
    yield current;
  }
}

/**
 * Upper bound for a single `stat` of a pasted path.
 *
 * Drag & drop paths can point at network shares (SMB/UNC, Windows mapped
 * drives, FUSE mounts). Those can take tens of seconds — or hang forever on a
 * stale handle — so every probe is bounded and a timeout is treated as "not a
 * usable file path", which degrades to inserting the pasted text verbatim.
 */
const PASTED_PATH_STAT_TIMEOUT_MS = 2000;

/**
 * Purely syntactic screen for "this paste might be file paths".
 *
 * Does not touch the filesystem, so it is safe to call synchronously from a
 * keypress handler. Callers use it to decide whether the (asynchronous)
 * validation below is worth scheduling at all.
 */
export function mayContainPastedFilePaths(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (PATH_PREFIX_PATTERN.test(trimmed)) return true;
  for (const segment of splitDragAndDropPaths(trimmed)) {
    if (PATH_PREFIX_PATTERN.test(segment)) return true;
  }
  return false;
}

/**
 * `fs.stat` bounded by {@link PASTED_PATH_STAT_TIMEOUT_MS}.
 *
 * The timeout does not cancel the underlying syscall (Node has no API for
 * that), it only stops the caller from waiting on an unresponsive mount.
 */
async function statPastedPath(p: string): Promise<Stats | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fs.stat(p),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`stat timed out after ${PASTED_PATH_STAT_TIMEOUT_MS}ms`)),
          PASTED_PATH_STAT_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validates that a path exists and is a file, without blocking the event loop.
 */
async function isValidFilePath(p: string): Promise<boolean> {
  if (!PATH_PREFIX_PATTERN.test(p)) return false;
  const stats = await statPastedPath(p);
  return stats?.isFile() ?? false;
}

/**
 * Checks whether a pasted segment syntactically looks like an image path that
 * the paste pipeline can consume in place (as PastedContent).
 *
 * This intentionally does not touch the filesystem. Existence and readability
 * are resolved by the asynchronous image pipeline behind the placeholder.
 */
export function isImageFilePath(p: string): boolean {
  if (!PATH_PREFIX_PATTERN.test(p)) return false;
  const ext = path.extname(p).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Groups unescaped words after a path prefix into the same candidate. This
 * preserves the useful single-path-with-spaces case while still recognizing
 * a new dragged path whenever another path prefix appears.
 */
function collectPastedPathCandidates(text: string): string[] | null {
  const segments = [...splitDragAndDropPaths(text)];
  const candidates: string[] = [];
  let current = '';

  for (const segment of segments) {
    if (PATH_PREFIX_PATTERN.test(segment)) {
      if (current) candidates.push(current);
      current = segment;
    } else if (current) {
      current += ` ${segment}`;
    } else {
      return null;
    }
  }

  if (current) candidates.push(current);
  return candidates.length > 0 ? candidates : null;
}

/**
 * Splits pasted text (drag & drop / copied file paths) into image paths and
 * non-image segments.
 *
 * Returns null when the text is not syntactically a pure path paste or contains
 * no image. Image paths are consumed in place by the asynchronous image
 * pipeline; non-image paths keep the @-mention rewrite behavior.
 */
export function extractPastedImagePaths(
  text: string,
): { imagePaths: string[]; otherPaths: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const splitSegments = [...splitDragAndDropPaths(trimmed)];
  const hasAnotherPathPrefix = splitSegments
    .slice(1)
    .some((segment) => PATH_PREFIX_PATTERN.test(segment));

  // Single path fast-path. Besides preserving unescaped spaces, this keeps
  // Windows separators intact when a Windows path is pasted on another OS.
  if (!hasAnotherPathPrefix && isImageFilePath(trimmed)) {
    return { imagePaths: [trimmed], otherPaths: [] };
  }

  const candidates = collectPastedPathCandidates(trimmed);
  if (!candidates) return null;

  const imagePaths: string[] = [];
  const otherPaths: string[] = [];
  for (const candidate of candidates) {
    if (isImageFilePath(candidate)) {
      imagePaths.push(candidate);
    } else {
      otherPaths.push(candidate);
    }
  }
  if (imagePaths.length === 0) return null;
  return { imagePaths, otherPaths };
}

/**
 * Processes pasted text containing file paths (like those from drag and drop),
 * adding @ prefix to valid paths and escaping them in a standard way.
 *
 * Asynchronous on purpose: never call the filesystem from the keypress path.
 *
 * @param text The pasted text
 * @returns Processed string with @ prefixes or null if any paths are invalid
 */
export async function parsePastedPaths(text: string): Promise<string | null> {
  // First, check if the entire text is a single valid path
  if (await isValidFilePath(text)) {
    return `@${escapePath(text)} `;
  }

  const validPaths = [];
  for (const segment of splitDragAndDropPaths(text)) {
    if (await isValidFilePath(segment)) {
      validPaths.push(`@${escapePath(segment)}`);
    } else {
      return null; // If any segment is invalid, return null for the whole string
    }
  }
  if (validPaths.length === 0) {
    return null;
  }
  return validPaths.join(' ') + ' ';
}
