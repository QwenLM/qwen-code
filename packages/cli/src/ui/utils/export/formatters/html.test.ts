import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION,
  EXPORT_TRANSCRIPT_RENDERER_VERSION,
} from '@qwen-code/web-templates';
import type { ExportSessionData } from '../types.js';
import * as exportTranscriptDocument from '../export-transcript-document.js';
import {
  injectDocumentIntoHtmlTemplate,
  renderExportTranscriptDocumentToHtml,
  toHtml,
} from './html.js';

const { createExportTranscriptDocumentV1, createExportTranscriptDocumentV2 } =
  exportTranscriptDocument;

interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface IsolatedWebTemplatesModule {
  EXPORT_TRANSCRIPT_HTML_TEMPLATE: string;
  EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2;
  EXPORT_TRANSCRIPT_RENDERER_LIMITS: {
    readonly maxBlocks: number;
    readonly maxEnvelopeBytes: number;
  };
  EXPORT_TRANSCRIPT_RENDERER_VERSION: string;
}

interface RendererInfo {
  identity: string;
  rendererIntegrity: string;
  cssIntegrity: string;
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../..',
);
const sourceTemplatesDir = join(repoRoot, 'packages/web-templates');
const execFileAsync = promisify(execFile);
let isolatedRoot: string | undefined;
let templatesDir: string;
let isolatedBuildReady = false;
let defaultRenderer: RendererInfo;

// Keep every subprocess async so long builds never block the Vitest worker
// event loop past birpc's 60s onTaskUpdate timeout.
async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    shell?: boolean;
  },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout,
      shell: options.shell,
    });
    return { status: 0, signal: null, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: NodeJS.Signals | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: typeof err.code === 'number' ? err.code : null,
      signal: err.signal ?? null,
      stdout:
        typeof err.stdout === 'string'
          ? err.stdout
          : (err.stdout?.toString('utf8') ?? ''),
      stderr:
        typeof err.stderr === 'string'
          ? err.stderr
          : (err.stderr?.toString('utf8') ?? ''),
      error: typeof err.code === 'number' ? undefined : err,
    };
  }
}

function commandSucceeded(result: CommandResult, label: string) {
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      `${label}: status=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'}\n${result.stderr}\n${result.stdout}`,
    );
  }
}

function buildTemplates(templatesDirectory: string, env: NodeJS.ProcessEnv) {
  return runCommand('npm', ['run', 'build'], {
    cwd: templatesDirectory,
    env,
    timeout: 90_000,
    shell: process.platform === 'win32',
  });
}

