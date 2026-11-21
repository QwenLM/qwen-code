import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION,
  EXPORT_TRANSCRIPT_RENDERER_VERSION,
} from '@qwen-code/web-templates';
import type { ExportSessionData } from '../types.js';
import { createExportTranscriptDocumentV1 } from '../export-transcript-document.js';
import {
  injectDocumentIntoHtmlTemplate,
  renderExportTranscriptDocumentToHtml,
  toHtml,
} from './html.js';

function assetIntegrity(extension: 'js' | 'css'): string {
  const contents = readFileSync(
    join(
      process.cwd(),
      `../web-templates/src/export-html/dist/export-transcript-document.${extension}`,
    ),
  );
  return `sha384-${createHash('sha384').update(contents).digest('base64')}`;
}

function buildAndExport(
  templatesDir: string,
  env: NodeJS.ProcessEnv,
): { template: string; html: string; schemaCeilingRejection: string } {
  const build = spawnSync('npm', ['run', 'build', '--prefix', templatesDir], {
    cwd: templatesDir,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(build.error).toBeUndefined();
  expect(build.status).toBe(0);
  expect(build.signal).toBeNull();
  const baseUrl = new URL('../web-templates/', `file://${templatesDir}/`);
  const moduleUrl = new URL(
    '../cli/dist/src/ui/utils/export/formatters/html.js',
    baseUrl,
  ).href;
  const factoryUrl = new URL(
    '../cli/dist/src/ui/utils/export/export-transcript-document.js',
    baseUrl,
  ).href;
  const rendererUrl = new URL('./dist/index.js', baseUrl).href;
  const output = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { toHtml, renderExportTranscriptDocumentToHtml } from ${JSON.stringify(moduleUrl)};
import { createExportTranscriptDocumentV2 } from ${JSON.stringify(factoryUrl)};
import { EXPORT_TRANSCRIPT_RENDERER_VERSION } from ${JSON.stringify(rendererUrl)};
const sessionData = ${JSON.stringify(sessionData)};
const records = ${JSON.stringify(records)};
const html = toHtml(sessionData, records);
let schemaCeilingRejection = '';
try {
  renderExportTranscriptDocumentToHtml(createExportTranscriptDocumentV2(
    records,
    sessionData,
    {
      rendererVersion: EXPORT_TRANSCRIPT_RENDERER_VERSION,
      exportedAt: sessionData.metadata?.exportTime,
    },
  ));
} catch (error) {
  if (error instanceof Error) schemaCeilingRejection = error.message;
  else throw error;
}
process.stdout.write(JSON.stringify({ html, schemaCeilingRejection }));`,
    ],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 },
  );
  expect(output.error).toBeUndefined();
  expect(output.status).toBe(0);
  expect(output.signal).toBeNull();
  const template = readFileSync(
    `${templatesDir}/src/generated/exportTranscriptDocumentTemplate.ts`,
    'utf8',
  );
  const { html, schemaCeilingRejection } = JSON.parse(output.stdout) as {
    html: string;
    schemaCeilingRejection: string;
  };
  return { template, html, schemaCeilingRejection };
}

function readRendererInfo(templatesDir: string) {
  const source = readFileSync(
    join(templatesDir, 'dist/generated/exportTranscriptDocumentTemplate.js'),
    'utf8',
  );
  const identity = source.match(
    /EXPORT_TRANSCRIPT_RENDERER_VERSION = "([^"]+)";/,
  )?.[1];
  if (!identity) throw new Error('Generated renderer identity is missing');
  expect(identity).toMatch(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\+[a-f0-9]{16}$/,
  );
  return {
    identity,
    rendererIntegrity: assetIntegrity('js'),
    cssIntegrity: assetIntegrity('css'),
  };
}

function snapshotRendererAssets(templatesDir: string) {
  const paths = [
    join(templatesDir, 'src/generated/exportTranscriptDocumentTemplate.ts'),
    join(templatesDir, 'src/export-html/dist/export-transcript-document.js'),
    join(templatesDir, 'src/export-html/dist/export-transcript-document.css'),
  ];
  return {
    paths,
    contents: paths.map((path) => readFileSync(path, 'utf8')),
  };
}

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
  const result = spawnSync('npm', ['run', 'build', '--prefix', templatesDir], {
    cwd: templatesDir,
    env: createBuilderEnvironment(),
    encoding: 'utf8',
    timeout: 90_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.signal).toBeNull();
  const template = readFileSync(
    join(templatesDir, 'src/generated/exportTranscriptDocumentTemplate.ts'),
    'utf8',
  );
  expect(template).toContain(
    'EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2 = 2',
  );
  expect(template).toContain(
    `EXPORT_TRANSCRIPT_RENDERER_VERSION = ${JSON.stringify(
      readRendererInfo(templatesDir).identity,
    )};`,
  );
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
  it.each([
    { delegated: false, schemaMaxVersion: 2 },
    { delegated: true, schemaMaxVersion: 1 },
    { delegated: true, schemaMaxVersion: 1, schemaOverride: '' },
    { delegated: true, schemaMaxVersion: 2, schemaOverride: '2' },
  ])(
    'emits schema $schemaMaxVersion when delegated=$delegated and override=$schemaOverride',
    { timeout: 90_000 },
    ({ delegated, schemaMaxVersion, schemaOverride }) => {
      const templatesDir = join(process.cwd(), '../web-templates');
      const initialBuild = spawnSync(
        'npm',
        ['run', 'build', '--prefix', templatesDir],
        {
          cwd: templatesDir,
          env: createBuilderEnvironment(),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(initialBuild.error).toBeUndefined();
      expect(initialBuild.status).toBe(0);
      expect(initialBuild.signal).toBeNull();
      const localRenderer = readRendererInfo(templatesDir);
      const { identity, rendererIntegrity, cssIntegrity } =
        delegated && schemaMaxVersion === 1
          ? {
              identity: '0.28.3+88485ce86a090982',
              rendererIntegrity:
                'sha384-RmZTu+dlEMG0jEt1MPe6uwIFPUR0wy3BVWW/vf8HIJwf0DvYK5GVg9c8F+mo3xei',
              cssIntegrity:
                'sha384-1b7aeIUXXz756dLmrlvZotdgyGVkZgJTxDJSHyrGt+l87CPiuPqosQM4Uz7dElT7',
            }
          : localRenderer;
      if (delegated && schemaMaxVersion === 2) {
        expect(identity).not.toBe('0.28.3+88485ce86a090982');
      }
      const env = createBuilderEnvironment();
      if (delegated) {
        Object.assign(env, {
          QWEN_EXPORT_RENDERER_IDENTITY: identity,
          QWEN_EXPORT_RENDERER_INTEGRITY: rendererIntegrity,
          QWEN_EXPORT_RENDERER_CSS_INTEGRITY: cssIntegrity,
        });
      }
      if (schemaOverride !== undefined) {
        env['QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION'] = schemaOverride;
      }
      const { template, html, schemaCeilingRejection } = buildAndExport(
        templatesDir,
        env,
      );
      expect(template).toContain(
        `EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2 = ${schemaMaxVersion};`,
      );
      expect(schemaCeilingRejection).toBe(
        delegated && schemaMaxVersion === 1
          ? 'Export transcript schema version 2 exceeds the renderer ceiling of 1.'
          : '',
      );
      if (delegated) {
        expect(template).toContain(JSON.stringify(identity));
      } else {
        const packageVersion = EXPORT_TRANSCRIPT_RENDERER_VERSION.split(
          '+',
        )[0].replaceAll('.', '\\.');
        expect(template).toMatch(
          new RegExp(
            `EXPORT_TRANSCRIPT_RENDERER_VERSION = "${packageVersion}\\+[a-f0-9]{16}";`,
          ),
        );
        expect(template).not.toContain(
          JSON.stringify('0.28.3+88485ce86a090982'),
        );
      }
      expect(html).toContain(`"schemaVersion":${schemaMaxVersion}`);
      if (delegated) {
        expect(template).toContain(rendererIntegrity);
        expect(template).toContain(cssIntegrity);
        expect(html).toContain(rendererIntegrity);
        expect(html).toContain(cssIntegrity);
        expect(html).toContain(
          'https://unpkg.com/@qwen-code/qwen-code@0.28.3/export-transcript-document.js',
        );
      }
    },
  );

  it.each([
    {
      schema: '1',
      delegated: false,
      message:
        'QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION requires QWEN_EXPORT_RENDERER_IDENTITY.',
    },
    {
      schema: '3',
      delegated: true,
      message: 'QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION must be 1 or 2',
    },
  ])(
    'rejects schema $schema while delegated=$delegated',
    ({ schema, delegated, message }) => {
      const templatesDir = join(process.cwd(), '../web-templates');
      const snapshot = snapshotRendererAssets(templatesDir);
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
      env['QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION'] = schema;
      const result = spawnSync(process.execPath, ['build.mjs'], {
        cwd: templatesDir,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(snapshot.paths.map((path) => readFileSync(path, 'utf8'))).toEqual(
        snapshot.contents,
      );
    },
  );

  it('uses the version-bound document renderer for the product export path', () => {
    const html = toHtml(sessionData, records);
    const secondHtml = toHtml(sessionData, records);
    const nonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    const secondNonce = secondHtml.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(html).toContain('id="transcript-document"');
    expect(html).toContain(
      `"schemaVersion":${EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION}`,
    );
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
