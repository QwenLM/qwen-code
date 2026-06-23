import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdtempSync, renameSync } from 'fs';
import { extname, basename, resolve, join, relative } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { isPathInsideOrEqual } from '@craft-agent/session-tools-core';

/**
 * Strip UTF-8 BOM (Byte Order Mark) from a string.
 * BOM (\uFEFF) can appear when files are written by certain editors or tools
 * and causes JSON.parse() to fail with "Unexpected token" errors.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * Parse a JSON string, stripping any leading UTF-8 BOM.
 * Use this instead of raw JSON.parse() for any content that may originate from a file.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(stripBom(text));
}

/**
 * Read and parse a JSON file, handling UTF-8 BOM transparently.
 * Replaces the common JSON.parse(readFileSync(path, 'utf-8')) pattern.
 */
export function readJsonFileSync<T = unknown>(filePath: string): T {
  return JSON.parse(stripBom(readFileSync(filePath, 'utf-8'))) as T;
}

/**
 * Atomically write a file by writing to a temp file then renaming.
 * This prevents partial writes from corrupting the file on crash/interrupt.
 * Uses write-to-temp-then-rename pattern which is atomic on POSIX systems.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, filePath);
  } catch (error) {
    // Clean up temp file if rename failed
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'unknown';
  path: string;
  name: string;
  mimeType: string;
  base64?: string;
  text?: string;
  size: number;
  /** Path where file is stored in session attachments folder (set by Electron app) */
  storedPath?: string;
  /** Path to converted markdown version (for office files) */
  markdownPath?: string;
}

// Supported image types for agent attachments
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.icns': 'image/x-icns',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

// Text file extensions
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.makefile',
  '.csv', '.log', '.conf', '.ini', '.cfg',
]);

// Office file extensions (will be converted to markdown via markitdown-js)
const OFFICE_EXTENSIONS: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB limit
const MAX_TEXT_SIZE = 100 * 1024; // 100KB for text files

// Conservative image limits for agent attachments.
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB hard limit
const MAX_IMAGE_DIMENSION = 8000; // 8000x8000 max pixels
const OPTIMAL_IMAGE_EDGE = 1568; // Recommended max edge for quality/cost balance (~1.15MP)

/**
 * Result of validating an image for agent compatibility
 */
export interface ImageValidationResult {
  valid: boolean;
  /** Hard error - image cannot be sent */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: 'dimension_exceeded' | 'size_exceeded';
  /** Warning - image will work but may have issues */
  warning?: string;
  /** Image needs resizing for optimal performance */
  needsResize?: boolean;
  /** Suggested new dimensions if resize needed */
  suggestedSize?: { width: number; height: number };
}

/**
 * Validate an image for agent compatibility
 * Returns validation result with errors, warnings, and resize suggestions
 *
 * @param size - File size in bytes
 * @param width - Image width in pixels (optional, for dimension checking)
 * @param height - Image height in pixels (optional, for dimension checking)
 */
export function validateImageForAgent(
  size: number,
  width?: number,
  height?: number
): ImageValidationResult {
  // Check file size first (hard limit - cannot resize to fix)
  if (size > MAX_IMAGE_SIZE) {
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      errorCode: 'size_exceeded',
      error: `Image too large (${sizeMB}MB). Limit is 5MB. Please resize or compress the image.`,
    };
  }

  // Check dimensions if provided
  if (width !== undefined && height !== undefined) {
    // Hard limit on dimensions - can be fixed by resizing
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      return {
        valid: false,
        errorCode: 'dimension_exceeded',
        error: `Image dimensions too large (${width}×${height}). Maximum is ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} pixels.`,
      };
    }

    // Check if resize is recommended for optimal performance
    const maxEdge = Math.max(width, height);
    if (maxEdge > OPTIMAL_IMAGE_EDGE) {
      const scale = OPTIMAL_IMAGE_EDGE / maxEdge;
      return {
        valid: true,
        needsResize: true,
        warning: `Large image (${width}×${height}). Will be resized to optimize tokens and latency.`,
        suggestedSize: {
          width: Math.round(width * scale),
          height: Math.round(height * scale),
        },
      };
    }
  }

  return { valid: true };
}

