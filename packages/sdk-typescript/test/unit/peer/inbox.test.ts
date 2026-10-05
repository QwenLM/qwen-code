/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthLine,
  buildUserFrame,
  encodePeerFrame,
  MAX_FRAME_CHARS,
  type PeerFrame,
} from '../../../src/peer/frames.js';
import {
  MAX_SOCKET_PATH_BYTES,
  resolveInboxCandidates,
  startPeerInbox,
  type PeerInbox,
} from '../../../src/peer/inbox.js';
import { dial, makeTempRoot, noUnixSockets } from './helpers.js';

const TOKEN = 'a'.repeat(64);

describe('resolveInboxCandidates', () => {
  it.runIf(process.platform !== 'win32')(
    'prefers the runtime directory, then nonce directories that fit sun_path',
    () => {
      const saved = process.env['XDG_RUNTIME_DIR'];
      process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';
      try {
        const candidates = resolveInboxCandidates(4242);
        expect(candidates[0]).toBe('/run/user/1000/qwen-socks/4242.sock');
        expect(candidates.at(-1)).toMatch(
          /^\/tmp\/qwen-socks-[0-9a-f]{16}\/4242\.sock$/,
        );
        for (const candidate of candidates) {
          expect(Buffer.byteLength(candidate)).toBeLessThanOrEqual(
            MAX_SOCKET_PATH_BYTES,
          );
        }
      } finally {
        if (saved === undefined) delete process.env['XDG_RUNTIME_DIR'];
        else process.env['XDG_RUNTIME_DIR'] = saved;
      }
    },
  );
});

