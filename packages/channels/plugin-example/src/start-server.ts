#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Start the mock WebSocket server for testing the plugin-example channel.
 *
 * Usage:
 *   npx qwen-channel-plugin-example-server
 *   # or
 *   node node_modules/@qwen-code/channel-plugin-example/dist/start-server.js
 *
 * Environment variables:
 *   HTTP_PORT  (default: 9200)
 *   WS_PORT    (default: 9201)
 */
import { createMockServer } from './mock-server.js';

const httpPort = parseInt(process.env['HTTP_PORT'] || '9200', 10);
const wsPort = parseInt(process.env['WS_PORT'] || '9201', 10);

const server = await createMockServer({ httpPort, wsPort });

console.log(`Mock server running:`);
console.log(`  HTTP: http://localhost:${server.httpPort}`);
console.log(`  WS:   ws://localhost:${server.wsPort}`);
console.log();
console.log(`Send a test message:`);
console.log(`  curl -sX POST http://localhost:${server.httpPort}/message \\`);
console.log(`    -H 'Content-Type: application/json' \\`);
console.log(
  `    -d '{"senderId":"user1","senderName":"Tester","text":"Hello"}'`,
);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
