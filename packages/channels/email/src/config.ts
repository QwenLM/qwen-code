import { resolvePrivatePolicy } from '@qwen-code/channel-base';

export function normalizeAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = value.trim().toLowerCase();
  // Deliberately accept a bare ASCII mailbox, never an address list or display name.
  return address.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(
      address,
    )
    ? address
    : undefined;
}

export function addressList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !normalizeAddress(item))) {
    throw new Error(`Email ${field} must contain bare email addresses.`);
  }
  return [...new Set(value.map((item) => normalizeAddress(item)!))];
}

export function emailSettings(raw: Readonly<Record<string, unknown>>) {
  const text = (key: string, fallback?: string): string => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
      throw new Error(`Email ${key} must be a non-empty single-line string.`);
    }
    return value;
  };
  const number = (key: string, fallback: number, max: number): number => {
    const value = raw[key] ?? fallback;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > max
    ) {
      throw new Error(`Email ${key} must be an integer between 1 and ${max}.`);
    }
    return value;
  };
  const secure = (key: string): boolean => {
    const value = raw[key] ?? true;
    if (typeof value !== 'boolean')
      throw new Error(`Email ${key} must be boolean.`);
    return value;
  };
  const address = normalizeAddress(raw['address']);
  if (!address)
    throw new Error('Email address must be a bare mailbox address.');
  if (resolvePrivatePolicy(raw) === 'pairing') {
    throw new Error(
      'Email supports privatePolicy allowlist, open or disabled; configure allowedUsers instead of pairing.',
    );
  }
  if (raw['dispatchMode'] === 'collect') {
    throw new Error(
      'Email does not support collect dispatch mode; use followup or steer so each delivery retains its durable claim.',
    );
  }
  addressList(raw['allowedUsers'], 'allowedUsers');
  addressList(raw['operators'], 'operators');
  const imapSecure = secure('imapSecure');
  const smtpSecure = secure('smtpSecure');
  return {
    address,
    imapHost: text('imapHost'),
    imapPort: number('imapPort', imapSecure ? 993 : 143, 65535),
    imapUser: text('imapUser'),
    imapPassword: text('imapPassword'),
    imapSecure,
    smtpHost: text('smtpHost'),
    smtpPort: number('smtpPort', smtpSecure ? 465 : 587, 65535),
    smtpUser: text('smtpUser'),
    smtpPassword: text('smtpPassword'),
    smtpSecure,
    folder: text('folder', 'INBOX'),
    pollInterval: number('pollInterval', 60_000, 86_400_000),
    maxMessageBytes: number(
      'maxMessageBytes',
      10 * 1024 * 1024,
      50 * 1024 * 1024,
    ),
    maxAttachmentBytes: number(
      'maxAttachmentBytes',
      5 * 1024 * 1024,
      50 * 1024 * 1024,
    ),
    maxTextLength: number('maxTextLength', 32_000, 100_000),
    proactiveRecipients: addressList(
      raw['proactiveRecipients'],
      'proactiveRecipients',
    ),
  };
}

export type EmailSettings = ReturnType<typeof emailSettings>;
