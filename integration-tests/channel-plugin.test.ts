/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Channel Plugin Integration Test — "Loopback Channel"
 *
 * Creative approach: instead of the heavy 3-process architecture
 * (mock server + channel service + mock client), we use an in-process
 * "loopback channel" that acts as both sender and receiver.
 *
 * The LoopbackChannel extends ChannelBase and plugs directly into AcpBridge.
 * When a message is sent, it flows through the REAL pipeline:
 *
 *   test.send("What is 2+2?")
 *     → LoopbackChannel.handleInbound(envelope)
 *       → SenderGate (open policy)
 *       → SessionRouter (creates/reuses session)
 *       → AcpBridge.prompt(sessionId, text)
 *         → qwen-code --acp (REAL model request)
 *       → LoopbackChannel.sendMessage(chatId, response)
 *     → test receives response via promise
 *
 * No WebSocket, no HTTP, no separate processes. Just the real
 * channel pipeline with a real agent backend.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

// Import channel-base directly from compiled dist
import {
  AcpBridge,
  ChannelBase,
  SessionRouter,
} from '../packages/channels/base/dist/index.js';
import type {
  ChannelConfig,
  Envelope,
  ChannelBaseOptions,
} from '../packages/channels/base/dist/index.js';
import type { AcpBridge as AcpBridgeType } from '../packages/channels/base/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
const RESPONSE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Loopback Channel — the creative core
// ---------------------------------------------------------------------------

/**
 * A channel that lives entirely in the test process.
 *
 * - connect() is a no-op (nothing external to connect to)
 * - sendMessage() resolves a pending promise so the test gets the response
 * - send() pushes a message through handleInbound and returns the agent reply
 *
 * Think of it as a "promise pipe" that wraps the full ChannelBase pipeline.
 */
class LoopbackChannel extends ChannelBase {
  /** Map of chatId → resolver for the next sendMessage call */
  private responseResolvers = new Map<string, (text: string) => void>();
  private responseChunks = new Map<string, string[]>();

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridgeType,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
  }

  async connect(): Promise<void> {
    // No external connection needed — we ARE the platform
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const resolver = this.responseResolvers.get(chatId);
    if (resolver) {
      resolver(text);
      this.responseResolvers.delete(chatId);
    } else {
      // Buffer for cases where response arrives before await
      const chunks = this.responseChunks.get(chatId) || [];
      chunks.push(text);
      this.responseChunks.set(chatId, chunks);
    }
  }

  disconnect(): void {
    // Clean up any pending resolvers
    for (const [, resolver] of this.responseResolvers) {
      resolver('[channel disconnected]');
    }
    this.responseResolvers.clear();
  }

  /**
   * Send a message through the full channel pipeline and wait for the response.
   * This is the test-facing API.
   */
  async send(
    text: string,
    options?: {
      senderId?: string;
      senderName?: string;
      chatId?: string;
      timeoutMs?: number;
    },
  ): Promise<string> {
    const chatId = options?.chatId || 'loopback-dm-1';
    const senderId = options?.senderId || 'test-user';
    const senderName = options?.senderName || 'Test User';
    const timeoutMs = options?.timeoutMs || RESPONSE_TIMEOUT_MS;

    // Create promise to capture the response from sendMessage
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseResolvers.delete(chatId);
        reject(new Error(`Loopback timeout: no response after ${timeoutMs}ms`));
      }, timeoutMs);

      this.responseResolvers.set(chatId, (text: string) => {
        clearTimeout(timer);
        resolve(text);
      });
    });

    // Build envelope and push through the pipeline
    const envelope: Envelope = {
      channelName: this.name,
      senderId,
      senderName,
      chatId,
      text,
      isGroup: false,
      isMentioned: false,
      isReplyToBot: false,
    };

    // handleInbound → gates → session → bridge.prompt → sendMessage
    await this.handleInbound(envelope);

    return responsePromise;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestConfig(cwd: string): ChannelConfig {
  return {
    type: 'loopback',
    token: '',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'user',
    cwd,
    groupPolicy: 'disabled',
    groups: {},
  } as ChannelConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Channel Plugin (Loopback)', () => {
  let bridge: InstanceType<typeof AcpBridge>;
  let channel: LoopbackChannel;
  let testDir: string;

  // Set up once for all tests — reuse the bridge (expensive to start)
  const setup = async () => {
    const baseDir =
      process.env['INTEGRATION_TEST_FILE_DIR'] ||
      join(__dirname, '..', '.integration-tests', `channel-${Date.now()}`);
    testDir = join(baseDir, 'channel-plugin');
    mkdirSync(testDir, { recursive: true });

    bridge = new AcpBridge({
      cliEntryPath: CLI_PATH,
      cwd: testDir,
    });
    await bridge.start();

    const router = new SessionRouter(bridge, testDir, 'user');
    const config = createTestConfig(testDir);
    channel = new LoopbackChannel('test-loopback', config, bridge, { router });
    await channel.connect();
  };

  afterAll(() => {
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
  });

  it(
    'should receive a real agent response through the full channel pipeline',
    async () => {
      await setup();

      const response = await channel.send(
        'What is 2+2? Reply with ONLY the number, nothing else.',
      );

      // The real model should return something containing "4"
      expect(response).toBeTruthy();
      expect(response).toContain('4');
      console.log(`[channel-plugin] Single turn response: "${response}"`);
    },
    RESPONSE_TIMEOUT_MS,
  );

  it(
    'should maintain session state across multiple messages',
    async () => {
      // Use a dedicated chatId for this test's session
      const chatId = 'session-test-dm';

      const r1 = await channel.send(
        'My secret word is "pineapple". Remember it.',
        {
          chatId,
        },
      );
      expect(r1).toBeTruthy();
      console.log(`[channel-plugin] Memory set response: "${r1}"`);

      const r2 = await channel.send(
        'What is my secret word? Reply with ONLY the word, nothing else.',
        { chatId },
      );
      expect(r2).toBeTruthy();
      expect(r2.toLowerCase()).toContain('pineapple');
      console.log(`[channel-plugin] Memory recall response: "${r2}"`);
    },
    RESPONSE_TIMEOUT_MS * 2,
  );

  it(
    'should handle a different sender through the same pipeline',
    async () => {
      // Use a different sender to verify per-sender session routing works
      const response = await channel.send(
        'What is 10 * 5? Reply with ONLY the number, nothing else.',
        {
          senderId: 'different-user',
          senderName: 'Another User',
          chatId: 'different-user-dm',
        },
      );

      expect(response).toBeTruthy();
      expect(response).toContain('50');
      console.log(`[channel-plugin] Different sender response: "${response}"`);
    },
    RESPONSE_TIMEOUT_MS,
  );
});