async function unlinkIfExists(targetPath: string) {
  try {
    await unlink(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function cleanupWorkspace() {
  if (isolatedRoot === undefined) return;
  const rootToRemove = isolatedRoot;
  isolatedRoot = undefined;
  isolatedBuildReady = false;
  // Detach directory junctions/symlinks explicitly before recursive removal.
  await unlinkIfExists(
    join(rootToRemove, 'packages/web-templates/node_modules'),
  );
  await unlinkIfExists(join(rootToRemove, 'node_modules'));
  await rm(rootToRemove, { recursive: true, force: true });
}

async function assetIntegrity(
  templatesDirectory: string,
  extension: 'js' | 'css',
): Promise<string> {
  const contents = await readFile(
    join(
      templatesDirectory,
      `src/export-html/dist/export-transcript-document.${extension}`,
    ),
  );
  return `sha384-${createHash('sha384').update(contents).digest('base64')}`;
}

async function loadIsolatedWebTemplates(
  templatesDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<IsolatedWebTemplatesModule> {
  const rendererUrl = pathToFileURL(
    join(templatesDirectory, 'dist/index.js'),
  ).href;
  // Load the freshly compiled ESM entry in a child process so Node's module
  // cache cannot retain an earlier build of generated/exportTranscriptDocumentTemplate.js.
  const output = await runCommand(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import {
  EXPORT_TRANSCRIPT_HTML_TEMPLATE,
  EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION,
  EXPORT_TRANSCRIPT_RENDERER_LIMITS,
  EXPORT_TRANSCRIPT_RENDERER_VERSION,
} from ${JSON.stringify(rendererUrl)};
process.stdout.write(JSON.stringify({
  EXPORT_TRANSCRIPT_HTML_TEMPLATE,
  EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION,
  EXPORT_TRANSCRIPT_RENDERER_LIMITS,
  EXPORT_TRANSCRIPT_RENDERER_VERSION,
}));`,
    ],
    { cwd: process.cwd(), env, timeout: 30_000 },
  );
  commandSucceeded(output, 'load compiled web-templates module');
  return JSON.parse(output.stdout) as IsolatedWebTemplatesModule;
}

async function buildAndExport(
  templatesDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  buildStdout: string;
  template: string;
  html: string;
  schemaCeilingRejection: string;
}> {
  const build = await buildTemplates(templatesDirectory, env);
  commandSucceeded(build, 'build isolated web-templates');
  const isolatedTemplates = await loadIsolatedWebTemplates(
    templatesDirectory,
    env,
  );

  vi.resetModules();
  vi.doMock('@qwen-code/web-templates', () => isolatedTemplates);
  // Keep the already-loaded document builder module so vi.resetModules() does
  // not re-evaluate @qwen-code/qwen-code-core on every build case.
  vi.doMock('../export-transcript-document.js', () => exportTranscriptDocument);
  let html: string;
  let schemaCeilingRejection = '';
  try {
    const {
      toHtml: isolatedToHtml,
      renderExportTranscriptDocumentToHtml: isolatedRender,
    } = await import('./html.js');
    html = isolatedToHtml(sessionData, records);
    try {
      isolatedRender(
        createExportTranscriptDocumentV2(records, sessionData, {
          rendererVersion: isolatedTemplates.EXPORT_TRANSCRIPT_RENDERER_VERSION,
          exportedAt:
            sessionData.metadata?.exportTime ?? '2026-08-16T01:00:00.000Z',
        }),
      );
    } catch (error) {
      if (error instanceof Error) schemaCeilingRejection = error.message;
      else throw error;
    }
  } finally {
    vi.doUnmock('../export-transcript-document.js');
    vi.doUnmock('@qwen-code/web-templates');
    vi.resetModules();
  }

  const template = await readFile(
    join(
      templatesDirectory,
      'src/generated/exportTranscriptDocumentTemplate.ts',
    ),
    'utf8',
  );
  return {
    buildStdout: build.stdout,
    template,
    html,
    schemaCeilingRejection,
  };
}

async function readRendererInfo(
  templatesDirectory: string,
): Promise<RendererInfo> {
  const source = await readFile(
    join(
      templatesDirectory,
      'dist/generated/exportTranscriptDocumentTemplate.js',
    ),
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
    rendererIntegrity: await assetIntegrity(templatesDirectory, 'js'),
    cssIntegrity: await assetIntegrity(templatesDirectory, 'css'),
  };
}

beforeAll(async () => {
  // Isolate only packages/web-templates against the prebuilt workspace
  // node_modules instead of creating a full git worktree + reinstall + full
  // monorepo build inside a unit test.
  isolatedRoot = await mkdtemp(join(tmpdir(), 'qwen-export-html-'));
  templatesDir = join(isolatedRoot, 'packages/web-templates');
  try {
    await mkdir(join(isolatedRoot, 'packages'), { recursive: true });
    await Promise.all([
      cp(join(repoRoot, 'package.json'), join(isolatedRoot, 'package.json')),
      cp(join(repoRoot, 'tsconfig.json'), join(isolatedRoot, 'tsconfig.json')),
      symlink(
        join(repoRoot, 'node_modules'),
        join(isolatedRoot, 'node_modules'),
        'junction',
      ),
      cp(sourceTemplatesDir, templatesDir, {
        recursive: true,
        filter: (src) => {
          const rel = relative(sourceTemplatesDir, src).replaceAll('\\', '/');
          return (
            rel !== 'node_modules' &&
            !rel.startsWith('node_modules/') &&
            rel !== 'dist' &&
            !rel.startsWith('dist/') &&
            rel !== 'src/generated' &&
            !rel.startsWith('src/generated/') &&
            rel !== 'src/export-html/dist' &&
            !rel.startsWith('src/export-html/dist/') &&
            rel !== 'src/insight/dist' &&
            !rel.startsWith('src/insight/dist/')
          );
        },
      }),
    ]);
    await symlink(
      join(sourceTemplatesDir, 'node_modules'),
      join(templatesDir, 'node_modules'),
      'junction',
    );
    const initialBuild = await buildTemplates(
      templatesDir,
      createBuilderEnvironment(),
    );
    commandSucceeded(initialBuild, 'build isolated default renderer');
    defaultRenderer = await readRendererInfo(templatesDir);
    isolatedBuildReady = true;
  } catch (error) {
    try {
      await cleanupWorkspace();
    } catch (cleanupError) {
      console.error('Unable to remove isolated workspace', cleanupError);
    }
    throw error;
  }
}, 120_000);

async function snapshotRendererAssets(templatesDirectory: string) {
  const paths = [
    join(
      templatesDirectory,
      'src/generated/exportTranscriptDocumentTemplate.ts',
    ),
    join(
      templatesDirectory,
      'src/export-html/dist/export-transcript-document.js',
    ),
    join(
      templatesDirectory,
      'src/export-html/dist/export-transcript-document.css',
    ),
  ];
  return {
    paths,
    contents: await Promise.all(paths.map((path) => readFile(path, 'utf8'))),
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

afterAll(async () => {
  if (isolatedRoot === undefined) return;
  try {
    if (isolatedBuildReady) {
      commandSucceeded(
        await buildTemplates(templatesDir, createBuilderEnvironment()),
        'restore isolated default renderer',
      );
      const template = await readFile(
        join(templatesDir, 'src/generated/exportTranscriptDocumentTemplate.ts'),
        'utf8',
      );
      expect(template).toContain(
        'EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION: 1 | 2 = 2',
      );
      expect(template).toContain(
        `EXPORT_TRANSCRIPT_RENDERER_VERSION = ${JSON.stringify(
          (await readRendererInfo(templatesDir)).identity,
        )};`,
      );
      for (const extension of ['js', 'css']) {
        expect(
          (
            await readFile(
              join(
                templatesDir,
                `src/export-html/dist/export-transcript-document.${extension}`,
              ),
              'utf8',
            )
          ).length,
        ).toBeGreaterThan(0);
      }
    }
  } finally {
    await cleanupWorkspace();
  }
}, 120_000);

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
    async ({
      delegated,
      schemaMaxVersion,
      schemaOverride,
      delegatedIdentity,
    }) => {
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
        : defaultRenderer;
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
      const { buildStdout, template, html, schemaCeilingRejection } =
        await buildAndExport(templatesDir, env);
      if (!delegated) {
        const localRenderer = await readRendererInfo(templatesDir);
        const measured = buildStdout.match(
          /Document export renderer JS is (\d+) bytes/,
        );
        const rendererJs = join(
          templatesDir,
          'src/export-html/dist/export-transcript-document.js',
        );
        expect(Number(measured?.[1])).toBe(
          (await readFile(rendererJs)).byteLength,
        );
        expect(localRenderer.identity.length).not.toBe(
          '__QWEN_RENDERER_BUILD_ID__'.length,
        );
      }
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
    async ({ schema, delegated, message }) => {
      const snapshot = await snapshotRendererAssets(templatesDir);
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
      const result = await runCommand(process.execPath, ['build.mjs'], {
        cwd: templatesDir,
        env,
        timeout: 60_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(
        await Promise.all(snapshot.paths.map((path) => readFile(path, 'utf8'))),
      ).toEqual(snapshot.contents);
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
