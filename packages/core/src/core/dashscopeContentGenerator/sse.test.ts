/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseDashScopeSse, type DashScopeSseFrame } from './sse.js';

function streamFromString(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function streamByteAtATime(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(index, index + 1));
      index += 1;
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<DashScopeSseFrame[]> {
  const frames: DashScopeSseFrame[] = [];
  for await (const frame of parseDashScopeSse(stream)) {
    frames.push(frame);
  }
  return frames;
}

const THREE_FRAME_SAMPLE = [
  'id:1',
  'event:result',
  ':HTTP_STATUS/200',
  'data:{"output":{"choices":[{"finish_reason":"null","message":{"role":"assistant","content":[],"reasoning_content":"The"}}]}}',
  '',
  'id:2',
  'event:result',
  ':HTTP_STATUS/200',
  'data:{"output":{"choices":[{"finish_reason":"null","message":{"role":"assistant","content":[{"text":"Hi"}]}}]}}',
  '',
  'id:3',
  'event:result',
  ':HTTP_STATUS/200',
  'data:{"output":{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":[]}}]}}',
  '',
].join('\n');

describe('parseDashScopeSse', () => {
  it('parses a whole-body 3-frame sample into 3 frames', async () => {
    const frames = await collect(streamFromString(THREE_FRAME_SAMPLE));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({
      id: '1',
      event: 'result',
      httpStatus: 200,
      data: '{"output":{"choices":[{"finish_reason":"null","message":{"role":"assistant","content":[],"reasoning_content":"The"}}]}}',
    });
    expect(frames[1].id).toBe('2');
    expect(frames[2].data).toContain('"finish_reason":"stop"');
  });

  it('parses byte-at-a-time identically to the whole-body parse', async () => {
    const wholeFrames = await collect(streamFromString(THREE_FRAME_SAMPLE));
    const byteFrames = await collect(streamByteAtATime(THREE_FRAME_SAMPLE));
    expect(byteFrames).toEqual(wholeFrames);
  });

  it('tolerates CRLF line endings', async () => {
    const crlfSample = THREE_FRAME_SAMPLE.split('\n').join('\r\n');
    const frames = await collect(streamFromString(crlfSample));
    expect(frames).toHaveLength(3);
    expect(frames[0].id).toBe('1');
    expect(frames[0].httpStatus).toBe(200);
  });

  it('joins multiple data: lines in one frame with a newline', async () => {
    const body = [
      'id:1',
      'event:result',
      'data:{"a":1}',
      'data:{"b":2}',
      '',
    ].join('\n');
    const frames = await collect(streamFromString(body));
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('{"a":1}\n{"b":2}');
  });

  it('surfaces an event:error frame with :HTTP_STATUS/400', async () => {
    const body = [
      'id:1',
      'event:error',
      ':HTTP_STATUS/400',
      'data:{"code":"InvalidParameter","message":"<400> bad request","request_id":"req-1"}',
      '',
    ].join('\n');
    const frames = await collect(streamFromString(body));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: '1',
      event: 'error',
      httpStatus: 400,
    });
  });

  it('flushes a trailing frame without a final blank line at EOF', async () => {
    const body = ['id:1', 'event:result', 'data:{"a":1}'].join('\n');
    const frames = await collect(streamFromString(body));
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('{"a":1}');
  });

  it('does not yield a frame with no data: lines', async () => {
    const body = ['id:1', 'event:result', ':HTTP_STATUS/200', ''].join('\n');
    const frames = await collect(streamFromString(body));
    expect(frames).toHaveLength(0);
  });

  it('releases the reader lock after normal completion', async () => {
    const stream = streamFromString(THREE_FRAME_SAMPLE);
    for await (const _frame of parseDashScopeSse(stream)) {
      // drain
    }
    expect(stream.locked).toBe(false);
  });

  it('cancels the underlying reader when the generator is returned early', async () => {
    const stream = streamFromString(THREE_FRAME_SAMPLE);
    const generator = parseDashScopeSse(stream);
    await generator.next();
    await generator.return(undefined);
    expect(stream.locked).toBe(false);
  });
});
