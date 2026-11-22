import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const repoRoot = join(process.cwd(), '../..');
const execFileAsync = promisify(execFile);
let isolatedRoot: string | undefined;
let templatesDir: string;
let isolatedBuildReady = false;

function commandSucceeded(result: ReturnType<typeof spawnSync>, label: string) {
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      `${label}: status=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'}\n${result.stderr}\n${result.stdout}`,
    );
  }
}

function buildTemplates(templatesDirectory: string, env: NodeJS.ProcessEnv) {
  return spawnSync('npm', ['run', 'build', '--prefix', templatesDirectory], {
    cwd: templatesDirectory,
    env,
    encoding: 'utf8',
    timeout: 90_000,
    shell: process.platform === 'win32',
  });
}

async function buildWorkspace(workspaceRoot: string, env: NodeJS.ProcessEnv) {
  try {
    const result = await execFileAsync('npm', ['run', 'build'], {
      cwd: workspaceRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      shell: process.platform === 'win32',
    });
    for (const line of result.stdout.split('\n')) {
      if (line.includes('Document export renderer JS is')) console.log(line);
    }
    return result;
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      console.error(error.stdout);
      console.error(error.stderr);
    }
    throw error;
  }
}

function cleanupWorkspace() {
  if (isolatedRoot === undefined) return;
  commandSucceeded(
    spawnSync('git', ['worktree', 'remove', '--force', isolatedRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
    'remove isolated workspace',
  );
  isolatedRoot = undefined;
  isolatedBuildReady = false;
}

function assetIntegrity(extension: 'js' | 'css'): string {
  const contents = readFileSync(
    join(
      templatesDir,
      `src/export-html/dist/export-transcript-document.${extension}`,
    ),
  );
  return `sha384-${createHash('sha384').update(contents).digest('base64')}`;
}

function buildAndExport(
  templatesDir: string,
  env: NodeJS.ProcessEnv,
): { template: string; html: string; schemaCeilingRejection: string } {
  const build = buildTemplates(templatesDir, env);
  commandSucceeded(build, 'build isolated web-templates');
  const moduleUrl = pathToFileURL(
    join(
      isolatedRoot!,
      'packages/cli/dist/src/ui/utils/export/formatters/html.js',
    ),
  ).href;
  const factoryUrl = pathToFileURL(
    join(
      isolatedRoot!,
      'packages/cli/dist/src/ui/utils/export/export-transcript-document.js',
    ),
  ).href;
  const rendererUrl = pathToFileURL(join(templatesDir, 'dist/index.js')).href;
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
  commandSucceeded(output, 'run compiled HTML writer');
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

beforeAll(async () => {
  isolatedRoot = mkdtempSync(join(tmpdir(), 'qwen-export-html-'));
  templatesDir = join(isolatedRoot, 'packages/web-templates');
  try {
    commandSucceeded(
      spawnSync('git', ['worktree', 'add', '--detach', isolatedRoot, 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
      'create isolated workspace',
    );
    const patch = spawnSync(
      'git',
      [
        'diff',
        '--binary',
        'HEAD',
        '--',
        'packages/cli',
        'packages/web-shell',
        'packages/web-templates',
        'integration-tests',
      ],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    commandSucceeded(patch, 'read working-tree changes');
    if (patch.stdout !== '') {
      commandSucceeded(
        spawnSync(
          'git',
          ['-C', isolatedRoot, 'apply', '--whitespace=nowarn', '-'],
          {
            cwd: isolatedRoot,
            encoding: 'utf8',
            input: patch.stdout,
          },
        ),
        'apply working-tree changes to isolated workspace',
      );
    }
    commandSucceeded(
      spawnSync(process.execPath, ['scripts/setup-worktree.js'], {
        cwd: isolatedRoot,
        env: createBuilderEnvironment(),
        encoding: 'utf8',
        timeout: 180_000,
      }),
      'install isolated workspace dependencies',
    );
    await buildWorkspace(isolatedRoot, {
      ...createBuilderEnvironment(),
      NODE_ENV: 'production',
    });
    isolatedBuildReady = true;
  } catch (error) {
    try {
      if (isolatedRoot) cleanupWorkspace();
    } catch (cleanupError) {
      console.error('Unable to remove isolated workspace', cleanupError);
    }
    throw error;
  }
}, 900_000);

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
  if (isolatedRoot === undefined) return;
  try {
    if (isolatedBuildReady) {
      commandSucceeded(
        buildTemplates(templatesDir, createBuilderEnvironment()),
        'restore isolated default renderer',
      );
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
    }
  } finally {
    cleanupWorkspace();
  }
});

describe('HTML export formatter', () => {
  it.each([
    { delegated: false, schemaMaxVersion: 2 },
    { delegated: true, schemaMaxVersion: 1 },
    { delegated: true, schemaMaxVersion: 1, schemaOverride: '' },
    { delegated: true, schemaMaxVersion: 2, schemaOverride: '2' },
    {
      delegated: true,
      schemaMaxVersion: 2,
      schemaOverride: '2',
      delegatedIdentity: '9.9.9+88485ce86a090982',
    },
  ])(
    'emits schema $schemaMaxVersion when delegated=$delegated and override=$schemaOverride',
    { timeout: 90_000 },
    ({ delegated, schemaMaxVersion, schemaOverride, delegatedIdentity }) => {
      const initialBuild = buildTemplates(
        templatesDir,
        createBuilderEnvironment(),
      );
      commandSucceeded(initialBuild, 'build isolated default renderer');
      const localRenderer = readRendererInfo(templatesDir);
      if (!delegated) {
        const measured = initialBuild.stdout.match(
          /Document export renderer JS is (\d+) bytes/,
        );
        const rendererJs = join(
          templatesDir,
          'src/export-html/dist/export-transcript-document.js',
        );
        expect(Number(measured?.[1])).toBe(readFileSync(rendererJs).byteLength);
        expect(localRenderer.identity.length).not.toBe(
          '__QWEN_RENDERER_BUILD_ID__'.length,
        );
      }
      const {
        identity: baseIdentity,
        rendererIntegrity,
        cssIntegrity,
      } = delegated && schemaMaxVersion === 1
        ? {
            identity: '0.28.3+88485ce86a090982',
            rendererIntegrity:
              'sha384-RmZTu+dlEMG0jEt1MPe6uwIFPUR0wy3BVWW/vf8HIJwf0DvYK5GVg9c8F+mo3xei',
            cssIntegrity:
              'sha384-1b7aeIUXXz756dLmrlvZotdgyGVkZgJTxDJSHyrGt+l87CPiuPqosQM4Uz7dElT7',
          }
        : localRenderer;
      const identity = delegatedIdentity ?? baseIdentity;
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
          `https://unpkg.com/@qwen-code/qwen-code@${identity.split('+')[0]}/export-transcript-document.js`,
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
