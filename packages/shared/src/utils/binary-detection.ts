/**
 * Binary Detection & File Saving Utilities
 *
 * Shared binary content detection used by guardLargeResult() to handle
 * binary data across all tool result paths (API tools, MCP tools, backend adapters).
 *
 * Extracted from api-tools.ts for centralized use.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================
// Constants
// ============================================================

/** Maximum file size for binary downloads (500MB) — prevents OOM */
export const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024;

/**
 * Magic bytes (file signatures) for common binary formats.
 * Used to detect file type when MIME type is unknown or generic.
 */
const MAGIC_SIGNATURES: Array<{ bytes: number[]; ext: string }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46], ext: '.pdf' },           // %PDF
  { bytes: [0x89, 0x50, 0x4E, 0x47], ext: '.png' },           // .PNG
  { bytes: [0xFF, 0xD8, 0xFF], ext: '.jpg' },                  // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: '.gif' },           // GIF8
  { bytes: [0x50, 0x4B, 0x03, 0x04], ext: '.zip' },           // PK.. (also docx, xlsx, pptx)
  { bytes: [0x52, 0x61, 0x72, 0x21], ext: '.rar' },           // Rar!
  { bytes: [0x1F, 0x8B], ext: '.gz' },                         // gzip
  { bytes: [0x42, 0x4D], ext: '.bmp' },                        // BM
  { bytes: [0x49, 0x44, 0x33], ext: '.mp3' },                  // ID3 (MP3 with ID3 tag)
  { bytes: [0xFF, 0xFB], ext: '.mp3' },                        // MP3 frame sync
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: '.wav' },           // RIFF (WAV container)
  { bytes: [0x4F, 0x67, 0x67, 0x53], ext: '.ogg' },           // OggS
  { bytes: [0x66, 0x4C, 0x61, 0x43], ext: '.flac' },          // fLaC
];

/**
 * MIME type to file extension mapping for binary downloads.
 */
export const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/octet-stream': '.bin',
};

// ============================================================
// Detection Functions
// ============================================================

/**
 * Inspect buffer contents to detect binary data.
 * Checks for null bytes and high ratio of non-printable characters.
 *
 * UTF-8 handling: We skip ALL bytes >= 0x80 (multibyte sequences) to avoid
 * misclassifying international text (accented chars, emojis, CJK) as binary.
 * Only ASCII bytes (0x00-0x7F) are analyzed for printability.
 */
export function looksLikeBinary(buffer: Buffer): boolean {
  // Check first 8KB for binary indicators
  const sample = buffer.slice(0, 8192);

  // Null bytes are a dead giveaway for binary
  if (sample.includes(0x00)) return true;

  // Count non-printable ASCII characters (skip UTF-8 multibyte entirely)
  let nonPrintable = 0;
  let asciiCount = 0;
  for (const byte of sample) {
    // Skip UTF-8 multibyte sequences (both leading and continuation bytes)
    if (byte >= 0x80) continue;

    asciiCount++;
    // Check if ASCII byte is non-printable (excluding common whitespace)
    if (byte < 0x09 || (byte > 0x0D && byte < 0x20)) {
      nonPrintable++;
    }
  }

  // If >10% of ASCII bytes are non-printable, likely binary
  return asciiCount > 0 && (nonPrintable / asciiCount) > 0.10;
}

/**
 * Detect file extension from magic bytes (file signature).
 * Inspects first bytes of buffer to identify common file formats.
 * Returns extension with dot (e.g., '.pdf') or empty string if unknown.
 */
export function detectExtensionFromMagic(buffer: Buffer): string {
  if (buffer.length < 8) return '';

  for (const sig of MAGIC_SIGNATURES) {
    if (sig.bytes.every((byte, i) => buffer[i] === byte)) {
      return sig.ext;
    }
  }
  return '';
}

/**
 * Get file extension from MIME type, with optional magic byte fallback.
 */
export function getMimeExtension(mimeType: string | null, buffer?: Buffer): string {
  if (mimeType) {
    const normalized = (mimeType.toLowerCase().split(';')[0] ?? '').trim();
    const ext = MIME_TO_EXT[normalized];
    if (ext && ext !== '.bin') return ext;
  }

  if (buffer) {
    return detectExtensionFromMagic(buffer);
  }

  return '';
}

// ============================================================
// Inline Base64 Detection
// ============================================================

/** Minimum base64 payload length to consider (avoids short tokens, API keys, JWTs) */
const MIN_BASE64_LENGTH = 256;

/** Minimum decoded size in bytes to consider as meaningful binary */
const MIN_DECODED_SIZE = 128;

/** MIME types that are inherently binary (skip looksLikeBinary verification on decoded bytes) */
const BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf', 'application/zip', 'application/gzip', 'application/octet-stream'];

/** Data URL regex: data:<mime>;base64,<payload> */
const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Result of extracting base64-encoded binary from a string.
 */
export interface Base64ExtractionResult {
  buffer: Buffer;
  mimeType: string | null;
  /** File extension (with dot) derived from MIME or magic bytes */
  ext: string;
  source: 'data-url' | 'raw-base64';
}

/**
 * Check if a MIME type is inherently binary (no need to verify decoded bytes).
 */
