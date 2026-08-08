/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DashScopeSseFrame {
  id?: string;
  event?: string;
  httpStatus?: number;
  data: string;
}

interface PendingFrame {
  id?: string;
  event?: string;
  httpStatus?: number;
  dataLines: string[];
}

function createPendingFrame(): PendingFrame {
  return { dataLines: [] };
}

const HTTP_STATUS_COMMENT_RE = /^:HTTP_STATUS\/(\d{3})/;

function applyLine(frame: PendingFrame, line: string): void {
  if (line.length === 0) {
    return;
  }
  if (line.startsWith('id:')) {
    frame.id = line.slice('id:'.length);
    return;
  }
  if (line.startsWith('event:')) {
    frame.event = line.slice('event:'.length);
    return;
  }
  if (line.startsWith('data:')) {
    frame.dataLines.push(line.slice('data:'.length));
    return;
  }
  if (line.startsWith(':')) {
    const match = HTTP_STATUS_COMMENT_RE.exec(line);
    if (match) {
      frame.httpStatus = Number(match[1]);
    }
    return;
  }
  // Any other non-blank line (unrecognized field) is ignored.
}

function toFrame(frame: PendingFrame): DashScopeSseFrame | undefined {
  if (frame.dataLines.length === 0) {
    return undefined;
  }
  return {
    ...(frame.id !== undefined ? { id: frame.id } : {}),
    ...(frame.event !== undefined ? { event: frame.event } : {}),
    ...(frame.httpStatus !== undefined ? { httpStatus: frame.httpStatus } : {}),
    data: frame.dataLines.join('\n'),
  };
}

/**
 * Decodes the native DashScope SSE wire format: field lines with no space
 * after the colon (`data:{...}`), an `:HTTP_STATUS/NNN` comment line carrying
 * the HTTP status, and a blank line terminating each frame. Never throws on
 * malformed content; JSON parsing of `data` happens downstream.
 */
export async function* parseDashScopeSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<DashScopeSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let frame = createPendingFrame();
  let finishedNormally = false;

  function consumeLines(chunk: string): DashScopeSseFrame[] {
    buffer += chunk;
    const frames: DashScopeSseFrame[] = [];
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line.length === 0) {
        const completed = toFrame(frame);
        frame = createPendingFrame();
        if (completed) {
          frames.push(completed);
        }
        continue;
      }
      applyLine(frame, line);
    }
    return frames;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      for (const completed of consumeLines(chunk)) {
        yield completed;
      }
    }

    const finalChunk = decoder.decode();
    for (const completed of consumeLines(finalChunk)) {
      yield completed;
    }
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        applyLine(frame, line);
      }
    }
    const trailing = toFrame(frame);
    if (trailing) {
      yield trailing;
    }
    finishedNormally = true;
  } finally {
    if (!finishedNormally) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
