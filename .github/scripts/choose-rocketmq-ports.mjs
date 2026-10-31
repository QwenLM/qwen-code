/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Prints NAME=PORT lines of free ports for scripts/rocketmq-lite-broker.sh,
// for the EventTransport gate lanes in sdk-java.yml. A pool host runs many
// jobs at once, so each cluster binds its own ports. They are checked on
// every interface (the proxy and the broker's HA port listen there), and the
// broker's companions (listenPort - 2 and + 1) are held too.
//
// The workflow step that runs this script is minutes away — and several
// steps earlier — from the JVMs that bind these ports. Closing the sockets
// here and re-opening them in a later step was a pick-to-bind race that
// anything else on the host could win (#14545's RocketMQ lanes died twice on
// `BindException: Address already in use`), so each chosen port is parked
// behind a detached holder process that keeps it bound. The broker script
// kills only the holder of the port it is about to hand to a JVM, shrinking
// the race to the sub-second kill-to-bind window. RMQ_HOLDER_DIR names the
// directory with one pid file per held port; the broker script cleans it up
// on success, rollback and stop.
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const holderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmq-port-holders-'));

// Kept dependency-free so it runs on any runner Node as `node -e`.
const HOLDER = `
// node -e leaves no script path in process.argv: argv is [node, port, file].
const net = require('node:net');
const fs = require('node:fs');
const port = Number(process.argv[1]);
const file = process.argv[2];
const server = net.createServer();
server.once('error', () => process.exit(1));
server.listen(port, '0.0.0.0', () =>
  fs.writeFileSync(file, String(process.pid) + '\\n'),
);
`;

// Parks one port behind a detached holder and waits for the pid file that
// proves it owns the bind. The record is newline-terminated because the
// broker script reads it with `read` under `set -e`, where a file without a
// final newline makes the read fail. Any stale pid file must be gone first
// and the (re)written one must name this spawn's pid, else a previous
// holder's artifact fakes success. Resolves false when the port cannot be
// held, so the caller picks another.
const hold = (port) =>
  new Promise((resolve) => {
    const file = path.join(holderDir, `${port}.pid`);
    fs.rmSync(file, { force: true });
    const child = spawn(process.execPath, ['-e', HOLDER, String(port), file], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    let waited = 0;
    const timer = setInterval(() => {
      try {
        if (Number(fs.readFileSync(file, 'utf8').trim()) === child.pid) {
          clearInterval(timer);
          resolve(true);
          return;
        }
      } catch {
        // No pid file yet.
      }
      if ((waited += 50) >= 5000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 50);
  });

// Kills the holder of a port the chooser decided not to use after all.
const release = (port) => {
  const file = path.join(holderDir, `${port}.pid`);
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid) process.kill(pid);
  } catch {
    // Holder already gone.
  }
  fs.rmSync(file, { force: true });
};

const bind = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '0.0.0.0', () => resolve(server));
  });

// Picks a kernel-reported free port and parks it behind a holder in one go,
// so a companion failure can never leave a picked port unheld behind.
const pick = async () => {
  for (;;) {
    const server = await bind(0);
    if (!server) return null;
    const port = server.address().port;
    server.close();
    if (await hold(port)) return port;
  }
};

const ports = {};
for (const name of [
  'RMQ_NAMESRV_PORT',
  'RMQ_PROXY_GRPC_PORT',
  'RMQ_PROXY_REMOTING_PORT',
  'RMQ_BROKER_PORT',
]) {
  while (ports[name] === undefined) {
    const port = await pick();
    if (port === null) continue;
    let kept = true;
    if (name === 'RMQ_BROKER_PORT') {
      // A companion can repeat a port an earlier role already parked: the
      // kernel hands out adjacent ephemeral ports, so ±1/±2 repeats are
      // common. Parking it again would spawn a child that dies on bind while
      // the live holder's pid file faked success, and the broker's fast
      // channel or HA listener would then collide with that role. Reject the
      // candidate, and release only the holders this candidate parked.
      const reserved = new Set(Object.values(ports));
      const companions = [port - 2, port + 1];
      const acquired = [];
      for (const companion of companions) {
        if (reserved.has(companion) || !(await hold(companion))) {
          kept = false;
          break;
        }
        acquired.push(companion);
      }
      if (!kept) {
        for (const candidate of [port, ...acquired]) release(candidate);
      }
    }
    if (kept) ports[name] = port;
  }
}

console.log(`RMQ_HOLDER_DIR=${holderDir}`);
for (const [name, port] of Object.entries(ports)) {
  console.log(`${name}=${port}`);
}
