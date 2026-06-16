/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LIVE Matrix E2EE integration test — the full wired path against a real Synapse.
 * ENV-GATED: skips cleanly in the default suite, runs only against a homeserver
 * the operator stands up in Docker (see `integration/matrix/README.md`). Set:
 *   QWEN_MATRIX_IT_HS_URL     e.g. http://localhost:8008
 *   QWEN_MATRIX_IT_REG_SECRET the homeserver's registration_shared_secret
 *
 * Both tests provision two throwaway crypto users (bot + sender); the SENDER
 * creates an encrypted room and invites the bot; the bot's `cryptoAdapter` joins,
 * prepares crypto and starts syncing BEFORE the sender sends (Megolm shares the
 * session key to known devices at send time and does not re-key history). Test 1
 * asserts the adapter decrypts into `onMessage`; test 2 wires the adapter through a
 * real MatrixBridge and asserts the full path — decrypted → bound session, the
 * bot's encrypted reply decrypted by the sender, and a reaction → vote.
 *
 * Two real-world gotchas, documented in the README and worth repeating:
 *   1. ORDERING — bot must be joined + prepared + syncing before the sender sends.
 *   2. UNVERIFIED-DEVICE POLICY — the sender must share keys to the bot's
 *      (unverified) device; if your Synapse/SDK build withholds keys from
 *      unverified devices the bot never decrypts. Verify the device or enable
 *      share-to-unverified.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMatrixCryptoAdapter,
  type DecryptedMatrixMessage,
} from './cryptoAdapter.js';
import { registerViaSharedSecret } from './synapseAdmin.js';
import { MatrixBridge } from './runner.js';
import { MatrixRoomStore } from './roomStore.js';
import type { BridgeClient } from '../client.js';

