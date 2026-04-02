/**
 * CDN download with AES-128-ECB decryption.
 * Ported from cc-weixin/plugins/weixin/src/media.ts (download path only).
 */

import { createDecipheriv } from 'node:crypto';

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function buildCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse aes_key from CDNMedia into a raw 16-byte Buffer.
 * Two encodings exist:
 *   - base64(raw 16 bytes) → images
 *   - base64(hex string of 16 bytes) → file/voice/video
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))
  ) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `Invalid aes_key: expected 16 raw bytes or 32 hex chars, got ${decoded.length} bytes`,
  );
}

/** Download encrypted media from CDN and decrypt it. */
export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKey: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`CDN download failed: HTTP ${resp.status}`);
  }

  const ciphertext = Buffer.from(await resp.arrayBuffer());
  const keyBuf = parseAesKey(aesKey);
  return decryptAesEcb(ciphertext, keyBuf);
}
