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

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16_384;

export function parseDingtalkWebhookConfig(
  config: Readonly<Record<string, unknown>>,
): { webhookUrl: URL; signingSecret?: string } {
  let webhookUrl: URL;
  try {
    const value = config['webhookUrl'];
    if (typeof value !== 'string' || value !== value.trim()) throw new Error();
    webhookUrl = new URL(value);
    const token = webhookUrl.searchParams.get('access_token');
    if (
      webhookUrl.protocol !== 'https:' ||
      webhookUrl.hostname !== 'oapi.dingtalk.com' ||
      webhookUrl.port ||
      webhookUrl.username ||
      webhookUrl.password ||
      webhookUrl.hash ||
      webhookUrl.pathname !== '/robot/send' ||
      webhookUrl.searchParams.size !== 1 ||
      !token?.trim()
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      'DingTalk webhook URL must be https://oapi.dingtalk.com/robot/send with one access_token parameter.',
    );
  }
  const signingSecret = config['signingSecret'];
  if (
    signingSecret !== undefined &&
    (typeof signingSecret !== 'string' || !signingSecret.trim())
  ) {
    throw new Error('DingTalk signing secret must be a non-empty string.');
  }
  return {
    webhookUrl,
    ...(typeof signingSecret === 'string' ? { signingSecret } : {}),
  };
}

export class DingtalkWebhookChannel extends ChannelBase {
  private connection?: ReturnType<typeof parseDingtalkWebhookConfig>;
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
        'DingTalk webhook connection was cancelled.',
      );
    }
    this.connection = parseDingtalkWebhookConfig(this.webhookConfig);
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
      target.chatId === 'default' &&
      target.senderId === 'default' &&
      target.threadId === undefined
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (chatId !== 'default' || typeof text !== 'string' || !text.trim()) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'DingTalk webhook requires its configured destination and non-empty text.',
      );
    }
    if (!this.connection) {
      throw new ChannelProactiveDeliveryError(
        'permanent',
        'DingTalk webhook Channel is not ready.',
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
    connection: NonNullable<DingtalkWebhookChannel['connection']>,
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort('timeout'),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    try {
      const url = new URL(connection.webhookUrl);
      if (connection.signingSecret) {
        const timestamp = String(Date.now());
        const sign = createHmac('sha256', connection.signingSecret)
          .update(`${timestamp}\n${connection.signingSecret}`)
          .digest('base64');
        url.searchParams.set('timestamp', timestamp);
        url.searchParams.set('sign', sign);
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ChannelProactiveDeliveryError(
          response.status === 429 || response.status >= 500
            ? 'transient'
            : 'permanent',
          `DingTalk webhook request failed (HTTP ${response.status}).`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let body = '';
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
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new ChannelProactiveDeliveryError(
          'transient',
          'DingTalk webhook returned an invalid response.',
        );
      }
      const rawCode =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)['errcode']
          : undefined;
      const code =
        typeof rawCode === 'number'
          ? rawCode
          : typeof rawCode === 'string' && /^-?\d{1,10}$/.test(rawCode)
            ? Number(rawCode)
            : undefined;
      if (code === undefined || !Number.isSafeInteger(code)) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          'DingTalk webhook returned an invalid response.',
        );
      }
      if (code !== 0) {
        throw new ChannelProactiveDeliveryError(
          code === -1 || code === 410100 ? 'transient' : 'permanent',
          `DingTalk webhook rejected the message (code ${code}).`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ChannelProactiveDeliveryError(
          'transient',
          controller.signal.reason === 'timeout'
            ? 'DingTalk webhook request timed out; delivery may have been accepted.'
            : 'DingTalk webhook request cancelled; delivery may have been accepted.',
        );
      }
      if (isChannelProactiveDeliveryError(error)) throw error;
      throw new ChannelProactiveDeliveryError(
        'transient',
        'DingTalk webhook request failed or returned an invalid response; delivery may have been accepted.',
      );
    } finally {
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
