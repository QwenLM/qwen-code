// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_BASE_URL,
  WeixinApiError,
  getConfig,
  getStateDir,
  getUpdates,
  getUploadUrl,
  loadAccount,
  sendMessage,
  sendTyping,
  uploadToCdn
} from "./chunk-ESBYWATJ.js";
import {
  ChannelBase,
  isTerminalTaskLifecycleType
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import "./chunk-CQ35AJ4Z.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/channels/weixin/dist/index.js
init_esbuild_shims();

// packages/channels/weixin/dist/WeixinAdapter.js
init_esbuild_shims();
import { mkdirSync, writeFileSync as writeFileSync2 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import { basename, join as join2 } from "node:path";
import { tmpdir as tmpdir2 } from "node:os";

// packages/channels/weixin/dist/monitor.js
init_esbuild_shims();

// packages/channels/weixin/dist/types.js
init_esbuild_shims();
var MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2
};
var MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
};
var MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2
};
var TypingStatus = {
  TYPING: 1,
  CANCEL: 2
};

// packages/channels/weixin/dist/monitor.js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var contextTokens = /* @__PURE__ */ new Map();
function getContextToken(userId) {
  return contextTokens.get(userId);
}
__name(getContextToken, "getContextToken");
function cursorPath() {
  return join(getStateDir(), "cursor.txt");
}
__name(cursorPath, "cursorPath");
function loadCursor() {
  const p = cursorPath();
  if (existsSync(p))
    return readFileSync(p, "utf-8").trim();
  return "";
}
__name(loadCursor, "loadCursor");
function saveCursor(cursor) {
  writeFileSync(cursorPath(), cursor, "utf-8");
}
__name(saveCursor, "saveCursor");
async function startPollLoop(params) {
  const { baseUrl, token, onMessage, abortSignal } = params;
  let cursor = loadCursor();
  let consecutiveErrors = 0;
  let pollTimeoutMs = 4e4;
  process.stderr.write("[weixin] Starting message poll loop...\n");
  while (!abortSignal.aborted) {
    try {
      const resp = await getUpdates(baseUrl, token, cursor, pollTimeoutMs, abortSignal);
      if (resp.errcode === -14) {
        process.stderr.write("[weixin] Session expired (errcode -14). Pausing 30s...\n");
        await new Promise((r) => setTimeout(r, 3e4));
        continue;
      }
      if (resp.ret !== 0 && resp.ret !== void 0) {
        throw new Error(`getUpdates error: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg}`);
      }
      consecutiveErrors = 0;
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        pollTimeoutMs = resp.longpolling_timeout_ms + 5e3;
      }
      if (resp.msgs && resp.msgs.length > 0) {
        for (const msg of resp.msgs) {
          await processMessage(msg, onMessage);
        }
      }
      if (resp.get_updates_buf) {
        cursor = resp.get_updates_buf;
        saveCursor(cursor);
      }
    } catch (err) {
      if (abortSignal.aborted)
        break;
      consecutiveErrors++;
      process.stderr.write(`[weixin] Poll error (${consecutiveErrors}): ${err instanceof Error ? err.message : err}
`);
      if (consecutiveErrors >= 3) {
        process.stderr.write("[weixin] Too many consecutive errors, backing off 30s...\n");
        await new Promise((r) => setTimeout(r, 3e4));
        consecutiveErrors = 0;
      } else {
        await new Promise((r) => setTimeout(r, 2e3));
      }
    }
  }
  process.stderr.write("[weixin] Poll loop stopped.\n");
}
__name(startPollLoop, "startPollLoop");
async function processMessage(msg, onMessage) {
  if (msg.message_type !== MessageType.USER)
    return;
  const fromUserId = msg.from_user_id;
  if (!fromUserId)
    return;
  if (msg.context_token) {
    contextTokens.set(fromUserId, msg.context_token);
  }
  let textContent = "";
  let image;
  let file;
  let refText;
  if (msg.item_list) {
    for (const item of msg.item_list) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        textContent += (textContent ? "\n" : "") + item.text_item.text;
      }
      if (item.ref_msg) {
        const refItem = item.ref_msg.message_item;
        if (refItem?.text_item?.text) {
          refText = refItem.text_item.text;
        } else if (item.ref_msg.title) {
          refText = item.ref_msg.title;
        }
      }
      if (item.type === MessageItemType.IMAGE && item.image_item) {
        const media = item.image_item.media;
        if (media?.encrypt_query_param && media.aes_key) {
          image = {
            encryptQueryParam: media.encrypt_query_param,
            aesKey: media.aes_key
          };
        }
      } else if (item.type === MessageItemType.FILE && item.file_item) {
        const media = item.file_item.media;
        if (media?.encrypt_query_param && media.aes_key) {
          file = {
            encryptQueryParam: media.encrypt_query_param,
            aesKey: media.aes_key,
            fileName: item.file_item.file_name || `file_${Date.now()}`
          };
        }
      }
    }
  }
  if (!textContent && !image && !file)
    return;
  await onMessage({
    fromUserId,
    messageId: String(msg.message_id || ""),
    text: textContent || (file ? `(file: ${file.fileName})` : "(image)"),
    ...textContent ? {} : { syntheticText: true },
    image,
    file,
    refText
  });
}
__name(processMessage, "processMessage");

