/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import webpush from 'web-push';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Gateway-owned VAPID keypair. Generated lazily on first open and persisted as
 * base64url JSON at mode 0600 (the private key is a secret). The private key is
 * exposed only via getKeys() (consumed by the cycle-9 sender); no route returns
 * it and it is never logged or audited.
 */
export class VapidStore {
  private constructor(
    private readonly keys: VapidKeys,
    private readonly subject: string,
  ) {}

  static async open(filePath: string, subject?: string): Promise<VapidStore> {
    let keys: VapidKeys | undefined;
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VapidKeys>;
      if (
        typeof parsed.publicKey === 'string' &&
        parsed.publicKey.length > 0 &&
        typeof parsed.privateKey === 'string' &&
        parsed.privateKey.length > 0
      ) {
        keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // Missing/corrupt file → regenerate below.
    }

    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(keys), { mode: 0o600 });
    }

    const resolvedSubject =
      subject ??
      process.env.QWEN_RC_WEBPUSH_SUBJECT ??
      `mailto:noreply@${hostname()}`;
    return new VapidStore(keys, resolvedSubject);
  }

  /** Base64url public key handed to clients for pushManager.subscribe(). */
  getApplicationServerKey(): string {
    return this.keys.publicKey;
  }

  /** Full keypair, including the private key (for the cycle-9 sender only). */
  getKeys(): VapidKeys {
    return this.keys;
  }

  /** mailto:/https: subject used by the sender (cycle 9). */
  getSubject(): string {
    return this.subject;
  }
}
