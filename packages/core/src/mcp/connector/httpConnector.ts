/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { authenticateHttpConnection } from './httpAuthentication.js';
import { prepareHttpConnection } from './httpPreparation.js';
import { createUrlTransport } from './transport/url.js';
import { WebsocketMcpConnector } from './websocketConnector.js';
import type {
  McpAuthenticationFailure,
  McpTransportConnector,
} from './httpAuthentication.js';
import type {
  McpConnectOutcome,
  McpConnectRequest,
  McpConnector,
  McpConnectorContext,
  McpPreparedHttpConnection,
} from './types.js';

/**
 * Shared setup for every URL-based transport: `${VAR}` expansion in the url
 * fields, an OAuth provider that can refresh mid-session, and headers from
 * `headersHelper`.
 *
 * A free function rather than a base class so `WebsocketMcpConnector` can reuse
 * it without `HttpMcpConnector` having to hold an instance of its own subclass.
 */

/**
 * Standard HTTP-family connector: Streamable HTTP and legacy SSE, with OAuth.
 *
 * `type: 'ws'` is delegated to {@link WebsocketMcpConnector}. Subclassing and
 * overriding {@link HttpMcpConnector.prepareManaged} is the supported way to
 * route some servers to a different endpoint; replacing the `http` slot in the
 * connector map installs the subclass.
 */
export class HttpMcpConnector implements McpConnector {
  private readonly websocket = new WebsocketMcpConnector();

  async connect(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
  ): Promise<McpConnectOutcome> {
    // A host subclass gets first refusal: whatever it prepares replaces the
    // standard url expansion / OAuth / headers path entirely.
    const managed = await this.prepareManaged(request, ctx);
    if (managed) {
      return {
        transport: this.createUrlTransport(request.serverName, managed),
      };
    }
    const { config } = request;
    if (!config.httpUrl && config.url && config.type === 'ws') {
      return this.websocket.connect(request, ctx);
    }
    const prepared = await prepareHttpConnection(request, ctx);
    return {
      transport: this.createUrlTransport(request.serverName, prepared),
    };
  }

  /**
   * Decides whether a server is reached through a substituted endpoint rather
   * than the one in its config. Returning `undefined` means "no substitution,
   * use the standard preparation". The base implementation always declines.
   */
  protected prepareManaged(
    _request: McpConnectRequest,
    _ctx: McpConnectorContext,
  ): Promise<McpPreparedHttpConnection | undefined> {
    return Promise.resolve(undefined);
  }

  async authenticate(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
    failure: McpAuthenticationFailure,
    connectTransport: McpTransportConnector,
  ): Promise<void> {
    await authenticateHttpConnection(
      request.serverName,
      request.config,
      ctx.cliConfig,
      failure,
      connectTransport,
    );
  }

  /**
   * Picks the concrete URL transport. Overridable so a host connector can keep
   * the shared preparation and still change which transport is built.
   */
  protected createUrlTransport(
    serverName: string,
    prepared: McpPreparedHttpConnection,
  ): Transport {
    return createUrlTransport(
      serverName,
      prepared.config,
      prepared.transportOptions,
    );
  }
}
