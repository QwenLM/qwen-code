/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough, Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StructuredIOReader,
  StructuredInputError,
  parseInboundUserMessage,
  type InboundMessage,
} from './structured-io-reader.js';
import { runLogger } from '../utils/runLogger.js';

vi.mock('../utils/runLogger.js', () => ({ runLogger: { warn: vi.fn() } }));

function user(text: string) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

async function collect(reader: StructuredIOReader): Promise<InboundMessage[]> {
  const messages: InboundMessage[] = [];
  for await (const message of reader.messages()) messages.push(message);
  return messages;
}

function read(chunks: Array<string | Buffer>) {
  return collect(
    new StructuredIOReader({ input: Readable.from(chunks) }),
  );
}

describe('StructuredIOReader wire framing', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['\u2028', '\u2029', '\n', '\r\n', '\r'])(
    'preserves content containing %j as one message',
    async (separator) => {
      const message = user(`12、正文${separator}13、图片说明`);
      expect(await read([JSON.stringify(message) + '\n'])).toEqual([message]);
    },
  );

  it('preserves multibyte text when every UTF-8 byte is a separate chunk', async () => {
    const messages = [user('中文\u2028🙂'), user('尾部\u2029完成')];
    const wire = Buffer.from(
      messages.map((m) => JSON.stringify(m) + '\n').join(''),
    );
    expect(await read(Array.from(wire, (byte) => Buffer.from([byte])))).toEqual(
      messages,
    );
  });

  it('preserves multi-megabyte image data and Unicode separators across chunks', async () => {
    const message = user('12、正文\u202813、图片说明\u2029结束');
    const image = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'A'.repeat(4 * 1024 * 1024),
      },
    };
    const withImage = {
      ...message,
      message: {
        ...message.message,
        content: [image, ...message.message.content],
      },
    };
    const wire = Buffer.from(JSON.stringify(withImage) + '\n');
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < wire.length; offset += 65536)
      chunks.push(wire.subarray(offset, offset + 65536));
    expect(await read(chunks)).toEqual([withImage]);
  });

  it('accepts CRLF, blank lines, BOM and a valid EOF tail', async () => {
    const messages = [user('第一条'), user('最后一条')];
    expect(
      await read([
        ' \r\n\n\uFEFF' + JSON.stringify(messages[0]) + '\r',
        '\n\t\n' + JSON.stringify(messages[1]),
      ]),
    ).toEqual(messages);
  });

  it('yields a complete message before stdin ends', async () => {
    const input = new PassThrough();
    const reader = new StructuredIOReader({ input });
    const iterator = reader.messages();
    const next = iterator.next();
    const message = user('不等待 EOF');
    input.write(JSON.stringify(message) + '\n');
    await expect(next).resolves.toMatchObject({ done: false, value: message });
    reader.close();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    input.destroy();
  });

  it.each(['\n', ''])(
    'fails on malformed JSON with terminator %j without exposing its content',
    async (terminator) => {
      const privateText = 'PRIVATE_PROMPT_AND_BASE64';
      const invalid = `{"type":"user","message":"${privateText}"`;
      const error = await read([invalid + terminator]).catch((e) => e);
      expect(error).toBeInstanceOf(StructuredInputError);
      expect(error).toMatchObject({
        code: 'invalid_stream_json',
        lineNumber: 1,
        charCount: invalid.length,
      });
      expect(error.message).not.toContain(privateText);
      expect(error.cause).toBeUndefined();
      expect(
        JSON.stringify(vi.mocked(runLogger.warn).mock.calls),
      ).not.toContain(privateText);
    },
  );

  it('does not accept later frames after a malformed frame', async () => {
    const input = Readable.from([
      'invalid\n' + JSON.stringify(user('不能执行')) + '\n',
    ]);
    const iterator = new StructuredIOReader({ input }).messages();
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'invalid_stream_json',
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('does not treat a bare CR between objects as a frame delimiter', async () => {
    await expect(
      read([
        JSON.stringify(user('甲')) + '\r' + JSON.stringify(user('乙')) + '\n',
      ]),
    ).rejects.toMatchObject({ code: 'invalid_stream_json' });
  });

  it('retains message routing and rejects invalid control envelopes without logging payloads', async () => {
    const messages = [
      {
        type: 'control_request',
        request_id: 'init',
        request: { subtype: 'initialize' },
      },
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: 'ask', response: {} },
      },
      { type: 'control_cancel_request', request_id: 'cancel' },
      { type: 'control_cancel', request_id: 'legacy' },
      { type: 'keep_alive' },
      user('继续'),
    ];
    const privateText = 'PRIVATE_CONTROL_VALUE';
    const rejected = [
      { type: privateText },
      { type: 'control_request', request: privateText },
      { text: privateText },
    ];
    expect(
      await read(
        [...rejected, ...messages].map((m) => JSON.stringify(m) + '\n'),
      ),
    ).toEqual(messages);
    expect(JSON.stringify(vi.mocked(runLogger.warn).mock.calls)).not.toContain(
      privateText,
    );
  });

  it('closing an idle reader unblocks iteration and leaves the caller stream intact', async () => {
    const input = new PassThrough();
    const reader = new StructuredIOReader({ input });
    const next = reader.messages().next();
    reader.close();
    await expect(next).resolves.toMatchObject({ done: true });
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('close')).toBe(0);
    input.destroy();
  });

  it('does not start reading after it has already been closed', async () => {
    const input = new PassThrough();
    const reader = new StructuredIOReader({ input });
    reader.close();
    expect(await collect(reader)).toEqual([]);
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
  });

  it('completes when the source was already destroyed before reading starts', async () => {
    const input = new PassThrough();
    input.destroy();
    expect(await collect(new StructuredIOReader({ input }))).toEqual([]);
  });

  it('completes when the source reached EOF before reading starts', async () => {
    const input = Readable.from([]);
    for await (const _ of input) {
      // 消费既有 EOF，模拟先关闭再创建读取器的时序。
    }
    expect(await collect(new StructuredIOReader({ input }))).toEqual([]);
  });

  it('propagates a source read error instead of treating it as normal EOF', async () => {
    const input = new PassThrough();
    const iterator = new StructuredIOReader({ input }).messages();
    const next = iterator.next();
    const error = new Error('input transport failed');
    input.destroy(error);
    await expect(next).rejects.toBe(error);
  });
});

describe('SDK 帧里的宿主附带头', () => {
  it('extra_headers 与 custom_context/extra 一并保留', () => {
    const envelope = {
      ...user('hi'),
      custom_context: { tenant: 't1' },
      extra_headers: { 'X-Host-Trace': 'abc' },
      extra: { submitted_at_ms: 1 },
    };
    expect(parseInboundUserMessage(envelope)).toMatchObject({
      custom_context: { tenant: 't1' },
      extra_headers: { 'X-Host-Trace': 'abc' },
      extra: { submitted_at_ms: 1 },
    });
  });

  it('值不是字符串时整帧拒绝，不把半截头带进链路', () => {
    expect(
      parseInboundUserMessage({
        ...user('hi'),
        extra_headers: { 'X-Host-Trace': 1 },
      }),
    ).toBeUndefined();
  });
});
