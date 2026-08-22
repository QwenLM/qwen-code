/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isUtf8 } from 'node:buffer';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { TextDecoder } from 'node:util';
import { detect as chardetDetect } from 'chardet';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('ENCODING');

// Cache for system encoding to avoid repeated detection
// Use undefined to indicate "not yet checked" vs null meaning "checked but failed"
let cachedSystemEncoding: string | null | undefined = undefined;

/**
 * Reset the encoding cache - useful for testing
 */
export function resetEncodingCache(): void {
  cachedSystemEncoding = undefined;
}

/**
 * Byte budget for chardet's statistical pass. chardet's `detect()` runs a
 * full O(n) scan with no sampling, so handing it the entire output buffer
 * (up to `maxBufferedOutputBytes`, 64 MiB by default) can stall the event
 * loop for seconds in the 'exit' handler. Detection confidence is
 * statistical, so a bounded head+tail sample is enough (at most
 * 2 × CHARDET_SAMPLE_BYTES scanned, regardless of total size).
 */
const CHARDET_SAMPLE_BYTES = 64 * 1024;

/**
 * Detects the encoding of a buffer.
 *
 * Strategy: try strict UTF-8, then the UTF-16 BOM, then the system encoding
 * (when non-UTF-8), then UTF-8 with replacement for mostly-valid buffers,
 * then chardet.
 * UTF-8 is tried first because modern developer tools, PowerShell Core,
 * git, node, and most CLI tools output UTF-8. Legacy codepage bytes
 * (0x80-0xFF) rarely form valid multi-byte UTF-8 sequences by accident.
 *
 * This function should be called on the **complete** output buffer
 * (after the command finishes), not on individual streaming chunks,
 * to avoid misdetection when early chunks are ASCII-only.
 *
 * @param buffer A buffer to analyze for encoding detection.
 */
export function getCachedEncodingForBuffer(buffer: Buffer): string {
  if (isUtf8(buffer)) {
    return 'utf-8';
  }

  // A UTF-16 byte-order mark is an authoritative signal that the buffer is
  // not a mostly-valid UTF-8 buffer with a couple of stray bytes. Without
  // this short-circuit the replacement-ratio heuristic below would count only
  // the 2 invalid BOM bytes (FF FE / FE FF) and classify ASCII-range UTF-16
  // text (char + NUL — valid UTF-8) as utf-8, silently NUL-interleaving the
  // output. Node's TextDecoder('utf-16') is an alias of utf-16le that does
  // NOT read the byte order from the BOM, so the LE (FF FE) branch uses it
  // and the BE (FE FF) branch must use the explicit 'utf-16be' label. (UTF-32
  // is not covered: WHATWG TextDecoder has no utf-32 label.)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16';
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf-16be';
  }

  // Substantially invalid UTF-8. On Windows, native CLI tools (cmd.exe,
  // findstr, dir, icacls) emit text in the OEM code page returned by `chcp`
  // (e.g. cp866 on Russian Windows). chardet's statistical detection is
  // unreliable for the short, mostly-ASCII strings CLI output produces —
  // measured 0/6 for cp866 (it returns windows-1252). The system code page
  // is authoritative, so consult it first and only fall through to chardet
  // when the system encoding is UTF-8 or unavailable: a non-UTF-8 buffer on
  // a UTF-8 system is genuinely foreign data (legacy tool output, a file in
  // a different encoding) that chardet should classify.
  if (cachedSystemEncoding === undefined) {
    cachedSystemEncoding = getSystemEncoding();
  }
  if (cachedSystemEncoding && cachedSystemEncoding !== 'utf-8') {
    return cachedSystemEncoding;
  }

  // Not strictly valid UTF-8, but a few stray bytes in otherwise-valid
  // UTF-8 (mixed-encoding file content, legacy tool banners) must not be
  // handed to chardet: its statistical guess (commonly windows-1252) would
  // decode the entire buffer with a single-byte label and silently mojibake
  // all the valid multi-byte content. If invalid bytes are scarce relative
  // to the buffer, treat it as UTF-8 and let the non-fatal TextDecoder
  // substitute U+FFFD for just the bad bytes. The absolute allowance
  // (replacements <= 2 && replacements * 2 < buffer.length) additionally
  // rescues short (<= ~100 byte) buffers that carry a single stray byte yet
  // miss the strict 1% ratio (exactly 1/100 = 0.01: the `length` side of the
  // comparison is strictly greater).
  const decoded = new TextDecoder('utf-8').decode(buffer);
  let replacements = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) === 0xfffd) {
      replacements++;
    }
  }
  if (
    replacements / buffer.length < 0.01 ||
    (replacements <= 2 && replacements * 2 < buffer.length)
  ) {
    return 'utf-8';
  }

  const detected = detectEncodingFromBuffer(buffer);
  if (detected) {
    return detected;
  }

  // Last resort
  return 'utf-8';
}

