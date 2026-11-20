import { ConnectorClient } from '@microsoft/agents-hosting';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTeamsAdapter, handleTeamsWebhook } from './ingress.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Teams SDK connection isolation', () => {
  it('preserves the configured bot and issuer validation under a host connection registry', () => {
    vi.stubEnv('TEST_MODE', 'true');
    vi.stubEnv('Connections__Host__Settings__ClientId', 'other-bot');
    vi.stubEnv(
      'Connections__Host__Settings__ClientSecret',
      'synthetic-other-secret',
    );
    vi.stubEnv('Connections__Host__Settings__TenantId', 'other-tenant');
    vi.stubEnv('Connections__Host__Settings__ValidateIssuer', 'false');
    vi.stubEnv('ConnectionsMap__0__Connection', 'Host');
    vi.stubEnv('ConnectionsMap__0__ServiceUrl', '*');
    const adapter = createTeamsAdapter({
      appId: 'teams-bot',
      appPassword: 'synthetic-teams-secret',
      tenantId: 'teams-tenant',
    });
    const configuration =
      adapter.connectionManager.getDefaultConnectionConfiguration();
    expect(configuration.clientId).toBe('teams-bot');
    expect(configuration.tenantId).toBe('teams-tenant');
    expect(configuration.validateIssuer).toBe(true);
    expect(() => adapter.connectionManager.getConnection('Host')).toThrow();
    expect(
      adapter.connectionManager.getTokenProvider(
        { aud: 'teams-bot' },
        'https://smba.trafficmanager.net/amer/',
      ).connectionSettings?.clientId,
    ).toBe('teams-bot');
  });
});

describe('Teams ingress with the real SDK turn pipeline', () => {
  const credentials = {
    appId: 'teams-bot',
    appPassword: 'synthetic-teams-secret',
    tenantId: 'teams-tenant',
  };
  const serviceUrl = 'https://smba.trafficmanager.net/amer/';

  it.each([
    ['accepts the configured tenant', 'teams-tenant', false, 200, 1],
    ['rejects matching foreign tenant fields', 'other-tenant', false, 400, 0],
    ['does not acknowledge failed acceptance', 'teams-tenant', true, 503, 1],
  ] as const)(
    '%s',
    async (_name, tenantId, rejectAcceptance, status, calls) => {
      const adapter = createTeamsAdapter(credentials);
      // Only authentication and outbound network effects are fixtures; process and
      // the SDK's turn-error middleware must remain real for the ACK regression.
      vi.spyOn(adapter, 'authorizeRequest').mockImplementation(
        async (request, _response, next) => {
          request.user = { aud: credentials.appId, serviceurl: serviceUrl };
          next();
        },
      );
      vi.spyOn(
        adapter.connectionManager.getDefaultConnection(),
        'getAccessToken',
      ).mockResolvedValue('synthetic-connector-token');
      vi.spyOn(ConnectorClient.prototype, 'replyToActivity').mockResolvedValue({
        id: 'synthetic-reply',
      });
      vi.spyOn(
        ConnectorClient.prototype,
        'sendToConversation',
      ).mockResolvedValue({
        id: 'synthetic-send',
      });
      const acceptInbound = vi.fn(async () => {
        if (rejectAcceptance) throw new Error('Persistence unavailable');
      });

      const response = await handleTeamsWebhook(
        adapter,
        'teams',
        credentials,
        acceptInbound,
        {
          headers: {},
          body: {
            type: 'message',
            id: 'message-1',
            channelId: 'msteams',
            serviceUrl,
            recipient: { id: '28:teams-bot' },
            from: { id: 'teams-user', aadObjectId: 'user-a' },
            conversation: {
              id: 'chat-1',
              conversationType: 'personal',
              tenantId,
            },
            channelData: { tenant: { id: tenantId } },
            text: 'hello',
          },
        },
      );

      expect(acceptInbound).toHaveBeenCalledTimes(calls);
      expect(response.status).toBe(status);
    },
  );
});
