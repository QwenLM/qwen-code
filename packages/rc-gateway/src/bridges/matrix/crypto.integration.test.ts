/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LIVE Matrix E2EE round-trip integration test (closes the decrypt half of the
 * ceiling). It is ENV-GATED and skips cleanly in the default suite — it runs only
 * against a real Synapse, which the operator stands up in Docker (see
 * `integration/matrix/README.md`). Set:
 *   QWEN_MATRIX_IT_HS_URL     e.g. http://synapse.pkix.local:8008
 *   QWEN_MATRIX_IT_REG_SECRET the homeserver's registration_shared_secret
 *
 * Flow: provision two throwaway crypto users (bot + sender); the SENDER creates an
 * encrypted room and invites the bot; the BOT (our Apns-style cryptoAdapter) joins,
 * prepares crypto and starts syncing — BEFORE the sender sends, because Megolm
 * shares the session key to known devices at send time and does not re-key history;
 * then the sender sends an encrypted message and we assert the bot's `onMessage`
 * fires with the decrypted plaintext.
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
});
