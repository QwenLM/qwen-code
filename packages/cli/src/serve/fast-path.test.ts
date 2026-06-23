/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

import {
  bootstrapServeFastPathEnvironment,
  parseServeFastPathArgs,
  tryRunServeFastPath,
  waitForServeRuntimeOrExit,
} from './fast-path.js';
import {
  getGlobalQwenDirFastPath,
  loadServeFastPathSettings,
  preResolveServeFastPathHomeEnvOverrides,
  resetServeFastPathHomeEnvBootstrapForTesting,
} from './fast-path-settings.js';
import {
  resetTrustedFoldersForTesting,
  TrustLevel,
} from '../config/trustedFolders.js';

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
const originalCwd = process.cwd();

function useTempQwenHome(): string {
  tempQwenHome = realpathSync(
    mkdtempSync(join(os.tmpdir(), 'qws-fast-path-home-')),
  );
  process.env['QWEN_HOME'] = tempQwenHome;
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
    const indexSource = readFileSync('index.ts', 'utf8');

    expect(indexSource).not.toContain("import './src/gemini.js'");
    expect(indexSource).not.toContain("import { main } from './src/gemini.js'");
    expect(indexSource).not.toContain("process.argv[2] === 'serve'");
    expect(indexSource).toContain('import { isServeFastPathArgv }');
    expect(indexSource).toContain("await import('./src/serve/fast-path.js')");
  });

  it('does not import the full settings loader on the serve fast path', () => {
    const fastPathSource = readFileSync('src/serve/fast-path.ts', 'utf8');

    expect(fastPathSource).not.toContain('../config/settings.js');
    expect(fastPathSource).not.toContain('../config/environment.js');
    expect(fastPathSource).not.toContain('@qwen-code/qwen-code-core');
    expect(fastPathSource).toContain('bootSettings: settings');
    expect(fastPathSource).toContain('resolveOnListen: true');
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

  it('returns false to let the full CLI handle fallback cases', async () => {
    await expect(tryRunServeFastPath(['serve', '--help'])).resolves.toBe(false);
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
      ['serve', '--rate-limit', '--rate-limit-prompt=0'],
      'qwen serve: --rate-limit-prompt must be a positive integer.',
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

      expect(getGlobalQwenDirFastPath()).toBe(Storage.getGlobalQwenDir());
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
      'QWEN_RUNTIME_DIR=from-home-env\n',
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
