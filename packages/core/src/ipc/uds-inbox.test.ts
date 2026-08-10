/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exercises the inbox against a real socket rather than a mock: the parts
 * most likely to break — framing across chunk boundaries, permission
 * bits, cleanup on close — only exist at the socket boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// Lets one test stall and then fail the inbox's socket chmod — the
// failure path that returns null *after* `listen()` has started
// accepting connections.
const chmodGate = vi.hoisted(() => ({
  stallSocket: false,
  fail: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: ((pathLike: string, mode: number) => {
      if (chmodGate.stallSocket && pathLike.endsWith('.sock')) {
        return new Promise<never>((_resolve, reject) => {
          chmodGate.fail = () => reject(new Error('chmod denied'));
        });
      }
      return actual.chmod(pathLike, mode);
    }) as typeof actual.chmod,
  };
});
import {
  MAX_FRAME_BYTES,
  buildUserFrame,
  encodePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import { MAX_SOCKET_PATH_BYTES } from './socket-path.js';
import { probePeerSocket, sendPeerFrame, PeerSendError } from './uds-client.js';
import {
  createLineReader,
  startPeerInbox,
  type PeerInbox,
} from './uds-inbox.js';

let tmpDir: string;
let inbox: PeerInbox | null = null;
let received: PeerFrame[];

const isWindows = process.platform === 'win32';

/**
 * Root for this suite's sockets.
 *
 * `startPeerInbox` refuses any path over `MAX_SOCKET_PATH_BYTES`, and
 * `os.tmpdir()` alone eats that whole budget on some hosts (deep
 * self-hosted runner work dirs, Nix sandboxes, devcontainers) — which
 * fails every test here with `inbox failed to start`, for a reason that
 * has nothing to do with the inbox. Mirror the short-path fallback
 * `resolvePeerSocketPath` already applies to production paths.
 */
function socketTmpRoot(): string {
  // Longest path the suite builds: <root>/qwen-inbox-XXXXXX/socks/<name>.
  const longest = path.join(
    os.tmpdir(),
    'qwen-inbox-XXXXXX',
    'socks',
    'a.sock',
  );
  return Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES
    ? os.tmpdir()
    : '/tmp';
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(socketTmpRoot(), 'qwen-inbox-'));
  received = [];
});

afterEach(async () => {
  chmodGate.stallSocket = false;
  chmodGate.fail = null;
  await inbox?.close();
  inbox = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function listen(name = 'a.sock'): Promise<PeerInbox> {
  const started = await startPeerInbox({
    socketPath: path.join(tmpDir, 'socks', name),
    onFrame: (frame) => received.push(frame),
  });
  if (!started) throw new Error('inbox failed to start');
  inbox = started;
  return started;
}

/** Write raw bytes, bypassing the client, to drive the framing directly. */
function writeRaw(socketPath: string, chunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.on('error', reject);
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
    socket.on('close', () => resolve());
  });
}

/**
 * Write one chunk per event-loop turn.
 *
 * `writeRaw` hands every chunk over in a single turn, which coalesces into
 * a handful of large `data` events and so hides any per-event cost. Pacing
 * is entirely the sender's choice, and a sender that wants to be expensive
 * picks this shape.
 */
