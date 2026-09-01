/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import yargs, { type Argv } from 'yargs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { QWEN_DIR, Storage } from '@qwen-code/qwen-code-core';

import {
  bootstrapServeFastPathEnvironment,
  parseServeFastPathArgs,
  tryRunServeFastPath,
  waitForServeRuntimeOrExit,
} from './fast-path.js';
import {
  consumeServeFastPathRejectedLoaderKeys,
  loadServeFastPathEnvironment,
  loadServeFastPathSettings,
  preResolveServeFastPathHomeEnvOverrides,
  resetServeFastPathHomeEnvBootstrapForTesting,
} from './fast-path-settings.js';
import { resetLoaderKeyRejectionReportingForTesting } from '../config/shared-env-keys.js';
import {
  getGlobalQwenDirLite,
  SETTINGS_DIRECTORY_NAME,
} from '../config/storage-paths-lite.js';
import { RUNTIME_STARTUP_CANCELLED_MESSAGE } from './runtime-startup-errors.js';
import {
  resetTrustedFoldersForTesting,
  TrustLevel,
} from '../config/trustedFolders.js';
import { HEADLESS_YOLO_NO_SANDBOX_WARNING } from '../utils/headlessSafetyWarnings.js';
import * as runQwenServeModule from './run-qwen-serve.js';
import type { ServeFastPathSettings } from './fast-path-settings.js';
import type { Settings } from '../config/settingsSchema.js';
import { serveCommand } from '../commands/serve.js';

let tempWorkspace: string | undefined;
let tempLaunchCwd: string | undefined;
let tempQwenHome: string | undefined;
let tempSymlink: string | undefined;
const originalToken = process.env['QWEN_SERVER_TOKEN'];
const originalQwenHome = process.env['QWEN_HOME'];
const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const originalQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
const originalMcpApprovalsPath = process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
const originalSystemSettingsPath =
  process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
const originalSystemDefaultsPath =
  process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
const originalTrustedFoldersPath =
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
const originalReferencedToken = process.env['FAST_PATH_REFERENCED_TOKEN'];
const originalRateLimit = process.env['QWEN_SERVE_RATE_LIMIT'];
const originalRateLimitPrompt = process.env['QWEN_SERVE_RATE_LIMIT_PROMPT'];
const originalCloudShell = process.env['CLOUD_SHELL'];
const originalGoogleCloudProject = process.env['GOOGLE_CLOUD_PROJECT'];
const originalNodeCompileCache = process.env['NODE_COMPILE_CACHE'];
const originalNodeDisableCompileCache =
  process.env['NODE_DISABLE_COMPILE_CACHE'];
const originalPendingCompileCache =
  process.env['QWEN_CODE_PENDING_COMPILE_CACHE'];
const originalCwd = process.cwd();
const cliPackageRoot = process.cwd();

interface StaticSourceGraph {
  localFiles: Set<string>;
  externalValueImports: Set<string>;
  unresolvedLocalImports: string[];
}

