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

  it('injects the group policy the Web Shell treats as inert for Email', async () => {
    // The plugin does not declare groupPolicy, so the registry injects it.
    // The Web Shell's private-only handling and its fixtures are built on this
    // shape; pin it here at the producer rather than only in client fixtures.
    const entry = (await supportedChannelCatalog()).find(
      (channel) => channel.type === 'email',
    );
    const plugin = await getPlugin('email');
    expect(
      plugin?.management?.fields.some((field) => field.key === 'groupPolicy'),
    ).toBe(false);
    expect(
      entry?.fields.find((field) => field.key === 'groupPolicy'),
    ).toMatchObject({ kind: 'enum', required: true, default: 'disabled' });
  });

  it('gives every required field a readable label and defaults implicit TLS on', async () => {
    const entry = (await supportedChannelCatalog()).find(
      (channel) => channel.type === 'email',
    );
    // The descriptor is public: a client without its own translation table
    // renders `label` directly, so a raw config key must never reach it.
    for (const key of [
      'address',
      'imapHost',
      'imapUser',
      'imapPassword',
      'smtpHost',
      'smtpUser',
      'smtpPassword',
    ]) {
      const field = entry?.fields.find((item) => item.key === key);
      expect(field?.label).not.toBe(key);
      expect(field?.label?.trim()).not.toBe('');
    }
    expect(entry?.fields.find((field) => field.key === 'imapHost')?.label).toBe(
      'IMAP Host',
    );
    // The editor seeds an absent boolean from this default, so it is what
    // keeps a mailbox on implicit TLS instead of silently dropping to STARTTLS.
    for (const key of ['imapSecure', 'smtpSecure']) {
      expect(entry?.fields.find((field) => field.key === key)).toMatchObject({
        kind: 'boolean',
        default: 'true',
      });
    }
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
