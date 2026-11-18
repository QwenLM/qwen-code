/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ManagedChannelAdapter,
  ManagedChannelControlPlane,
  ManagedChannelPolicy,
  ManagedClaimedDelivery,
  ManagedInboundEvent,
  ManagedReceipt,
} from '@qwen-code/channel-base';

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

  get destinationKey(): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    // The full registration identity: a pending ledger must follow the owning
    // actor/workspace/cwd-relative too, not just the tenant/channel, or a
    // restart that re-registers the same channel under a different workspace
    // would replay the prior owner's pending messages into the new Session.
    return [
      base,
      this.options.tenantId,
      this.options.channelId,
      this.options.actorId,
      this.options.workspaceId,
      this.options.cwdRelative,
    ].join(String.fromCharCode(0));
  }

  async register(request: {
    platform: ManagedChannelAdapter;
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

  /**
   * PR-watch binding list (github-local GithubPrWatchControlPlane surface). The
   * shared client carries it because pr-watch rides the same trusted channel
   * adapter prefix; email/DingTalk never call it.
   */
  async listPrWatchBindings(): Promise<
    Array<{
      owner: string;
      repo: string;
      prNumber: number;
      sessionId: string;
      events: string[];
    }>
  > {
    const answer = await this.call('POST', '/pr-watch:list', {});
    const bindings = Array.isArray(answer['bindings'])
      ? (answer['bindings'] as Array<Record<string, unknown>>)
      : [];
    return bindings.map((binding) => ({
      owner: String(binding['owner']),
      repo: String(binding['repo']),
      prNumber: Number(binding['prNumber']),
      sessionId: String(binding['sessionId']),
      events: Array.isArray(binding['events'])
        ? (binding['events'] as unknown[]).map(String)
        : [],
    }));
  }

  /**
   * Inject one watched-PR transition into the binding's Session (private-only).
   * The adapter supplies the transition evidence; the model-facing prompt text
   * is composed here because the inject contract requires it. The control plane
   * forces the target Session from the binding and derives the idempotent input
   * id (episode included).
   */
  async injectPrEvent(event: {
    owner: string;
    repo: string;
    prNumber: number;
    transition: string;
    headSha: string;
    evidence: string;
    episode: number;
  }): Promise<void> {
    const text =
      `The watched pull request ${event.owner}/${event.repo}#${event.prNumber} ` +
      `reported a ${event.transition} transition on head ${event.headSha}. ` +
      'Inspect the pull request and decide whether action is needed.';
    await this.call('POST', '/pr-watch:inject', {
      owner: event.owner,
      repo: event.repo,
      prNumber: event.prNumber,
      transition: event.transition,
      headSha: event.headSha,
      episode: event.episode,
      evidence: event.evidence,
      text,
    });
  }

  /**
   * Retire this channel's PR-watch binding so the PR stops consuming an
   * observation slot and can be bound to another Session. Idempotent: a
   * binding that is already gone answers 404, which is a tolerated no-op.
   */
  async retirePrWatchBinding(pr: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<void> {
    try {
      await this.call('POST', '/pr-watch:retire', {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.prNumber,
      });
    } catch (error) {
      if (error instanceof ManagedChannelClientError && error.status === 404) {
        return;
      }
      throw error;
    }
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
