/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('node:fs');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

(async () => {
  const root = fs.mkdtempSync('/tmp/qc-input-backpressure-');
  const socketPath = join(root, 'input.sock');
  const outDir = join(root, 'out');
  let server;
  let writer;
  let writerPeak = 0;
  let accepted = 0;
  let callbackCount = 0;
  let pauseCalls = 0;
  let resumeCalls = 0;
  const payload = Buffer.alloc(4 * 1024 * 1024 + 123, 0x5a);
  const digest = createHash('sha256').update(payload).digest('hex');
  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = (file, options) => {
    const stream = originalCreateWriteStream(file, {
      ...options,
      highWaterMark: 16 * 1024,
    });
    writer = stream;
    const originalWrite = stream.write;
    stream.write = function (chunk, ...args) {
      const result = originalWrite.call(this, chunk, ...args);
      accepted += chunk.length;
      writerPeak = Math.max(writerPeak, this.writableLength);
      return result;
    };
    const originalInternalWrite = stream._write;
    stream._write = function (chunk, encoding, callback) {
      setTimeout(() => {
        originalInternalWrite.call(this, chunk, encoding, (error) => {
          callbackCount += 1;
          callback(error);
        });
      }, 5);
    };
    const originalInternalWritev = stream._writev;
    stream._writev = function (chunks, callback) {
      setTimeout(() => {
        originalInternalWritev.call(this, chunks, (error) => {
          callbackCount += chunks.length;
          callback(error);
        });
      }, 5);
    };
    return stream;
  };
  const originalPause = net.Socket.prototype.pause;
  const originalResume = net.Socket.prototype.resume;
  net.Socket.prototype.pause = function () {
    if (!this.server) pauseCalls += 1;
    return originalPause.call(this);
  };
  net.Socket.prototype.resume = function () {
    if (!this.server) resumeCalls += 1;
    return originalResume.call(this);
  };
  syncBuiltinESMExports();
  const channel = await import(process.argv[2]);
  const manifestBytes = channel.buildInputManifest({
    runId: 'bp-probe',
    baseRefOid: 'a'.repeat(40),
    headRefOid: 'b'.repeat(40),
    bundleSha256: digest,
    bundleBytes: payload.length,
    entropyHex: '01'.repeat(32),
    modelProxy: null,
  }).manifestBytes;
  const requests = [];
  const connections = new Set();
  const timeout = setTimeout(() => {
    for (const socket of connections) socket.destroy();
    if (server) server.close();
  }, 25_000);
  try {
    server = net.createServer((socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      socket.on('error', () => {});
      socket.once('data', (data) => {
        const request = data.toString('utf8');
        requests.push(request);
        if (request === 'GET manifest\n') {
          socket.end(
            Buffer.concat([
              Buffer.from(`OK ${manifestBytes.length}\n`),
              manifestBytes,
            ]),
          );
        } else if (request === 'GET bundle\n') {
          socket.end(
            Buffer.concat([Buffer.from(`OK ${payload.length}\n`), payload]),
          );
        } else {
          socket.destroy();
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await channel.fetchRoundInputFromSocket({
      socketPath,
      outDir,
    });
    console.log(
      JSON.stringify({
        payloadBytes: payload.length,
        writerHighWaterMark: writer.writableHighWaterMark,
        accepted,
        maxWriterWritableLength: writerPeak,
        completedWriteCallbacksAtReturn: callbackCount,
        finalBytes: fs.statSync(join(outDir, 'round.bundle')).size,
        finalShaMatches:
          createHash('sha256')
            .update(fs.readFileSync(join(outDir, 'round.bundle')))
            .digest('hex') === digest,
        pauseCalls,
        resumeCalls,
        requests,
      }),
    );
  } finally {
    clearTimeout(timeout);
    fs.createWriteStream = originalCreateWriteStream;
    net.Socket.prototype.pause = originalPause;
    net.Socket.prototype.resume = originalResume;
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
