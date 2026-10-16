/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ManagedChannelControlPlane,
  ManagedChannelPolicy,
  ManagedClaimedDelivery,
  ManagedInboundEvent,
  ManagedReceipt,
} from '@qwen-code/channel-email';

// H5b/H5c of #12827: the HTTP client of the control plane's trusted channel
// adapter surface (/internal/managed-channels/v1), reachable on the
// deployment's internal listener only. Every call is one of the surface's
// idempotent verbs; a non-2xx answer is an error naming the server's code,
// and the adapter decides what to re-drive.

export interface ManagedChannelClientOptions {
  /** The internal listener's base URL, e.g. http://127.0.0.1:4181. */
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly channelId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly cwdRelative: string;
  readonly fetch?: typeof fetch;
}

export class ManagedChannelClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HttpManagedChannelControlPlane
  implements ManagedChannelControlPlane
{
  private readonly fetchImpl: typeof fetch;
  private readonly root: string;

  constructor(private readonly options: ManagedChannelClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.root = `${options.baseUrl.replace(/\/+$/, '')}/internal/managed-channels/v1/channels/${encodeURIComponent(options.channelId)}`;
  }

  async register(request: {
    platform: 'email';
    accountId: string;
    accountGeneration: number;
    policy: ManagedChannelPolicy;
  }): Promise<void> {
    await this.call('PUT', '', {
      platform: request.platform,
      accountId: request.accountId,
      accountGeneration: request.accountGeneration,
      actorId: this.options.actorId,
      workspaceId: this.options.workspaceId,
      cwdRelative: this.options.cwdRelative,
      policy: request.policy,
    });
  }

  async disconnect(): Promise<void> {
    await this.call('POST', '/disconnect', {});
  }

  async submitInbound(
    event: ManagedInboundEvent,
  ): Promise<{ inputId: string; sessionId: string; replayed: boolean }> {
    const answer = await this.call('POST', '/inbound', {
      accountGeneration: event.accountGeneration,
      platformEventId: event.platformEventId,
      semanticRevision: event.semanticRevision,
      scope: event.scope,
      senderId: event.senderId,
      chatId: event.chatId,
      threadId: event.threadId,
      subject: event.subject,
      text: event.text,
      attachments: event.attachments,
      replyContext: event.replyContext,
    });
    return {
      inputId: String(answer['inputId']),
      sessionId: String(answer['sessionId']),
      replayed: answer['replayed'] === true,
    };
  }

  async claimDeliveries(limit: number): Promise<ManagedClaimedDelivery[]> {
    const answer = await this.call('POST', '/deliveries:claim', { limit });
    const deliveries = Array.isArray(answer['deliveries'])
      ? (answer['deliveries'] as Array<Record<string, unknown>>)
      : [];
    return deliveries.map((delivery) => ({
      deliveryId: String(delivery['deliveryId']),
      replyContext: delivery['replyContext'] ?? null,
      segments: (
        (delivery['segments'] ?? []) as Array<Record<string, unknown>>
      ).map((segment) => ({
        ordinal: Number(segment['ordinal']),
        segmentId: String(segment['segmentId']),
        text: String(segment['text'] ?? ''),
      })),
    }));
  }

  async receipt(deliveryId: string, receipt: ManagedReceipt): Promise<void> {
    await this.call(
      'POST',
      `/deliveries/${encodeURIComponent(deliveryId)}:receipt`,
      receipt.outcome === 'accepted'
        ? {
            outcome: 'accepted',
            ordinal: receipt.ordinal,
            providerMessageId: receipt.providerMessageId,
            acceptedAt: receipt.acceptedAt,
          }
        : { outcome: receipt.outcome },
    );
  }

  private async call(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.root}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-qwen-tenant-id': this.options.tenantId,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    const record =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    if (!response.ok) {
      const error = record['error'];
      const code =
        typeof error === 'object' && error !== null
          ? String((error as Record<string, unknown>)['code'] ?? 'error')
          : String(record['code'] ?? 'error');
      throw new ManagedChannelClientError(
        response.status,
        code,
        `Managed channel control plane answered ${response.status} ${code} for ${method} ${path || '/'}.`,
      );
    }
    return record;
  }
}
