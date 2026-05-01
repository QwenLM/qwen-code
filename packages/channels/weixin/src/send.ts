/**
 * Send messages to WeChat users.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sendMessage, getUploadUrl, uploadToCdn } from './api.js';
import { MessageType, MessageState, MessageItemType } from './types.js';
import { encryptAesEcb, computeMd5 } from './media.js';

/** Convert markdown to plain text (WeChat doesn't support markdown) */
export function markdownToPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}$/gm, '---')
    .replace(/^[\s]*[-*+]\s+/gm, '- ')
    .replace(/^[\s]*(\d+)\.\s+/gm, '$1. ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Send a text message */
export async function sendText(params: {
  to: string;
  text: string;
  baseUrl: string;
  token: string;
  contextToken: string;
}): Promise<void> {
  const { to, text, baseUrl, token, contextToken } = params;
  const plainText = markdownToPlainText(text);

  await sendMessage(baseUrl, token, {
    to_user_id: to,
    from_user_id: '',
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: plainText } }],
  });
}

/**
 * Send an image message via the four-step CDN upload flow:
 *   1. Read file, compute rawsize + MD5; generate random AES key + filekey
 *   2. Request upload URL via getuploadurl
 *   3. AES-128-ECB encrypt + POST upload to CDN; extract x-encrypted-param
 *   4. Send message with image_item referencing the CDN media
 */
export async function sendImage(params: {
  to: string;
  imagePath: string;
  baseUrl: string;
  token: string;
  contextToken: string;
}): Promise<void> {
  const { to, imagePath, baseUrl, token, contextToken } = params;

  // Step 1: read file, compute metadata + generate random identifiers
  const fileBuffer = readFileSync(imagePath);
  const rawsize = fileBuffer.length;
  const rawfilemd5 = computeMd5(fileBuffer);

  // Generate random 16-byte AES key as hex string
  const aesKeyBytes = randomBytes(16);
  const aesKeyHex = aesKeyBytes.toString('hex');

  // Generate random 32-char hex filekey
  const filekey = randomBytes(16).toString('hex');

  // AES-128-ECB PKCS#7 padding: encrypted size = ceil((rawsize + 1) / 16) * 16
  const encryptedSize = Math.ceil((rawsize + 1) / 16) * 16;

  // Step 2: get upload URL and CDN credentials
  const uploadParam = await getUploadUrl(
    baseUrl,
    token,
    to,
    filekey,
    rawsize,
    rawfilemd5,
    encryptedSize,
    aesKeyHex,
  );

  // Step 3: encrypt and upload to CDN
  const encrypted = encryptAesEcb(fileBuffer, aesKeyBytes);
  const cdnEncryptParam = await uploadToCdn(uploadParam, filekey, encrypted);

  // Step 4: send message with image_item using CDN's x-encrypted-param
  // aes_key in sendmessage should be base64(hex string) per protocol
  const aesKeyBase64 = Buffer.from(aesKeyHex, 'ascii').toString('base64');

  await sendMessage(baseUrl, token, {
    to_user_id: to,
    from_user_id: '',
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: cdnEncryptParam,
            aes_key: aesKeyBase64,
            encrypt_type: 1,
          },
        },
      },
    ],
  });
}