function writePaced(socketPath: string, chunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.on('error', reject);
    socket.on('close', () => resolve());
    socket.on('connect', () => {
      let i = 0;
      const step = () => {
        if (i >= chunks.length) {
          socket.end();
          return;
        }
        socket.write(chunks[i]!);
        i += 1;
        setImmediate(step);
      };
      step();
    });
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe.skipIf(isWindows)('startPeerInbox', () => {
  it('receives a frame written by the client', async () => {
    const started = await listen();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'hi' }));
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
  });

  it('creates the socket directory as 0700 and the socket as 0600', async () => {
    const started = await listen();
    const dirStat = await fs.stat(path.dirname(started.socketPath));
    const sockStat = await fs.stat(started.socketPath);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(sockStat.mode & 0o777).toBe(0o600);
  });

  it('tightens a pre-existing loose socket directory', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    await fs.chmod(dir, 0o755);

    const started = await listen();
    const dirStat = await fs.stat(path.dirname(started.socketPath));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('reclaims a socket file left behind by a crashed session', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.sock'), 'stale');

    const started = await listen();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'hi' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('refuses a non-local path', async () => {
    const started = await startPeerInbox({
      socketPath: 'relative.sock',
      onFrame: () => {},
    });
    expect(started).toBeNull();
  });

  it('destroys connections accepted before a chmod failure', async () => {
    // The socket accepts from `listen()` onward, and the chmod that can
    // still fail runs after it. A connection made in that window must be
    // destroyed by the failure path: the caller only gets null, so no
    // `close()` is ever coming for it.
    const socketPath = path.join(tmpDir, 'socks', 'c.sock');
    chmodGate.stallSocket = true;
    const inboxPromise = startPeerInbox({
      socketPath,
      onFrame: () => {},
    });

    // Wait for bind (the socket file appears) before dialing in.
    for (let i = 0; i < 200; i += 1) {
      try {
        await fs.stat(socketPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const clientClosed = new Promise<void>((resolve, reject) => {
      const client = net.connect({ path: socketPath });
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('client connection was not closed'));
      }, 2000);
      client.on('connect', () => {
        // Fail the chmod while this connection is live in the window.
        // The kernel can complete the handshake from the backlog before
        // the server's chmod call exists, so retry until the gate is
        // actually standing.
        const trip = () => {
          if (chmodGate.fail) chmodGate.fail();
          else setTimeout(trip, 1);
        };
        trip();
      });
      client.on('error', () => {});
      client.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await expect(inboxPromise).resolves.toBeNull();
    await expect(clientClosed).resolves.toBeUndefined();
  });

  it('unlinks the socket on close', async () => {
    const started = await listen();
    await started.close();
    inbox = null;
    await expect(fs.stat(started.socketPath)).rejects.toThrow();
  });

  it('is safe to close twice', async () => {
    const started = await listen();
    await started.close();
    await expect(started.close()).resolves.toBeUndefined();
    inbox = null;
  });
});

describe.skipIf(isWindows)('framing', () => {
  it('reassembles a frame split across writes', async () => {
    const started = await listen();
    const encoded = encodePeerFrame(buildUserFrame({ content: 'split me' }));
    const mid = Math.floor(encoded.length / 2);
    await writeRaw(started.socketPath, [
      encoded.slice(0, mid),
      encoded.slice(mid),
    ]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'split me' } });
  });

  it('splits several frames arriving in one write', async () => {
    const started = await listen();
    const payload =
      encodePeerFrame(buildUserFrame({ content: 'one' })) +
      encodePeerFrame(buildUserFrame({ content: 'two' }));
    await writeRaw(started.socketPath, [payload]);
    await settle();

    expect(
      received.map(
        (f) => (f as { message: { content: string } }).message.content,
      ),
    ).toEqual(['one', 'two']);
  });

  it('keeps two concurrent senders from splicing into each other', async () => {
    const started = await listen();
    const a = encodePeerFrame(buildUserFrame({ content: 'aaa' }));
    const b = encodePeerFrame(buildUserFrame({ content: 'bbb' }));

    // Each connection sends a half-frame, then the other half, interleaved.
    await Promise.all([
      writeRaw(started.socketPath, [a.slice(0, 20), a.slice(20)]),
      writeRaw(started.socketPath, [b.slice(0, 20), b.slice(20)]),
    ]);
    await settle();

    const contents = received
      .map((f) => (f as { message: { content: string } }).message.content)
      .sort();
    expect(contents).toEqual(['aaa', 'bbb']);
  });

  it('ignores blank lines', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, [
      '\n\n   \n' + encodePeerFrame(buildUserFrame({ content: 'hi' })),
    ]);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('drops an unparseable line without killing the connection', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, [
      'not json\n' + encodePeerFrame(buildUserFrame({ content: 'after' })),
    ]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'after' } });
  });

  it('keeps pipelined frames whose accumulated bytes cross the cap', async () => {
    // Regression: the cap used to be applied to the whole accumulated
    // buffer *before* complete lines were extracted. Two legal frames on
    // one connection push the buffer past the cap between the newline of
    // the first and the end of the second, so both were discarded and the
    // connection destroyed — even though neither line is over-cap.
    const started = await listen();
    const filler = 'z'.repeat(MAX_FRAME_BYTES - 512);
    const first = encodePeerFrame(buildUserFrame({ content: `a${filler}` }));
    const second = encodePeerFrame(buildUserFrame({ content: `b${filler}` }));
    expect(Buffer.byteLength(first)).toBeLessThan(MAX_FRAME_BYTES);
    expect(
      Buffer.byteLength(first) + Buffer.byteLength(second),
    ).toBeGreaterThan(MAX_FRAME_BYTES);

    await writeRaw(started.socketPath, [first + second]);
    await settle();

    const contents = received.map((f) =>
      (f as { message: { content: string } }).message.content.slice(0, 1),
    );
    expect(contents).toEqual(['a', 'b']);
  });

  it('accepts a line of exactly the cap', async () => {
    // The terminating newline is not part of the line, so a frame sized
    // exactly at the cap has to be admitted, not rejected off-by-one.
    const started = await listen();
    const base = buildUserFrame({ content: '' });
    const overhead = Buffer.byteLength(
      encodePeerFrame({ ...base, message: { ...base.message, content: '' } }),
    );
    // encodePeerFrame appends the newline, which is not part of the line.
    const padding = MAX_FRAME_BYTES - (overhead - 1);
    const frame = buildUserFrame({ content: 'y'.repeat(padding) });
    const line = encodePeerFrame(frame);
    expect(Buffer.byteLength(line) - 1).toBe(MAX_FRAME_BYTES);

    await writeRaw(started.socketPath, [line]);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('accepts a multibyte line sized exactly at the byte cap', async () => {
    // The cap is bytes, not UTF-16 units: 'é' is one code unit but two
    // UTF-8 bytes, so this line rides the byte limit with multibyte
    // content. A guard measuring `.length` would reject it off the limit.
    const started = await listen();
    const base = buildUserFrame({ content: '' });
    const overhead = Buffer.byteLength(encodePeerFrame(base)) - 1;
    const budget = MAX_FRAME_BYTES - overhead;
    const content =
      budget % 2 === 0
        ? 'é'.repeat(budget / 2)
        : `a${'é'.repeat((budget - 1) / 2)}`;
    const line = encodePeerFrame(buildUserFrame({ content }));
    expect(Buffer.byteLength(line) - 1).toBe(MAX_FRAME_BYTES);

    await writeRaw(started.socketPath, [line]);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('enforces the cap in bytes when the char count stays under it', async () => {
    // The mirror direction: 600k 'é' stay under the cap in UTF-16 units
    // while their UTF-8 encoding crosses it. A char-based guard would
    // deliver the frame; the byte-based one destroys the connection.
    const started = await listen();
    const line = encodePeerFrame(
      buildUserFrame({ content: 'é'.repeat(600_000) }),
    );
    expect(line.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(Buffer.byteLength(line)).toBeGreaterThan(MAX_FRAME_BYTES);

    // Do not `end()` the connection: the drop has to be observable as the
    // server destroying it, not the client leaving.
    const dropped = new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: started.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connection was not dropped'));
      }, 2000);
      socket.on('connect', () => socket.write(line));
      // ECONNRESET is the destroy arriving — `close` follows it.
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await expect(dropped).resolves.toBeUndefined();
    expect(received).toHaveLength(0);

    // The inbox survives the dropped connection.
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'ok' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('drops an over-cap line completed by a newline chunk', async () => {
    // End-to-end shape of a line that only completes after pending is
    // near the cap; the extraction-path check itself is pinned by the
    // direct createLineReader tests below.
    const started = await listen();
    const base = encodePeerFrame(
      buildUserFrame({ content: 'é'.repeat(600_000) }),
    ).replace(/\n$/, '');
    const prefixLen = base.indexOf('é');
    const splitAt = Math.floor(
      prefixLen + (MAX_FRAME_BYTES - 4096 - prefixLen) / 2,
    );
    const firstHalf = base.slice(0, splitAt);
    expect(Buffer.byteLength(firstHalf)).toBeLessThan(MAX_FRAME_BYTES);

    const dropped = new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: started.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connection was not dropped'));
      }, 2000);
      socket.on('connect', () => {
        socket.write(firstHalf);
        socket.write(`${base.slice(splitAt)}\n`);
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await expect(dropped).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it('caps the leftover partial line after extraction', async () => {
    // A chunk holding a complete frame plus a newline-free tail over the
    // cap must still deliver the frame and then destroy the connection.
    // The tail check itself is pinned by the direct createLineReader
    // tests below.
    const started = await listen();
    const first = encodePeerFrame(buildUserFrame({ content: 'legal' }));
    const tail = 'é'.repeat(600_000);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(MAX_FRAME_BYTES);

    const dropped = new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: started.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connection was not dropped'));
      }, 2000);
      socket.on('connect', () => socket.write(first + tail));
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await expect(dropped).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'legal' } });
  });

  it('drops a connection that never sends a newline', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, ['x'.repeat(MAX_FRAME_BYTES + 1)]);
    await settle();
    expect(received).toHaveLength(0);

    // The inbox is still usable afterwards.
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'ok' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('keeps per-event framing cost proportional to the chunk, not the buffer', async () => {
    // Regression: the reader concatenated onto one string and re-scanned
    // all of it (indexOf + Buffer.byteLength) on every `data` event, so a
    // sender dripping bytes with no newline paid one syscall per event and
    // billed this process a full re-scan — quadratic, ~4.6s of saturated
    // event loop to reach the cap once. The cap bounds memory, not CPU.
    //
    // Asserted on how much string gets measured rather than on wall clock:
    // the timing gap is the symptom, but a duration threshold on a shared
    // CI runner is a coin flip, and the size of what gets scanned is the
    // same signal without the flake.
    const started = await listen();
    const chunkBytes = 256;
    const chunk = 'x'.repeat(chunkBytes);
    // One short of the cap, so the drip never trips the overflow path.
    const chunks = Array.from(
      { length: Math.floor(MAX_FRAME_BYTES / chunkBytes) - 1 },
      () => chunk,
    );

    const measured: number[] = [];
    const realByteLength = Buffer.byteLength.bind(Buffer);
    const spy = vi.spyOn(Buffer, 'byteLength').mockImplementation(((
      value: string,
      encoding?: BufferEncoding,
    ) => {
      if (typeof value === 'string') measured.push(value.length);
      return realByteLength(value, encoding);
    }) as typeof Buffer.byteLength);
    try {
      await writePaced(started.socketPath, chunks);
      await settle();
    } finally {
      spy.mockRestore();
    }

    // Guard against the guard passing vacuously: `Math.max(...[])` is
    // -Infinity, so a reimplementation that stops measuring through
    // `Buffer.byteLength` would sail through an unchecked maximum. The
    // fixed reader measures once per chunk on the no-newline path.
    expect(measured).not.toHaveLength(0);
    // Pre-fix this peaked just under MAX_FRAME_BYTES; the writer's own
    // per-write measurement of one chunk is the only thing left.
    expect(Math.max(...measured)).toBeLessThan(chunkBytes * 4);
    // Pre-fix the total ran to ~n²/2 ≈ 2 GiB for 1 MiB of traffic.
    const written = chunkBytes * chunks.length;
    expect(measured.reduce((sum, n) => sum + n, 0)).toBeLessThan(written * 8);
    // A quadratic regression that dodges this spy must measure the buffer
    // in UTF-16 units instead of bytes to keep the cap working, and the
    // multibyte cap tests below pin that direction.
  });

  it('still caps a paced drip that never sends a newline', async () => {
    // The no-newline fast path has its own cap check now, so it needs its
    // own coverage: the single-write case above cannot reach it.
    const started = await listen();
    const chunk = 'x'.repeat(4096);
    const chunks = Array.from(
      { length: Math.floor(MAX_FRAME_BYTES / 4096) + 1 },
      () => chunk,
    );
    await writePaced(started.socketPath, chunks);
    await settle();
    expect(received).toHaveLength(0);

    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'ok' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('reassembles a frame dripped one byte per event', async () => {
    const started = await listen();
    const line = encodePeerFrame(buildUserFrame({ content: 'dripped' }));
    await writePaced(started.socketPath, [...line]);
    await settle();
    expect(received).toHaveLength(1);
    expect(
      (received[0] as { message: { content: string } }).message.content,
    ).toBe('dripped');
  });

  it('does not let a throwing handler take down the server', async () => {
    // Containment has to mean "the connection keeps working", not only
    // "the listener survives": destroying the connection inside the catch
    // would still keep the server up while dropping everything the peer
    // writes next. Two frames on one connection pin the stronger property.
    const frames: PeerFrame[] = [];
    let calls = 0;
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'b.sock'),
      onFrame: (frame) => {
        calls += 1;
        if (calls === 1) throw new Error('handler exploded');
        frames.push(frame);
      },
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;

    // The frames must arrive in separate reads: two frames in one chunk
    // are extracted in the same pass, so a connection destroyed after
    // the first throw would still deliver the second from that batch.
    const client = net.connect({ path: started.socketPath });
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('connect', () => resolve());
    });
    client.on('error', () => {
      // A destroyed connection surfaces as ECONNRESET on later writes.
    });
    client.write(encodePeerFrame(buildUserFrame({ content: 'boom' })));
    await settle();
    client.write(encodePeerFrame(buildUserFrame({ content: 'after' })));
    client.end();
    await settle();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ message: { content: 'after' } });
    expect(await probePeerSocket(started.socketPath)).toBe(true);
  });
});

