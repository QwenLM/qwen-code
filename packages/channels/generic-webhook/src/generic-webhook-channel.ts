/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ChannelBase,
  ChannelProactiveDeliveryError,
  isChannelProactiveDeliveryError,
} from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  SessionTarget,
} from '@qwen-code/channel-base';
import {
  NetworkPolicyError,
  resolveNetworkTarget,
} from '@qwen-code/network-policy';
import undici from 'undici';
import type { Dispatcher } from 'undici';
import { parseGenericWebhookConfig } from './config.js';
import type { GenericWebhookConfig } from './config.js';

export const GENERIC_WEBHOOK_DELIVERY_TARGET_ID = 'default';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 640 * 1024;

function boundedCleanup(
  cleanup: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void Promise.resolve().then(cleanup).then(finish, finish);
    if (signal.aborted) finish();
  });
}

export class GenericWebhookChannel extends ChannelBase {
  private connection?: GenericWebhookConfig;
  private lifecycle = 0;
  private readonly requests = new Map<AbortController, Promise<void>>();
  private disconnectDrain = Promise.resolve();

  constructor(
    name: string,
    private readonly webhookConfig: ChannelConfig & Record<string, unknown>,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, webhookConfig, bridge, options);
  }

  async connect(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.connection = undefined;
    await this.disconnectDrain;
    if (lifecycle !== this.lifecycle) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Generic webhook connection was cancelled.',
      );
    }
    this.connection = parseGenericWebhookConfig(this.webhookConfig);
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  protected override supportsProactiveTarget(_target: SessionTarget): boolean {
    return false;
  }

  protected override supportsProactiveWebhookTarget(
    _target: SessionTarget,
  ): boolean {
    return false;
  }

  protected override supportsProactiveDeliveryTarget(
    target: SessionTarget,
  ): boolean {
    return (
      target.channelName === this.name &&
      target.isGroup === true &&
      target.chatId === GENERIC_WEBHOOK_DELIVERY_TARGET_ID &&
      target.senderId === GENERIC_WEBHOOK_DELIVERY_TARGET_ID &&
      target.threadId === undefined
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (
      chatId !== GENERIC_WEBHOOK_DELIVERY_TARGET_ID ||
      typeof text !== 'string' ||
      !text.trim()
    ) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Generic webhook requires its configured destination and non-empty text.',
      );
    }
    if (!this.connection) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Generic webhook Channel is not ready.',
      );
    }
    const body = JSON.stringify({ version: 1, text });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Generic webhook request exceeds the 655,360-byte limit.',
      );
    }
    const controller = new AbortController();
    const pending = this.post(this.connection, body, controller);
    this.requests.set(controller, pending);
    try {
      await pending;
    } finally {
      this.requests.delete(controller);
    }
  }

  private async post(
    connection: GenericWebhookConfig,
    body: string,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort('timeout'),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    let dispatcher: Dispatcher | undefined;
    let response: Awaited<ReturnType<typeof undici.fetch>> | undefined;
    try {
      const target = await resolveNetworkTarget(
        connection.webhookUrl,
        connection.networkPolicy,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (this.proxy) {
        const port =
          target.url.port || (target.url.protocol === 'https:' ? '443' : '80');
        const authority = `${target.url.hostname}:${port}`;
        const pinnedAuthority = `${target.family === 6 ? `[${target.address}]` : target.address}:${port}`;
        dispatcher = new undici.EnvHttpProxyAgent({
          httpProxy: this.proxy,
          httpsProxy: this.proxy,
          connect: { lookup: target.lookup, rejectUnauthorized: true },
          requestTls: { rejectUnauthorized: true },
          proxyTls: { rejectUnauthorized: true },
          clientFactory: (origin, options) =>
            new undici.Pool(origin, options).compose(
              (dispatch) => (options, handler) => {
                if (
                  options.method !== 'CONNECT' ||
                  options.path !== authority
                ) {
                  throw new Error('Unexpected generic webhook proxy tunnel.');
                }
                return dispatch(
                  {
                    ...options,
                    path: pinnedAuthority,
                    headers: { ...options.headers, host: pinnedAuthority },
                  },
                  handler,
                );
              },
            ),
        });
      } else {
        dispatcher = new undici.Agent({
          connect: { lookup: target.lookup, rejectUnauthorized: true },
        });
      }
      response = await undici.fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.bearerToken
            ? { Authorization: `Bearer ${connection.bearerToken}` }
            : {}),
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
      });
      if (!response.ok) {
        throw new ChannelProactiveDeliveryError(
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
            ? 'transient'
            : 'permanent',
          `Generic webhook request failed (HTTP ${response.status}).`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          controller.signal.reason === 'timeout'
            ? 'Generic webhook request timed out; delivery may have been accepted.'
            : 'Generic webhook request cancelled; delivery may have been accepted.',
        );
      }
      if (isChannelProactiveDeliveryError(error)) throw error;
      if (error instanceof NetworkPolicyError) {
        throw new ChannelProactiveDeliveryError(
          'permanent',
          'Generic webhook destination is not permitted by its network policy.',
        );
      }
      throw new ChannelProactiveDeliveryError(
        'transient',
        'Generic webhook request failed; delivery may have been accepted.',
      );
    } finally {
      await Promise.all([
        boundedCleanup(async () => response?.body?.cancel(), controller.signal),
        boundedCleanup(async () => dispatcher?.destroy(), controller.signal),
      ]);
      clearTimeout(timeout);
    }
  }

  disconnect(): void {
    this.lifecycle++;
    this.connection = undefined;
    for (const controller of this.requests.keys()) controller.abort('shutdown');
    this.disconnectDrain = Promise.allSettled(this.requests.values()).then(
      () => undefined,
    );
  }

  override waitForDisconnect(): Promise<void> {
    return this.disconnectDrain;
  }
}
