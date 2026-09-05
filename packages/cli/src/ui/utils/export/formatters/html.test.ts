import { describe, expect, it } from 'vitest';
import { EXPORT_TRANSCRIPT_RENDERER_VERSION } from '@qwen-code/web-templates';
import type { ExportSessionData } from '../types.js';
import { createExportTranscriptDocumentV1 } from '../export-transcript-document.js';
import {
  injectDocumentIntoHtmlTemplate,
  renderExportTranscriptDocumentToHtml,
  toHtml,
} from './html.js';

const sessionData: ExportSessionData = {
  sessionId: 'session-secret',
  startTime: '2026-08-16T00:00:00.000Z',
  messages: [],
  metadata: {
    sessionId: 'session-secret',
    startTime: '2026-08-16T00:00:00.000Z',
    exportTime: '2026-08-16T01:00:00.000Z',
    cwd: '/home/alice/project',
    gitRepo: 'qwen-code',
    gitBranch: 'feature/export',
    model: 'qwen-test',
    channel: 'cli',
    promptCount: 1,
    contextUsagePercent: 25,
    contextWindowSize: 128_000,
    totalTokens: 32_000,
    filesWritten: 1,
    linesAdded: 2,
    linesRemoved: 1,
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
    const secondHtml = toHtml(sessionData, records);
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    const secondNonce = secondHtml.match(/script-src 'nonce-([^']+)'/)?.[1];

    expect(html).toContain('id="transcript-document"');
    expect(html).toContain('Hello from the document exporter.');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain('id="chat-data"');
    expect(html).not.toContain('session-secret');
    expect(html).not.toContain('/home/alice');
    expect(html).not.toContain('__EXPORT_NONCE__');
    expect(html).toContain('data-document-metadata');
    expect(html).toContain('Context Usage');
    expect(html).toContain('data-document-expand-all');
    expect(html).toContain('data-document-collapse-all');
    expect(html).toContain('data-document-theme-toggle');
    expect(nonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(nonce);
    expect(html).toContain(`nonce="${nonce}"`);
  });

  it('fails closed when the product template loses its document slot', () => {
    expect(() => injectDocumentIntoHtmlTemplate('<html></html>', {})).toThrow(
      'Export HTML template is missing transcript-document.',
    );
  });

  it('fails closed when a document targets another renderer version', () => {
    const document = createExportTranscriptDocumentV1(records, sessionData, {
      rendererVersion: EXPORT_TRANSCRIPT_RENDERER_VERSION,
      exportedAt: '2026-08-16T01:00:00.000Z',
    });

    expect(() =>
      renderExportTranscriptDocumentToHtml({
        ...document,
        rendererVersion: '0.0.0-incompatible',
      }),
    ).toThrow('Export transcript renderer version mismatch.');
  });
});