describe('createLineReader cap branches', () => {
  // Driven directly because socket events (~64 KiB) cannot carry the
  // shapes that reach these branches: the drip guard always trips first
  // when bytes accumulate event by event.
  function collect(): {
    read: (chunk: string) => void;
    lines: string[];
    overflows: () => number;
  } {
    const lines: string[] = [];
    const state = { overflows: 0 };
    const read = createLineReader(
      (line) => lines.push(line),
      () => {
        state.overflows += 1;
      },
    );
    return { read, lines, overflows: () => state.overflows };
  }

  it('overflows on a line over the cap when the drip stayed under it', () => {
    // Chars vs bytes matters here: the line is MAX chars but twice that
    // in UTF-8 bytes, so a char-based check lets it through.
    const { read, lines, overflows } = collect();
    const line = 'é'.repeat(MAX_FRAME_BYTES);
    read(line.slice(0, (MAX_FRAME_BYTES - 2048) / 2));
    expect(overflows()).toBe(0);
    read(line.slice((MAX_FRAME_BYTES - 2048) / 2) + '\n');
    expect(overflows()).toBe(1);
    expect(lines).toEqual([]);
  });

  it('overflows on an over-cap tail left after the last newline', () => {
    const { read, lines, overflows } = collect();
    read('\n' + 'é'.repeat(600_000));
    expect(overflows()).toBe(1);
    expect(lines).toEqual([]);
  });
});

