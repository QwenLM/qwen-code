import { describe, expect, it } from 'vitest';
import type { ExportSessionData } from '../types.js';
import { injectDocumentIntoHtmlTemplate, toHtml } from './html.js';

const sessionData: ExportSessionData = {
  sessionId: 'session-secret',
  startTime: '2026-08-16T00:00:00.000Z',
  messages: [],
  metadata: {
    sessionId: 'session-secret',
    startTime: '2026-08-16T00:00:00.000Z',
    exportTime: '2026-08-16T01:00:00.000Z',
    cwd: '/home/alice/project',
    promptCount: 1,
    uniqueFiles: ['/home/alice/project/secret.ts'],
  },
};

const records = [
  {
    uuid: 'user-record',
    parentUuid: null,
    sessionId: 'session-secret',
    timestamp: '2026-08-16T00:00:00.000Z',
    cwd: '/home/alice/project',
    type: 'user',
    message: {
      role: 'user',
      parts: [{ text: 'Hello from the document exporter.' }],
    },
  },
];

describe('HTML export formatter', () => {
  it('preserves the legacy formatter when source records are unavailable', () => {
    const html = toHtml(sessionData);

    expect(html).toContain('id="chat-data"');
    expect(html).not.toContain('id="transcript-document"');
  });

  it('uses the version-bound document renderer for the product export path', () => {
    const html = toHtml(sessionData, records);

    expect(html).toContain('id="transcript-document"');
    expect(html).toContain('Hello from the document exporter.');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain('id="chat-data"');
    expect(html).not.toContain('session-secret');
    expect(html).not.toContain('/home/alice');
  });

  it('fails closed when the product template loses its document slot', () => {
    expect(() => injectDocumentIntoHtmlTemplate('<html></html>', {})).toThrow(
      'Export HTML template is missing transcript-document.',
    );
  });
});
