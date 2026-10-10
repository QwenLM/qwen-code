import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlugin, supportedChannelCatalog } from './channel-registry.js';
import { parseChannelConfig } from './config-utils.js';

const config = {
  type: 'email',
  address: 'agent@example.com',
  imapHost: 'imap.example.com',
  imapUser: 'agent',
  imapPassword: '$EMAIL_IMAP_TEST',
  smtpHost: 'smtp.example.com',
  smtpUser: 'agent',
  smtpPassword: '$EMAIL_SMTP_TEST',
};

afterEach(() => vi.unstubAllEnvs());

describe('built-in Email channel #8281', () => {
  it('offers Email in the catalog with managed secret and access fields', async () => {
    const entry = (await supportedChannelCatalog()).find(
      (channel) => channel.type === 'email',
    );
    expect(entry).toMatchObject({ manageable: true, displayName: 'Email' });
    for (const key of ['imapPassword', 'smtpPassword']) {
      expect(entry?.fields.find((field) => field.key === key)).toMatchObject({
        kind: 'secret',
        envResolvable: true,
      });
    }
    expect(
      entry?.fields.find((field) => field.key === 'privatePolicy')?.default,
    ).toBe('allowlist');
    expect(await getPlugin('email')).toBeDefined();
  });

  it('resolves environment references without mutating settings and defaults to isolated threads', async () => {
    vi.stubEnv('EMAIL_IMAP_TEST', 'imap-fixture-secret');
    vi.stubEnv('EMAIL_SMTP_TEST', 'smtp-fixture-secret');
    const parsed = await parseChannelConfig('mail', config);
    expect(parsed).toMatchObject({
      imapPassword: 'imap-fixture-secret',
      smtpPassword: 'smtp-fixture-secret',
      sessionScope: 'chat_thread',
      privatePolicy: 'allowlist',
    });
    expect(config.imapPassword).toBe('$EMAIL_IMAP_TEST');
    expect(
      (await getPlugin('email'))?.management?.validateConfig?.(parsed),
    ).toBeUndefined();
  });
});
