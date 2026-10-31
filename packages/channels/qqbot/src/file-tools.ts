/**
 * QQ outbound media tools exposed to the agent as client MCP tools.
 *
 * The model calls one with a local path; the adapter owns the chat binding, the
 * credentials and the platform upload. This module owns the schemas, the
 * workspace path boundary, the format and size validation, and the text the
 * model sees.
 *
 * The boundary is deliberately narrow: a path is only readable when it is an
 * absolute path that resolves inside the session's workspace or the system
 * temporary directory. Sending media is an outbound action with the bot's own
 * identity, so it stays opt-in and its failures are reported, never silently
 * downgraded to a text message or to a different message kind.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, sep } from 'node:path';
import type {
  ChannelLoopToolResult,
  ChannelToolDefinition,
} from '@qwen-code/channel-base';

/** Platform hard limit is 200 MB; the repository's outbound-file convention is
 *  20 MiB, which keeps the file in memory and the exposure bounded. */
export const QQ_OUTBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** The media caps are the platform's decimal soft limits: a larger image, video,
 *  or voice upload is quietly downgraded by the platform to a file card, so the
 *  tool refuses it locally instead of reporting a different visible outcome. */
export const QQ_OUTBOUND_IMAGE_MAX_BYTES = 20_000_000;
export const QQ_OUTBOUND_VIDEO_MAX_BYTES = 30_000_000;
export const QQ_OUTBOUND_VOICE_MAX_BYTES = 20_000_000;

const MAX_FILE_NAME_CHARS = 100;

export type QQMediaKind = 'file' | 'image' | 'video' | 'voice';

/** Tool names, also used by the adapter to prefix failures. */
export const QQ_MEDIA_TOOL_NAMES: Record<QQMediaKind, string> = {
  file: 'qq_send_file',
  image: 'qq_send_image',
  video: 'qq_send_video',
  voice: 'qq_send_voice',
};

const OUTBOUND_MAX_BYTES: Record<QQMediaKind, number> = {
  file: QQ_OUTBOUND_FILE_MAX_BYTES,
  image: QQ_OUTBOUND_IMAGE_MAX_BYTES,
  video: QQ_OUTBOUND_VIDEO_MAX_BYTES,
  voice: QQ_OUTBOUND_VOICE_MAX_BYTES,
};

export interface QQOutboundFile {
  bytes: Buffer;
  fileName: string;
}

/** A rejected path or file; the message is safe to show the model. */
export class QQOutboundFileError extends Error {}

export interface QQFileToolDeps {
  /** Chat bound to the agent session that invoked the tool. */
  resolveChat(sessionId: string): { chatId: string } | undefined;
  /** Workspace the session runs in; the path boundary's first root. */
  sessionCwd(sessionId: string): string | undefined;
  /** Upload and send; the adapter owns route, reply anchor and msg_seq. */
  sendMedia(input: {
    sessionId: string;
    chatId: string;
    kind: QQMediaKind;
    fileName: string;
    bytes: Buffer;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  log(message: string): void;
}

const PATH_PROPERTY = {
  type: 'string',
  description:
    'Absolute path of the local file to send, inside the session workspace or the system temporary directory.',
};

const FILE_NAME_PROPERTY = {
  type: 'string',
  description: "Display name for the file. Defaults to the file's own name.",
};

interface OutboundMediaSpec {
  kind: QQMediaKind;
  /** Noun used in the success line and the no-chat failure. */
  noun: string;
  description: string;
}

const MEDIA_SPECS: OutboundMediaSpec[] = [
  {
    kind: 'file',
    noun: 'File',
    description:
      'Send a local file to the current QQ chat, where it arrives as a file card the user can download. Use it when the user asks for a document, archive, spreadsheet or any other generated artifact, or when a file cannot be sent as an image, video or voice message. The path must be absolute and inside the session workspace or the system temporary directory; the file must be non-empty and at most 20 MiB.',
  },
  {
    kind: 'image',
    noun: 'Image',
    description:
      'Send a local PNG or JPEG image to the current QQ chat, where it is rendered as an image. Use it when the user asks for a picture, chart, screenshot or photo. The path must be absolute and inside the session workspace or the system temporary directory; the file must be a non-empty PNG or JPEG of at most 20 MB. Use qq_send_file for an image in any other format, so it arrives as a downloadable file card.',
  },
  {
    kind: 'video',
    noun: 'Video',
    description:
      'Send a local MP4 video to the current QQ chat, where it is rendered as a playable video. The path must be absolute and inside the session workspace or the system temporary directory; the file must be a non-empty MP4 of at most 30 MB. Use qq_send_file for a video in any other format, so it arrives as a downloadable file card.',
  },
  {
    kind: 'voice',
    noun: 'Voice',
    description:
      'Send a local voice message to the current QQ chat, where it is rendered as a voice bar. The path must be absolute and inside the session workspace or the system temporary directory; the file must be a non-empty SILK, MP3, WAV or OGG recording of at most 20 MB. Use qq_send_file for audio in any other format, so it arrives as a downloadable file card.',
  },
];

export function buildFileTools(deps: QQFileToolDeps): ChannelToolDefinition[] {
  return MEDIA_SPECS.map((spec) => ({
    name: QQ_MEDIA_TOOL_NAMES[spec.kind],
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        ...(spec.kind === 'file' ? { file_name: FILE_NAME_PROPERTY } : {}),
      },
      required: ['path'],
    },
    handler: makeHandler(deps, spec),
  }));
}

