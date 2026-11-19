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

export const WECOM_WEBHOOK_DELIVERY_TARGET_ID = 'default';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 16_384;

export function parseWeComWebhookConfig(
  config: Readonly<Record<string, unknown>>,
): { webhookUrl: URL } {
  const value = config['webhookUrl'];
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9._~-]+$/.test(
      value,
    )
  ) {
    throw new Error(
      'WeCom webhook URL must be https://qyapi.weixin.qq.com/cgi-bin/webhook/send with one URL-safe key parameter.',
    );
  }
  return { webhookUrl: new URL(value) };
}

export class WeComWebhookChannel extends ChannelBase {
  private connection?: ReturnType<typeof parseWeComWebhookConfig>;
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
        'WeCom webhook connection was cancelled.',
      );
    }
    this.connection = parseWeComWebhookConfig(this.webhookConfig);
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
      target.chatId === WECOM_WEBHOOK_DELIVERY_TARGET_ID &&
      target.senderId === WECOM_WEBHOOK_DELIVERY_TARGET_ID &&
      target.threadId === undefined
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (
      chatId !== WECOM_WEBHOOK_DELIVERY_TARGET_ID ||
      typeof text !== 'string' ||
      !text.trim()
    ) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'WeCom webhook requires its configured destination and non-empty text.',
      );
    }
    if (!this.connection) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'WeCom webhook Channel is not ready.',
      );
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTENT_BYTES) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'WeCom webhook content exceeds the 4096-byte limit.',
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
    connection: NonNullable<WeComWebhookChannel['connection']>,
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
      const body = JSON.stringify({
        msgtype: 'markdown_v2',
        markdown_v2: { content: text },
      });
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
          `WeCom webhook request failed (HTTP ${response.status}).`,
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
          'WeCom webhook returned an invalid response.',
        );
      }
      const code =
        responsePayload &&
        typeof responsePayload === 'object' &&
        !Array.isArray(responsePayload)
          ? (responsePayload as Record<string, unknown>)['errcode']
          : undefined;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          'WeCom webhook returned an invalid response.',
        );
      }
      if (code !== 0) {
        throw new ChannelProactiveDeliveryError(
          code === -1 || code === 45009 || code === 45033
            ? 'transient'
            : 'permanent',
          `WeCom webhook rejected the message (code ${code}).`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          controller.signal.reason === 'timeout'
            ? 'WeCom webhook request timed out; delivery may have been accepted.'
            : 'WeCom webhook request cancelled; delivery may have been accepted.',
        );
      }
      if (isChannelProactiveDeliveryError(error)) throw error;
      throw new ChannelProactiveDeliveryError(
        'transient',
        'WeCom webhook request failed or returned an invalid response; delivery may have been accepted.',
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
