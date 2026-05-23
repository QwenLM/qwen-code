/**
 * Send messages to WeChat users.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  readFileSync,
  statSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
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

// ── Image path validation ─────────────────────────────────────────

const ALLOWED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

/** Image magic bytes → MIME type mapping. */
export function detectImageMime(data: Buffer): string {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46
  ) {
    return 'image/webp';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  throw new Error(
    'Unrecognized image format: magic bytes do not match any supported type',
  );
}

/**
 * Validate and resolve an image path before reading.
 *
 * Security: prevents AI-controlled [IMAGE: ...] markers from reading
 * arbitrary files by enforcing directory allowlist, extension allowlist,
 * size cap, and magic-byte verification.
 *
 * @param imagePath  Raw path from the AI response.
 * @param workspaceDirs  Additional directories to allow (typically the cwd).
 * @returns Resolved absolute realpath if valid.
 */
export function validateImagePath(
  imagePath: string,
  workspaceDirs: string[] = [],
): string {
  const resolved = resolve(imagePath);
  const ext = extname(resolved).toLowerCase();

  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`Image extension not allowed: ${ext} (path: ${resolved})`);
  }

  const real: string = (() => {
    try {
      return realpathSync(resolved);
    } catch {
      throw new Error(`Image file not found: ${resolved}`);
    }
  })();

  const st = statSync(real);
  if (!st.isFile()) {
    throw new Error(`Not a regular file: ${real}`);
  }
  if (st.size > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image too large: ${st.size} bytes (max ${MAX_IMAGE_SIZE})`,
    );
  }

  // Build the allowlist: /tmp/ (and macOS real /private/tmp/), os.tmpdir(),
  // plus workspace directories passed by the caller. Use realpathSync to
  // resolve symlinks (e.g. /tmp → /private/tmp on macOS).
  const ALLOWED_DIRS = [
    '/tmp/',
    realpathSync('/tmp/') + '/',
    tmpdir() + '/',
    realpathSync(tmpdir()) + '/',
    ...workspaceDirs.map((d) => realpathSync(resolve(d)) + '/'),
  ];

  if (!ALLOWED_DIRS.some((dir) => real.startsWith(dir))) {
    throw new Error(`Image path outside allowed directories: ${real}`);
  }

  // Verify magic bytes match the extension (read only first 16 bytes to
  // avoid TOCTOU double-read — sendImage reads the full file later).
  let fd: number | undefined;
  try {
    fd = openSync(real, 'r');
    const head = Buffer.alloc(16);
    const bytesRead = readSync(fd, head, 0, 16, 0);
    const mime = detectImageMime(head.slice(0, bytesRead));
    const extToExpectedMime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const expected = extToExpectedMime[ext];
    if (mime !== expected) {
      throw new Error(
        `Image type mismatch: ext=${ext} expects ${expected} but got ${mime}`,
      );
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  return real;
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
 *   1. Validate path + read file, compute rawsize + MD5; generate AES key + filekey
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
  /** Workspace directories to allow for image paths. */
  workspaceDirs?: string[];
}): Promise<void> {
  const { to, imagePath, baseUrl, token, contextToken, workspaceDirs } = params;

  // Step 1 (security): validate and resolve the image path
  const resolvedPath = validateImagePath(imagePath, workspaceDirs);

  // Step 1 (continued): read file, compute metadata + generate random identifiers
  const fileBuffer = readFileSync(resolvedPath);
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
  // aes_key: base64(raw 16 bytes) for images per protocol
  const aesKeyBase64 = aesKeyBytes.toString('base64');

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