function makeHandler(deps: QQFileToolDeps, spec: OutboundMediaSpec) {
  const toolName = QQ_MEDIA_TOOL_NAMES[spec.kind];
  return async function handler(
    args: Record<string, unknown>,
    context: { sessionId: string },
  ): Promise<string | ChannelLoopToolResult> {
    const fail = (text: string): ChannelLoopToolResult => ({
      text,
      isError: true,
    });
    const chat = deps.resolveChat(context.sessionId);
    if (!chat) {
      return fail(
        `No QQ chat is bound to this session yet, so no ${spec.noun.toLowerCase()} can be sent.`,
      );
    }
    let file: QQOutboundFile;
    try {
      const requested = args['path'];
      if (typeof requested !== 'string' || requested.trim() === '') {
        throw new QQOutboundFileError('path is required.');
      }
      file = readOutboundFile(
        requested.trim(),
        deps.sessionCwd(context.sessionId),
        spec.kind,
      );
    } catch (error) {
      if (error instanceof QQOutboundFileError) {
        return fail(`${toolName}: ${error.message}`);
      }
      throw error;
    }
    const requestedName = args['file_name'];
    const fileName =
      spec.kind === 'file' &&
      typeof requestedName === 'string' &&
      requestedName.trim() !== ''
        ? safeFileName(requestedName) || file.fileName
        : file.fileName;
    const result = await deps.sendMedia({
      sessionId: context.sessionId,
      chatId: chat.chatId,
      kind: spec.kind,
      fileName,
      bytes: file.bytes,
    });
    if (!result.ok) {
      deps.log(`${toolName} failed: ${result.message}`);
      return fail(result.message);
    }
    deps.log(`${toolName} ok (${file.bytes.length} bytes)`);
    return `${spec.noun} sent (${fileName}).`;
  };
}

/**
 * Read a file the model asked to send, refusing anything outside the session
 * workspace or the temporary directory.
 *
 * `realpathSync` resolves symlinks before the root check, so a link inside the
 * workspace cannot smuggle an outside file, and `O_NOFOLLOW` refuses a final
 * component swapped to a symlink after that check. Two further guards close the
 * ways a path check alone is blind: a file with more than one hard link is
 * refused (a hard link has no target to resolve, so the check would otherwise
 * read the linked contents), and where the platform exposes `/proc/self/fd` the
 * descriptor is re-resolved after opening, which catches a directory component
 * swapped between the check and the open. The read is re-checked against
 * `fstat` so a file rewritten mid-read is reported instead of sent truncated.
 *
 * `kind` picks the byte cap and the format the bytes must match. The sniff runs
 * on the same descriptor that was already validated, so the bytes that were
 * checked are the bytes that are uploaded.
 */