// packages/channels/weixin/dist/send.js
init_esbuild_shims();
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync as readFileSync2, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, extname, win32, posix } from "node:path";

// packages/channels/weixin/dist/media.js
init_esbuild_shims();
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
var CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
function buildCdnDownloadUrl(encryptedQueryParam) {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
__name(buildCdnDownloadUrl, "buildCdnDownloadUrl");
function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
__name(decryptAesEcb, "decryptAesEcb");
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid aes_key: expected 16 raw bytes or 32 hex chars, got ${decoded.length} bytes`);
}
__name(parseAesKey, "parseAesKey");
async function downloadAndDecrypt(encryptQueryParam, aesKey) {
  const url = buildCdnDownloadUrl(encryptQueryParam);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4e4);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`CDN download failed: HTTP ${resp.status}`);
    }
    const ciphertext = Buffer.from(await resp.arrayBuffer());
    const keyBuf = parseAesKey(aesKey);
    return decryptAesEcb(ciphertext, keyBuf);
  } finally {
    clearTimeout(timeout);
  }
}
__name(downloadAndDecrypt, "downloadAndDecrypt");
function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
__name(encryptAesEcb, "encryptAesEcb");
function computeMd5(data) {
  return createHash("md5").update(data).digest("hex");
}
__name(computeMd5, "computeMd5");

// packages/channels/weixin/dist/send.js
function markdownToPlainText(text) {
  return text.replace(/```[\s\S]*?\n([\s\S]*?)```/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\*\*\*(.+?)\*\*\*/g, "$1").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/___(.+?)___/g, "$1").replace(/__(.+?)__/g, "$1").replace(/_(.+?)_/g, "$1").replace(/~~(.+?)~~/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/!\[([^\]]*)\]\([^)]+\)/g, "[$1]").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/^>\s+/gm, "").replace(/^[-*_]{3,}$/gm, "---").replace(/^[\s]*[-*+]\s+/gm, "- ").replace(/^[\s]*(\d+)\.\s+/gm, "$1. ").replace(/\n{3,}/g, "\n\n").trim();
}
__name(markdownToPlainText, "markdownToPlainText");
var ALLOWED_EXTS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
var MAX_IMAGE_SIZE = 20 * 1024 * 1024;
function looksLikeWindowsPath(pathValue) {
  return /^[a-zA-Z]:[\\/]/.test(pathValue) || pathValue.startsWith("\\\\");
}
__name(looksLikeWindowsPath, "looksLikeWindowsPath");
function normalizeWindowsPath(pathValue) {
  return pathValue.replace(/\//g, "\\");
}
__name(normalizeWindowsPath, "normalizeWindowsPath");
function isInsideAllowedDir(realPath, allowedDir) {
  const windowsStyle = looksLikeWindowsPath(realPath) || looksLikeWindowsPath(allowedDir);
  const pathImpl = windowsStyle ? win32 : posix;
  const from = windowsStyle ? normalizeWindowsPath(allowedDir) : allowedDir;
  const to = windowsStyle ? normalizeWindowsPath(realPath) : realPath;
  const relative = pathImpl.relative(from, to);
  return relative === "" || !relative.startsWith("..") && !pathImpl.isAbsolute(relative);
}
__name(isInsideAllowedDir, "isInsideAllowedDir");
function trimDisplayDir(dir) {
  if (/^[a-zA-Z]:[\\/]?$/.test(dir))
    return dir;
  const trimmed = dir.replace(/[\\/]+$/, "");
  return trimmed || dir;
}
__name(trimDisplayDir, "trimDisplayDir");
function formatAllowedImageDirs(dirs) {
  return Array.from(new Set(dirs.map(trimDisplayDir))).join(", ");
}
__name(formatAllowedImageDirs, "formatAllowedImageDirs");
function detectImageMime(data) {
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) {
    return "image/png";
  }
  if (data[0] === 71 && data[1] === 73 && data[2] === 70) {
    return "image/gif";
  }
  if (data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70 && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) {
    return "image/webp";
  }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return "image/jpeg";
  }
  throw new Error("Unrecognized image format: magic bytes do not match any supported type");
}
__name(detectImageMime, "detectImageMime");
function validateImagePath(imagePath, workspaceDirs = []) {
  const resolved = resolve(imagePath);
  const ext = extname(resolved).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`Image extension not allowed: ${ext} (path: ${resolved})`);
  }
  const real = (() => {
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
    throw new Error(`Image too large: ${st.size} bytes (max ${MAX_IMAGE_SIZE})`);
  }
  const ALLOWED_DIRS = [
    "/tmp/",
    realpathSync("/tmp/") + "/",
    tmpdir() + "/",
    realpathSync(tmpdir()) + "/",
    ...workspaceDirs.map((d) => realpathSync(resolve(d)) + "/")
  ];
  if (!ALLOWED_DIRS.some((dir) => isInsideAllowedDir(real, dir))) {
    throw new Error(`Image path outside allowed directories: ${real}. Allowed directories: ${formatAllowedImageDirs(ALLOWED_DIRS)}`);
  }
  let fd;
  try {
    fd = openSync(real, "r");
    const head = Buffer.alloc(16);
    const bytesRead = readSync(fd, head, 0, 16, 0);
    const mime = detectImageMime(head.slice(0, bytesRead));
    const extToExpectedMime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp"
    };
    const expected = extToExpectedMime[ext];
    if (mime !== expected) {
      throw new Error(`Image type mismatch: ext=${ext} expects ${expected} but got ${mime}`);
    }
  } finally {
    if (fd !== void 0)
      closeSync(fd);
  }
  return real;
}
__name(validateImagePath, "validateImagePath");
async function sendText(params) {
  const { to, text, baseUrl, token, contextToken } = params;
  await sendMessage(baseUrl, token, {
    to_user_id: to,
    from_user_id: "",
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }]
  });
}
__name(sendText, "sendText");
async function sendImage(params) {
  const { to, imagePath, baseUrl, token, contextToken, workspaceDirs } = params;
  const resolvedPath = validateImagePath(imagePath, workspaceDirs);
  const fileBuffer = readFileSync2(resolvedPath);
  const rawsize = fileBuffer.length;
  const rawfilemd5 = computeMd5(fileBuffer);
  const aesKeyBytes = randomBytes(16);
  const aesKeyHex = aesKeyBytes.toString("hex");
  const filekey = randomBytes(16).toString("hex");
  const encryptedSize = Math.ceil((rawsize + 1) / 16) * 16;
  const uploadParam = await getUploadUrl(baseUrl, token, to, filekey, rawsize, rawfilemd5, encryptedSize, aesKeyHex);
  const encrypted = encryptAesEcb(fileBuffer, aesKeyBytes);
  const cdnEncryptParam = await uploadToCdn(uploadParam, filekey, encrypted);
  const aesKeyBase64 = Buffer.from(aesKeyHex, "ascii").toString("base64");
  await sendMessage(baseUrl, token, {
    to_user_id: to,
    from_user_id: "",
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          aeskey: aesKeyHex,
          mid_size: encryptedSize,
          media: {
            encrypt_query_param: cdnEncryptParam,
            aes_key: aesKeyBase64,
            encrypt_type: 1
          }
        }
      }
    ]
  });
}
__name(sendImage, "sendImage");

// packages/channels/weixin/dist/WeixinAdapter.js
var typingTickets = /* @__PURE__ */ new Map();
var TYPING_KEEPALIVE_INTERVAL_MS = 4e3;
var TYPING_KEEPALIVE_MAX_MS = 10 * 60 * 1e3;
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegex, "escapeRegex");
var WeixinChannel = class extends ChannelBase {
  static {
    __name(this, "WeixinChannel");
  }
  abortController = null;
  activeTypingSessions = /* @__PURE__ */ new Map();
  typingKeepaliveIntervals = /* @__PURE__ */ new Map();
  typingKeepaliveInFlight = /* @__PURE__ */ new Set();
  /**
   * Per-chat generation token; stale setTyping continuations bail out.
   * Entries are reclaimed only by `disconnect()` — deleting them in
   * `stopTyping` would restart the numbering and let a stale continuation
   * carrying the same generation match again.
   */
  typingGenerations = /* @__PURE__ */ new Map();
  baseUrl;
  token = "";
  constructor(name, config, bridge, options) {
    super(name, config, bridge, options);
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  }
  async connect() {
    const imageInstructions = [
      "",
      "If you created an image file (screenshot, chart, etc.), you can send it to the user by writing:",
      "[IMAGE: /absolute/path/to/file.png]",
      "",
      "The marker is stripped from text and the image is uploaded automatically.",
      "",
      "CRITICAL: Only use real file paths. Do NOT write [IMAGE: ...] with:",
      "- Example paths like /path/to/file or /tmp/cat.png",
      "- Placeholder symbols like ...",
      "- Paths that don't exist on disk"
    ].join("\n");
    if (!this.config.instructions) {
      this.config.instructions = [
        "## WeChat Channel",
        "",
        "You are a concise coding assistant responding via WeChat.",
        "Keep responses under 500 characters. Use plain text only.",
        "",
        "Users can also send you images.",
        imageInstructions
      ].join("\n");
    } else if (!this.config.instructions.includes("[IMAGE:")) {
      this.config.instructions = this.config.instructions + "\n" + imageInstructions;
    }
    const account = loadAccount();
    if (!account) {
      throw new Error('WeChat account not configured. Run "qwen channel configure-weixin" first.');
    }
    this.token = account.token;
    if (account.baseUrl) {
      this.baseUrl = account.baseUrl;
    }
    this.abortController = new AbortController();
    startPollLoop({
      baseUrl: this.baseUrl,
      token: this.token,
      onMessage: /* @__PURE__ */ __name(async (msg) => {
        const envelope = {
          channelName: this.name,
          senderId: msg.fromUserId,
          senderName: msg.fromUserId,
          chatId: msg.fromUserId,
          text: msg.text,
          ...msg.syntheticText ? { syntheticText: true } : {},
          isGroup: false,
          isMentioned: false,
          isReplyToBot: false,
          referencedText: msg.refText
        };
        this.handleInboundWithMedia(envelope, msg.image, msg.file).catch((err) => {
          const errMsg = err instanceof Error ? err.message : JSON.stringify(err, null, 2);
          process.stderr.write(`[Weixin:${this.name}] Error handling message: ${errMsg}
`);
        });
      }, "onMessage"),
      abortSignal: this.abortController.signal
    }).catch((err) => {
      if (!this.abortController?.signal.aborted) {
        process.stderr.write(`[Weixin:${this.name}] Poll loop error: ${err}
`);
      }
    });
    process.stderr.write(`[Weixin:${this.name}] Connected to WeChat (${this.baseUrl})
`);
  }
  onPromptStart(chatId, sessionId) {
    this.startTyping(chatId, sessionId);
  }
  onPromptEnd(chatId, sessionId) {
    this.stopTyping(chatId, sessionId);
  }
  onTaskLifecycle(event) {
    if (event.type === "started") {
      this.startTyping(event.chatId, event.sessionId);
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      this.stopTyping(event.chatId, event.sessionId);
    }
  }
  async handleInboundWithMedia(envelope, image, file) {
    await this.prepareThenHandleInbound(envelope, async () => {
      if (image) {
        try {
          const imageData = await downloadAndDecrypt(image.encryptQueryParam, image.aesKey);
          envelope.imageBase64 = imageData.toString("base64");
          envelope.imageMimeType = detectImageMime(imageData);
        } catch (err) {
          process.stderr.write(`[Weixin:${this.name}] Failed to download image: ${err instanceof Error ? err.message : err}
`);
          const failureText = "(User sent an image but download failed)";
          envelope.text = envelope.syntheticText ? failureText : `${envelope.text}

${failureText}`;
        }
      }
      if (file) {
        try {
          const fileData = await downloadAndDecrypt(file.encryptQueryParam, file.aesKey);
          const dir = join2(tmpdir2(), "channel-files", randomUUID2());
          mkdirSync(dir, { recursive: true });
          const filePath = join2(dir, basename(file.fileName) || `file_${Date.now()}`);
          writeFileSync2(filePath, fileData);
          envelope.attachments = [
            {
              type: "file",
              filePath,
              mimeType: "application/octet-stream",
              fileName: file.fileName
            }
          ];
        } catch (err) {
          process.stderr.write(`[Weixin:${this.name}] Failed to download file: ${err instanceof Error ? err.message : err}
`);
          envelope.text = `(User sent a file "${file.fileName}" but download failed)`;
        }
      }
    });
  }
  async sendMessage(chatId, text) {
    await this.sendProjectedMessage(chatId, text);
  }
  async sendThreadMessage(chatId, _threadId, text, sourceLabel) {
    await this.sendProjectedMessage(chatId, text, sourceLabel);
  }
  async sendProjectedMessage(chatId, text, sourceLabel) {
    const contextToken = getContextToken(chatId) || "";
    const textWithoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const imageRegex = /\[IMAGE:\s*([^\]]+)\]/gi;
    const parsedImages = [];
    for (const m of textWithoutCode.matchAll(imageRegex)) {
      const trimmed = m[1]?.trim();
      if (trimmed)
        parsedImages.push(trimmed);
    }
    let cleanedText = text;
    for (const path of parsedImages) {
      cleanedText = cleanedText.replace(new RegExp(`\\[IMAGE:\\s*${escapeRegex(path)}\\]`, "gi"), "");
    }
    cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
    const plainText = cleanedText ? markdownToPlainText(cleanedText) : "";
    const visibleText = plainText ? this.formatAttributedText(plainText, sourceLabel) : parsedImages.length > 0 ? sourceLabel : void 0;
    if (visibleText) {
      await sendText({
        to: chatId,
        text: visibleText,
        baseUrl: this.baseUrl,
        token: this.token,
        contextToken
      });
    }
    if (parsedImages.length) {
      const workspaceDirs = [this.config.cwd];
      for (const imagePath of parsedImages) {
        try {
          await sendImage({
            to: chatId,
            imagePath,
            baseUrl: this.baseUrl,
            token: this.token,
            contextToken,
            workspaceDirs
          });
        } catch (err) {
          const status = err instanceof WeixinApiError ? err.status : 0;
          const ret = err instanceof WeixinApiError ? err.ret : void 0;
          const errcode = err instanceof WeixinApiError ? err.errcode : void 0;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[Weixin:${this.name}] Failed to send image (status=${status} ret=${ret} errcode=${errcode}): ${msg}
`);
          try {
            await sendText({
              to: chatId,
              text: this.formatAttributedText("\u56FE\u7247\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", sourceLabel),
              baseUrl: this.baseUrl,
              token: this.token,
              contextToken
            });
          } catch (fallbackErr) {
            process.stderr.write(`[Weixin:${this.name}] Fallback text also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}
`);
          }
        }
      }
    }
  }
  disconnect() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    for (const interval of this.typingKeepaliveIntervals.values()) {
      clearInterval(interval);
    }
    this.typingKeepaliveIntervals.clear();
    this.typingKeepaliveInFlight.clear();
    this.typingGenerations.clear();
    this.activeTypingSessions.clear();
  }
  startTyping(chatId, sessionId) {
    const sessions = this.activeTypingSessions.get(chatId) ?? /* @__PURE__ */ new Map();
    if (sessions.has(sessionId))
      return;
    const firstSession = sessions.size === 0;
    sessions.set(sessionId, Date.now());
    this.activeTypingSessions.set(chatId, sessions);
    if (!firstSession)
      return;
    const controller = this.abortController;
    const generation = (this.typingGenerations.get(chatId) ?? 0) + 1;
    this.typingGenerations.set(chatId, generation);
    void this.setTyping(chatId, true).then((started) => {
      if (controller !== this.abortController || controller?.signal.aborted) {
        return;
      }
      if (generation !== this.typingGenerations.get(chatId)) {
        if (started && !this.activeTypingSessions.has(chatId)) {
          void this.setTyping(chatId, false);
        }
        return;
      }
      if (started && !this.activeTypingSessions.has(chatId)) {
        void this.setTyping(chatId, false);
        return;
      }
      if (this.activeTypingSessions.has(chatId)) {
        this.startTypingKeepalive(chatId);
      }
    });
  }
  stopTyping(chatId, sessionId) {
    const sessions = this.activeTypingSessions.get(chatId);
    if (!sessions?.delete(sessionId))
      return;
    if (sessions.size > 0)
      return;
    this.activeTypingSessions.delete(chatId);
    this.stopTypingChat(chatId);
  }
  stopTypingChat(chatId) {
    this.typingGenerations.set(chatId, (this.typingGenerations.get(chatId) ?? 0) + 1);
    this.stopTypingKeepalive(chatId);
    void this.setTyping(chatId, false);
  }
  /**
   * Refreshes TYPING periodically while the chat stays in
   * active sessions, so the indicator survives long turns. Each tick expires
   * only sessions that exceeded the backstop; newer sessions in the same chat
   * keep ownership.
   */
  startTypingKeepalive(chatId) {
    if (this.typingKeepaliveIntervals.has(chatId))
      return;
    this.typingKeepaliveIntervals.set(chatId, setInterval(() => {
      const sessions = this.activeTypingSessions.get(chatId);
      if (!sessions) {
        this.stopTypingKeepalive(chatId);
        return;
      }
      const now = Date.now();
      let expiredSessions = 0;
      for (const [sessionId, startedAt] of sessions) {
        if (now - startedAt >= TYPING_KEEPALIVE_MAX_MS) {
          sessions.delete(sessionId);
          expiredSessions++;
        }
      }
      if (expiredSessions > 0) {
        process.stderr.write(`[Weixin:${this.name}] Typing keepalive backstop (${TYPING_KEEPALIVE_MAX_MS}ms) elapsed for ${expiredSessions} session(s) in chat ${chatId}
`);
      }
      if (sessions.size === 0) {
        this.activeTypingSessions.delete(chatId);
        this.stopTypingChat(chatId);
        return;
      }
      if (this.typingKeepaliveInFlight.has(chatId))
        return;
      this.typingKeepaliveInFlight.add(chatId);
      void this.setTyping(chatId, true).finally(() => {
        this.typingKeepaliveInFlight.delete(chatId);
      });
    }, TYPING_KEEPALIVE_INTERVAL_MS));
  }
  stopTypingKeepalive(chatId) {
    const interval = this.typingKeepaliveIntervals.get(chatId);
    if (interval === void 0)
      return;
    clearInterval(interval);
    this.typingKeepaliveIntervals.delete(chatId);
    this.typingKeepaliveInFlight.delete(chatId);
  }
  onSessionDied(sessionId) {
    for (const [chatId, sessions] of this.activeTypingSessions) {
      if (sessions.has(sessionId)) {
        this.stopTyping(chatId, sessionId);
      }
    }
    super.onSessionDied(sessionId);
  }
  async setTyping(userId, typing) {
    try {
      let ticket = typingTickets.get(userId);
      if (!ticket) {
        const contextToken = getContextToken(userId);
        const config = await getConfig(this.baseUrl, this.token, userId, contextToken);
        if (config.typing_ticket) {
          ticket = config.typing_ticket;
          typingTickets.set(userId, ticket);
        }
      }
      if (!ticket)
        return false;
      await sendTyping(this.baseUrl, this.token, {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL
      });
      return true;
    } catch {
      return false;
    }
  }
};

// packages/channels/weixin/dist/index.js
var plugin = {
  channelType: "weixin",
  displayName: "WeChat",
  createChannel: /* @__PURE__ */ __name((name, config, bridge, options) => new WeixinChannel(name, config, bridge, options), "createChannel")
};
export {
  WeixinChannel,
  plugin
};