function normalizePathForTest(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function moduleSpecifierText(
  specifier: ts.Expression | undefined,
): string | undefined {
  if (!specifier || !ts.isStringLiteral(specifier)) return undefined;
  return specifier.text;
}

function importDeclarationHasRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  if (bindings.elements.length === 0) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause) return true;
  if (ts.isNamespaceExport(clause)) return true;
  if (clause.elements.length === 0) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function resolveLocalSourceImport(
  importer: string,
  specifier: string,
): string | undefined {
  const basePath = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [`${basePath.slice(0, -3)}.ts`, `${basePath.slice(0, -3)}.tsx`]
    : [
        `${basePath}.ts`,
        `${basePath}.tsx`,
        join(basePath, 'index.ts'),
        join(basePath, 'index.tsx'),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

function collectStaticSourceGraph(entryFile: string): StaticSourceGraph {
  const visited = new Set<string>();
  const localFiles = new Set<string>();
  const externalValueImports = new Set<string>();
  const unresolvedLocalImports: string[] = [];

  function visit(filePath: string): void {
    const normalizedFilePath = resolve(filePath);
    if (visited.has(normalizedFilePath)) return;
    visited.add(normalizedFilePath);
    localFiles.add(
      normalizePathForTest(relative(cliPackageRoot, normalizedFilePath)),
    );

    const sourceText = readFileSync(normalizedFilePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      normalizedFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      normalizedFilePath.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );

    for (const statement of sourceFile.statements) {
      let specifier: string | undefined;
      let hasRuntimeValue = false;
      if (ts.isImportDeclaration(statement)) {
        specifier = moduleSpecifierText(statement.moduleSpecifier);
        hasRuntimeValue = importDeclarationHasRuntimeValue(statement);
      } else if (ts.isExportDeclaration(statement)) {
        specifier = moduleSpecifierText(statement.moduleSpecifier);
        hasRuntimeValue = exportDeclarationHasRuntimeValue(statement);
      }
      if (!specifier || !hasRuntimeValue) continue;
      if (!specifier.startsWith('.')) {
        externalValueImports.add(specifier);
        continue;
      }
      const resolvedImport = resolveLocalSourceImport(
        normalizedFilePath,
        specifier,
      );
      if (!resolvedImport) {
        unresolvedLocalImports.push(
          `${normalizePathForTest(relative(cliPackageRoot, normalizedFilePath))} -> ${specifier}`,
        );
        continue;
      }
      visit(resolvedImport);
    }
  }

  visit(entryFile);
  return { localFiles, externalValueImports, unresolvedLocalImports };
}

function useTempQwenHome(): string {
  tempQwenHome = realpathSync(
    mkdtempSync(join(os.tmpdir(), 'qws-fast-path-home-')),
  );
  process.env['QWEN_HOME'] = tempQwenHome;
  // getUserLevelEnvPathsFastPath always includes os.homedir() candidates,
  // so redirect HOME/USERPROFILE too — a real ~/.env or ~/.qwen/.env would
  // otherwise leak keys and warning counts into these tests.
  process.env['HOME'] = tempQwenHome;
  process.env['USERPROFILE'] = tempQwenHome;
  process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = join(
    tempQwenHome,
    'system-settings.json',
  );
  process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = join(
    tempQwenHome,
    'system-defaults.json',
  );
  return tempQwenHome;
}

function buildServeCommandParser(): Argv {
  return (serveCommand.builder as (argv: Argv) => Argv)(
    yargs([]).exitProcess(false).fail(false).locale('en'),
  );
}

function pickServeFastPathComparable(
  settings: Settings,
): ServeFastPathSettings {
  const out: ServeFastPathSettings = {};
  if (settings.env) {
    out.env = settings.env;
  }
  if (settings.general?.chatRecording !== undefined) {
    out.general = { chatRecording: settings.general.chatRecording };
  }
  if (settings.advanced?.excludedEnvVars !== undefined) {
    out.advanced = {
      ...(out.advanced ?? {}),
      excludedEnvVars: settings.advanced.excludedEnvVars,
    };
  }
  if (settings.advanced?.runtimeOutputDir !== undefined) {
    out.advanced = {
      ...(out.advanced ?? {}),
      runtimeOutputDir: settings.advanced.runtimeOutputDir,
    };
  }
  if (settings.security?.folderTrust?.enabled !== undefined) {
    out.security = {
      folderTrust: { enabled: settings.security.folderTrust.enabled },
    };
  }
  if (settings.tools?.approvalMode !== undefined) {
    out.tools = {
      ...(out.tools ?? {}),
      approvalMode: settings.tools.approvalMode,
    };
  }
  if (settings.tools?.sandbox !== undefined) {
    out.tools = { ...(out.tools ?? {}), sandbox: settings.tools.sandbox };
  }
  if (settings.context?.fileName !== undefined) {
    out.context = {
      ...(out.context ?? {}),
      fileName: settings.context.fileName,
    };
  }
  if (settings.context?.fileFiltering?.customIgnoreFiles !== undefined) {
    out.context = {
      ...(out.context ?? {}),
      fileFiltering: {
        customIgnoreFiles: settings.context.fileFiltering.customIgnoreFiles,
      },
    };
  }
  if (settings.policy?.permissionStrategy !== undefined) {
    out.policy = {
      ...(out.policy ?? {}),
      permissionStrategy: settings.policy.permissionStrategy,
    };
  }
  if (settings.policy?.consensusQuorum !== undefined) {
    out.policy = {
      ...(out.policy ?? {}),
      consensusQuorum: settings.policy.consensusQuorum,
    };
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  if (originalToken === undefined) {
    delete process.env['QWEN_SERVER_TOKEN'];
  } else {
    process.env['QWEN_SERVER_TOKEN'] = originalToken;
  }
  if (originalQwenHome === undefined) {
    delete process.env['QWEN_HOME'];
  } else {
    process.env['QWEN_HOME'] = originalQwenHome;
  }
  if (originalHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env['USERPROFILE'];
  } else {
    process.env['USERPROFILE'] = originalUserProfile;
  }
  if (originalSystemSettingsPath === undefined) {
    delete process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  } else {
    process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = originalSystemSettingsPath;
  }
  if (originalSystemDefaultsPath === undefined) {
    delete process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
  } else {
    process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = originalSystemDefaultsPath;
  }
  if (originalTrustedFoldersPath === undefined) {
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  } else {
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = originalTrustedFoldersPath;
  }
  if (originalReferencedToken === undefined) {
    delete process.env['FAST_PATH_REFERENCED_TOKEN'];
  } else {
    process.env['FAST_PATH_REFERENCED_TOKEN'] = originalReferencedToken;
  }
  if (originalRateLimit === undefined) {
    delete process.env['QWEN_SERVE_RATE_LIMIT'];
  } else {
    process.env['QWEN_SERVE_RATE_LIMIT'] = originalRateLimit;
  }
  if (originalRateLimitPrompt === undefined) {
    delete process.env['QWEN_SERVE_RATE_LIMIT_PROMPT'];
  } else {
    process.env['QWEN_SERVE_RATE_LIMIT_PROMPT'] = originalRateLimitPrompt;
  }
  if (originalCloudShell === undefined) {
    delete process.env['CLOUD_SHELL'];
  } else {
    process.env['CLOUD_SHELL'] = originalCloudShell;
  }
  if (originalGoogleCloudProject === undefined) {
    delete process.env['GOOGLE_CLOUD_PROJECT'];
  } else {
    process.env['GOOGLE_CLOUD_PROJECT'] = originalGoogleCloudProject;
  }
  if (originalNodeCompileCache === undefined) {
    delete process.env['NODE_COMPILE_CACHE'];
  } else {
    process.env['NODE_COMPILE_CACHE'] = originalNodeCompileCache;
  }
  if (originalNodeDisableCompileCache === undefined) {
    delete process.env['NODE_DISABLE_COMPILE_CACHE'];
  } else {
    process.env['NODE_DISABLE_COMPILE_CACHE'] = originalNodeDisableCompileCache;
  }
  if (originalPendingCompileCache === undefined) {
    delete process.env['QWEN_CODE_PENDING_COMPILE_CACHE'];
  } else {
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] =
      originalPendingCompileCache;
  }
  if (originalQwenRuntimeDir === undefined) {
    delete process.env['QWEN_RUNTIME_DIR'];
  } else {
    process.env['QWEN_RUNTIME_DIR'] = originalQwenRuntimeDir;
  }
  if (originalMcpApprovalsPath === undefined) {
    delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
  } else {
    process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = originalMcpApprovalsPath;
  }
  resetServeFastPathHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
  if (tempWorkspace) {
    rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = undefined;
  }
  if (tempLaunchCwd) {
    rmSync(tempLaunchCwd, { recursive: true, force: true });
    tempLaunchCwd = undefined;
  }
  if (tempQwenHome) {
    rmSync(tempQwenHome, { recursive: true, force: true });
    tempQwenHome = undefined;
  }
  if (tempSymlink) {
    rmSync(tempSymlink, { force: true });
    tempSymlink = undefined;
  }
});

describe('CLI entry import boundary', () => {
  it('does not statically import the full gemini entry before the serve fast path can run', () => {
    const cliSource = readFileSync('src/cli.ts', 'utf8');

    expect(cliSource).not.toContain("import './llm.js'");
    expect(cliSource).not.toContain("import { main } from './llm.js'");
    expect(cliSource).not.toContain("process.argv[2] === 'serve'");
    expect(cliSource).toContain("await import('./serve/fast-path.js')");
  });

  it('does not import the full settings loader on the serve fast path', () => {
    const fastPathSource = readFileSync('src/serve/fast-path.ts', 'utf8');

    expect(fastPathSource).not.toContain('../config/settings.js');
    expect(fastPathSource).not.toContain('../config/environment.js');
    expect(fastPathSource).not.toContain('@qwen-code/qwen-code-core');
    expect(fastPathSource).toContain('bootSettings: settings');
    expect(fastPathSource).toContain('resolveOnListen: true');
    expect(fastPathSource).toContain(
      'deferRuntimeUntilFirstHealth: !parsed.open',
    );
  });

  it('uses the shared headless yolo warning helper on the serve fast path', () => {
    const fastPathSource = readFileSync('src/serve/fast-path.ts', 'utf8');

    expect(fastPathSource).toContain('getHeadlessYoloSafetyWarning');
    expect(fastPathSource).not.toContain(
      "settings.tools?.approvalMode === 'yolo'",
    );
  });

  it('keeps headless yolo warning helper free of runtime core imports', () => {
    const helperSource = readFileSync(
      'src/utils/headlessSafetyWarnings.ts',
      'utf8',
    );

    expect(helperSource).not.toMatch(
      /import\s+(?!type\b)[^;]*from ['"]@qwen-code\/qwen-code-core['"]/,
    );
  });

  it('keeps settings free of UI imports used before serve can listen', () => {
    const settingsSource = readFileSync('src/config/settings.ts', 'utf8');

    expect(settingsSource).not.toContain('../ui/');
  });

  it('keeps extension command parsing free of UI state imports', () => {
    const updateCommandSource = readFileSync(
      'src/commands/extensions/update.ts',
      'utf8',
    );

    expect(updateCommandSource).not.toContain('../../ui/');
  });

  it('keeps runQwenServe from statically loading the full server and ACP runtime', () => {
    const runServeSource = readFileSync('src/serve/run-qwen-serve.ts', 'utf8');

    expect(runServeSource).not.toMatch(/from ['"]\.\/server\.js['"]/);
    expect(runServeSource).not.toMatch(/from ['"]\.\/web-shell-static\.js['"]/);
    expect(runServeSource).not.toMatch(
      /from ['"]\.\/acp-session-bridge\.js['"]/,
    );
    expect(runServeSource).not.toMatch(
      /from ['"]@qwen-code\/acp-bridge\/bridge['"]/,
    );
    expect(runServeSource).not.toMatch(
      /from ['"]@qwen-code\/acp-bridge\/spawnChannel['"]/,
    );
    expect(runServeSource).toContain("import('./server.js')");
    expect(runServeSource).toContain("import('@qwen-code/acp-bridge/bridge')");
  });

  it('keeps request helpers from value-importing the ACP compatibility shim', () => {
    const requestHelpersSource = readFileSync(
      'src/serve/server/request-helpers.ts',
      'utf8',
    );

    expect(requestHelpersSource).not.toMatch(
      /from ['"]\.\.\/acp-session-bridge\.js['"]/,
    );
    expect(requestHelpersSource).toContain(
      "import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';",
    );
    // MAX_WORKSPACE_PATH_LENGTH (and, since #7139, the sandbox path
    // translation) must come from the workspacePaths subpath — never the
    // acp-bridge barrel or the compatibility shim.
    expect(requestHelpersSource).toMatch(
      /import \{[^}]*\bMAX_WORKSPACE_PATH_LENGTH\b[^}]*\} from '@qwen-code\/acp-bridge\/workspacePaths';/,
    );
    expect(requestHelpersSource).not.toMatch(/from '@qwen-code\/acp-bridge';/);
  });

  it('keeps the runQwenServe static source graph free of ACP runtime modules', () => {
    const graph = collectStaticSourceGraph(
      resolve(cliPackageRoot, 'src/serve/run-qwen-serve.ts'),
    );

    expect(graph.unresolvedLocalImports).toEqual([]);
    const forbiddenLocalFiles = [...graph.localFiles].filter(
      (filePath) => filePath === 'src/serve/acp-session-bridge.ts',
    );
    expect(
      forbiddenLocalFiles,
      `Unexpected static source graph files:\n${forbiddenLocalFiles.join('\n')}`,
    ).toEqual([]);

    const forbiddenExternalImports = [
      '@qwen-code/acp-bridge',
      '@qwen-code/acp-bridge/bridge',
      '@qwen-code/acp-bridge/spawnChannel',
      '@qwen-code/acp-bridge/bridgeClient',
      '@qwen-code/acp-bridge/bridgeErrors',
    ];
    const forbiddenImports = [...graph.externalValueImports].filter(
      (specifier) => forbiddenExternalImports.includes(specifier),
    );
    expect(
      forbiddenImports,
      `Unexpected ACP runtime imports:\n${forbiddenImports.join('\n')}`,
    ).toEqual([]);
  });
});

describe('serve fast path argument parsing', () => {
  it('parses the common daemon startup flags without loading the full CLI parser', () => {
    const parsed = parseServeFastPathArgs([
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--workspace',
      '/tmp/workspace',
      '--no-web',
      '--no-open',
    ]);

    expect(parsed).toEqual({
      kind: 'serve',
      openWithAuth: false,
      httpBridge: true,
      open: false,
      options: {
        hostname: '127.0.0.1',
        mcpBudgetMode: 'off',
        mode: 'http-bridge',
        port: 0,
        serveWebShell: false,
        workspace: '/tmp/workspace',
      },
    });
  });

  it('parses --tls-cert and --tls-key on the fast path', () => {
    const parsed = parseServeFastPathArgs([
      'serve',
      '--tls-cert',
      '/tmp/cert.pem',
      '--tls-key',
      '/tmp/key.pem',
    ]);

    expect(parsed).toMatchObject({
      kind: 'serve',
      options: {
        tlsCert: '/tmp/cert.pem',
        tlsKey: '/tmp/key.pem',
      },
    });
  });

  it('parses valid memory project scopes and falls back for invalid values', () => {
    expect(
      parseServeFastPathArgs(['serve', '--memory-project-scope', 'workspace']),
    ).toMatchObject({
      kind: 'serve',
      options: { memoryProjectScope: 'workspace' },
    });
    expect(
      parseServeFastPathArgs(['serve', '--memory-project-scope=git-root']),
    ).toMatchObject({
      kind: 'serve',
      options: { memoryProjectScope: 'git-root' },
    });
    expect(
      parseServeFastPathArgs([
        'serve',
        '--memory-project-scope',
        'unsupported',
      ]),
    ).toEqual({ kind: 'fallback' });
  });

  it('parses bundled entrypoint argv before serve', () => {
    const parsed = parseServeFastPathArgs([
      '/repo/dist/cli.js',
      'serve',
      '--port',
      '0',
    ]);

    expect(parsed).toMatchObject({
      kind: 'serve',
      options: { port: 0 },
    });
  });

  it('falls back to the full parser for repeatable --workspace values', () => {
    expect(
      parseServeFastPathArgs([
        'serve',
        '--workspace',
        '/tmp/primary',
        '--workspace',
        '/tmp/secondary',
      ]),
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back to the full parser for empty --workspace values', () => {
    expect(parseServeFastPathArgs(['serve', '--workspace='])).toEqual({
      kind: 'fallback',
    });
    expect(parseServeFastPathArgs(['serve', '--workspace', ''])).toEqual({
      kind: 'fallback',
    });
  });

  it('parses Windows bundled entrypoint argv before serve', () => {
    const parsed = parseServeFastPathArgs([
      'C:\\repo\\dist\\cli.js',
      'serve',
      '--port',
      '0',
    ]);

    expect(parsed).toMatchObject({
      kind: 'serve',
      options: { port: 0 },
    });
  });

  it('falls back to the full parser for help and unknown options', () => {
    expect(parseServeFastPathArgs(['serve', '--help'])).toEqual({
      kind: 'fallback',
    });
    expect(parseServeFastPathArgs(['serve', '--unknown-option'])).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back to the full parser for daemon-managed channels', () => {
    expect(parseServeFastPathArgs(['serve', '--channel', 'telegram'])).toEqual({
      kind: 'fallback',
    });
  });

  it('handles every yargs serve long option or explicitly falls back', () => {
    const options = (
      buildServeCommandParser() as unknown as {
        getOptions(): {
          key: Record<string, boolean>;
          alias: Record<string, string[]>;
        };
      }
    ).getOptions();
    const longOptionNames = Object.keys(options.key).filter(
      (name) => name.length > 1 && !options.alias[name]?.length,
    );
    const sampleArgvByOption = new Map<string, string[]>([
      ['port', ['--port', '0']],
      ['hostname', ['--hostname', '127.0.0.1']],
      ['token', ['--token', 'token']],
      ['max-sessions', ['--max-sessions', '10']],
      ['max-total-sessions', ['--max-total-sessions', '20']],
      [
        'max-pending-prompts-per-session',
        ['--max-pending-prompts-per-session', '5'],
      ],
      ['max-connections', ['--max-connections', '256']],
      ['event-ring-size', ['--event-ring-size', '8000']],
      [
        'compacted-replay-max-bytes',
        ['--compacted-replay-max-bytes', '4194304'],
      ],
      ['max-journal-events', ['--max-journal-events', '10000']],
      ['max-journal-bytes', ['--max-journal-bytes', '8388608']],
      ['workspace', ['--workspace', process.cwd()]],
      ['memory-project-scope', ['--memory-project-scope', 'workspace']],
      ['require-auth', ['--require-auth']],
      ['enable-session-shell', ['--enable-session-shell']],
      ['tls-cert', ['--tls-cert', '/tmp/cert.pem']],
      ['tls-key', ['--tls-key', '/tmp/key.pem']],
      ['web', ['--no-web']],
      ['open', ['--open']],
      ['open-with-auth', ['--open-with-auth']],
      ['local-control', ['--local-control']],
      ['local-control-address', ['--local-control-address', '192.168.1.2']],
      ['http-bridge', ['--no-http-bridge']],
      ['memory-budget-mb', ['--memory-budget-mb', '8192']],
      ['memory-pressure-mode', ['--memory-pressure-mode', 'observe']],
      ['child-heap-mode', ['--child-heap-mode', 'observe']],
      ['mcp-client-budget', ['--mcp-client-budget', '10']],
      ['mcp-budget-mode', ['--mcp-budget-mode', 'warn']],
      ['allow-origin', ['--allow-origin', 'http://localhost:3000']],
      ['allow-private-auth-base-url', ['--allow-private-auth-base-url']],
      ['prompt-deadline-ms', ['--prompt-deadline-ms', '1000']],
      ['writer-idle-timeout-ms', ['--writer-idle-timeout-ms', '1000']],
      ['channel-idle-timeout-ms', ['--channel-idle-timeout-ms', '1000']],
      ['initialize-timeout-ms', ['--initialize-timeout-ms', '30000']],
      ['session-restore-timeout-ms', ['--session-restore-timeout-ms', '60000']],
      ['session-reap-interval-ms', ['--session-reap-interval-ms', '1000']],
      ['session-idle-timeout-ms', ['--session-idle-timeout-ms', '1000']],
      [
        'session-prompt-settled-close-grace-ms',
        ['--session-prompt-settled-close-grace-ms', '60000'],
      ],
      [
        'permission-response-timeout-ms',
        ['--permission-response-timeout-ms', '1000'],
      ],
      ['rate-limit', ['--rate-limit']],
      ['rate-limit-prompt', ['--rate-limit-prompt', '10']],
      ['rate-limit-mutation', ['--rate-limit-mutation', '30']],
      ['rate-limit-read', ['--rate-limit-read', '120']],
      ['rate-limit-window-ms', ['--rate-limit-window-ms', '60000']],
      ['experimental-lsp', ['--experimental-lsp']],
      ['restore-ask-user-question', ['--restore-ask-user-question']],
      ['external-tool-guard-mode', ['--external-tool-guard-mode', 'off']],
      [
        'external-tool-guard-endpoint',
        ['--external-tool-guard-endpoint', 'http://127.0.0.1:3001/v1'],
      ],
      [
        'external-tool-guard-timeout-ms',
        ['--external-tool-guard-timeout-ms', '3000'],
      ],
      ['channel', ['--channel', 'telegram']],
      ['help', ['--help']],
      ['version', ['--version']],
    ]);
    const expectedFallbackOptions = new Set([
      'channel',
      'external-tool-guard-endpoint',
      'external-tool-guard-mode',
      'external-tool-guard-timeout-ms',
      'help',
      'local-control',
      'local-control-address',
      'version',
    ]);

    expect(longOptionNames.sort()).toEqual(
      [...sampleArgvByOption.keys()].sort(),
    );
    for (const [optionName, sampleArgv] of sampleArgvByOption) {
      const parsed = parseServeFastPathArgs(['serve', ...sampleArgv]);
      if (parsed.kind === 'fallback') {
        expect(expectedFallbackOptions.has(optionName)).toBe(true);
      } else {
        expect(expectedFallbackOptions.has(optionName)).toBe(false);
      }
    }
  });

  it('matches yargs defaults for options materialized before runQwenServe', () => {
    const yargsParsed = buildServeCommandParser().parseSync('');
    const fastPathParsed = parseServeFastPathArgs(['serve']);

    expect(fastPathParsed).toMatchObject({
      kind: 'serve',
      options: {
        hostname: yargsParsed['hostname'],
        mode: 'http-bridge',
        port: yargsParsed['port'],
      },
    });
    expect(fastPathParsed).not.toHaveProperty('options.maxSessions');
    expect(fastPathParsed).not.toHaveProperty('options.maxTotalSessions');
    expect(fastPathParsed).not.toHaveProperty('options.maxConnections');
    expect(fastPathParsed).not.toHaveProperty('options.eventRingSize');
    expect(fastPathParsed).not.toHaveProperty(
      'options.compactedReplayMaxBytes',
    );
    expect(fastPathParsed).not.toHaveProperty(
      'options.maxPendingPromptsPerSession',
    );
  });

  it('parses --memory-pressure-mode and falls back on an unknown value', () => {
    for (const argv of [
      ['serve', '--memory-pressure-mode', 'off'],
      ['serve', '--memory-pressure-mode=off'],
    ]) {
      expect(parseServeFastPathArgs(argv)).toMatchObject({
        kind: 'serve',
        options: { memoryPressureMode: 'off' },
      });
    }
    // An out-of-range choice defers to yargs rather than the fast path
    // inventing a second wording for the same error.
    expect(
      parseServeFastPathArgs(['serve', '--memory-pressure-mode', 'enforce']),
    ).toEqual({ kind: 'fallback' });
  });

  it('parses --child-heap-mode and falls back on an unknown value', () => {
    for (const argv of [
      ['serve', '--child-heap-mode', 'off'],
      ['serve', '--child-heap-mode=off'],
    ]) {
      expect(parseServeFastPathArgs(argv)).toMatchObject({
        kind: 'serve',
        options: { childHeapMode: 'off' },
      });
    }
    // `enforce` is deliberately not a value yet, so it is the sample worth
    // pinning: the fast path must defer to yargs rather than smuggle it in.
    expect(
      parseServeFastPathArgs(['serve', '--child-heap-mode', 'enforce']),
    ).toEqual({ kind: 'fallback' });
  });

  it('parses --memory-budget-mb on the fast path in both spellings', () => {
    for (const argv of [
      ['serve', '--memory-budget-mb', '8192'],
      ['serve', '--memory-budget-mb=8192'],
    ]) {
      const parsed = parseServeFastPathArgs(argv);
      expect(parsed).toMatchObject({
        kind: 'serve',
        options: { memoryBudgetMb: 8192 },
      });
    }
  });

  it('parses --compacted-replay-max-bytes on the fast path', () => {
    const parsed = parseServeFastPathArgs([
      'serve',
      '--compacted-replay-max-bytes',
      '1048576',
    ]);

    expect(parsed).toMatchObject({
      kind: 'serve',
      options: { compactedReplayMaxBytes: 1024 * 1024 },
    });
  });

  it('keeps --experimental-lsp on the fast path', () => {
    const parsed = parseServeFastPathArgs(['serve', '--experimental-lsp']);

    expect(parsed).toMatchObject({
      kind: 'serve',
      options: { experimentalLsp: true },
    });
  });

  it('keeps --restore-ask-user-question on the fast path', () => {
    const parsed = parseServeFastPathArgs([
      'serve',
      '--restore-ask-user-question',
    ]);

    expect(parsed).toMatchObject({
      kind: 'serve',
      options: { restoreAskUserQuestion: true },
    });
  });

  it('keeps authenticated open on the fast path', () => {
    const parsed = parseServeFastPathArgs(['serve', '--open-with-auth']);

    expect(parsed).toMatchObject({
      kind: 'serve',
      open: true,
      openWithAuth: true,
    });
  });

  it('lets authenticated open imply --open regardless of --no-open', () => {
    expect(
      parseServeFastPathArgs(['serve', '--open-with-auth', '--no-open']),
    ).toMatchObject({
      kind: 'serve',
      open: true,
      openWithAuth: true,
    });
  });

  it('returns false to let the full CLI handle fallback cases', async () => {
    await expect(tryRunServeFastPath(['serve', '--help'])).resolves.toBe(false);
  });

  it('prints a breadcrumb when settings bootstrap falls back to the full CLI', async () => {
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-fallback-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(join(tempWorkspace, '.qwen', 'settings.json'), '{');
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await expect(
      tryRunServeFastPath(['serve', '--workspace', tempWorkspace]),
    ).resolves.toBe(false);

    expect(stderrWrites.join('')).toContain(
      'qwen serve: fast-path bootstrap failed, falling back to full startup:',
    );
  });

  it.each([
    [
      ['serve', '--mcp-client-budget', '0'],
      'qwen serve: --mcp-client-budget must be a positive integer.',
    ],
    [
      ['serve', '--mcp-budget-mode', 'enforce'],
      'qwen serve: --mcp-budget-mode=enforce requires --mcp-client-budget=N.',
    ],
    [
      ['serve', '--max-pending-prompts-per-session=-1'],
      'qwen serve: --max-pending-prompts-per-session must be a non-negative integer (0 / Infinity = unlimited).',
    ],
    [
      ['serve', '--compacted-replay-max-bytes=0'],
      'qwen serve: --compacted-replay-max-bytes must be a positive safe integer in [1, 268435456].',
    ],
    [
      ['serve', '--rate-limit', '--rate-limit-prompt=0'],
      'qwen serve: --rate-limit-prompt must be a positive integer.',
    ],
    [
      ['serve', '--memory-budget-mb', '512'],
      'qwen serve: --memory-budget-mb must be an integer in [1024, 1048576].',
    ],
  ])(
    'validates %s before bootstrapping settings and environment',
    async (argv, message) => {
      const qwenHome = useTempQwenHome();
      writeFileSync(join(qwenHome, 'settings.json'), '{');
      const stderrWrites: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
      vi.spyOn(process, 'exit').mockImplementation(((
        code?: string | number | null,
      ) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit);

      await expect(tryRunServeFastPath(argv)).rejects.toThrow(
        'process.exit(1)',
      );
      expect(stderrWrites.join('')).toContain(message);
    },
  );

  it.each([
    [['serve', '--memory-budget-mb', '8192'], 'valid --memory-budget-mb'],
    [['serve'], 'absent --memory-budget-mb'],
  ])('accepts %s without a range error', async (argv, _label) => {
    const qwenHome = useTempQwenHome();
    writeFileSync(join(qwenHome, 'settings.json'), '{');
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected process.exit');
    }) as typeof process.exit);

    // Bootstrap fails (broken settings.json), but validation must pass
    // first — a spurious range error would exit(1) before reaching it.
    const result = await tryRunServeFastPath(argv);

    expect(result).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).not.toContain(
      'must be an integer in [1024, 1048576]',
    );
  });

  it('does not enable rate limiting just because tuning flags are present', () => {
    const parsed = parseServeFastPathArgs([
      'serve',
      '--rate-limit-prompt',
      '0',
      '--rate-limit-window-ms',
      '1',
    ]);

    expect(parsed.kind).toBe('serve');
    if (parsed.kind !== 'serve') return;
    expect(parsed.options).not.toHaveProperty('rateLimit');
    expect(parsed.options.rateLimitPrompt).toBe(0);
    expect(parsed.options.rateLimitWindowMs).toBe(1);
  });

  it('enables rate limiting from env and applies env tuning values', () => {
    const parsed = parseServeFastPathArgs(['serve'], {
      QWEN_SERVE_RATE_LIMIT: '1',
      QWEN_SERVE_RATE_LIMIT_PROMPT: '10',
    });

    expect(parsed.kind).toBe('serve');
    if (parsed.kind !== 'serve') return;
    expect(parsed.options.rateLimit).toBe(true);
    expect(parsed.options.rateLimitPrompt).toBe(10);
  });

  it('discards rate limit env tuning when rate limiting is disabled', () => {
    const parsed = parseServeFastPathArgs(['serve'], {
      QWEN_SERVE_RATE_LIMIT_PROMPT: '10',
    });

    expect(parsed.kind).toBe('serve');
    if (parsed.kind !== 'serve') return;
    expect(parsed.options).not.toHaveProperty('rateLimit');
    expect(parsed.options.rateLimitPrompt).toBeUndefined();
  });

  it('rejects unsafe rate limit env integers instead of rounding them', () => {
    const parsed = parseServeFastPathArgs(['serve', '--rate-limit'], {
      QWEN_SERVE_RATE_LIMIT_PROMPT: String(Number.MAX_SAFE_INTEGER + 1),
    });

    expect(parsed.kind).toBe('serve');
    if (parsed.kind !== 'serve') return;
    expect(parsed.options.rateLimitPrompt).toBeNaN();
  });
});

describe('serve fast path environment bootstrap', () => {
  it('keeps the lite settings directory name in sync with core QWEN_DIR', () => {
    expect(SETTINGS_DIRECTORY_NAME).toBe(QWEN_DIR);
  });

  it('matches Storage.getGlobalQwenDir path resolution', () => {
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-storage-cwd-')),
    );
    tempQwenHome = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-storage-home-')),
    );
    process.chdir(tempWorkspace);

    for (const qwenHome of [
      undefined,
      tempQwenHome,
      '~',
      '~/qwen-fast-path',
      '~\\qwen-fast-path',
      'relative-qwen-home',
    ]) {
      if (qwenHome === undefined) {
        delete process.env['QWEN_HOME'];
      } else {
        process.env['QWEN_HOME'] = qwenHome;
      }

      expect(getGlobalQwenDirLite()).toBe(Storage.getGlobalQwenDir());
    }
  });

  it('closes the listener and exits when runtime startup fails after listen', async () => {
    const stderrWrites: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(
      waitForServeRuntimeOrExit({
        runtimeReady: Promise.reject(new Error('runtime boom')),
        close,
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(close).toHaveBeenCalledTimes(1);
    expect(stderrWrites.join('')).toContain(
      'qwen serve: runtime startup failed after listener was ready: runtime boom',
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not report startup failure when runtime startup is cancelled by close', async () => {
    const stderrWrites: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(
      waitForServeRuntimeOrExit({
        runtimeReady: Promise.reject(
          new Error(RUNTIME_STARTUP_CANCELLED_MESSAGE),
        ),
        close,
      }),
    ).resolves.toBeUndefined();

    expect(close).not.toHaveBeenCalled();
    expect(stderrWrites.join('')).not.toContain(
      'runtime startup failed after listener was ready',
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('validates rate limit env after settings bootstrap enables rate limiting', async () => {
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-rate-limit-env-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify({
        env: {
          QWEN_SERVE_RATE_LIMIT: '1',
          QWEN_SERVE_RATE_LIMIT_PROMPT: '0',
        },
      }),
    );
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(
      tryRunServeFastPath([
        'serve',
        '--workspace',
        tempWorkspace,
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--no-open',
        '--no-web',
      ]),
    ).rejects.toThrow('process.exit(1)');

    expect(stderrWrites.join('')).toContain(
      'qwen serve: --rate-limit-prompt must be a positive integer.',
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits when runQwenServe fails after settings bootstrap succeeds', async () => {
    useTempQwenHome();
    vi.spyOn(runQwenServeModule, 'runQwenServe').mockRejectedValue(
      new Error('listen boom'),
    );
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(
      tryRunServeFastPath([
        'serve',
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--no-open',
        '--no-web',
      ]),
    ).rejects.toThrow('process.exit(1)');

    expect(stderrWrites.join('')).toContain('qwen serve: listen boom');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('keeps headless yolo warning best-effort after listening', async () => {
    const originalSandbox = process.env['SANDBOX'];
    const originalSuppress = process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'];
    delete process.env['SANDBOX'];
    delete process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'];
    const qwenHome = useTempQwenHome();
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ tools: { approvalMode: 'yolo', sandbox: false } }),
    );
    const runtimeReady = Promise.reject(new Error('runtime boom'));
    void runtimeReady.catch(() => undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(runQwenServeModule, 'runQwenServe').mockResolvedValue({
      runtimeReady,
      close,
    } as unknown as Awaited<
      ReturnType<typeof runQwenServeModule.runQwenServe>
    >);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      const text = String(chunk);
      stderrWrites.push(text);
      if (text.includes(HEADLESS_YOLO_NO_SANDBOX_WARNING)) {
        throw new Error('stderr closed');
      }
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    try {
      await expect(
        tryRunServeFastPath(['serve', '--port', '0', '--no-open', '--no-web']),
      ).rejects.toThrow('process.exit(1)');

      expect(stderrWrites.join('')).toContain(HEADLESS_YOLO_NO_SANDBOX_WARNING);
      expect(stderrWrites.join('')).toContain(
        'qwen serve: runtime startup failed after listener was ready: runtime boom',
      );
      expect(stderrWrites.join('')).not.toContain('qwen serve: stderr closed');
      expect(close).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledWith(1);
    } finally {
      if (originalSandbox === undefined) {
        delete process.env['SANDBOX'];
      } else {
        process.env['SANDBOX'] = originalSandbox;
      }
      if (originalSuppress === undefined) {
        delete process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'];
      } else {
        process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'] = originalSuppress;
      }
    }
  });

  it('rejects malformed user settings so the full settings loader can handle it', async () => {
    const qwenHome = useTempQwenHome();
    writeFileSync(join(qwenHome, 'settings.json'), '{');

    await expect(bootstrapServeFastPathEnvironment(undefined)).rejects.toThrow(
      /settings/i,
    );
  }, 10_000);

  it('falls back to the full CLI when fast-path settings bootstrap fails', async () => {
    const qwenHome = useTempQwenHome();
    writeFileSync(join(qwenHome, 'settings.json'), '{');

    await expect(
      tryRunServeFastPath(['serve', '--port', '0', '--no-open', '--no-web']),
    ).resolves.toBe(false);
  }, 10_000);

  it.each([
    [
      'advanced.excludedEnvVars',
      { advanced: { excludedEnvVars: 'QWEN_SERVER_TOKEN' } },
    ],
    [
      'advanced.runtimeOutputDir',
      { advanced: { runtimeOutputDir: ['.qwen-runtime'] } },
    ],
    [
      'security.folderTrust.enabled',
      { security: { folderTrust: { enabled: 'true' } } },
    ],
  ])(
    'falls back to the full CLI when %s has an incompatible shape',
    async (_field, settingsJson) => {
      const qwenHome = useTempQwenHome();
      writeFileSync(
        join(qwenHome, 'settings.json'),
        JSON.stringify(settingsJson),
      );

      await expect(
        tryRunServeFastPath(['serve', '--port', '0', '--no-open', '--no-web']),
      ).resolves.toBe(false);
    },
  );

  it('loads QWEN_SERVER_TOKEN from the workspace .env before the daemon starts', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-env-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', '.env'),
      'QWEN_SERVER_TOKEN=from-workspace-env\n',
    );
    process.chdir(tempWorkspace);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe('from-workspace-env');
  });

  it('preserves workspace .env compile cache over the pending default', async () => {
    delete process.env['NODE_COMPILE_CACHE'];
    delete process.env['NODE_DISABLE_COMPILE_CACHE'];
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-compile-cache-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', '.env'),
      'NODE_COMPILE_CACHE=/tmp/operator-cache\n',
    );

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['NODE_COMPILE_CACHE']).toBe('/tmp/operator-cache');
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('loads .env from --workspace even when launched from another directory', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-workspace-env-')),
    );
    tempLaunchCwd = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-launch-cwd-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', '.env'),
      'QWEN_SERVER_TOKEN=from-explicit-workspace-env\n',
    );
    process.chdir(tempLaunchCwd);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe(
      'from-explicit-workspace-env',
    );
  });

  it('loads home .env after workspace .env for daemon boot-time keys', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    delete process.env['QWEN_SERVE_RATE_LIMIT'];
    delete process.env['QWEN_SERVE_RATE_LIMIT_PROMPT'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-layered-env-')),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVE_RATE_LIMIT_PROMPT=123\n',
    );
    writeFileSync(
      join(qwenHome, '.env'),
      ['QWEN_SERVER_TOKEN=from-home-env', 'QWEN_SERVE_RATE_LIMIT=1'].join('\n'),
    );

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVE_RATE_LIMIT_PROMPT']).toBe('123');
    expect(process.env['QWEN_SERVER_TOKEN']).toBe('from-home-env');
    expect(process.env['QWEN_SERVE_RATE_LIMIT']).toBe('1');
  });

  it('applies legacy excludedProjectEnvVars before loading workspace .env', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ excludedProjectEnvVars: ['QWEN_SERVER_TOKEN'] }),
    );
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-legacy-env-')),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-workspace-env\n',
    );
    process.chdir(tempWorkspace);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('loads QWEN_SERVER_TOKEN from workspace settings.env without the full settings loader', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-settings-env-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify({
        env: { QWEN_SERVER_TOKEN: 'from-workspace-settings-env' },
      }),
    );
    process.chdir(tempWorkspace);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe(
      'from-workspace-settings-env',
    );
  });

  it('pre-resolves home env overrides in the same order as the full loader', () => {
    delete process.env['QWEN_HOME'];
    delete process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    delete process.env['QWEN_CODE_SERVE'];
    delete process.env['QWEN_CODE_DESKTOP'];
    tempLaunchCwd = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-fake-home-')),
    );
    process.env['HOME'] = tempLaunchCwd;
    process.env['USERPROFILE'] = tempLaunchCwd;
    tempQwenHome = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-discovered-home-')),
    );
    mkdirSync(join(tempLaunchCwd, '.qwen'), { recursive: true });
    writeFileSync(
      join(tempLaunchCwd, '.qwen', '.env'),
      `QWEN_HOME=${tempQwenHome}\n`,
    );
    writeFileSync(
      join(tempLaunchCwd, '.env'),
      [
        'QWEN_RUNTIME_DIR=from-home-env',
        'QWEN_CODE_SERVE=1',
        'QWEN_CODE_DESKTOP=1',
      ].join('\n'),
    );
    writeFileSync(
      join(tempQwenHome, '.env'),
      [
        'QWEN_CODE_MCP_APPROVALS_PATH=from-discovered-home',
        'QWEN_CODE_TRUSTED_FOLDERS_PATH=from-discovered-trust',
      ].join('\n'),
    );

    preResolveServeFastPathHomeEnvOverrides();

    expect(process.env['QWEN_HOME']).toBe(tempQwenHome);
    expect(process.env['QWEN_RUNTIME_DIR']).toBe('from-home-env');
    expect(process.env['QWEN_CODE_MCP_APPROVALS_PATH']).toBe(
      'from-discovered-home',
    );
    expect(process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH']).toBe(
      'from-discovered-trust',
    );
    expect(process.env['QWEN_CODE_SERVE']).toBeUndefined();
    expect(process.env['QWEN_CODE_DESKTOP']).toBeUndefined();
  });

  it('still pre-resolves missing home-scoped keys when QWEN_HOME and runtime are already set', () => {
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    const qwenHome = useTempQwenHome();
    process.env['QWEN_RUNTIME_DIR'] = join(qwenHome, 'runtime');
    writeFileSync(
      join(qwenHome, '.env'),
      'QWEN_CODE_TRUSTED_FOLDERS_PATH=from-existing-home\n',
    );

    preResolveServeFastPathHomeEnvOverrides();

    expect(process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH']).toBe(
      'from-existing-home',
    );
  });

  it('applies legacy settings keys consumed by the serve fast path', () => {
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-legacy-settings-')),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({
        approvalMode: 'yolo',
        contextFileName: 'LEGACY.md',
        excludedProjectEnvVars: ['QWEN_SERVER_TOKEN'],
        fileFiltering: { customIgnoreFiles: ['.legacy-ignore'] },
        folderTrust: true,
        sandbox: false,
      }),
    );

    const settings = loadServeFastPathSettings(tempWorkspace);

    expect(settings).toMatchObject({
      advanced: { excludedEnvVars: ['QWEN_SERVER_TOKEN'] },
      context: {
        fileName: 'LEGACY.md',
        fileFiltering: { customIgnoreFiles: ['.legacy-ignore'] },
      },
      security: { folderTrust: { enabled: true } },
      tools: { approvalMode: 'yolo', sandbox: false },
    });
  });

  it('matches the full settings loader for fields consumed before listen', async () => {
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-settings-parity-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    const { SETTINGS_VERSION, loadSettings } = await import(
      '../config/settings.js'
    );
    const versioned = (settings: Record<string, unknown>) => ({
      $version: SETTINGS_VERSION,
      ...settings,
    });
    writeFileSync(
      process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']!,
      JSON.stringify(
        versioned({
          env: {
            FAST_PATH_DEFAULT_ONLY: 'default',
            FAST_PATH_OVERLAP: 'default',
          },
          advanced: {
            excludedEnvVars: ['FAST_PATH_DEFAULT_EXCLUDED'],
            runtimeOutputDir: '.default-runtime',
          },
          context: {
            fileName: 'DEFAULT.md',
            fileFiltering: { customIgnoreFiles: ['.default-ignore'] },
          },
          security: { folderTrust: { enabled: false } },
          tools: { approvalMode: 'default' },
        }),
      ),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify(
        versioned({
          env: {
            FAST_PATH_USER_ONLY: 'user',
            FAST_PATH_OVERLAP: 'user',
          },
          advanced: {
            excludedEnvVars: ['FAST_PATH_USER_EXCLUDED'],
          },
          security: { folderTrust: { enabled: true } },
          tools: { approvalMode: 'auto' },
        }),
      ),
    );
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify(
        versioned({
          env: {
            FAST_PATH_WORKSPACE_ONLY: 'workspace',
            FAST_PATH_OVERLAP: 'workspace',
          },
          advanced: { runtimeOutputDir: '.workspace-runtime' },
          general: { chatRecording: false },
          context: {
            fileName: 'WORKSPACE.md',
            fileFiltering: { customIgnoreFiles: ['.workspace-ignore'] },
          },
          policy: { permissionStrategy: 'consensus', consensusQuorum: 3 },
          tools: { sandbox: true },
        }),
      ),
    );
    writeFileSync(
      process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']!,
      JSON.stringify(
        versioned({
          env: {
            FAST_PATH_SYSTEM_ONLY: 'system',
            FAST_PATH_OVERLAP: 'system',
          },
          context: { fileName: 'SYSTEM.md' },
          tools: { approvalMode: 'yolo' },
        }),
      ),
    );
    expect(loadServeFastPathSettings(tempWorkspace)).toEqual(
      pickServeFastPathComparable(
        loadSettings(tempWorkspace, { skipLoadEnvironment: true }).merged,
      ),
    );
  });

  it('loads runtimeOutputDir for daemon startup artifacts', () => {
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-runtime-dir-')),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({
        advanced: { runtimeOutputDir: '.qwen-runtime' },
      }),
    );

    const settings = loadServeFastPathSettings(tempWorkspace);

    expect(settings.advanced?.runtimeOutputDir).toBe('.qwen-runtime');
  });

  it('ignores stale legacy keys in current-version settings files', () => {
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-stale-legacy-settings-')),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({
        $version: 5,
        approvalMode: 'yolo',
        contextFileName: 'LEGACY.md',
        excludedProjectEnvVars: ['QWEN_SERVER_TOKEN'],
        fileFiltering: { customIgnoreFiles: ['.legacy-ignore'] },
        folderTrust: true,
        sandbox: false,
      }),
    );

    const settings = loadServeFastPathSettings(tempWorkspace);

    expect(settings.advanced).toBeUndefined();
    expect(settings.context).toBeUndefined();
    expect(settings.security).toBeUndefined();
    expect(settings.tools).toBeUndefined();
  });

  it('uses trusted-folders path from home .env before loading workspace env', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    delete process.env['QWEN_RUNTIME_DIR'];
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    const qwenHome = useTempQwenHome();
    const customTrustedFoldersPath = join(qwenHome, 'custom-trusted.json');
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-home-trust-env-')),
    );
    writeFileSync(
      join(qwenHome, '.env'),
      `QWEN_CODE_TRUSTED_FOLDERS_PATH=${customTrustedFoldersPath}\n`,
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    writeFileSync(
      customTrustedFoldersPath,
      JSON.stringify({ [tempWorkspace]: TrustLevel.DO_NOT_TRUST }),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-untrusted-workspace-env\n',
    );

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH']).toBe(
      customTrustedFoldersPath,
    );
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('uses legacy folderTrust before loading workspace env', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-legacy-trust-')),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ folderTrust: true }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({ [tempWorkspace]: TrustLevel.DO_NOT_TRUST }),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-untrusted-workspace-env\n',
    );

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('caches trusted folders during a single fast-path bootstrap', () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trust-cache-')),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({ [tempWorkspace]: TrustLevel.TRUST_FOLDER }),
    );
    writeFileSync(join(tempWorkspace, '.env'), 'QWEN_SERVER_TOKEN=trusted\n');

    const settings = loadServeFastPathSettings(tempWorkspace);
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({ [tempWorkspace]: TrustLevel.DO_NOT_TRUST }),
    );

    loadServeFastPathEnvironment(settings, tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe('trusted');
  });

  // Regression for #8653: the fast path runs before runQwenServeImpl freezes
  // daemonRuntimeBaseEnv, so any loader key it applies is baked into the base
  // env distributed to every workspace's session subprocesses — the exact
  // cross-workspace vector the daemon-side scrub closes.
  it('never applies loader-affecting keys from .env files or settings.env', () => {
    // Hermetic: the walk-up reaches the user-level candidates, so the real
    // ~/.qwen/.env must not leak into this test.
    useTempQwenHome();
    const trackedKeys = [
      'NODE_OPTIONS',
      'npm_config_node_options',
      'npm_config_node-options',
      'NPM_CONFIG_NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
    ] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }

    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-env-')),
    );
    try {
      writeFileSync(
        join(tempWorkspace, '.env'),
        [
          'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
          'npm_config_node_options=--import file:///workspace-a/hook.mjs',
          // npm applies npm_config_* case-insensitively and maps
          // non-leading underscores onto hyphens, so the gate must reject
          // case variants and the hyphen spelling too.
          'NPM_CONFIG_NODE_OPTIONS=--import file:///workspace-a/upper.mjs',
          'npm_config_node-options=--import file:///workspace-a/hyphen.mjs',
          'FASTPATH_DOTENV_ALLOWED=allowed',
          '',
        ].join('\n'),
      );
      loadServeFastPathEnvironment({}, tempWorkspace);
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
      expect(process.env['npm_config_node_options']).toBeUndefined();
      expect(process.env['npm_config_node-options']).toBeUndefined();
      expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
      expect(process.env['FASTPATH_DOTENV_ALLOWED']).toBe('allowed');
      rmSync(tempWorkspace, { recursive: true, force: true });

      // The privileged .qwen/.env scope bypasses excludedEnvVars, so pin it
      // separately: exempting it would ship green without this case.
      tempWorkspace = realpathSync(
        mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-env-')),
      );
      mkdirSync(join(tempWorkspace, SETTINGS_DIRECTORY_NAME));
      writeFileSync(
        join(tempWorkspace, SETTINGS_DIRECTORY_NAME, '.env'),
        [
          'NODE_PATH=/workspace-a/node_modules',
          'FASTPATH_QWEN_ALLOWED=allowed',
          '',
        ].join('\n'),
      );
      loadServeFastPathEnvironment({}, tempWorkspace);
      expect(process.env['NODE_PATH']).toBeUndefined();
      expect(process.env['FASTPATH_QWEN_ALLOWED']).toBe('allowed');

      loadServeFastPathEnvironment(
        {
          env: {
            LD_PRELOAD: '/workspace-a/hijack.so',
            NPM_CONFIG_NODE_OPTIONS: '--import file:///workspace-a/upper.mjs',
            'npm_config_node-options':
              '--import file:///workspace-a/hyphen.mjs',
            FASTPATH_SETTINGS_ALLOWED: 'allowed',
          },
        },
        tempWorkspace,
      );
      expect(process.env['LD_PRELOAD']).toBeUndefined();
      expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
      expect(process.env['npm_config_node-options']).toBeUndefined();
      expect(process.env['FASTPATH_SETTINGS_ALLOWED']).toBe('allowed');
    } finally {
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
      delete process.env['FASTPATH_DOTENV_ALLOWED'];
      delete process.env['FASTPATH_QWEN_ALLOWED'];
      delete process.env['FASTPATH_SETTINGS_ALLOWED'];
    }
  });

  // The loader gate runs before any scope check, and home-scoped files are
  // exempt from PROJECT_ENV_HARDCODED_EXCLUSIONS — pin that a home-scoped
  // exemption mutant for loader keys cannot ship green on the fast path.
  it('never applies loader-affecting keys from user-level .env files either', () => {
    const trackedKeys = ['NODE_OPTIONS', 'npm_config_node_options'] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }

    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-home-')),
    );
    writeFileSync(
      join(qwenHome, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'npm_config_node_options=--import file:///workspace-a/hook.mjs',
        'FASTPATH_HOME_ALLOWED=allowed',
        '',
      ].join('\n'),
    );

    try {
      loadServeFastPathEnvironment({}, tempWorkspace);
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
      expect(process.env['npm_config_node_options']).toBeUndefined();
      expect(process.env['FASTPATH_HOME_ALLOWED']).toBe('allowed');
    } finally {
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
      delete process.env['FASTPATH_HOME_ALLOWED'];
    }
  });

  // QWEN_CLI_ENTRY is the spawned session-process entrypoint: a start-dir
  // .env fixing it turns `qwen serve` in an untrusted repo into arbitrary
  // script execution for every workspace's sessions. The fast path consults
  // no reload tier, so the key must be hardcoded-excluded here.
  it('never applies QWEN_CLI_ENTRY from a project .env on the fast path', () => {
    useTempQwenHome();
    const trackedKeys = ['QWEN_CLI_ENTRY', 'qwen_cli_entry'] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-cli-entry-')),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      [
        'QWEN_CLI_ENTRY=/workspace-a/evil-entry.js',
        // Windows env lookup is case-insensitive, so the gate must reject
        // case variants too.
        'qwen_cli_entry=/workspace-a/evil-entry-lower.js',
        '',
      ].join('\n'),
    );

    try {
      loadServeFastPathEnvironment({}, tempWorkspace);
      expect(process.env['QWEN_CLI_ENTRY']).toBeUndefined();
      expect(process.env['qwen_cli_entry']).toBeUndefined();
    } finally {
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });

  // The fast-path settings.env loop rejects hardcoded exclusions through the
  // case-folded isHardcodedProjectEnvExclusion predicate. Every other
  // settings.env fixture uses loader/allowlisted keys, so a regression to
  // exact-case membership would ship green — this pins a lowercase hardcoded
  // key (the entrypoint hijack) being rejected from settings.env.
  it('never applies a case-variant hardcoded exclusion from settings.env on the fast path', () => {
    useTempQwenHome();
    const trackedKeys = [
      'QWEN_CLI_ENTRY',
      'qwen_cli_entry',
      'node_extra_ca_certs',
    ] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-settings-hardcoded-')),
    );

    try {
      loadServeFastPathEnvironment(
        {
          env: {
            qwen_cli_entry: '/workspace-a/evil-entry-lower.js',
            node_extra_ca_certs: '/workspace-a/evil-ca.pem',
          },
        },
        tempWorkspace,
      );
      expect(process.env['qwen_cli_entry']).toBeUndefined();
      expect(process.env['QWEN_CLI_ENTRY']).toBeUndefined();
      expect(process.env['node_extra_ca_certs']).toBeUndefined();
    } finally {
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });

  // Daemon-side loadSettings() skips the .env load for untrusted workspaces
  // and only re-runs it later for trusted ones, so a loader key rejected at
  // boot would vanish without a breadcrumb unless the fast path reports it.
  it('warns when loader-affecting keys are rejected on the fast path', () => {
    resetLoaderKeyRejectionReportingForTesting();
    useTempQwenHome();
    const trackedKeys = ['NODE_OPTIONS', 'LD_PRELOAD'] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }

    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-warn-')),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      ['NODE_OPTIONS=--max-old-space-size=8192', ''].join('\n'),
    );
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadServeFastPathEnvironment(
        { env: { LD_PRELOAD: '/workspace-a/hijack.so' } },
        tempWorkspace,
      );
    } finally {
      stderrWrite.mockRestore();
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }

    const warnings = stderrWrites.filter((chunk) =>
      chunk.includes('cannot set loader-affecting env vars'),
    );
    expect(warnings).toHaveLength(2);
    const combined = warnings.join('');
    expect(combined).toContain(join(tempWorkspace, '.env'));
    expect(combined).toContain('NODE_OPTIONS');
    expect(combined).toContain('settings.env');
    expect(combined).toContain('LD_PRELOAD');
  });

  // The daemon consumes the stashed fast-path rejections once at boot to
  // persist them; the reset keeps a later consume (a second consumer or a
  // re-entered boot path in one process) from re-logging the same keys.
  it('resets the rejected-loader-key stash after one consume', () => {
    useTempQwenHome();
    const trackedKeys = ['NODE_OPTIONS'] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }

    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-consume-')),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'NODE_OPTIONS=--max-old-space-size=8192\n',
    );

    try {
      loadServeFastPathEnvironment({}, tempWorkspace);
      expect(consumeServeFastPathRejectedLoaderKeys()).toContain(
        'NODE_OPTIONS',
      );
      expect(consumeServeFastPathRejectedLoaderKeys()).toEqual([]);
    } finally {
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });

  // A second fast-path load must not clobber the keys rejected by the
  // first, and the same key rejected by both loads lands in the stash once.
  it('accumulates rejected loader keys across loads without duplicates', () => {
    useTempQwenHome();
    const trackedKeys = ['NODE_OPTIONS', 'LD_PRELOAD'] as const;
    const previous: Record<string, string | undefined> = {};
    for (const key of trackedKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }

    const firstWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-accum-1-')),
    );
    const secondWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-loader-accum-2-')),
    );
    writeFileSync(
      join(firstWorkspace, '.env'),
      'NODE_OPTIONS=--max-old-space-size=8192\n',
    );
    writeFileSync(join(secondWorkspace, '.env'), 'LD_PRELOAD=/hijack.so\n');

    try {
      // The stash is a module-global; drain any residue left by earlier tests
      // so this exact-match assertion does not depend on test declaration
      // order (partial `-t` selection, --sequence.shuffle, or a new load-
      // bearing test inserted before this one).
      consumeServeFastPathRejectedLoaderKeys();
      loadServeFastPathEnvironment({}, firstWorkspace);
      loadServeFastPathEnvironment(
        { env: { LD_PRELOAD: '/hijack.so', NODE_OPTIONS: '--inspect' } },
        secondWorkspace,
      );
      expect([...consumeServeFastPathRejectedLoaderKeys()].sort()).toEqual([
        'LD_PRELOAD',
        'NODE_OPTIONS',
      ]);
    } finally {
      rmSync(firstWorkspace, { recursive: true, force: true });
      rmSync(secondWorkspace, { recursive: true, force: true });
      for (const key of trackedKeys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });

  it('does not load env from an explicitly untrusted nested workspace', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trust-precedence-')),
    );
    const childWorkspace = join(tempWorkspace, 'child');
    mkdirSync(childWorkspace);
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [tempWorkspace]: TrustLevel.TRUST_FOLDER,
        [childWorkspace]: TrustLevel.DO_NOT_TRUST,
      }),
    );
    writeFileSync(join(childWorkspace, '.env'), 'QWEN_SERVER_TOKEN=trusted\n');

    await bootstrapServeFastPathEnvironment(childWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('does not load env from a descendant of an explicitly untrusted workspace', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trust-descendant-')),
    );
    const childWorkspace = join(tempWorkspace, 'evil-repo');
    const subDir = join(childWorkspace, 'packages', 'foo');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [tempWorkspace]: TrustLevel.TRUST_FOLDER,
        [childWorkspace]: TrustLevel.DO_NOT_TRUST,
      }),
    );
    writeFileSync(
      join(childWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-untrusted-descendant-env\n',
    );

    await bootstrapServeFastPathEnvironment(subDir);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('allows a trusted child rule to override an untrusted parent', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trust-opt-in-')),
    );
    const trustedWorkspace = join(tempWorkspace, 'good-repo');
    const subDir = join(trustedWorkspace, 'src');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [tempWorkspace]: TrustLevel.DO_NOT_TRUST,
        [trustedWorkspace]: TrustLevel.TRUST_FOLDER,
      }),
    );
    writeFileSync(
      join(trustedWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-trusted-child-env\n',
    );

    await bootstrapServeFastPathEnvironment(subDir);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe('from-trusted-child-env');
  });

  it('does not load a distrusted parent .env for a trusted child workspace', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trusted-child-')),
    );
    const childWorkspace = join(tempWorkspace, 'child');
    mkdirSync(childWorkspace);
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-distrusted-parent-env\n',
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [tempWorkspace]: TrustLevel.DO_NOT_TRUST,
        [childWorkspace]: TrustLevel.TRUST_FOLDER,
      }),
    );

    await bootstrapServeFastPathEnvironment(childWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('treats TRUST_PARENT as trusting the containing folder', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trust-parent-')),
    );
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [join(tempWorkspace, 'marker')]: TrustLevel.TRUST_PARENT,
      }),
    );
    writeFileSync(join(tempWorkspace, '.env'), 'QWEN_SERVER_TOKEN=trusted\n');

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe('trusted');
  });

  it('matches Cloud Shell default project behavior for empty env values', async () => {
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    process.env['CLOUD_SHELL'] = 'true';
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-cloud-shell-')),
    );
    writeFileSync(join(tempWorkspace, '.env'), 'GOOGLE_CLOUD_PROJECT=\n');

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe('cloudshell-gca');
  });

  it('expands process environment placeholders in workspace settings.env', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    useTempQwenHome();
    process.env['FAST_PATH_REFERENCED_TOKEN'] = 'from-referenced-env';
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-settings-env-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify({
        env: { QWEN_SERVER_TOKEN: '${FAST_PATH_REFERENCED_TOKEN}' },
      }),
    );
    process.chdir(tempWorkspace);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe('from-referenced-env');
  });

  it('never expands Qwen-internal secrets referenced from workspace settings.env', async () => {
    process.env['QWEN_SERVER_TOKEN'] = 'daemon-secret';
    delete process.env['FAST_PATH_LEAKED_COPY'];
    useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-settings-secret-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify({
        env: {
          FAST_PATH_LEAKED_COPY: 'copy=${QWEN_SERVER_TOKEN}/$qwen_server_token',
        },
      }),
    );
    process.chdir(tempWorkspace);

    try {
      await bootstrapServeFastPathEnvironment(tempWorkspace);

      // The placeholders survive verbatim, exactly like an unset variable's;
      // the daemon bearer token is never copied under another key.
      expect(process.env['FAST_PATH_LEAKED_COPY']).toBe(
        'copy=${QWEN_SERVER_TOKEN}/$qwen_server_token',
      );
    } finally {
      delete process.env['FAST_PATH_LEAKED_COPY'];
    }
  });

  it('expands home .env fallback placeholders in workspace settings.env', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    delete process.env['FAST_PATH_REFERENCED_TOKEN'];
    const qwenHome = useTempQwenHome();
    writeFileSync(
      join(qwenHome, '.env'),
      'FAST_PATH_REFERENCED_TOKEN=from-home-env\n',
    );
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-settings-env-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify({
        env: { QWEN_SERVER_TOKEN: '${FAST_PATH_REFERENCED_TOKEN}' },
      }),
    );
    process.chdir(tempWorkspace);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBe('from-home-env');
  });

  it.each([
    ['malformed JSON', '{ "env": { "QWEN_SERVER_TOKEN": "broken" }'],
    ['non-object JSON', '[]'],
  ])(
    'rejects %s workspace settings so the full settings loader can handle it',
    async (_name, settingsJson) => {
      delete process.env['QWEN_SERVER_TOKEN'];
      useTempQwenHome();
      tempWorkspace = realpathSync(
        mkdtempSync(join(os.tmpdir(), 'qws-fast-path-bad-settings-')),
      );
      mkdirSync(join(tempWorkspace, '.qwen'));
      writeFileSync(
        join(tempWorkspace, '.qwen', 'settings.json'),
        settingsJson,
      );
      process.chdir(tempWorkspace);

      await expect(
        bootstrapServeFastPathEnvironment(tempWorkspace),
      ).rejects.toThrow(/settings/i);
      expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
    },
  );

  it('still reads invalid workspace settings before dropping an untrusted workspace from the merge', () => {
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-untrusted-settings-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({ [tempWorkspace]: TrustLevel.DO_NOT_TRUST }),
    );
    writeFileSync(join(tempWorkspace, '.qwen', 'settings.json'), '[]');
    process.chdir(tempWorkspace);

    expect(() => loadServeFastPathSettings(tempWorkspace!)).toThrow(
      /settings/i,
    );
  });

  it('does not load env from an explicit untrusted workspace when launched elsewhere', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-untrusted-env-')),
    );
    tempLaunchCwd = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-trusted-launch-')),
    );
    mkdirSync(join(tempWorkspace, '.qwen'));
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [tempLaunchCwd]: TrustLevel.TRUST_FOLDER,
        [tempWorkspace]: TrustLevel.DO_NOT_TRUST,
      }),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-untrusted-workspace-env\n',
    );
    writeFileSync(
      join(tempWorkspace, '.qwen', 'settings.json'),
      JSON.stringify({
        env: { QWEN_SERVER_TOKEN: 'from-untrusted-workspace-settings' },
      }),
    );
    process.chdir(tempLaunchCwd);

    await bootstrapServeFastPathEnvironment(tempWorkspace);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  it('checks trust against the canonical explicit workspace path', async () => {
    delete process.env['QWEN_SERVER_TOKEN'];
    const qwenHome = useTempQwenHome();
    tempWorkspace = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-real-untrusted-env-')),
    );
    tempLaunchCwd = realpathSync(
      mkdtempSync(join(os.tmpdir(), 'qws-fast-path-symlink-launch-')),
    );
    tempSymlink = join(tempLaunchCwd, 'workspace-link');
    symlinkSync(tempWorkspace, tempSymlink, 'dir');
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: true } } }),
    );
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = join(
      qwenHome,
      'trustedFolders.json',
    );
    writeFileSync(
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'],
      JSON.stringify({
        [tempLaunchCwd]: TrustLevel.TRUST_FOLDER,
        [tempWorkspace]: TrustLevel.DO_NOT_TRUST,
      }),
    );
    writeFileSync(
      join(tempWorkspace, '.env'),
      'QWEN_SERVER_TOKEN=from-symlinked-untrusted-workspace-env\n',
    );
    process.chdir(tempLaunchCwd);

    await bootstrapServeFastPathEnvironment(tempSymlink);

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });
});
