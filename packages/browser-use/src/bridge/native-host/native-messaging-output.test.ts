/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { FrameDecoder } from '../transport/framing.js';
import {
  encodeNativeMessagingOutput,
  NATIVE_MESSAGE_CHUNK_TYPE,
} from './native-messaging-output.js';

test('chunks host output below the Chrome Native Messaging limit', () => {
  const message = {
    type: 'request',
    id: 'large-request',
    text: '\u0000'.repeat(1_000_000),
  };
  const frames = encodeNativeMessagingOutput(message, 'chunk-1');
  assert.ok(frames.length > 1);
  assert.ok(frames.every((frame) => frame.length <= 1_048_576));

  const decoded = frames.flatMap((frame) => new FrameDecoder().push(frame)) as
    | Array<{
        type: string;
        index: number;
        data: string;
      }>
    | undefined;
  assert.ok(decoded);
  assert.ok(decoded.every((part) => part.type === NATIVE_MESSAGE_CHUNK_TYPE));
  const payload = Buffer.concat(
    decoded
      .sort((left, right) => left.index - right.index)
      .map((part) => Buffer.from(part.data, 'base64')),
  );
  assert.deepEqual(JSON.parse(payload.toString()), message);
});
