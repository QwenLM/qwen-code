/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPowerShellProvider,
  getPowerShellCommonArgs,
  powerShellRequiresLeadingPosition,
  quotePowerShellSingleQuotedLiteral,
} from './powerShell.js';

describe('PowerShell provider', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    'param()',
    '# comment\nusing namespace System',
    '<# outer <# nested #> #> begin {}',
    '[CmdletBinding()] param()',
  ])('recognizes declarations after comments: %s', (command) => {
    expect(powerShellRequiresLeadingPosition(command)).toBe(true);
  });
  it('does not confuse a static member call with a script attribute', () => {
    expect(powerShellRequiresLeadingPosition('[System.Math]::Abs(-1)')).toBe(
      false,
    );
  });
  it('adds environment defaults without replacing explicit settings or FORCE_COLOR', async () => {
    const provider = await createPowerShellProvider({
      executable: 'pwsh',
      edition: 'core',
    });
    vi.stubEnv('PYTHONIOENCODING', undefined);
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
    expect(await provider.getEnvironmentOverrides('')).toEqual({
      PYTHONIOENCODING: 'utf-8:surrogateescape',
      NO_COLOR: '1',
    });
    vi.stubEnv('FORCE_COLOR', '1');
    vi.stubEnv('PYTHONIOENCODING', 'ascii');
    expect(await provider.getEnvironmentOverrides('')).toEqual({});
    vi.stubEnv('NO_COLOR', '0');
    expect(await provider.getEnvironmentOverrides('')).toEqual({});
  });
  it('uses a non-interactive profile-free execution-policy bypass by default', () => {
    expect(getPowerShellCommonArgs({})).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
    ]);
  });

  it('respects the configured execution policy', () => {
    expect(
      getPowerShellCommonArgs({
        QWEN_POWERSHELL_RESPECT_EXECUTION_POLICY: 'true',
      }),
    ).toEqual(['-NoProfile', '-NonInteractive']);
  });

  it('quotes apostrophes and rejects PowerShell Unicode quote variants', () => {
    expect(quotePowerShellSingleQuotedLiteral("C:\\A'B")).toBe("'C:\\A''B'");
    expect(() => quotePowerShellSingleQuotedLiteral('C:\\A\u2019B')).toThrow(
      'U+2019',
    );
  });

  it('isolates temporary paths even with identical caller IDs and removes the directory', async () => {
    const { existsSync } = await import('node:fs');
    const { basename, dirname } = await import('node:path');
    const slug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
    const provider = await createPowerShellProvider({
      executable: 'pwsh',
      edition: 'core',
    });
    const results = await Promise.all([
      provider.buildExecCommand('Get-Location', { id: 'same' }),
      provider.buildExecCommand('Get-Location', { id: 'same' }),
    ]);
    try {
      expect(dirname(results[0].cwdFilePath)).not.toBe(
        dirname(results[1].cwdFilePath),
      );
      for (const result of results) {
        const directory = dirname(result.cwdFilePath);
        expect(basename(directory).startsWith(`${slug}-powershell-`)).toBe(true);
        expect(existsSync(directory)).toBe(true);
      }
    } finally {
      for (const result of results) result.cleanup?.();
    }
    for (const result of results)
      expect(existsSync(dirname(result.cwdFilePath))).toBe(false);
  });

  it('uses -Command and appends exit-code and CWD propagation', async () => {
    const provider = await createPowerShellProvider({
      executable: 'pwsh',
      edition: 'core',
    });
    const built = await provider.buildExecCommand('Get-Location', {
      id: 'test',
    });
    expect(built.commandString).toContain('$LASTEXITCODE');
    expect(built.commandString).toContain('$?');
    expect(built.commandString).toContain('Get-Location');
    expect(provider.getSpawnArgs(built.commandString)).toContain('-Command');
    expect(provider.cwdFileContentPathStyle).toBe('native');
    built.cleanup?.();
  });
});

