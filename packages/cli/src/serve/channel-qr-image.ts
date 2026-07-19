/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import QRCode from 'qrcode';

const MAX_QR_PAYLOAD_LENGTH = 4096;

export interface ChannelQrImage {
  contentType: 'image/svg+xml';
  bytes: Buffer;
}

export class ChannelQrImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelQrImageError';
  }
}

export async function renderChannelQrImage(
  payload: string,
): Promise<ChannelQrImage> {
  if (payload.length > MAX_QR_PAYLOAD_LENGTH) {
    throw new ChannelQrImageError(
      'channel_auth_qr_payload_too_large',
      'Channel authentication QR payload is too large.',
    );
  }
  const svg = await QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
  return {
    contentType: 'image/svg+xml',
    bytes: Buffer.from(svg, 'utf8'),
  };
}
