// @vitest-environment jsdom

/**
 * Cross-package contract for `/export` artifacts in the Web Shell.
 *
 * The descriptor a slash command produces crosses a JSON `_meta` hop between
 * the CLI's nominal `ToolArtifact` type and the Web Shell's independently
 * written reader; neither side's own tests see the other. Likewise, the
 * export HTML document's renderer asset URLs embed the root package version
 * while the Web Shell preview's allow-list injects the web-shell package
 * version — the two only agree because the release script bumps them in
 * lockstep. These tests run the real producer and the real consumer against
 * each other so a drift on either side turns red here.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_TRANSCRIPT_RENDERER_VERSION } from '@qwen-code/web-templates';
import type { SessionEmitterContext } from '../packages/cli/src/acp-integration/session/types.js';
import type { CommandContext } from '../packages/cli/src/ui/commands/types.js';
import type { ExportSessionData } from '../packages/cli/src/ui/utils/export/types.js';
import type { ToolArtifact } from '@qwen-code/qwen-code-core';

// The contract under test is the descriptor shape and the wire key, not the
// session log or the formatters — those are replaced, while the descriptor
// construction, path canonicalization, validation, and emission all run for
// real.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    SessionService: class {
      constructor(_cwd: string) {}
      async loadSession(_sessionId: string) {
        return {
          conversation: {
            sessionId: 'contract-session',
            startTime: '2026-09-18T00:00:00.000Z',
            messages: [],
          },
        };
      }
    },
  };
});

vi.mock('../packages/cli/src/ui/utils/export/index.js', () => ({
  collectSessionData: vi.fn(async () => ({
    sessionId: 'contract-session',
    startTime: '2026-09-18T00:00:00.000Z',
    messages: [],
  })),
  normalizeSessionData: vi.fn((data: unknown) => data),
  toMarkdown: vi.fn(() => '# Contract export'),
  toHtml: vi.fn(() => '<html>contract</html>'),
  toJson: vi.fn(() => '{"messages":[]}'),
  toJsonl: vi.fn(() => '{"type":"session_metadata"}'),
  generateExportFilename: vi.fn((ext: string) => `contract-export.${ext}`),
}));

const { exportCommand } = await import(
  '../packages/cli/src/ui/commands/exportCommand.js'
);
const { MessageEmitter } = await import(
  '../packages/cli/src/acp-integration/session/emitters/MessageEmitter.js'
);
const { readReportedArtifacts } = await import(
  '../packages/web-shell/client/adapters/reported-artifacts.js'
);
const { loadArtifactPreviewDocument } = await import(
  '../packages/web-shell/client/components/artifacts/artifactUtils.js'
);
const { toHtml } = await import(
  '../packages/cli/src/ui/utils/export/formatters/html.js'
);

declare global {
  // Mirrors the vite define in packages/web-shell/vite.config.ts; the
  // integration program never sees packages/web-shell/client/vite-env.d.ts.
  var __WEB_SHELL_VERSION__: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('export artifact wire contract', () => {
  let workDir: string | undefined;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  it.each(['md', 'html'] as const)(
    'a produced %s descriptor survives the _meta hop into the Web Shell reader',
    async (format) => {
      workDir = await mkdtemp(join(tmpdir(), 'export-artifact-contract-'));
      const context = {
        executionMode: 'acp',
        services: {
          config: {
            getWorkingDir: () => workDir,
            getTargetDir: () => workDir,
            getProjectRoot: () => workDir,
            getSessionId: () => 'contract-session',
          },
        },
      } as unknown as CommandContext;
      const command = exportCommand.subCommands?.find(
        (subCommand) => subCommand.name === format,
      );
      const result = await command?.action?.(context, '');
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      const artifacts = (result as { artifacts?: ToolArtifact[] }).artifacts;
      expect(artifacts).toHaveLength(1);

      const sendUpdate = vi.fn(async (_update: unknown) => undefined);
      const emitter = new MessageEmitter({
        sessionId: 'contract-session',
        sendUpdate,
      } as unknown as SessionEmitterContext);
      await emitter.emitSlashCommandOutput('Exported.', undefined, artifacts);
      const frame = sendUpdate.mock.calls[0]?.[0] as {
        _meta?: Record<string, unknown>;
      };

      // The wire is JSON: the frame reaches the Web Shell as plain data.
      const wireMeta = JSON.parse(JSON.stringify(frame._meta)) as Record<
        string,
        unknown
      >;
      expect(readReportedArtifacts(wireMeta)).toEqual(artifacts);
    },
  );
});

describe('export preview resource contract', () => {
  it('loads a real export document under the Web Shell resource allow-list', async () => {
    // The consumer side injects its version from packages/web-shell's own
    // manifest (packages/web-shell/vite.config.ts), while the producer embeds
    // the root version in the asset URLs; the release script keeps the two in
    // lockstep, and this test is where a drift fails.
    const webShellVersion = (
      JSON.parse(
        readFileSync(
          resolve(repoRoot, 'packages/web-shell/package.json'),
          'utf8',
        ),
      ) as { version: string }
    ).version;
    vi.stubGlobal('__WEB_SHELL_VERSION__', webShellVersion);
    expect(EXPORT_TRANSCRIPT_RENDERER_VERSION.split('+')[0]).toBe(
      webShellVersion,
    );

    const sessionData: ExportSessionData = {
      sessionId: 'contract-session',
      startTime: '2026-09-18T00:00:00.000Z',
      messages: [],
      metadata: {
        sessionId: 'contract-session',
        startTime: '2026-09-18T00:00:00.000Z',
        exportTime: '2026-09-18T01:00:00.000Z',
        cwd: '/tmp/export-contract',
        gitRepo: 'qwen-code',
        gitBranch: 'main',
        model: 'qwen-test',
        channel: 'cli',
        promptCount: 1,
        contextUsagePercent: 25,
        contextWindowSize: 128_000,
        totalTokens: 32_000,
        filesWritten: 0,
        linesAdded: 0,
        linesRemoved: 0,
        uniqueFiles: [],
      },
    };
    const records = [
      {
        uuid: 'user-record',
        parentUuid: null,
        sessionId: 'contract-session',
        timestamp: '2026-09-18T00:00:00.000Z',
        cwd: '/tmp/export-contract',
        type: 'user',
        message: {
          role: 'user',
          parts: [{ text: 'Hello from the export contract test.' }],
        },
      },
    ];
    const html = toHtml(sessionData, records);
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).endsWith('.css')
        ? new Response('/* contract */')
        : new Response('// contract'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const previewDocument = await loadArtifactPreviewDocument(
      html,
      'Export',
      new AbortController().signal,
    );

    const rendererBase = `https://unpkg.com/@qwen-code/qwen-code@${EXPORT_TRANSCRIPT_RENDERER_VERSION.split('+')[0]}`;
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `${rendererBase}/export-transcript-document.js`,
      `${rendererBase}/export-transcript-document.css`,
    ]);
    expect(previewDocument).toContain('data:text/javascript;base64,');
    expect(previewDocument).toContain('data:text/css;base64,');
  });
});
