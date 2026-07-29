/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import QRCode from 'qrcode';

/** Render `text` as a terminal-drawable QR (`utf8` type — half-block chars). */
export function renderQr(text: string): Promise<string> {
  // `type: 'utf8'` is documented for all qrcode versions; do NOT add
  // `{ small: true }` (not part of the toString options — it would be ignored
  // or throw and, because up swallows a renderQr rejection, silently drop the QR).
  return QRCode.toString(text, { type: 'utf8' });
}