export function readOutboundFile(
  filePath: string,
  workspaceDir: string | undefined,
  kind: QQMediaKind = 'file',
): QQOutboundFile {
  if (!isAbsolute(filePath)) {
    throw new QQOutboundFileError('path must be absolute.');
  }
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    throw new QQOutboundFileError('the file does not exist.');
  }
  const roots: string[] = [];
  for (const root of [workspaceDir, tmpdir()]) {
    if (!root) continue;
    try {
      roots.push(realpathSync(root));
    } catch {
      // A missing workspace root simply contributes no allowed root.
    }
  }
  if (!insideRoots(resolved, roots)) {
    throw new QQOutboundFileError(
      'the file is outside the session workspace and the temporary directory.',
    );
  }

  const fd = openSync(
    resolved,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new QQOutboundFileError('the path is not a regular file.');
    }
    if (before.nlink > 1) {
      throw new QQOutboundFileError(
        'the file has more than one hard link, so its contents are not tied to the workspace.',
      );
    }
    const openedPath = descriptorPath(fd);
    if (openedPath !== undefined && !insideRoots(openedPath, roots)) {
      throw new QQOutboundFileError(
        'the file is outside the session workspace and the temporary directory.',
      );
    }
    if (before.size === 0) {
      throw new QQOutboundFileError('the file is empty.');
    }
    const maxBytes = OUTBOUND_MAX_BYTES[kind];
    if (before.size > maxBytes) {
      throw new QQOutboundFileError(
        `the file is larger than ${formatCap(kind, maxBytes)}.`,
      );
    }
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const chunk = readSync(fd, bytes, read, bytes.length - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    if (read !== bytes.length) {
      throw new QQOutboundFileError('the file could not be read completely.');
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new QQOutboundFileError(
        'the file changed while it was being read; try again.',
      );
    }
    if (!matchesKind(kind, bytes)) {
      throw new QQOutboundFileError(
        `the file is not ${FORMAT_TEXT[kind]}; use qq_send_file to send it as a file card.`,
      );
    }
    return { bytes, fileName: basename(resolved) };
  } finally {
    closeSync(fd);
  }
}

const FORMAT_TEXT: Record<QQMediaKind, string> = {
  file: 'a file',
  image: 'a PNG or JPEG image',
  video: 'an MP4 video',
  voice: 'SILK, MP3, WAV or OGG audio',
};

function formatCap(kind: QQMediaKind, maxBytes: number): string {
  return kind === 'file'
    ? `${maxBytes / (1024 * 1024)} MiB`
    : `${maxBytes / 1_000_000} MB`;
}

/** Magic-byte check; the file name is model-supplied and decides nothing. */
function matchesKind(kind: QQMediaKind, bytes: Buffer): boolean {
  switch (kind) {
    case 'file':
      return true;
    case 'image':
      return isPng(bytes) || isJpeg(bytes);
    case 'video':
      return isMp4(bytes);
    case 'voice':
      return isSilk(bytes) || isMp3(bytes) || isWav(bytes) || isOgg(bytes);
    default:
      return false;
  }
}

function hasAscii(bytes: Buffer, offset: number, text: string): boolean {
  return (
    bytes.length >= offset + text.length &&
    bytes.toString('latin1', offset, offset + text.length) === text
  );
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && hasAscii(bytes, 1, 'PNG');
}

function isJpeg(bytes: Buffer): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function isMp4(bytes: Buffer): boolean {
  return hasAscii(bytes, 4, 'ftyp');
}

/** SILK v3 starts with `#!SILK_V3`, with a leading format byte in some files. */
function isSilk(bytes: Buffer): boolean {
  return hasAscii(bytes, 0, '#!SILK_V3') || hasAscii(bytes, 1, '#!SILK_V3');
}

function isMp3(bytes: Buffer): boolean {
  return (
    hasAscii(bytes, 0, 'ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  );
}

function isWav(bytes: Buffer): boolean {
  return hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WAVE');
}

function isOgg(bytes: Buffer): boolean {
  return hasAscii(bytes, 0, 'OggS');
}

/** Whether a resolved path is one of the allowed roots or below one. */
function insideRoots(path: string, roots: string[]): boolean {
  return roots.some(
    (root) =>
      path === root || path.startsWith(root.endsWith(sep) ? root : root + sep),
  );
}

/**
 * The path a descriptor actually points at, when the platform exposes one.
 * `/proc/self/fd` is the Linux answer; elsewhere there is nothing to ask, so
 * the caller keeps the pre-open check as its only guard.
 */
function descriptorPath(fd: number): string | undefined {
  try {
    return realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** The platform file name is model-supplied, so drop separators and controls. */
function safeFileName(name: string): string {
  let cleaned = '';
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '/' || char === '\\') continue;
    // Bidi overrides would let a display name read as something it is not.
    if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      continue;
    if (code === 0x200e || code === 0x200f) continue;
    // A lone surrogate (only reachable from malformed input) cannot be encoded.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    cleaned += char;
  }
  // Slice by code point: a UTF-16 slice can cut a surrogate pair in half.
  return [...cleaned.trim()].slice(0, MAX_FILE_NAME_CHARS).join('');
}
