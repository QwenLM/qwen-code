import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeCallbackKey,
  decryptCallback,
  parseCallbackXml,
  verifyCallbackSignature,
} from './wecom-callback-crypto.js';

// Published SDK fixture, predating redaction of the sample configuration:
// https://github.com/sbzhu/weworkapi_python/blob/27220fbe9d5251d46101e33751568eae9f413666/callback/Sample.py
const key = decodeCallbackKey('6qkdMrq68nTKduznJYO1A37W2oEgpkMUvkttRToqhUt');
const encrypted =
  'fsi1xnbH4yQh0+PJxcOdhhK6TDXkjMyhEPA7xB2TGz6b+g7xyAbEkRxN/3cNXW9qdqjnoVzEtpbhnFyq6SVHyA==';

describe('WeCom callback protocol', () => {
  it('verifies and decrypts the independent WeCom SDK handshake fixture', () => {
    verifyCallbackSignature(
      'hJqcu3uJ9Tn2gXPmxx2w9kkCkCE2EPYo',
      '1476416373',
      '47744683',
      encrypted,
      '012bc692d0a58dd4b10f8dfe5c4ac00ae211ebeb',
    );
    expect(decryptCallback(key, 'ww1436e0e65a779aee', encrypted)).toBe(
      '1288432023552776189',
    );
  });

  it('rejects invalid signature, key, receiver and ciphertext', () => {
    expect(() =>
      verifyCallbackSignature(
        'wrong',
        '1476416373',
        '47744683',
        encrypted,
        '012bc692d0a58dd4b10f8dfe5c4ac00ae211ebeb',
      ),
    ).toThrow('signature');
    expect(() => verifyCallbackSignature('', '', '', '', 'not-hex')).toThrow(
      'signature',
    );
    expect(() => decodeCallbackKey('bad')).toThrow('AES key');
    expect(() => decryptCallback(key, 'another-corp', encrypted)).toThrow(
      'receiver',
    );
    expect(() => decryptCallback(key, '', 'junk')).toThrow('ciphertext');
  });

  it.each([0, 33])('rejects invalid padding length %s', (padding) => {
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.alloc(32, padding)),
      cipher.final(),
    ]).toString('base64');
    expect(() => decryptCallback(key, '', ciphertext)).toThrow('padding');
  });

  it('rejects inconsistent padding bytes and oversized framing', () => {
    const encrypt = (data: Buffer) => {
      const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
      cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString(
        'base64',
      );
    };
    const padded = Buffer.alloc(32);
    padded[31] = 2;
    expect(() => decryptCallback(key, '', encrypt(padded))).toThrow('padding');
    padded.fill(12, 20);
    padded.writeUInt32BE(0xffffffff, 16);
    expect(() => decryptCallback(key, '', encrypt(padded))).toThrow('receiver');
  });

  it('preserves CDATA and decodes entities exactly once', () => {
    expect(
      parseCallbackXml(
        '<xml><Content><![CDATA[  hello <world> ]]>&amp;&lt;</Content><MsgId>123</MsgId></xml>',
      ),
    ).toEqual({ Content: '  hello <world> &<', MsgId: '123' });
  });

  it.each([
    '<!DOCTYPE xml [<!ENTITY x "bad">]><xml><Content>&x;</Content></xml>',
    '<xml><MsgId>1</MsgId><MsgId>2</MsgId></xml>',
    '<xml><Content><nested/></Content></xml>',
    '<other/>',
    '<xml><Content></xml>',
    '<xml/><xml/>',
  ])('rejects ambiguous or unsafe XML: %s', (xml) => {
    expect(() => parseCallbackXml(xml)).toThrow();
  });
});
