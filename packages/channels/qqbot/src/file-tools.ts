/**
 * QQ outbound file tool exposed to the agent as a client MCP tool.
 *
 * The model calls it with a local path; the adapter owns the chat binding, the
 * credentials and the platform upload. This module owns the schema, the
 * workspace path boundary, and the text the model sees.
 *
 * The boundary is deliberately narrow: a path is only readable when it is an
 * absolute path that resolves inside the session's workspace or the system
 * temporary directory. Sending a file is an outbound action with the bot's own
 * identity, so it stays opt-in and its failures are reported, never silently
 * downgraded to a text message.
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

const MAX_FILE_NAME_CHARS = 100;

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
  sendFile(input: {
    sessionId: string;
    chatId: string;
    fileName: string;
    bytes: Buffer;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  log(message: string): void;
}

const SEND_FILE_TOOL = {
  name: 'qq_send_file',
  description:
    'Send a local file to the current QQ chat, where it arrives as a file card the user can download. Use it when the user asks for a document, image, archive, spreadsheet or any other generated artifact. The path must be absolute and inside the session workspace or the system temporary directory; the file must be non-empty and at most 20 MiB.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Absolute path of the local file to send, inside the session workspace or the system temporary directory.',
      },
      file_name: {
        type: 'string',
        description:
          "Display name for the file. Defaults to the file's own name.",
      },
    },
    required: ['path'],
  },
};

export function buildFileTools(deps: QQFileToolDeps): ChannelToolDefinition[] {
  return [
    {
      name: SEND_FILE_TOOL.name,
      description: SEND_FILE_TOOL.description,
      inputSchema: SEND_FILE_TOOL.inputSchema,
      async handler(
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
            'No QQ chat is bound to this session yet, so no file can be sent.',
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
          );
        } catch (error) {
          if (error instanceof QQOutboundFileError) {
            return fail(`${SEND_FILE_TOOL.name}: ${error.message}`);
          }
          throw error;
        }
        const requestedName = args['file_name'];
        const fileName =
          typeof requestedName === 'string' && requestedName.trim() !== ''
            ? safeFileName(requestedName) || file.fileName
            : file.fileName;
        const result = await deps.sendFile({
          sessionId: context.sessionId,
          chatId: chat.chatId,
          fileName,
          bytes: file.bytes,
        });
        if (!result.ok) {
          deps.log(`${SEND_FILE_TOOL.name} failed: ${result.message}`);
          return fail(result.message);
        }
        deps.log(`${SEND_FILE_TOOL.name} ok (${file.bytes.length} bytes)`);
        return `File sent (${fileName}).`;
      },
    },
  ];
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
 */
export function readOutboundFile(
  filePath: string,
  workspaceDir: string | undefined,
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
    if (before.size > QQ_OUTBOUND_FILE_MAX_BYTES) {
      throw new QQOutboundFileError(
        `the file is larger than ${QQ_OUTBOUND_FILE_MAX_BYTES / (1024 * 1024)} MiB.`,
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
    return { bytes, fileName: basename(resolved) };
  } finally {
    closeSync(fd);
  }
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