function isBinaryMime(mime: string): boolean {
  const normalized = mime.toLowerCase().trim();
  return BINARY_MIME_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Try to extract base64-encoded binary content from a text string.
 *
 * Handles two forms:
 * 1. Data URLs: `data:<mime>;base64,<payload>`
 * 2. Raw base64 blobs: long strings of base64 characters
 *
 * Two-step verification to minimize false positives:
 * - Charset + structure check (is it plausibly base64?)
 * - Decode + binary verification (are the decoded bytes actually binary?)
 *
 * Returns null if the string doesn't contain extractable base64 binary.
 */
export function extractBase64Binary(text: string): Base64ExtractionResult | null {
  const trimmed = text.trim();

  // --- Path A: Data URL ---
  const dataUrlMatch = trimmed.match(DATA_URL_RE);
  if (dataUrlMatch) {
    const mime = dataUrlMatch[1]!;
    const payload = dataUrlMatch[2]!;
    if (payload.length < MIN_BASE64_LENGTH) return null;

    try {
      const decoded = Buffer.from(payload, 'base64');
      if (decoded.length < MIN_DECODED_SIZE) return null;

      // For known binary MIME types, trust the MIME — skip looksLikeBinary check
      if (!isBinaryMime(mime) && !looksLikeBinary(decoded)) return null;

      const ext = getMimeExtension(mime, decoded) || '.bin';
      return { buffer: decoded, mimeType: mime, ext, source: 'data-url' };
    } catch {
      return null;
    }
  }

  // --- Path B: Raw base64 blob ---
  // Strict canonicalization pipeline — rejects anything that isn't structurally
  // valid base64. Eliminates false positives from Node's lenient Buffer.from().
  if (trimmed.length < MIN_BASE64_LENGTH) return null;

  // Quick reject: structured data delimiters
  const firstChar = trimmed.charCodeAt(0);
  if (firstChar === 0x7B || firstChar === 0x5B || firstChar === 0x3C) return null; // { [ <

  // Step 1: Strip only CR/LF (standard base64 line wrapping per RFC 2045).
  // Spaces are NOT stripped — real base64 never contains spaces.
  const stripped = trimmed.replace(/[\r\n]/g, '');

  // Step 2: Strict charset — detect alphabet variant.
  // Standard: [A-Za-z0-9+/] with optional = padding
  // URL-safe: [A-Za-z0-9\-_] with optional = padding
  const isStandard = /^[A-Za-z0-9+/]+=*$/.test(stripped);
  const isUrlSafe = !isStandard && /^[A-Za-z0-9\-_]+=*$/.test(stripped);
  if (!isStandard && !isUrlSafe) return null;

  // Step 3: Normalize to standard alphabet for decoding
  const normalized = isUrlSafe
    ? stripped.replace(/-/g, '+').replace(/_/g, '/')
    : stripped;

  // Step 4: Auto-pad to make length divisible by 4
  const padded = normalized.length % 4 === 0
    ? normalized
    : normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  // Step 5: Decode
  let decoded: Buffer;
  try {
    decoded = Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
  if (decoded.length < MIN_DECODED_SIZE) return null;

  // Step 6: Canonical roundtrip — re-encode and compare to padded input.
  // Catches any input that Node's lenient decoder silently mangled.
  if (decoded.toString('base64') !== padded) return null;

  // Step 7: Binary-likeness check (unchanged)
  if (!looksLikeBinary(decoded)) return null;

  const ext = detectExtensionFromMagic(decoded) || '.bin';
  return { buffer: decoded, mimeType: null, ext, source: 'raw-base64' };
}

// ============================================================
// File Saving
// ============================================================

/** Format bytes to human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

/** Sanitize filename by removing unsafe characters. */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 200);
}

/**
 * Binary download result returned to the agent.
 */
export interface BinaryDownloadResult {
  type: 'file_download';
  path: string;
  filename: string;
  mimeType: string | null;
  size: number;
  sizeHuman: string;
}

/**
 * Error result returned when binary save fails.
 */
export interface BinaryDownloadError {
  type: 'file_download_error';
  error: string;
}

/**
 * Save binary response to session's downloads folder.
 * Uses atomic file creation (O_EXCL) to prevent TOCTOU race conditions.
 */
export function saveBinaryResponse(
  sessionPath: string,
  filename: string,
  buffer: Buffer,
  mimeType: string | null
): BinaryDownloadResult | BinaryDownloadError {
  const downloadsDir = join(sessionPath, 'downloads');

  try {
    mkdirSync(downloadsDir, { recursive: true });
  } catch (err) {
    return {
      type: 'file_download_error',
      error: `Failed to create downloads directory: ${(err as Error).message}`,
    };
  }

  let finalFilename = filename;
  let filePath = join(downloadsDir, finalFilename);
  let counter = 0;
  const maxAttempts = 100;

  while (counter < maxAttempts) {
    try {
      writeFileSync(filePath, buffer, { flag: 'wx' });
      return {
        type: 'file_download',
        path: filePath,
        filename: finalFilename,
        mimeType,
        size: buffer.length,
        sizeHuman: formatBytes(buffer.length),
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EEXIST') {
        counter++;
        const dotIdx = filename.lastIndexOf('.');
        if (dotIdx > 0) {
          const base = filename.slice(0, dotIdx);
          const ext = filename.slice(dotIdx);
          finalFilename = `${base}-${counter}${ext}`;
        } else {
          finalFilename = `${filename}-${counter}`;
        }
        filePath = join(downloadsDir, finalFilename);
      } else {
        return {
          type: 'file_download_error',
          error: `Failed to save file: ${error.message}`,
        };
      }
    }
  }

  return {
    type: 'file_download_error',
    error: `Failed to save file after ${maxAttempts} attempts - too many collisions`,
  };
}