// Export constants for use in other modules
export const IMAGE_LIMITS = {
  MAX_SIZE: MAX_IMAGE_SIZE,
  /** Max raw file size before base64 encoding (base64 inflates by 4/3, so 5MB base64 ≈ 3.75MB raw) */
  MAX_RAW_SIZE: Math.floor(MAX_IMAGE_SIZE * 3 / 4),
  MAX_DIMENSION: MAX_IMAGE_DIMENSION,
  OPTIMAL_EDGE: OPTIMAL_IMAGE_EDGE,
  /** JPEG quality for photo-like images */
  JPEG_QUALITY_HIGH: 90,
  /** JPEG quality for fallback compression when size still exceeds limits */
  JPEG_QUALITY_FALLBACK: 75,
} as const;

/**
 * Extract file paths from input text
 * Handles:
 * - Absolute paths (/path/to/file)
 * - Home-relative paths (~/path/to/file)
 * - Quoted paths ("path with spaces")
 * - Shell-escaped paths (/path/to/file\ with\ spaces)
 * - Paths with spaces ending in .extension
 */
export function extractFilePaths(input: string): string[] {
  const paths: string[] = [];

  // Match quoted paths first (handles spaces naturally)
  const quotedRegex = /["']([^"']+)["']/g;
  let match;
  while ((match = quotedRegex.exec(input)) !== null) {
    const path = match[1];
    if (path && looksLikeFilePath(path)) {
      paths.push(path);
    }
  }

  // Match shell-escaped paths (backslash before spaces): /path/to/file\ name.ext
  const escapedRegex = /(?:^|\s)((?:\/|~\/)[^\s"']*(?:\\ [^\s"']*)+)/g;
  while ((match = escapedRegex.exec(input)) !== null) {
    let path = match[1];
    if (path) {
      // Unescape the path
      path = path.replace(/\\ /g, ' ');
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
  }

  // Try to match paths with spaces by looking for any file extension
  // This handles: /Users/test/Screenshot 2024-01-01.png
  const lines = input.split('\n');
  for (const line of lines) {
    // Look for paths that start with / or ~/ and end with any .extension
    const pathMatch = line.match(/^((?:\/|~\/)[^\n]+?)(\.[a-zA-Z0-9]{1,10})(\s|$)/);
    if (pathMatch && pathMatch[1] && pathMatch[2]) {
      const fullPath = pathMatch[1] + pathMatch[2];
      if (!paths.includes(fullPath)) {
        paths.push(fullPath);
      }
    }
  }

  // Match simple unquoted paths (no spaces, starting with / or ~)
  const unquotedRegex = /(?:^|\s)((?:\/|~\/)[^\s"']+)/g;
  while ((match = unquotedRegex.exec(input)) !== null) {
    const path = match[1];
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * Check if a string looks like a file path
 */
function looksLikeFilePath(str: string): boolean {
  // Must start with / or ~/
  if (!str.startsWith('/') && !str.startsWith('~/')) {
    return false;
  }
  // Must have some content after the prefix
  if (str.length < 2) {
    return false;
  }
  // Should have a file extension or be a directory
  return true;
}

/**
 * Resolve a path (handle ~ expansion)
 */
export function resolvePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(home, filePath.slice(2));
  }
  return resolve(filePath);
}

/**
 * Determine the type of a file based on extension
 * Falls back to 'text' for unknown extensions (will try to read as text)
 */
export function getFileType(filePath: string): 'image' | 'text' | 'pdf' | 'office' | 'unknown' {
  const ext = extname(filePath).toLowerCase();

  if (ext in IMAGE_EXTENSIONS) {
    return 'image';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext in OFFICE_EXTENSIONS) {
    return 'office';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }

  // For unknown extensions, default to 'text' - we'll try to read it as text
  // Binary files will show garbled content but at least they'll attach
  return 'text';
}

/**
 * Get MIME type for a file
 */
export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  const imageMime = IMAGE_EXTENSIONS[ext];
  if (imageMime) {
    return imageMime;
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  const officeMime = OFFICE_EXTENSIONS[ext];
  if (officeMime) {
    return officeMime;
  }

  // Default to text for known text extensions
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text/plain';
  }

  return 'application/octet-stream';
}

/**
 * Read a file and return attachment info
 */
export function readFileAttachment(filePath: string): FileAttachment | null {
  try {
    const resolved = resolvePath(filePath);

    if (!existsSync(resolved)) {
      return null;
    }

    const stats = statSync(resolved);

    if (!stats.isFile()) {
      return null;
    }

    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${basename(resolved)} (${Math.round(stats.size / 1024 / 1024)}MB > 20MB limit)`);
    }

    const type = getFileType(resolved);
    const mimeType = getMimeType(resolved);
    const name = basename(resolved);

    const attachment: FileAttachment = {
      type,
      path: resolved,
      name,
      mimeType,
      size: stats.size,
    };

    if (type === 'image') {
      // Read as base64 for images
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'text') {
      // Read as text for text files (with size limit)
      if (stats.size > MAX_TEXT_SIZE) {
        // Read only first part of large text files
        const buffer = readFileSync(resolved);
        attachment.text = buffer.toString('utf-8').slice(0, MAX_TEXT_SIZE) +
          `\n\n[File truncated - showing first ${MAX_TEXT_SIZE / 1024}KB of ${Math.round(stats.size / 1024)}KB]`;
      } else {
        attachment.text = readFileSync(resolved, 'utf-8');
      }
    } else if (type === 'pdf') {
      // Read PDF as base64
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'office') {
      // Read Office files as base64 (will be converted to markdown later)
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    }

    return attachment;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('File too large')) {
      throw error;
    }
    return null;
  }
}

/**
 * Process input text and extract any file attachments
 * Returns the cleaned text and any file attachments
 */
export function processInputWithFiles(input: string): {
  text: string;
  attachments: FileAttachment[];
  errors: string[];
} {
  const paths = extractFilePaths(input);
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];

  // Process each path
  for (const path of paths) {
    try {
      const attachment = readFileAttachment(path);
      if (attachment) {
        attachments.push(attachment);
      } else {
        // File doesn't exist - might just be text that looks like a path
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(error.message);
      }
    }
  }

  // Remove successfully attached file paths from the text
  let cleanedText = input;
  for (const attachment of attachments) {
    // Remove the path from the text (both quoted and unquoted forms)
    cleanedText = cleanedText.replace(`"${attachment.path}"`, '');
    cleanedText = cleanedText.replace(`'${attachment.path}'`, '');
    cleanedText = cleanedText.replace(attachment.path, '');

    // Also try with original path (before resolution)
    const originalPath = paths.find(p => resolvePath(p) === attachment.path);
    if (originalPath && originalPath !== attachment.path) {
      cleanedText = cleanedText.replace(`"${originalPath}"`, '');
      cleanedText = cleanedText.replace(`'${originalPath}'`, '');
      cleanedText = cleanedText.replace(originalPath, '');
    }
  }

  // Clean up extra whitespace
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

  return { text: cleanedText, attachments, errors };
}

/**
 * Read from clipboard (cross-platform)
 * Checks for: 1) File URLs (copied files), 2) Images
 * Returns FileAttachment[] - could be multiple files
 */
export function readClipboard(): FileAttachment[] {
  if (process.platform === 'darwin') {
    return readClipboardMacOS();
  } else if (process.platform === 'win32') {
    return readClipboardWindows();
  } else if (process.platform === 'linux') {
    return readClipboardLinux();
  }
  return [];
}

/**
 * Read from clipboard on macOS
 * Checks for: 1) File URLs (copied files in Finder), 2) Images
 */
function readClipboardMacOS(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // First, check for file URLs in clipboard (when files are copied in Finder)
  try {
    const scriptFile = join(tmpdir(), `craft-clipboard-files-${Date.now()}.js`);
    const jxaScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');

var pb = $.NSPasteboard.generalPasteboard;

// Check for file URLs
var fileURLs = pb.propertyListForType($.NSFilenamesPboardType);
if (fileURLs && !fileURLs.isNil()) {
  var paths = ObjC.deepUnwrap(fileURLs);
  if (Array.isArray(paths) && paths.length > 0) {
    JSON.stringify({ type: 'files', paths: paths });
  } else {
    "no_files";
  }
} else {
  "no_files";
}
`;
    writeFileSync(scriptFile, jxaScript);

    const result = execSync(`osascript -l JavaScript "${scriptFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    try { unlinkSync(scriptFile); } catch {}

    if (result !== 'no_files' && result.startsWith('{')) {
      const parsed = JSON.parse(result);
      if (parsed.type === 'files' && Array.isArray(parsed.paths)) {
        for (const filePath of parsed.paths) {
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }
    }
  } catch {
    // File URL reading failed
  }

  // If we got files, return them
  if (attachments.length > 0) {
    return attachments;
  }

  // Otherwise, check for image data in clipboard
  const imageAttachment = readClipboardImageDataMacOS();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * Read from clipboard on Windows
 * Uses PowerShell to access clipboard for files and images
 */
function readClipboardWindows(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // Check for file paths in clipboard (copied files in Explorer)
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
      if ($files.Count -gt 0) {
        $files | ConvertTo-Json -Compress
      } else {
        "no_files"
      }
    `;
    const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (result !== 'no_files' && result.length > 0) {
      try {
        // PowerShell returns single item as string, array as JSON array
        const paths = result.startsWith('[') ? JSON.parse(result) : [result.replace(/^"|"$/g, '')];
        for (const filePath of paths) {
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      } catch {
        // JSON parse failed
      }
    }
  } catch {
    // File reading failed
  }

  // If we got files, return them
  if (attachments.length > 0) {
    return attachments;
  }

  // Check for image data in clipboard
  const imageAttachment = readClipboardImageDataWindows();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * Read image data from Windows clipboard using PowerShell
 */
function readClipboardImageDataWindows(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  try {
    // PowerShell script to save clipboard image to file
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img -ne $null) {
        $img.Save("${tempFile.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
        "success"
      } else {
        "no_image"
      }
    `;
    const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (result === 'success' && existsSync(tempFile)) {
      return readImageFile(tempFile);
    }
  } catch {
    // PowerShell clipboard image extraction failed
  }

  return null;
}

/**
 * Read from clipboard on Linux
 * Uses xclip or xsel for clipboard access
 */
function readClipboardLinux(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // Check for file URIs in clipboard (GNOME/KDE file managers use this format)
  try {
    // Try xclip first (most common)
    let result: string | null = null;
    try {
      result = execSync('xclip -selection clipboard -t text/uri-list -o 2>/dev/null', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      }).trim();
    } catch {
      // xclip not available, try xsel
      try {
        result = execSync('xsel --clipboard --output 2>/dev/null', {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        }).trim();
      } catch {
        // xsel also not available
      }
    }

    if (result && result.startsWith('file://')) {
      // Parse file:// URIs
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.startsWith('file://')) {
          // Decode URI and convert to path
          const filePath = decodeURIComponent(line.replace('file://', ''));
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }
    }
  } catch {
    // File reading failed
  }

  // If we got files, return them
  if (attachments.length > 0) {
    return attachments;
  }

  // Check for image data in clipboard
  const imageAttachment = readClipboardImageDataLinux();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * Read image data from Linux clipboard using xclip
 */
function readClipboardImageDataLinux(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  // Try xclip for image/png content
  try {
    execSync(`xclip -selection clipboard -t image/png -o > "${tempFile}" 2>/dev/null`, {
      shell: '/bin/bash',
      stdio: 'pipe',
      timeout: 5000,
    });

    if (existsSync(tempFile)) {
      const stats = statSync(tempFile);
      if (stats.size > 0) {
        return readImageFile(tempFile);
      }
      // Empty file, cleanup
      try { unlinkSync(tempFile); } catch {}
    }
  } catch {
    // xclip image extraction failed
  }

  // Try wl-paste for Wayland
  try {
    execSync(`wl-paste --type image/png > "${tempFile}" 2>/dev/null`, {
      shell: '/bin/bash',
      stdio: 'pipe',
      timeout: 5000,
    });

    if (existsSync(tempFile)) {
      const stats = statSync(tempFile);
      if (stats.size > 0) {
        return readImageFile(tempFile);
      }
      // Empty file, cleanup
      try { unlinkSync(tempFile); } catch {}
    }
  } catch {
    // wl-paste failed
  }

  return null;
}

/**
 * Read image data directly from macOS clipboard (for screenshots, copied images)
 */
function readClipboardImageDataMacOS(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  // Method 1: Try pngpaste first (most reliable if installed via: brew install pngpaste)
  try {
    execSync(`pngpaste "${tempFile}" 2>/dev/null`, { stdio: 'pipe' });
    if (existsSync(tempFile)) {
      const result = readImageFile(tempFile);
      if (result) return result;
    }
  } catch {
    // pngpaste not available or failed
  }

  // Method 2: Use osascript with JXA (JavaScript for Automation)
  try {
    const scriptFile = join(tmpdir(), `craft-clipboard-script-${Date.now()}.js`);
    const jxaScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');

var pb = $.NSPasteboard.generalPasteboard;

// Try PNG first
var imgData = pb.dataForType($.NSPasteboardTypePNG);

// If no PNG, try TIFF
if (!imgData || imgData.isNil()) {
  imgData = pb.dataForType($.NSPasteboardTypeTIFF);
}

if (imgData && !imgData.isNil()) {
  var path = $.NSString.stringWithString("${tempFile}");
  var success = imgData.writeToFileAtomically(path, true);
  success ? "success" : "write_failed";
} else {
  "no_image";
}
`;
    writeFileSync(scriptFile, jxaScript);

    const result = execSync(`osascript -l JavaScript "${scriptFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    try { unlinkSync(scriptFile); } catch {}

    if (result === 'success' && existsSync(tempFile)) {
      const imageResult = readImageFile(tempFile);
      if (imageResult) return imageResult;
    }
  } catch {
    // JXA method failed
  }

  return null;
}

/**
 * Helper to read image file and create attachment
 */
function readImageFile(tempFile: string): FileAttachment | null {
  try {
    const stats = statSync(tempFile);
    const buffer = readFileSync(tempFile);
    const base64 = buffer.toString('base64');

    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }

    return {
      type: 'image',
      path: 'clipboard',
      name: `pasted-image.png`, // Renderer assigns sequential name
      mimeType: 'image/png',
      base64,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

/**
 * Format a single absolute path to relative if it's within cwd
 * @param absolutePath - The absolute path to format
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Relative path prefixed with ./ or original path if outside cwd
 */
export function formatSinglePathToRelative(absolutePath: string, cwd?: string): string {
  const basePath = resolve(cwd || process.cwd());
  const targetPath = resolve(absolutePath);
  const relativePath = relative(basePath, targetPath);

  if (relativePath && isPathInsideOrEqual(basePath, targetPath)) {
    return './' + relativePath;
  }

  return absolutePath;
}

/**
 * Format absolute file paths in text to relative paths from cwd
 * Converts paths like /Users/john/project/src/file.ts to ./src/file.ts
 *
 * @param text - Text containing file paths
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Text with absolute paths converted to relative paths
 */
export function formatPathsToRelative(text: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  // Regex to match absolute file paths
  // Matches paths starting with / followed by path segments
  // Handles paths with common file extensions and directory paths
  const absolutePathRegex = /(\/(?:Users|home|var|tmp|opt|etc)[^\s\n:,\]\})"'`]*)/g;

  return text.replace(absolutePathRegex, (match) => {
    return formatSinglePathToRelative(match, basePath);
  });
}

/**
 * Format file paths in tool input objects to relative paths
 * Handles common tool input patterns like { file_path: "..." } or { path: "..." }
 *
 * @param input - Tool input object
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns New object with paths formatted to relative
 */
export function formatToolInputPaths(
  input: Record<string, unknown> | undefined,
  cwd?: string
): Record<string, unknown> | undefined {
  if (!input) return input;

  const result: Record<string, unknown> = {};
  const pathKeys = ['file_path', 'path', 'directory', 'folder', 'source', 'destination', 'target'];

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && pathKeys.includes(key) && value.startsWith('/')) {
      result[key] = formatSinglePathToRelative(value, cwd);
    } else if (typeof value === 'string') {
      // Also format paths embedded in string values
      result[key] = formatPathsToRelative(value, cwd);
    } else {
      result[key] = value;
    }
  }

  return result;
}