const HS = process.env.QWEN_MATRIX_IT_HS_URL;
const REG = process.env.QWEN_MATRIX_IT_REG_SECRET;
const RUN = !!HS && !!REG;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// describe.skipIf keeps the default suite green when the homeserver env is absent.
describe.skipIf(!RUN)('Matrix E2EE live decrypt (Synapse-gated)', () => {
  it('the bot decrypts a message sent into an encrypted room', async () => {
    const sdk = await import('matrix-bot-sdk');
    const {
      MatrixClient,
      RustSdkCryptoStorageProvider,
      SimpleFsStorageProvider,
    } = sdk;
    // Runtime store-type value from the native package (matrix-bot-sdk's
    // RustSdkCryptoStoreType is a runtime-erased const enum — see cryptoAdapter.ts).
    const { StoreType } = await import('@matrix-org/matrix-sdk-crypto-nodejs');

    const stamp = `${Date.now()}`;
    const botName = `qwenbot_${stamp}`;
    const senderName = `sender_${stamp}`;
    const bot = await registerViaSharedSecret(HS!, REG!, botName, 'pw', false);
    const sender = await registerViaSharedSecret(
      HS!,
      REG!,
      senderName,
      'pw',
      false,
    );

    const dir = mkdtempSync(join(tmpdir(), 'rc-mx-it-'));
    const received: DecryptedMatrixMessage[] = [];

    // Sender: a second crypto-capable client that creates + encrypts the room.
    const senderClient = new MatrixClient(
      HS!,
      sender.accessToken,
      new SimpleFsStorageProvider(join(dir, 'sender-sync.json')),
      new RustSdkCryptoStorageProvider(
        join(dir, 'sender-olm'),
        StoreType.Sqlite,
      ),
    );

    const botAdapter = await createMatrixCryptoAdapter({
      homeserverUrl: HS!,
      accessToken: bot.accessToken,
      stateDir: join(dir, 'bot-state'),
      onMessage: (m) => {
        received.push(m);
      },
    });
    expect(botAdapter).not.toBeNull();

    try {
      await senderClient.crypto.prepare([]);
      await senderClient.start();

      // Sender creates an ENCRYPTED room and invites the bot.
      const roomId = await senderClient.createRoom({
        preset: 'private_chat',
        invite: [bot.userId],
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      });

      // Bot joins, prepares crypto, and starts syncing FIRST (key-share order).
      await botAdapter!.joinRoom(roomId);
      await botAdapter!.start();
      await sleep(2000); // let both clients settle device lists / sync

      const plaintext = `hello-encrypted-${stamp}`;
      await senderClient.sendMessage(roomId, {
        msgtype: 'm.text',
        body: plaintext,
      });

      // Poll for the decrypted message (up to ~15s).
      const deadline = Date.now() + 15_000;
      while (
        !received.some((m) => m.body === plaintext) &&
        Date.now() < deadline
      ) {
        await sleep(500);
      }
      expect(received.map((m) => m.body)).toContain(plaintext);
    } finally {
      await botAdapter?.stop();
      senderClient.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('routes a decrypted message to a bound session, encrypts its reply, and votes a reaction', async () => {
    // Full live wiring (what startBridge assembles): the adapter is BOTH the
    // inbound transport (decrypt → dispatch) and the encrypting outbound rest.
    // Asserts the three properties unit tests can't reach against real crypto:
    //   1. a decrypted message reaches a BOUND SESSION (through dispatch);
    //   2. the bot's reply is real ciphertext the SENDER decrypts (no plaintext
    //      leak into the encrypted room);
    //   3. a 👍 reaction on the bot's tracked message registers a vote.
    const sdk = await import('matrix-bot-sdk');
    const {
      MatrixClient,
      RustSdkCryptoStorageProvider,
      SimpleFsStorageProvider,
    } = sdk;
    const { StoreType } = await import('@matrix-org/matrix-sdk-crypto-nodejs');

    const stamp = `${Date.now()}`;
    const bot = await registerViaSharedSecret(
      HS!,
      REG!,
      `botw_${stamp}`,
      'pw',
      false,
    );
    const sender = await registerViaSharedSecret(
      HS!,
      REG!,
      `sndw_${stamp}`,
      'pw',
      false,
    );

    const dir = mkdtempSync(join(tmpdir(), 'rc-mx-itw-'));
    const ac = new AbortController();

    // The sender is a crypto client that records every message IT can decrypt —
    // so seeing the bot's reply here proves the reply was genuine ciphertext.
    const senderClient = new MatrixClient(
      HS!,
      sender.accessToken,
      new SimpleFsStorageProvider(join(dir, 'snd-sync.json')),
      new RustSdkCryptoStorageProvider(join(dir, 'snd-olm'), StoreType.Sqlite),
    );
    const senderSaw: Array<{ eventId: string; body: string }> = [];
    senderClient.on('room.message', (_rid: string, ev: unknown) => {
      const e = ev as { event_id?: string; content?: { body?: unknown } };
      if (typeof e.content?.body === 'string')
        senderSaw.push({ eventId: e.event_id ?? '', body: e.content.body });
    });

    // The bot's gateway client is faked so we can observe the prompts/votes the
    // bridge drives — the rest of the bridge is the real runner + dispatch.
    const prompts: Array<{ sessionId: string; prompt: string }> = [];
    const votesSeen: Array<{
      sessionId: string;
      requestId: string;
      outcome: string;
    }> = [];
    const client = {
      register: async () => ({ ok: true, status: 200 }),
      heartbeat: async () => ({ ok: true, status: 200 }),
      subscribeEvents: async () => {},
      sendPrompt: async (sessionId: string, prompt: string) => {
        prompts.push({ sessionId, prompt });
        return { ok: true, status: 200 };
      },
      vote: async (sessionId: string, requestId: string, outcome: string) => {
        votesSeen.push({ sessionId, requestId, outcome });
        return { ok: true, status: 200 };
      },
    } as unknown as BridgeClient;

    const rooms = await MatrixRoomStore.open(join(dir, 'rooms.json'));
    // The adapter captures its callbacks at construction; route them into the
    // bridge once it exists (mirrors startBridge's sink).
    const wired: { bridge?: MatrixBridge } = {};
    const adapter = await createMatrixCryptoAdapter({
      homeserverUrl: HS!,
      accessToken: bot.accessToken,
      stateDir: join(dir, 'bot-state'),
      onMessage: (m) => wired.bridge?.dispatchDecryptedMessage(m, m.powerLevel),
      onReaction: (r) => wired.bridge?.dispatchReaction(r),
    });
    expect(adapter).not.toBeNull();

    const bridge = new MatrixBridge({
      client,
      rest: adapter!, // outbound goes through the SDK → encrypts
      rooms,
      botUserId: bot.userId,
      baseUrl: 'http://127.0.0.1:4170',
      syncOnce: async () => ({}), // unused: the adapter owns /sync
      runInbound: async () => void (await adapter!.start()),
      sleep: () => new Promise<void>(() => {}), // park SSE reconnect
    });
    wired.bridge = bridge;

    try {
      await senderClient.crypto.prepare([]);
      await senderClient.start();

      const roomId = await senderClient.createRoom({
        preset: 'private_chat',
        invite: [bot.userId],
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      });

      // Real fresh-room path: the bot is INVITED and AutojoinRoomsMixin joins it
      // after start() (we do NOT pre-join) — verifying that a room joined post-
      // start still decrypts. Bind the session; then start + settle before send.
      await rooms.bind(roomId, 'sess_e2ee');
      await bridge.start(ac.signal); // runInbound → adapter prepare + sync + autojoin
      await sleep(4000);

      // (1) decrypted message → bound session.
      const prompt = `do-thing-${stamp}`;
      await senderClient.sendMessage(roomId, {
        msgtype: 'm.text',
        body: prompt,
      });
      const d1 = Date.now() + 20_000;
      while (!prompts.some((p) => p.prompt === prompt) && Date.now() < d1)
        await sleep(500);
      expect(prompts.map((p) => p.prompt)).toContain(prompt);
      expect(prompts.find((p) => p.prompt === prompt)!.sessionId).toBe(
        'sess_e2ee',
      );

      // (2) the bridge delivers a permission_request → sent ENCRYPTED into the
      // room AND tracked. The sender decrypting it proves no plaintext leak.
      bridge.deliverEvent('sess_e2ee', {
        type: 'permission_request',
        data: {
          requestId: 'req-it',
          bridgeHints: {
            argsSummaryShort: 'run ls',
            recommendedSurface: 'inline',
          },
        },
      } as never);
      const d2 = Date.now() + 20_000;
      while (
        !senderSaw.some((m) => m.body.includes('Tool call')) &&
        Date.now() < d2
      )
        await sleep(500);
      const reqMsg = senderSaw.find((m) => m.body.includes('Tool call'));
      expect(reqMsg).toBeTruthy();

      // (3) sender reacts 👍 on the bot's (tracked) request → a vote is cast.
      await senderClient.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: reqMsg!.eventId,
          key: '👍',
        },
      });
      const d3 = Date.now() + 20_000;
      while (votesSeen.length === 0 && Date.now() < d3) await sleep(500);
      expect(votesSeen).toEqual([
        { sessionId: 'sess_e2ee', requestId: 'req-it', outcome: 'allow_once' },
      ]);
    } finally {
      ac.abort();
      await adapter?.stop();
      senderClient.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
