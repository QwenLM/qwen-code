import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { SaxesParser } from 'saxes';

export function parseCallbackXml(xml: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  const parser = new SaxesParser();
  let depth = 0;
  let field = '';
  parser.on('doctype', () => {
    throw new Error('DTD is not supported');
  });
  parser.on('opentag', (tag) => {
    depth++;
    if (
      depth > 2 ||
      (depth === 1 && tag.name !== 'xml') ||
      Object.keys(tag.attributes).length > 0
    ) {
      throw new Error('Invalid callback XML structure');
    }
    if (depth === 2) {
      field = tag.name;
      if (Object.hasOwn(fields, field)) throw new Error('Duplicate XML field');
      fields[field] = '';
    }
  });
  const append = (value: string) => {
    if (depth === 2) fields[field] += value;
    else if (value.trim()) throw new Error('Invalid callback XML text');
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    depth--;
  });
  parser.write(xml).close();
  return fields;
}

export function decodeCallbackKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}$/.test(value)) {
    throw new Error('encodingAESKey must be a 43-character Base64 AES key');
  }
  const key = Buffer.from(value + '=', 'base64');
  if (key.length !== 32) {
    throw new Error('Invalid encodingAESKey');
  }
  return key;
}

export function verifyCallbackSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  signature: string,
): void {
  const expected = createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest();
  if (
    !/^[a-fA-F0-9]{40}$/.test(signature) ||
    !timingSafeEqual(expected, Buffer.from(signature, 'hex'))
  ) {
    throw new Error('Invalid callback signature');
  }
}

export function decryptCallback(
  key: Buffer,
  corpId: string,
  encrypted: string,
): string {
  const ciphertext = Buffer.from(encrypted, 'base64');
  if (
    ciphertext.length === 0 ||
    ciphertext.length % 16 !== 0 ||
    ciphertext.toString('base64') !== encrypted
  ) {
    throw new Error('Invalid callback ciphertext');
  }
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const padding = padded[padded.length - 1]!;
  if (
    padding < 1 ||
    padding > 32 ||
    !padded.subarray(-padding).every((byte) => byte === padding)
  ) {
    throw new Error('Invalid callback padding');
  }
  const plaintext = padded.subarray(0, -padding);
  if (plaintext.length < 20) throw new Error('Invalid callback framing');
  const length = plaintext.readUInt32BE(16);
  const receiver = Buffer.from(corpId);
  if (
    plaintext.length !== 20 + length + receiver.length ||
    !plaintext.subarray(20 + length).equals(receiver)
  ) {
    throw new Error('Invalid callback receiver');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    plaintext.subarray(20, 20 + length),
  );
}
