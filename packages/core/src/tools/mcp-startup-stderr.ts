/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client, Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StringDecoder } from 'node:string_decoder';
import { redactUrlCredentials } from '../extension/redaction.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';

const MAX_CAPTURE_CHARS = 4096;
// Leave room for the connection error in getErrorMessage's 1000-character limit.
const MAX_DISPLAY_CHARS = 512;

export async function connectWithStartupStderr(
  client: Client,
  transport: Transport,
  options: Parameters<Client['connect']>[1],
): Promise<void> {
  if (!(transport instanceof StdioClientTransport) || !transport.stderr) {
    return client.connect(transport, options);
  }

  const stderr = transport.stderr;
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let truncated = false;
  const append = (text: string) => {
    tail += text;
    if (tail.length > MAX_CAPTURE_CHARS) {
      tail = tail.slice(-MAX_CAPTURE_CHARS);
      truncated = true;
    }
  };
  const capture = (chunk: Buffer) => append(decoder.write(chunk));
  stderr.on('data', capture);
  try {
    await client.connect(transport, options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    append(decoder.end());
    // A clipped line may start inside a credential or terminal escape sequence.
    // Drop that incomplete line before applying the existing display policies.
    const completeTail = truncated
      ? tail.slice(
          tail.indexOf('\n') < 0 ? tail.length : tail.indexOf('\n') + 1,
        )
      : tail;
    let diagnostic = redactUrlCredentials(
      completeTail.split('\n').map(stripAnsiAndControl).join('\n'),
    )
      .replace(
        /(^|[ \t{,])(["']?(?:proxy-)?authorization["']?[ \t]*:[ \t]*)[^\n]*/gim,
        '$1$2<redacted>',
      )
      .trim();
    if (diagnostic.length > MAX_DISPLAY_CHARS) {
      diagnostic = diagnostic.slice(-MAX_DISPLAY_CHARS);
      if (/^[\uDC00-\uDFFF]/u.test(diagnostic))
        diagnostic = diagnostic.slice(1);
      truncated = true;
    }
    if (!diagnostic && !truncated) throw error;
    throw new Error(
      `MCP server stderr${truncated ? ' (truncated)' : ''}:\n${diagnostic}\nStartup error: ${getErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    stderr.off('data', capture);
    tail = '';
  }
}
