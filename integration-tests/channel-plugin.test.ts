/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Channel Plugin Integration Test — Real E2E with WebSocket
 *
 * Tests the actual MockPluginChannel (from @qwen-code/channel-mock) connected
 * to an in-process mock server via WebSocket. The full message flow is:
 *
 *   server.sendMessage("What is 2+2?")
 *     → WebSocket push to MockPluginChannel
 *       → ChannelBase.handleInbound(envelope)
 *         → SenderGate (open policy)
 *         → SessionRouter (creates/reuses session)
 *         → AcpBridge.prompt(sessionId, text)
 *           → qwen-code --acp (REAL model request)
 *       → MockPluginChannel.sendMessage(chatId, response)
 *         → WebSocket response to mock server
 *     → server resolves promise with agent text
 *
 * This exercises the real WebSocket protocol, real message serialization,
 * real ChannelPlugin interface, and real model backend — all in one test process.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

// Import from the monorepo channel packages
import {
  AcpBridge,
  SessionRouter,
} from '../packages/channels/base/dist/index.js';
import type { ChannelConfig } from '../packages/channels/base/dist/index.js';
import {
  MockPluginChannel,
  createMockServer,
} from '../packages/channels/mock/src/index.js';
import type { MockServerHandle } from '../packages/channels/mock/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
const RESPONSE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Channel Plugin (Mock WebSocket E2E)', () => {
  let bridge: InstanceType<typeof AcpBridge>;
  let channel: MockPluginChannel;
  let server: MockServerHandle;
  let testDir: string;

  const setup = async () => {
    const baseDir =
      process.env['INTEGRATION_TEST_FILE_DIR'] ||
      join(__dirname, '..', '.integration-tests', `channel-${Date.now()}`);
    testDir = join(baseDir, 'channel-mock-e2e');
    mkdirSync(testDir, { recursive: true });

    // 1. Start mock server on random ports (no port conflicts)
    server = await createMockServer({ httpPort: 0, wsPort: 0 });

    // 2. Start AcpBridge (spawns real qwen-code --acp)
    bridge = new AcpBridge({
      cliEntryPath: CLI_PATH,
      cwd: testDir,
    });
    await bridge.start();

    // 3. Create and connect MockPluginChannel via WebSocket
    const config: ChannelConfig & Record<string, unknown> = {
      type: 'mock-plugin',
      token: '',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: testDir,
      groupPolicy: 'disabled',
      groups: {},
      serverWsUrl: server.wsUrl,
    };

    const router = new SessionRouter(bridge, testDir, 'user');
    channel = new MockPluginChannel('test-mock', config, bridge, { router });
    await channel.connect();

    // 4. Wait for the channel's WebSocket to be registered by the server
    await server.waitForConnection(5_000);
  };

  afterAll(async () => {
    try {
      channel?.disconnect();
    } catch {
      // ignore
    }
    try {
      bridge?.stop();
    } catch {
      // ignore
    }
    try {
      await server?.close();
    } catch {
      // ignore
    }
  });

  it(
    'should send a message through WebSocket and receive a real agent response',
    async () => {
      await setup();

      // This goes: server → WS → MockPluginChannel → ChannelBase → AcpBridge → agent → back
      const response = await server.sendMessage(
        'What is 2+2? Reply with ONLY the number, nothing else.',
      );

      expect(response).toBeTruthy();
      expect(response).toContain('4');
      console.log(`[mock-e2e] Single turn response: "${response}"`);
    },
    RESPONSE_TIMEOUT_MS,
  );

  it(
    'should maintain session state across multiple WebSocket messages',
    async () => {
      const chatId = 'ws-session-test';
      const opts = { chatId };

      const r1 = await server.sendMessage(
        'My secret word is "pineapple". Remember it.',
        opts,
      );
      expect(r1).toBeTruthy();
      console.log(`[mock-e2e] Memory set response: "${r1}"`);

      const r2 = await server.sendMessage(
        'What is my secret word? Reply with ONLY the word, nothing else.',
        opts,
      );
      expect(r2).toBeTruthy();
      expect(r2.toLowerCase()).toContain('pineapple');
      console.log(`[mock-e2e] Memory recall response: "${r2}"`);
    },
    RESPONSE_TIMEOUT_MS * 2,
  );

  it(
    'should handle a different sender through the same WebSocket pipeline',
    async () => {
      const response = await server.sendMessage(
        'What is 10 * 5? Reply with ONLY the number, nothing else.',
        {
          senderId: 'another-user',
          senderName: 'Another User',
          chatId: 'dm-another-user',
        },
      );

      expect(response).toBeTruthy();
      expect(response).toContain('50');
      console.log(`[mock-e2e] Different sender response: "${response}"`);
    },
    RESPONSE_TIMEOUT_MS,
  );
});
