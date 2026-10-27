import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTeamsAdapter } from './ingress.js';

afterEach(() => {
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
