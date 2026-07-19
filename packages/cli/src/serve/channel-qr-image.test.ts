/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderChannelQrImage } from './channel-qr-image.js';

describe('renderChannelQrImage', () => {
  it('renders payloads locally as SVG bytes', async () => {
    const image = await renderChannelQrImage('https://example.test/qr?id=123');

    expect(image.contentType).toBe('image/svg+xml');
    expect(Buffer.isBuffer(image.bytes)).toBe(true);
    expect(image.bytes.toString('utf8')).toMatch(/^<svg[^>]*>/u);
    expect(image.bytes.toString('utf8')).toContain('<path');
  });

  it('never passes third-party markup through to the SVG response', async () => {
    const payload = '<script>globalThis.pwned = true</script>';
    const image = await renderChannelQrImage(payload);
    const svg = image.bytes.toString('utf8');

    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('globalThis.pwned');
    expect(svg).toMatch(/^<svg[^>]*>/u);
  });

  it('rejects payloads over 4096 UTF-16 code units', async () => {
    await expect(renderChannelQrImage('a'.repeat(4097))).rejects.toMatchObject({
      code: 'channel_auth_qr_payload_too_large',
    });
    await expect(
      renderChannelQrImage(`${'😀'.repeat(2048)}a`),
    ).rejects.toMatchObject({ code: 'channel_auth_qr_payload_too_large' });
  });
});