describe.skipIf(isWindows)('client errors', () => {
  it('reports ENOENT for a socket that does not exist', async () => {
    const missing = path.join(tmpDir, 'nope.sock');
    await expect(
      sendPeerFrame(missing, buildUserFrame({ content: 'hi' })),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: 'ENOENT' });
  });

  it('reports ECONNREFUSED for a stale socket file', async () => {
    const started = await listen();
    const socketPath = started.socketPath;
    // Close the server but leave the inode: a crashed session's leftovers.
    await started.close();
    inbox = null;
    await fs.writeFile(socketPath, '');

    await expect(
      sendPeerFrame(socketPath, buildUserFrame({ content: 'hi' })),
    ).rejects.toBeInstanceOf(PeerSendError);
  });

  it('refuses a non-local path before dialing', async () => {
    // `code: undefined` is the guard's fingerprint: a dial failure would
    // carry an errno, so this assertion fails if the guard is deleted and
    // the rejection comes from a real connect instead.
    await expect(
      sendPeerFrame('relative.sock', buildUserFrame({ content: 'hi' })),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: undefined });
  });
});

describe.skipIf(isWindows)('probePeerSocket', () => {
  it('is true for a listening inbox', async () => {
    const started = await listen();
    expect(await probePeerSocket(started.socketPath)).toBe(true);
  });

  it('is false once the inbox closes', async () => {
    const started = await listen();
    await started.close();
    inbox = null;
    expect(await probePeerSocket(started.socketPath)).toBe(false);
  });

  it('is false for a leftover socket file with nobody listening', async () => {
    const stale = path.join(tmpDir, 'stale.sock');
    await fs.writeFile(stale, '');
    expect(await probePeerSocket(stale)).toBe(false);
  });

  it('is false for a non-local path', async () => {
    expect(await probePeerSocket('relative.sock')).toBe(false);
  });
});