describe.skipIf(noUnixSockets)('startPeerInbox', () => {
  let root: string;
  let frames: PeerFrame[];
  const opened: PeerInbox[] = [];
  const servers: net.Server[] = [];

  beforeEach(() => {
    root = makeTempRoot();
    frames = [];
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((inbox) => inbox.close()));
    for (const server of servers.splice(0)) server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function open(
    name = 'inbox.sock',
    options: {
      lineDeadlineMs?: number;
      onFrame?: (frame: PeerFrame) => void;
    } = {},
  ): Promise<PeerInbox> {
    const inbox = await startPeerInbox({
      socketPath: path.join(root, 'socks', name),
      requiredToken: TOKEN,
      onFrame: options.onFrame ?? ((frame) => frames.push(frame)),
      keepAlive: false,
      ...(options.lineDeadlineMs !== undefined
        ? { lineDeadlineMs: options.lineDeadlineMs }
        : {}),
    });
    opened.push(inbox);
    return inbox;
  }

  it('binds an owner-only socket in an owner-only directory', async () => {
    const inbox = await open();
    expect(inbox.socketPath).toBe(path.join(root, 'socks', 'inbox.sock'));
    expect(fs.statSync(inbox.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(inbox.socketPath)).mode & 0o777).toBe(
      0o700,
    );
  });

  it('delivers frames only after the right token', async () => {
    const inbox = await open();
    const frame = buildUserFrame({ content: 'hello' });

    await dial(inbox.socketPath, encodePeerFrame(frame));
    await dial(
      inbox.socketPath,
      buildAuthLine('b'.repeat(64)) + encodePeerFrame(frame),
    );
    // A refusal is final: a correct auth line after a wrong one changes nothing.
    await dial(
      inbox.socketPath,
      buildAuthLine('wrong') + buildAuthLine(TOKEN) + encodePeerFrame(frame),
    );
    expect(frames).toEqual([]);

    await dial(inbox.socketPath, buildAuthLine(TOKEN) + encodePeerFrame(frame));
    expect(frames).toEqual([frame]);
  });

  it('skips lines that do not parse and keeps reading', async () => {
    const inbox = await open();
    const frame = buildUserFrame({ content: 'after junk' });
    await dial(
      inbox.socketPath,
      `${buildAuthLine(TOKEN)}not json\n{"msgV":9}\n${encodePeerFrame(frame)}`,
    );
    expect(frames).toEqual([frame]);
  });

  it('survives a callback that throws', async () => {
    const onFrame = vi.fn(() => {
      throw new Error('boom');
    });
    const inbox = await open('throwing.sock', { onFrame });
    const line =
      buildAuthLine(TOKEN) + encodePeerFrame(buildUserFrame({ content: 'x' }));
    await dial(inbox.socketPath, line);
    await dial(inbox.socketPath, line);
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it('drops a connection that completes no line in time, or sends an over-long one', async () => {
    const inbox = await open('slow.sock', { lineDeadlineMs: 50 });
    const started = Date.now();
    await dial(inbox.socketPath, '{"msgV":1', { end: false });
    expect(Date.now() - started).toBeLessThan(5_000);

    await dial(
      inbox.socketPath,
      buildAuthLine(TOKEN) + 'x'.repeat(MAX_FRAME_CHARS + 16),
      { end: false },
    );
    expect(frames).toEqual([]);
  });

  it('binds beside a socket something is still listening on, instead of taking it', async () => {
    const requested = path.join(root, 'socks', 'inbox.sock');
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    const occupant = net.createServer();
    servers.push(occupant);
    await new Promise<void>((resolve) => occupant.listen(requested, resolve));

    const inbox = await open();
    expect(path.basename(inbox.socketPath)).toMatch(
      /^inbox-[0-9a-f]{8}\.sock$/,
    );
    expect(fs.existsSync(requested)).toBe(true);
  });

  it.runIf(process.platform === 'linux')(
    'replaces a file nothing listens on',
    async () => {
      const requested = path.join(root, 'socks', 'inbox.sock');
      fs.mkdirSync(path.dirname(requested), { recursive: true });
      fs.writeFileSync(requested, '');
      const inbox = await open();
      expect(inbox.socketPath).toBe(requested);
    },
  );

  it('removes its socket on close, asynchronously or not', async () => {
    const first = await open('first.sock');
    const second = await open('second.sock');
    await first.close();
    second.closeSync();
    expect(fs.existsSync(first.socketPath)).toBe(false);
    expect(fs.existsSync(second.socketPath)).toBe(false);
    await first.close();
  });

  it('fails with bind-failed for a path it cannot use', async () => {
    await expect(
      startPeerInbox({
        socketPath: 'relative.sock',
        requiredToken: TOKEN,
        onFrame: () => {},
      }),
    ).rejects.toMatchObject({ name: 'PeerEndpointError', code: 'bind-failed' });
    await expect(
      startPeerInbox({
        socketPath: path.join(
          root,
          'x'.repeat(MAX_SOCKET_PATH_BYTES),
          'i.sock',
        ),
        requiredToken: TOKEN,
        onFrame: () => {},
      }),
    ).rejects.toMatchObject({ code: 'bind-failed' });
  });
});

describe.skipIf(noUnixSockets)('startPeerInbox — defensive paths', () => {
  let root: string;
  const opened: PeerInbox[] = [];
  const servers: net.Server[] = [];

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((inbox) => inbox.close()));
    for (const server of servers.splice(0)) server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function open(socketPath: string, frames: PeerFrame[] = []) {
    const inbox = await startPeerInbox({
      socketPath,
      requiredToken: TOKEN,
      onFrame: (frame) => frames.push(frame),
      keepAlive: false,
    });
    opened.push(inbox);
    return inbox;
  }

  it('leaves the permissions of a directory a caller chose alone', async () => {
    const deploy = path.join(root, 'deploy');
    fs.mkdirSync(deploy);
    fs.chmodSync(deploy, 0o755);
    const inbox = await open(path.join(deploy, 'agent.sock'));
    expect(fs.statSync(deploy).mode & 0o777).toBe(0o755);
    expect(fs.statSync(inbox.socketPath).mode & 0o777).toBe(0o600);
  });

  it('tightens a socket directory that already existed', async () => {
    const socks = path.join(root, 'qwen-socks');
    fs.mkdirSync(socks);
    fs.chmodSync(socks, 0o755);
    await open(path.join(socks, 'inbox.sock'));
    expect(fs.statSync(socks).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory that is a symlink', async () => {
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    await expect(open(path.join(link, 'inbox.sock'))).rejects.toMatchObject({
      code: 'bind-failed',
      message: expect.stringContaining('not a directory'),
    });
  });

  it('fails rather than take a live name when no sibling name fits', async () => {
    const dir = path.join(root, 's');
    fs.mkdirSync(dir);
    const room =
      MAX_SOCKET_PATH_BYTES - Buffer.byteLength(path.join(dir, '.sock'));
    const requested = path.join(dir, `${'n'.repeat(room)}.sock`);
    expect(Buffer.byteLength(requested)).toBe(MAX_SOCKET_PATH_BYTES);
    const occupant = net.createServer();
    servers.push(occupant);
    await new Promise<void>((resolve) => occupant.listen(requested, resolve));
    await expect(open(requested)).rejects.toMatchObject({
      code: 'bind-failed',
      message: expect.stringContaining('no sibling name fits'),
    });
  });

  it('drops an over-long line at once, not at the line deadline', async () => {
    const frames: PeerFrame[] = [];
    const inbox = await startPeerInbox({
      socketPath: path.join(root, 'long.sock'),
      requiredToken: TOKEN,
      onFrame: (frame) => frames.push(frame),
      keepAlive: false,
    });
    opened.push(inbox);
    const started = Date.now();
    await dial(
      inbox.socketPath,
      buildAuthLine(TOKEN) + 'x'.repeat(MAX_FRAME_CHARS + 16),
      { end: false },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(frames).toEqual([]);
  });

  it('closes promptly while a connection is still open', async () => {
    const inbox = await open(path.join(root, 'idle.sock'));
    const idle = net.connect({ path: inbox.socketPath });
    idle.on('error', () => {});
    await new Promise<void>((resolve) => idle.on('connect', resolve));
    const started = Date.now();
    await inbox.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    idle.destroy();
  });

  it('offers no candidate path on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(resolveInboxCandidates()).toEqual([]);
      await expect(
        startPeerInbox({ requiredToken: TOKEN, onFrame: () => {} }),
      ).rejects.toMatchObject({ code: 'unsupported-platform' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
