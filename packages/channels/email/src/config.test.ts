import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressList, emailSettings, normalizeAddress } from './config.js';
import { EmailStateStore, validState } from './state.js';
import { boundedText } from './message.js';

const settings = {
  address: 'agent@example.com',
  imapHost: 'imap.example.com',
  imapUser: 'agent',
  imapPassword: 'secret',
  smtpHost: 'smtp.example.com',
  smtpUser: 'agent',
  smtpPassword: 'secret',
};
describe('email configuration and bounds', () => {
  it('normalizes bare addresses and rejects recipient lists/header injection', () => {
    expect(normalizeAddress(' ALICE@Example.Com ')).toBe('alice@example.com');
    for (const value of [
      'Alice <alice@example.com>',
      'a@example.com,b@example.com',
      'a@example.com\r\nBcc:b@example.com',
      'a@example.com; b@example.com',
      '',
      undefined,
    ])
      expect(normalizeAddress(value)).toBeUndefined();
    expect(
      addressList(['A@example.com', 'a@example.com'], 'allowedUsers'),
    ).toEqual(['a@example.com']);
    expect(() => addressList('a@example.com', 'allowedUsers')).toThrow('bare');
  });
  it('requires TLS modes and finite size/time/port bounds without echoing values', () => {
    expect(emailSettings(settings)).toMatchObject({
      imapPort: 993,
      smtpPort: 465,
      imapSecure: true,
      smtpSecure: true,
    });
    expect(
      emailSettings({ ...settings, imapSecure: false, smtpSecure: false }),
    ).toMatchObject({ imapPort: 143, smtpPort: 587 });
    for (const override of [
      { smtpSecure: 'false' },
      { imapPort: NaN },
      { maxTextLength: -1 },
      { maxMessageBytes: Infinity },
      { pollInterval: 0 },
      { privatePolicy: 'pairing' },
      { dispatchMode: 'collect' },
    ])
      expect(() => emailSettings({ ...settings, ...override })).toThrow();
    expect(() =>
      emailSettings({ ...settings, smtpPassword: '\r\nsecret' }),
    ).toThrow('Email smtpPassword must be a non-empty single-line string.');
  });
  it('bounds body text and removes conventional quote/signature blocks', () => {
    expect(boundedText('new\n\n> old', 200)).toBe('new');
    expect(boundedText('new\n-- \nsignature', 200)).toBe('new');
    expect(boundedText('new\nOn Monday Alice wrote:\nold', 200)).toBe('new');
    expect(boundedText('abcdef', 3)).toBe('abc');
  });
  it('isolates workspaces/accounts but keeps canonical paths and credential rotation stable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'email-scope-'));
    try {
      const workspace = join(directory, 'workspace');
      mkdirSync(workspace);
      const alias = join(directory, 'alias');
      symlinkSync(workspace, alias, 'dir');
      const normal = new EmailStateStore(
        'mail',
        workspace,
        emailSettings(settings),
      );
      expect(
        new EmailStateStore(
          'mail',
          alias,
          emailSettings({ ...settings, imapPassword: 'rotated' }),
        ).file,
      ).toBe(normal.file);
      expect(
        new EmailStateStore(
          'mail',
          join(directory, 'other'),
          emailSettings(settings),
        ).file,
      ).not.toBe(normal.file);
      expect(
        new EmailStateStore(
          'mail',
          workspace,
          emailSettings({ ...settings, imapUser: 'other' }),
        ).file,
      ).not.toBe(normal.file);
      expect(
        new EmailStateStore('other-name', workspace, emailSettings(settings))
          .file,
      ).not.toBe(normal.file);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('fails closed on invalid durable state', () => {
    const empty = {
      version: 1,
      uidValidity: '1',
      lastUid: 0,
      pending: [],
      outboundPending: [],
      recent: [],
      routes: [],
    };
    expect(validState(empty)).toBe(true);
    expect(validState({ ...empty, lastUid: -1 })).toBe(false);
    expect(validState({ ...empty, pending: [1] })).toBe(false);
    expect(validState({ ...empty, uidValidity: '0' })).toBe(false);
    expect(validState({ ...empty, uidValidity: '4294967296' })).toBe(false);
    expect(validState({ ...empty, routes: [{}] })).toBe(false);
    expect(validState(null)).toBe(false);
  });
});
