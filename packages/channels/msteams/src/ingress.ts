import { CloudAdapter } from '@microsoft/agents-hosting';
import type { Request, WebResponse } from '@microsoft/agents-hosting';
import {
  normalizeActivity,
  teamsServiceUrls,
  TeamsActivityError,
} from './activity.js';
import type {
  TeamsCredentials,
  TeamsInboundEvent,
  TeamsIngress,
  TeamsWebhookRequest,
  TeamsWebhookResponse,
} from './types.js';

export const MAX_BODY_BYTES = 1024 * 1024;

class ResponseBuffer implements WebResponse {
  result: TeamsWebhookResponse = { status: 200, headers: {} };
  headersSent = false;
  writableEnded = false;
  status(code: number): this {
    this.result.status = code;
    return this;
  }
  setHeader(name: string, value: string): this {
    this.result.headers[name] = value;
    return this;
  }
  send(body?: unknown): this {
    this.result.body = body;
    this.headersSent = true;
    return this;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
}

export function createTeamsAdapter(config: TeamsCredentials): CloudAdapter {
  if (!config.appId || !config.appPassword || !config.tenantId) {
    throw new Error('Teams requires appId, appPassword, and tenantId.');
  }
  const adapter = new CloudAdapter(
    {
      // A flat SDK config is ignored when the host defines Connections__*.
      connections: new Map([
        [
          'serviceConnection',
          {
            clientId: config.appId,
            clientSecret: config.appPassword,
            tenantId: config.tenantId,
            validateIssuer: true,
          },
        ],
      ]),
      connectionsMap: [{ serviceUrl: '*', connection: 'serviceConnection' }],
    },
    undefined,
    undefined,
    { validateServiceUrl: true },
    teamsServiceUrls,
  );
  // The SDK default swallows turn errors, acknowledging failed durable acceptance.
  adapter.onTurnError = async (_context, error) => {
    throw error;
  };
  return adapter;
}

export async function handleTeamsWebhook(
  adapter: CloudAdapter,
  name: string,
  config: TeamsCredentials,
  acceptInbound: (event: TeamsInboundEvent) => Promise<void>,
  input: TeamsWebhookRequest,
): Promise<TeamsWebhookResponse> {
  if (Buffer.byteLength(JSON.stringify(input.body), 'utf8') > MAX_BODY_BYTES)
    return { status: 413, headers: {} };
  const request: Request = {
    method: 'POST',
    headers: input.headers,
    body: input.body,
  };
  const response = new ResponseBuffer();
  let authorized = false;
  try {
    await adapter.authorizeRequest(request, response, (error?: unknown) => {
      if (error) throw error;
      authorized = true;
    });
    if (!authorized || !request.user)
      return { ...response.result, status: 401 };
    await adapter.process(request, response, async (context) => {
      const event = normalizeActivity(name, config, context.activity);
      if (event) await acceptInbound(event);
    });
    return response.result;
  } catch (error) {
    return {
      status:
        error instanceof TeamsActivityError ? 400 : authorized ? 503 : 401,
      headers: {},
    };
  }
}

export function createTeamsIngress(
  name: string,
  credentials: TeamsCredentials,
  acceptInbound: (event: TeamsInboundEvent) => Promise<void>,
): TeamsIngress {
  const config = { ...credentials };
  const adapter = createTeamsAdapter(config);
  return {
    handleWebhook: (input) =>
      handleTeamsWebhook(adapter, name, config, acceptInbound, input),
  };
}
