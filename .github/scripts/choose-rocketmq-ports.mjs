/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Prints NAME=PORT lines of free ports for scripts/rocketmq-lite-broker.sh,
// for the EventTransport gate lanes in sdk-java.yml. A pool host runs many
// jobs at once, so each cluster binds its own ports. They are checked on
// every interface (the proxy and the broker's HA port listen there), and the
// broker's companions (listenPort - 2 and + 1) must be free too. Every port
// stays held until all are chosen, so no two names share one.
import net from 'node:net';

const bind = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '0.0.0.0', () => resolve(server));
  });

const held = [];
const ports = {};
for (const name of [
  'RMQ_NAMESRV_PORT',
  'RMQ_PROXY_GRPC_PORT',
  'RMQ_PROXY_REMOTING_PORT',
  'RMQ_BROKER_PORT',
]) {
  while (ports[name] === undefined) {
    const server = await bind(0);
    held.push(server);
    const port = server.address().port;
    const companions =
      name === 'RMQ_BROKER_PORT'
        ? await Promise.all([bind(port - 2), bind(port + 1)])
        : [];
    held.push(...companions.filter(Boolean));
    if (companions.every(Boolean)) ports[name] = port;
  }
}
held.forEach((server) => server.close());
for (const [name, port] of Object.entries(ports)) {
  console.log(`${name}=${port}`);
}
