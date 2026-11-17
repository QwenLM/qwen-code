/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthLine,
  buildUserFrame,
  encodePeerFrame,
  MAX_FRAME_CHARS,
} from '../../../src/peer/frames.js';
import { startPeerInbox, type PeerInbox } from '../../../src/peer/inbox.js';

vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof net>()),
  createServer: vi.fn(),
}));

vi.mock('../../../src/peer/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/peer/client.js')>()),
  probePeerSocketVerdict: vi.fn().mockResolvedValue('dead'),
}));

function frameOfLength(length: number): string {
  const frame = buildUserFrame({ content: '' });
  const overhead = encodePeerFrame(frame).length - 1;
  frame.message.content = 'x'.repeat(length - overhead);
  return encodePeerFrame(frame);
}

describe('peer inbox frame limits', () => {
  let root: string;
  let inbox: PeerInbox;
  let socket: EventEmitter & { destroy: () => void };
  const onFrame = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-'));
    const server = Object.assign(new EventEmitter(), {
      listen: (target: string, onListening: () => void) => {
        fs.writeFileSync(target, '');
        onListening();
      },
      close: (onClose: () => void) => onClose(),
      unref: vi.fn(),
    });
    vi.mocked(net.createServer).mockReturnValue(
      server as unknown as net.Server,
    );
    inbox = await startPeerInbox({
      socketPath: path.join(root, 'inbox.sock'),
      requiredToken: 'token',
      onFrame,
      keepAlive: false,
    });
    socket = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      unref: vi.fn(),
      destroy: vi.fn(() => socket.emit('close')),
      end: vi.fn(),
    });
    const accept = vi.mocked(net.createServer).mock.calls[0]?.[1];
    if (!accept) throw new Error('Expected the inbox connection listener');
    accept(socket as unknown as net.Socket);
    socket.emit('data', buildAuthLine('token'));
  });

  afterEach(async () => {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    'rejects an oversized completed frame and the remaining batch (split: %s)',
    (split) => {
      const frame = frameOfLength(MAX_FRAME_CHARS + 1);
      if (split) socket.emit('data', frame.slice(0, MAX_FRAME_CHARS - 10));
      socket.emit(
        'data',
        (split ? frame.slice(MAX_FRAME_CHARS - 10) : frame) +
          encodePeerFrame(buildUserFrame({ content: 'after overflow' })),
      );
      expect(onFrame).not.toHaveBeenCalled();
      expect(socket.destroy).toHaveBeenCalledOnce();
    },
  );

  it('accepts a completed frame exactly at the limit', () => {
    socket.emit('data', frameOfLength(MAX_FRAME_CHARS));
    expect(onFrame).toHaveBeenCalledOnce();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('measures individual lines instead of the total batch size', () => {
    const frame = frameOfLength(MAX_FRAME_CHARS / 2 + 1);
    socket.emit('data', frame + frame);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('still rejects an oversized unfinished line', () => {
    socket.emit('data', 'x'.repeat(MAX_FRAME_CHARS + 1));
    expect(onFrame).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
