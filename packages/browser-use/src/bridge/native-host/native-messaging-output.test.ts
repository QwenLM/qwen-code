/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { encodeFrame, FrameDecoder } from '../transport/framing.js';
import {
  encodeNativeMessagingOutput,
  NATIVE_MESSAGE_CHUNK_TYPE,
} from './native-messaging-output.js';

// The wire contract this module exists to honour (docs/design/browser-use.md:
// "Native Host messages sent to Chrome are limited to 1 MiB"). Pinned as a
// literal on purpose: a boundary derived from the module's own threshold
// would follow the threshold if it were ever raised past what Chrome accepts.
const CHROME_NATIVE_MESSAGE_LIMIT_BYTES = 1_048_576;

interface ChunkEnvelope {
  type: string;
  id: string;
  index: number;
  total: number;
  data: string;
}

function decodeAll(frames: Buffer[]): ChunkEnvelope[] {
  return frames.flatMap(
    (frame) => new FrameDecoder().push(frame) as ChunkEnvelope[],
  );
}

/** A request whose encoded frame is exactly `frameBytes` long. */
function messageWithFrameLength(frameBytes: number): {
  type: string;
  id: string;
  text: string;
} {
  const base = { type: 'request', id: 'boundary', text: '' };
  const overhead = encodeFrame(base).length;
  return { ...base, text: 'a'.repeat(frameBytes - overhead) };
}

test('chunks host output below the Chrome Native Messaging limit', () => {
  const message = {
    type: 'request',
    id: 'large-request',
    text: '\u0000'.repeat(1_000_000),
  };
  const frames = encodeNativeMessagingOutput(message, 'chunk-1');
  assert.ok(frames.length > 1);
  assert.ok(
    frames.every((frame) => frame.length <= CHROME_NATIVE_MESSAGE_LIMIT_BYTES),
  );

  const decoded = decodeAll(frames);
  assert.equal(decoded.length, frames.length);
  // The envelope the extension validates before reassembly: the caller's id,
  // a 0-based contiguous index in emission order, and the group total.
  decoded.forEach((part, index) => {
    const { data, ...envelope } = part;
    assert.deepEqual(envelope, {
      type: NATIVE_MESSAGE_CHUNK_TYPE,
      id: 'chunk-1',
      index,
      total: frames.length,
    });
    assert.equal(typeof data, 'string');
  });
  const payload = Buffer.concat(
    decoded.map((part) => Buffer.from(part.data, 'base64')),
  );
  assert.deepEqual(JSON.parse(payload.toString()), message);
});

test('sends a frame exactly at the Chrome limit unchunked', () => {
  const message = messageWithFrameLength(CHROME_NATIVE_MESSAGE_LIMIT_BYTES);
  const frames = encodeNativeMessagingOutput(message, 'chunk-2');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.length, CHROME_NATIVE_MESSAGE_LIMIT_BYTES);
  assert.deepEqual(new FrameDecoder().push(frames[0]!), [message]);
});

test('chunks a frame one byte over the Chrome limit', () => {
  const message = messageWithFrameLength(CHROME_NATIVE_MESSAGE_LIMIT_BYTES + 1);
  const frames = encodeNativeMessagingOutput(message, 'chunk-3');
  assert.ok(frames.length > 1);
  assert.ok(
    frames.every((frame) => frame.length <= CHROME_NATIVE_MESSAGE_LIMIT_BYTES),
  );
  const decoded = decodeAll(frames);
  assert.deepEqual(
    decoded.map(({ type, id, index, total }) => ({ type, id, index, total })),
    decoded.map((_, index) => ({
      type: NATIVE_MESSAGE_CHUNK_TYPE,
      id: 'chunk-3',
      index,
      total: frames.length,
    })),
  );
  const payload = Buffer.concat(
    decoded.map((part) => Buffer.from(part.data, 'base64')),
  );
  assert.deepEqual(JSON.parse(payload.toString()), message);
});
