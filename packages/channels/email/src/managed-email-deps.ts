import type { ManagedEmailAdapterDeps } from './managed-email-adapter.js';

/**
 * The production dependencies of the managed email adapter: the same IMAP,
 * SMTP, parser and lock the Legacy adapter uses, with the same transport
 * hardening (TLS required, no file or URL access, bounded timeouts).
 */
export function createManagedEmailDeps(): ManagedEmailAdapterDeps {
  return {
    createImap: async (settings) => {
      const { default: imapflow } = await import('imapflow');
      const { ImapFlow: Client } = imapflow;
      return new Client({
        host: settings.imapHost,
        port: settings.imapPort,
        secure: settings.imapSecure,
        ...(settings.imapSecure ? {} : { doSTARTTLS: true }),
        tls: { rejectUnauthorized: true },
        auth: { user: settings.imapUser, pass: settings.imapPassword },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 60_000,
      });
    },
    createSmtp: async (settings) => {
      const { default: nodemailer } = await import('nodemailer');
      return nodemailer.createTransport({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
        auth: { user: settings.smtpUser, pass: settings.smtpPassword },
        logger: false,
        debug: false,
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 60_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    parse: async () => (await import('mailparser')).default.simpleParser,
    lock: async (directory) => {
      const { default: lockfile } = await import('proper-lockfile');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return lockfile.lock(directory, { retries: 0 });
    },
  };
}
