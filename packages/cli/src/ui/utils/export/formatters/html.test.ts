import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

function createBuilderEnvironment() {
  const env = { ...process.env };
  delete env['QWEN_EXPORT_RENDERER_IDENTITY'];
  delete env['QWEN_EXPORT_RENDERER_INTEGRITY'];
  delete env['QWEN_EXPORT_RENDERER_CSS_INTEGRITY'];
  delete env['QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION'];
  return env;
}

afterAll(() => {
  const templatesDir = join(process.cwd(), '../web-templates');
  const result = spawnSync(process.execPath, ['build.mjs'], {
    cwd: templatesDir,
    env: createBuilderEnvironment(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  expect(
    readFileSync(
      join(templatesDir, 'src/generated/exportTranscriptDocumentTemplate.ts'),
      'utf8',
    ),
  ).toContain('EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2 = 2');
  for (const extension of ['js', 'css']) {
    expect(
      readFileSync(
        join(
          templatesDir,
          `src/export-html/dist/export-transcript-document.${extension}`,
        ),
        'utf8',
      ).length,
    ).toBeGreaterThan(0);
  }
});

describe('HTML export formatter', () => {
  it.each([false, true])(
    'emits the declared schema ceiling when delegated=%s',
    { timeout: 90_000 },
    (delegated) => {
      const templatesDir = join(process.cwd(), '../web-templates');
      const env = createBuilderEnvironment();
      if (delegated) {
        Object.assign(env, {
          QWEN_EXPORT_RENDERER_IDENTITY: '0.28.3+88485ce86a090982',
          QWEN_EXPORT_RENDERER_INTEGRITY:
            'sha384-RmZTu+dlEMG0jEt1MPe6uwIFPUR0wy3BVWW/vf8HIJwf0DvYK5GVg9c8F+mo3xei',
          QWEN_EXPORT_RENDERER_CSS_INTEGRITY:
            'sha384-1b7aeIUXXz756dLmrlvZotdgyGVkZgJTxDJSHyrGt+l87CPiuPqosQM4Uz7dElT7',
        });
      }
      const result = spawnSync(process.execPath, ['build.mjs'], {
        cwd: templatesDir,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      const template = readFileSync(
        join(templatesDir, 'src/generated/exportTranscriptDocumentTemplate.ts'),
        'utf8',
      );
      expect(template).toContain(
        `EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2 = ${delegated ? 1 : 2};`,
      );
      const identity = delegated
        ? '0.28.3+88485ce86a090982'
        : EXPORT_TRANSCRIPT_RENDERER_VERSION;
      expect(template).toContain(JSON.stringify(identity));
      expect(result.stderr).not.toContain(
        'Document export renderer JS exceeds',
      );
    },
  );

  it('rejects a schema ceiling that is not paired with a delegated renderer', () => {
    const templatesDir = join(process.cwd(), '../web-templates');
    const assetPaths = [
      join(templatesDir, 'src/generated/exportTranscriptDocumentTemplate.ts'),
      join(templatesDir, 'src/export-html/dist/export-transcript-document.js'),
      join(templatesDir, 'src/export-html/dist/export-transcript-document.css'),
    ];
    const assets = assetPaths.map((path) => readFileSync(path, 'utf8'));
    const result = spawnSync(process.execPath, ['build.mjs'], {
      cwd: templatesDir,
      env: {
        ...createBuilderEnvironment(),
        QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION requires QWEN_EXPORT_RENDERER_IDENTITY.',
    );
    expect(assetPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(
      assets,
    );
  });

  it('uses the version-bound document renderer for the product export path', () => {
    const html = toHtml(sessionData, records);
    const secondHtml = toHtml(sessionData, records);
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    const secondNonce = secondHtml.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(html).toContain('id="transcript-document"');
    expect(html).toContain('"schemaVersion":2');
    expect(html).toContain('Hello from the document exporter.');
    expect(html).toContain("connect-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[^']+';/);
    expect(html).toContain(
      `https://unpkg.com/@qwen-code/qwen-code@${EXPORT_TRANSCRIPT_RENDERER_VERSION.split('+')[0]}/export-transcript-document.js`,
    );
    expect(html).toContain(
      `https://unpkg.com/@qwen-code/qwen-code@${EXPORT_TRANSCRIPT_RENDERER_VERSION.split('+')[0]}/export-transcript-document.css`,
    );
    expect(html).toContain('id="transcript-stylesheet"');
    expect(html).toContain('rel="stylesheet"');
    expect(EXPORT_TRANSCRIPT_RENDERER_VERSION).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+[a-f0-9]{16}$/,
    );
    // The JS renderer and the CSS stylesheet each carry their own SRI digest.
    expect(html.match(/integrity="sha384-[A-Za-z0-9+/]{64}"/g)).toHaveLength(2);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).not.toContain('qwen-code-assets.oss-cn-hangzhou.aliyuncs.com');
    expect(html).not.toContain('type="importmap"');
    expect(html).not.toContain('type="module"');
    expect(html.length).toBeLessThan(500_000);
    expect(html).not.toContain('id="chat-data"');
    expect(html).not.toContain('session-secret');
    expect(html).not.toContain('/home/alice');
    expect(html).not.toContain('__EXPORT_NONCE__');
    expect(nonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(nonce);
    expect(html).toContain(`nonce="${nonce}"`);
    const stylesheetLink =
      html.match(/<link\s+rel="stylesheet"[\s\S]*?\/>/)?.[0] ?? '';
    expect(stylesheetLink).not.toBe('');
    expect(stylesheetLink).toContain(`nonce="${nonce}"`);
    expect(stylesheetLink).toMatch(/integrity="sha384-[A-Za-z0-9+/]{64}"/);
  });

  it('still renders a legacy V1 envelope', () => {
    const document = createExportTranscriptDocumentV1(records, sessionData, {
      rendererVersion: EXPORT_TRANSCRIPT_RENDERER_VERSION,
      exportedAt: '2026-08-16T01:00:00.000Z',
    });
    expect(renderExportTranscriptDocumentToHtml(document)).toContain(
      '"schemaVersion":1',
    );
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
