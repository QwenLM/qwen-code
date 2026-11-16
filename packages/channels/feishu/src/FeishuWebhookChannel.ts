/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac } from 'node:crypto';
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
import { buildFeishuWebhookCard } from './webhook-card.js';

export const FEISHU_WEBHOOK_DELIVERY_TARGET_ID = 'default';

const REQUEST_TIMEOUT_MS = 15_000;
// A conservative local budget; Feishu documents 20 KB without an exact byte value.
const MAX_REQUEST_BYTES = 20_000;
const MAX_RESPONSE_BYTES = 16_384;

export function parseFeishuWebhookConfig(
  config: Readonly<Record<string, unknown>>,
): { webhookUrl: URL; signingSecret?: string } {
  let webhookUrl: URL;
  try {
    const value = config['webhookUrl'];
    if (
      typeof value !== 'string' ||
      value !== value.trim() ||
      /[%\\?#\s]/.test(value)
    ) {
      throw new Error();
    }
    webhookUrl = new URL(value);
    if (
      webhookUrl.protocol !== 'https:' ||
      webhookUrl.hostname !== 'open.feishu.cn' ||
      webhookUrl.port ||
      webhookUrl.username ||
      webhookUrl.password ||
      webhookUrl.hash ||
      webhookUrl.search ||
      !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9._~-]+$/.test(
        webhookUrl.pathname,
      )
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      'Feishu webhook URL must be https://open.feishu.cn/open-apis/bot/v2/hook/ with one URL-safe token path segment.',
    );
  }
  const signingSecret = config['signingSecret'];
  if (
    signingSecret !== undefined &&
    (typeof signingSecret !== 'string' ||
      !signingSecret.trim() ||
      signingSecret !== signingSecret.trim())
  ) {
    throw new Error(
      'Feishu signing secret must be a non-empty string without surrounding whitespace.',
    );
  }
  return {
    webhookUrl,
    ...(typeof signingSecret === 'string' ? { signingSecret } : {}),
  };
}

export class FeishuWebhookChannel extends ChannelBase {
  private connection?: ReturnType<typeof parseFeishuWebhookConfig>;
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
        'Feishu webhook connection was cancelled.',
      );
    }
    this.connection = parseFeishuWebhookConfig(this.webhookConfig);
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
      target.chatId === FEISHU_WEBHOOK_DELIVERY_TARGET_ID &&
      target.senderId === FEISHU_WEBHOOK_DELIVERY_TARGET_ID &&
      target.threadId === undefined
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (
      chatId !== FEISHU_WEBHOOK_DELIVERY_TARGET_ID ||
      typeof text !== 'string' ||
      !text.trim()
    ) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Feishu webhook requires its configured destination and non-empty text.',
      );
    }
    if (!this.connection) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'Feishu webhook Channel is not ready.',
      );
    }
    const controller = new AbortController();
    const pending = this.post(this.connection, text, controller);
    this.requests.set(controller, pending);
    try {
      await pending;
    } finally {
      this.requests.delete(controller);
    }
  }

  private async post(
    connection: NonNullable<FeishuWebhookChannel['connection']>,
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort('timeout'),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    let dispatcher: import('undici').Dispatcher | undefined;
    try {
      const payload: Record<string, unknown> = {
        msg_type: 'interactive',
        card: buildFeishuWebhookCard(text),
      };
      if (connection.signingSecret) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        payload['timestamp'] = timestamp;
        payload['sign'] = createHmac(
          'sha256',
          `${timestamp}\n${connection.signingSecret}`,
        ).digest('base64');
      }
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
        throw new ChannelProactiveDeliveryError(
          'permanent',
          'Feishu webhook request exceeds the local 20,000-byte limit.',
        );
      }
      const request = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'error' as const,
        signal: controller.signal,
      };
      let response: Response | import('undici').Response;
      if (this.proxy) {
        const { default: undici } = await import('undici');
        dispatcher = new undici.EnvHttpProxyAgent({
          httpProxy: this.proxy,
          httpsProxy: this.proxy,
        });
        response = await undici.fetch(connection.webhookUrl, {
          ...request,
          dispatcher,
        });
      } else {
        response = await fetch(connection.webhookUrl, request);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ChannelProactiveDeliveryError(
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
            ? 'transient'
            : 'permanent',
          `Feishu webhook request failed (HTTP ${response.status}).`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let responseBody = '';
      let bytes = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error();
          }
          responseBody += decoder.decode(value, { stream: true });
        }
        responseBody += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      let responsePayload: unknown;
      try {
        responsePayload = JSON.parse(responseBody);
      } catch {
        throw new ChannelProactiveDeliveryError(
          'transient',
          'Feishu webhook returned an invalid response.',
        );
      }
      const code =
        responsePayload &&
        typeof responsePayload === 'object' &&
        !Array.isArray(responsePayload)
          ? (responsePayload as Record<string, unknown>)['code']
          : undefined;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          'Feishu webhook returned an invalid response.',
        );
      }
      if (code !== 0) {
        throw new ChannelProactiveDeliveryError(
          code === 11232 ? 'transient' : 'permanent',
          `Feishu webhook rejected the message (code ${code}).`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          controller.signal.reason === 'timeout'
            ? 'Feishu webhook request timed out; delivery may have been accepted.'
            : 'Feishu webhook request cancelled; delivery may have been accepted.',
        );
      }
      if (isChannelProactiveDeliveryError(error)) throw error;
      throw new ChannelProactiveDeliveryError(
        'transient',
        'Feishu webhook request failed or returned an invalid response; delivery may have been accepted.',
      );
    } finally {
      clearTimeout(timeout);
      await dispatcher?.destroy().catch(() => {});
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