/**
 * Decodes a process output buffer to a string using detected encoding.
 *
 * @param buffer The buffer (or already-decoded string) to decode.
 * @param encoding Optional pre-detected encoding label. When provided,
 *   detection is skipped — callers that already computed the label (e.g.
 *   to share it across stdout/stderr or a background-promote handoff) pass
 *   it here to avoid re-running chardet over the same bytes.
 */
export function decodeProcessOutput(
  buffer: Buffer | string,
  encoding?: string,
): string {
  if (!Buffer.isBuffer(buffer)) return String(buffer);
  if (buffer.length === 0) return '';
  const label = encoding ?? getCachedEncodingForBuffer(buffer);
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    // The detected label may be a Unix locale codeset the blocklist does not
    // cover, or a chardet guess, that Node's WHATWG TextDecoder rejects with
    // RangeError. Fall back to utf-8 so a throw never escapes into an
    // 'exit'/'data' handler, which would otherwise leave the shell-execution
    // promise unsettled.
    debugLogger.debug(
      `TextDecoder rejected encoding label "${label}"; falling back to utf-8`,
    );
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Detects the system encoding based on the platform.
 * For Windows, it uses the 'chcp' command to get the current code page.
 * For Unix-like systems, it checks environment variables like LC_ALL, LC_CTYPE, and LANG.
 * If those are not set, it tries to run 'locale charmap' to get the encoding.
 * If detection fails, it returns null.
 * @returns The system encoding as a string, or null if detection fails.
 */
export function getSystemEncoding(): string | null {
  // Windows
  if (os.platform() === 'win32') {
    try {
      const output = execSync('chcp', { encoding: 'utf8' });
      const match = output.match(/:\s*(\d+)/);
      if (match) {
        const codePage = parseInt(match[1], 10);
        if (!isNaN(codePage)) {
          return windowsCodePageToEncoding(codePage);
        }
      }
      // Only warn if we can't parse the output format, not if windowsCodePageToEncoding fails
      throw new Error(
        `Unable to parse Windows code page from 'chcp' output "${output.trim()}". `,
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to get Windows code page using 'chcp' command: ${error instanceof Error ? error.message : String(error)}. ` +
          `Will attempt to detect encoding from command output instead.`,
      );
    }
    return null;
  }

  // Unix-like
  // Use environment variables LC_ALL, LC_CTYPE, and LANG to determine the
  // system encoding. However, these environment variables might not always
  // be set or accurate. Handle cases where none of these variables are set.
  const env = process.env;
  let locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  let fromCharmap = false;

  // Fallback to querying the system directly when environment variables are missing
  if (!locale) {
    try {
      locale = execSync('locale charmap', { encoding: 'utf8' })
        .toString()
        .trim();
      fromCharmap = true;
    } catch (_e) {
      debugLogger.warn('Failed to get locale charmap.');
      return null;
    }
  }

  // Extract the codeset (the part after the LAST dot of a locale name like
  // "en_US.UTF-8"). `locale charmap` output is already just the codeset, so
  // it needs no dot parsing. A locale without a codeset (LANG=C, LANG=POSIX)
  // or a C-locale charmap (ANSI_X3.4-1968, plain ASCII) has no decodable
  // non-UTF-8 label: returning those names unvalidated would make the system
  // gate authoritative for a label TextDecoder rejects and silently corrupt
  // output. Returning null lets detection fall through to chardet instead.
  let codeset: string | null;
  if (fromCharmap) {
    codeset = locale.split('@')[0].toLowerCase();
  } else {
    const dot = locale.lastIndexOf('.');
    codeset =
      dot === -1
        ? null
        : locale
            .slice(dot + 1)
            .split('@')[0]
            .toLowerCase();
  }

  if (!codeset) return null;
  if (codeset === 'utf8') return 'utf-8';
  // ASCII-family names either have no decodable foreign codepage or resolve
  // to windows-1252 via WHATWG normalization; returning one would make the
  // system gate force a windows-1252 decode of genuinely foreign bytes.
  if (
    codeset === 'c' ||
    codeset === 'posix' ||
    codeset === 'ansi_x3.4-1968' ||
    codeset === 'us-ascii' ||
    codeset === 'ascii' ||
    codeset === 'iso646-us' ||
    codeset === 'iso_646.irv:1991'
  ) {
    return null;
  }

  // Probe-validate the codeset through TextDecoder before returning — Unix
  // locale codesets like eucjp, euckr, tis620, big5hkscs, koi8u are rejected
  // by WHATWG TextDecoder with RangeError. Normalise common glibc spellings
  // to their WHATWG-accepted forms first.
  const normalised = codeset
    .replace(/^eucjp$/, 'euc-jp')
    .replace(/^euckr$/, 'euc-kr');
  try {
    new TextDecoder(normalised);
  } catch {
    return null;
  }

  return normalised;
}

/**
 * Converts a Windows code page number to a corresponding encoding name.
 * @param cp The Windows code page number (e.g., 437, 850, etc.)
 * @returns The corresponding encoding name as a string, or null if no mapping exists.
 */

export function windowsCodePageToEncoding(cp: number): string | null {
  // Most common mappings; extend as needed.
  // 437/850/852 are deliberately absent: there is no WHATWG TextDecoder label
  // for them (`cp437`/`cp850`/`cp852` throw RangeError), so returning a label
  // here would make the system code page authoritative for a label Node cannot
  // decode, silently falling back to UTF-8 garbage. Returning null lets
  // detection fall through to chardet instead.
  const map: { [key: number]: string } = {
    866: 'cp866',
    874: 'windows-874',
    932: 'shift_jis',
    936: 'gbk',
    949: 'euc-kr',
    950: 'big5',
    1200: 'utf-16le',
    1201: 'utf-16be',
    1250: 'windows-1250',
    1251: 'windows-1251',
    1252: 'windows-1252',
    1253: 'windows-1253',
    1254: 'windows-1254',
    1255: 'windows-1255',
    1256: 'windows-1256',
    1257: 'windows-1257',
    1258: 'windows-1258',
    65001: 'utf-8',
  };

  if (map[cp]) {
    return map[cp];
  }

  // These pages are deliberately skipped (no WHATWG TextDecoder label), not
  // unknown — return null silently so an intentional design decision is not
  // logged as a detection failure. Known-but-skipped pages on the hosts this
  // OEM-decoding work targets (437 on US English, 850 in Western Europe)
  // would otherwise spam the warn on every process's first non-UTF-8 output.
  if (cp === 437 || cp === 850 || cp === 852) {
    return null;
  }

  debugLogger.warn(`Unable to determine encoding for windows code page ${cp}.`);
  return null; // Return null if no mapping found
}

/**
 * Attempts to detect the encoding of a non-UTF-8 buffer using chardet
 * statistical analysis. Returns null when chardet cannot determine the
 * encoding (e.g. the buffer is too small or ambiguous).
 *
 * Callers that need a guaranteed result should provide their own fallback
 * (e.g. {@link getCachedEncodingForBuffer} falls back to the system codepage).
 *
 * @param buffer The buffer to analyze for encoding.
 * @return The detected encoding as a lowercase string, or null if detection fails.
 */
export function detectEncodingFromBuffer(buffer: Buffer): string | null {
  // Try chardet statistical detection first — works well for larger files.
  // Detection runs on a bounded sample (CHARDET_SAMPLE_BYTES from the head
  // and the tail) so a large buffer doesn't pay chardet's full O(n)
  // byte-statistics pass. Sampling both ends keeps detection correct for
  // buffers whose head is pure ASCII but whose bulk is a foreign encoding
  // (e.g. a large shell log or file with an ASCII prefix followed by
  // OEM/GBK content), which a head-only sample would misdetect as Latin-1.
  try {
    let sample = buffer;
    if (buffer.length > CHARDET_SAMPLE_BYTES * 2) {
      // Head + middle + tail sampling for large buffers — foreign content
      // concentrated in the middle of buffers >128 KiB would be missed by
      // head+tail only (e.g. a 300 KiB file with ASCII head/tail and
      // windows-1251 middle).
      const middleStart =
        Math.floor(buffer.length / 2) - Math.floor(CHARDET_SAMPLE_BYTES / 2);
      sample = Buffer.concat([
        buffer.subarray(0, CHARDET_SAMPLE_BYTES),
        buffer.subarray(middleStart, middleStart + CHARDET_SAMPLE_BYTES),
        buffer.subarray(buffer.length - CHARDET_SAMPLE_BYTES),
      ]);
    } else if (buffer.length > CHARDET_SAMPLE_BYTES) {
      sample = Buffer.concat([
        buffer.subarray(0, CHARDET_SAMPLE_BYTES),
        buffer.subarray(buffer.length - CHARDET_SAMPLE_BYTES),
      ]);
    }
    const detected = chardetDetect(sample);
    if (detected && typeof detected === 'string') {
      return detected.toLowerCase();
    }
  } catch (error) {
    debugLogger.warn('Failed to detect encoding with chardet:', error);
  }

  return null;
}
