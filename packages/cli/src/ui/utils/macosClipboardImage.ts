/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import {
  repairBunNativesRuntime,
  runLogger,
} from '@qwen-code/core';

type NativeClipboardModule = typeof import('@crosscopy/clipboard');

const requireFromHere = createRequire(import.meta.url);
let nativeClipboard: NativeClipboardModule | null | undefined;

function getNativeClipboard(): NativeClipboardModule | null {
  if (nativeClipboard !== undefined) {
    return nativeClipboard;
  }

  if (process.platform !== 'darwin') {
    nativeClipboard = null;
    return nativeClipboard;
  }

  try {
    // Bun standalone binaries extract native packages before loading them.
    // Revalidate that tree because the module is loaded lazily on first paste.
    repairBunNativesRuntime();
    nativeClipboard = requireFromHere(
      '@crosscopy/clipboard',
    ) as NativeClipboardModule;
  } catch (error) {
    nativeClipboard = null;
    runLogger.debug(
      'Native macOS clipboard module is unavailable; using AppleScript fallback.',
      error,
    );
  }

  return nativeClipboard;
}

/**
 * Returns whether the native clipboard contains an image.
 * `undefined` means the native module is unavailable and the caller should use
 * the existing AppleScript path.
 */
export function hasNativeMacOSClipboardImage(): boolean | undefined {
  const clipboard = getNativeClipboard();
  if (!clipboard) return undefined;

  try {
    return clipboard.hasImage();
  } catch (error) {
    runLogger.debug(
      'Native macOS clipboard image check failed; using AppleScript fallback.',
      error,
    );
    return undefined;
  }
}

/**
 * Reads the clipboard image as PNG bytes through the native pasteboard API.
 *
 * - `Buffer`: image read successfully
 * - `null`: native clipboard is available but contains no image
 * - `undefined`: native access failed; use the AppleScript fallback
 */
export async function readNativeMacOSClipboardImage(): Promise<
  Buffer | null | undefined
> {
  const clipboard = getNativeClipboard();
  if (!clipboard) return undefined;

  try {
    if (!clipboard.hasImage()) return null;
    // The binary API materializes every byte as a JavaScript number. Base64
    // keeps the native/JS boundary compact, then decodes directly to Buffer.
    const base64 = await clipboard.getImageBase64();
    if (base64.length === 0) {
      throw new Error('Native clipboard returned empty image data');
    }
    const image = Buffer.from(base64, 'base64');
    if (image.length === 0) {
      throw new Error('Native clipboard returned invalid image data');
    }
    return image;
  } catch (error) {
    runLogger.debug(
      'Native macOS clipboard image read failed; using AppleScript fallback.',
      error,
    );
    return undefined;
  }
}