// Real child processes verify wrapper syntax and status propagation, not just strings.
describe.skipIf(!process.env['CLI_TEST_PWSH_EXE'])(
  'PowerShell provider real execution',
  () => {
    it.each([
      ['Write-Output "中文😀"', 0, '中文😀'],
      ['param()\nWrite-Output $OutputEncoding.WebName', 0, 'utf-8'],
      [
        'using namespace System\nparam()\nWrite-Output $OutputEncoding.WebName',
        0,
        'utf-8',
      ],
      [
        '[CmdletBinding()] param()\nWrite-Output $OutputEncoding.WebName',
        0,
        'utf-8',
      ],
      ["Write-Output @'\r\n中文😀\r\n'@", 0, '中文😀'],
      ['Write-Error "expected failure"', 1, ''],
      ['exit 7', 7, ''],
      ['# initial comment\nparam()\nWrite-Output hello', 0, 'hello'],
      ['using namespace System\nWrite-Output hello', 0, 'hello'],
      [
        'using namespace System\nbegin { Write-Output begin } end { Write-Output end }',
        0,
        'end',
      ],
      [
        'using namespace System; using namespace System.Text\nparam()\nWrite-Output hello',
        0,
        'hello',
      ],
      [
        "using module @{ ModuleName = 'Microsoft.PowerShell.Management'; ModuleVersion = '7.0' }\nbegin { Write-Output begin } end { Write-Output end }",
        0,
        'end',
      ],
      [
        '<# initial #> using namespace System # trailing comment\n<# between #> using namespace System.Text; [CmdletBinding()] param()\nWrite-Output hello',
        0,
        'hello',
      ],
      ['param()\n/bin/sh -c "exit 7"', 7, ''],
      ['begin { /bin/sh -c "exit 7" } end { Write-Output end }', 7, 'end'],
      [
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; Write-Output restricted",
        0,
        'restricted',
      ],
      [
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; Write-Error expected",
        1,
        '',
      ],
      ['begin { Write-Output begin } end { Write-Output end }', 0, 'end'],
    ])(
      'executes once and preserves status: %s',
      async (command, code, output) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { readFile, realpath } = await import('node:fs/promises');
        const provider = await createPowerShellProvider({
          executable: process.env['CLI_TEST_PWSH_EXE']!,
          edition: 'core',
        });
        const built = await provider.buildExecCommand(command, {
          id: crypto.randomUUID(),
        });
        try {
          let actualCode = 0;
          let stdout = '';
          try {
            stdout = (
              await promisify(execFile)(
                provider.shellPath,
                provider.getSpawnArgs(built.commandString),
                { timeout: 10000 },
              )
            ).stdout;
          } catch (error) {
            const failure = error as { code: number; stdout: string };
            actualCode = failure.code;
            stdout = failure.stdout;
          }
          expect(actualCode).toBe(code);
          if (output) expect(stdout).toContain(output);
          if (!command.startsWith('exit ')) {
            expect(
              (await readFile(built.cwdFilePath, 'utf8')).replace(
                /^\uFEFF/u,
                '',
              ),
            ).toBe(await realpath(process.cwd()));
          }
        } finally {
          built.cleanup?.();
        }
      },
    );
  },
);

describe.skipIf(!process.env['CLI_TEST_PWSH_EXE'])(
  'PowerShell constrained-language wrapper',
  () => {
    it.each([
      ['Write-Output "中文😀"', 0, '中文😀'],
      ['param()\nWrite-Output $OutputEncoding.WebName', 0, 'utf-8'],
      [
        '[CmdletBinding()] param()\nWrite-Output $OutputEncoding.WebName',
        0,
        'utf-8',
      ],
      ['Write-Error expected', 1, ''],
      ['param()\nWrite-Output declaration', 0, 'declaration'],
      ['begin { Write-Output begin } end { Write-Output end }', 0, 'end'],
    ])(
      'preserves output, status and cwd: %s',
      async (command, code, output) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { readFile, realpath } = await import('node:fs/promises');
        const provider = await createPowerShellProvider({
          executable: process.env['CLI_TEST_PWSH_EXE']!,
          edition: 'core',
        });
        const built = await provider.buildExecCommand(command, {
          id: crypto.randomUUID(),
        });
        let actualCode = 0;
        let stdout = '';
        let stderr = '';
        try {
          try {
            ({ stdout, stderr } = await promisify(execFile)(
              provider.shellPath,
              provider.getSpawnArgs(
                "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage';\n" +
                  built.commandString,
              ),
              { timeout: 10000 },
            ));
          } catch (error) {
            const failure = error as {
              code: number;
              stdout: string;
              stderr: string;
            };
            actualCode = failure.code;
            stdout = failure.stdout;
            stderr = failure.stderr;
          }
          expect(actualCode).toBe(code);
          if (output) expect(stdout).toContain(output);
          if (code === 0) expect(stderr).toBe('');
          expect(
            (await readFile(built.cwdFilePath, 'utf8')).replace(/^\uFEFF/u, ''),
          ).toBe(await realpath(process.cwd()));
        } finally {
          built.cleanup?.();
        }
      },
    );
  },
);

describe.skipIf(!process.env['CLI_TEST_PWSH_EXE'])(
  'PowerShell cwd and encoding',
  () => {
    it('persists a quoted Unicode cwd and writes UTF-8 without executing twice', async () => {
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const { promisify } = await import('node:util');
      const { execFile } = await import('node:child_process');
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), 'qwen-ps-provider-'),
      );
      const cwd = path.join(root, "中文 space's");
      await fs.mkdir(cwd);
      const provider = await createPowerShellProvider({
        executable: process.env['CLI_TEST_PWSH_EXE']!,
        edition: 'core',
      });
      const built = await provider.buildExecCommand(
        `Set-Location -LiteralPath ${quotePowerShellSingleQuotedLiteral(cwd)}; '中文😀' | Out-File -FilePath output.txt; Add-Content counter.txt x`,
        { id: crypto.randomUUID() },
      );
      try {
        await promisify(execFile)(
          provider.shellPath,
          provider.getSpawnArgs(built.commandString),
          { timeout: 10000 },
        );
        expect(
          (await fs.readFile(built.cwdFilePath, 'utf8')).replace(
            /^\uFEFF/u,
            '',
          ),
        ).toBe(await fs.realpath(cwd));
        expect(await fs.readFile(path.join(cwd, 'output.txt'), 'utf8')).toBe(
          '中文😀\n',
        );
        expect(await fs.readFile(path.join(cwd, 'counter.txt'), 'utf8')).toBe(
          'x\n',
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        built.cleanup?.();
      }
    });
  },
);
