/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAND_CLI_NAME, ENV_PID } from '../../config/brand.js';
import {
  _resetSnapshotsDirForTest,
  setSnapshotsDir,
} from '../bash/ShellSnapshot.js';
import {
  _resetPkillSelfProtectionForTest,
  buildPkillSelfProtectionScript,
  getPkillSelfProtectionSourceCommand,
  setPkillSelfProtectionEnabled,
} from './pkillSelfProtection.js';

const PROTECTED_PID = 4242;
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const itZsh = existsSync('/bin/zsh') ? it : it.skip;

describePosix('pkill self-protection', () => {
  let tempDir: string;
  let fakePgrep: string;
  let pgrepLog: string;
  let pkillLog: string;

  beforeEach(async () => {
    setPkillSelfProtectionEnabled(false);
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pkill-protection-'));
    setSnapshotsDir(tempDir);
    _resetPkillSelfProtectionForTest();
    await mkdir(path.join(tempDir, String(PROTECTED_PID)), { recursive: true });
    await writeFile(
      path.join(tempDir, String(PROTECTED_PID), 'comm'),
      'qwen\n',
    );
    fakePgrep = path.join(tempDir, 'pgrep');
    pgrepLog = path.join(tempDir, 'pgrep.log');
    pkillLog = path.join(tempDir, 'pkill.log');
    await writeFile(
      fakePgrep,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$FAKE_PGREP_LOG"',
        '[ -z "$FAKE_PGREP_OUTPUT" ] || printf "%s\\n" "$FAKE_PGREP_OUTPUT"',
        'exit "${FAKE_PGREP_STATUS:-0}"',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(tempDir, 'pkill'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$FAKE_PKILL_LOG"',
        'exit 0',
        '',
      ].join('\n'),
    );
    await chmod(fakePgrep, 0o755);
    await chmod(path.join(tempDir, 'pkill'), 0o755);
  });

  afterEach(async () => {
    setPkillSelfProtectionEnabled(false);
    _resetPkillSelfProtectionForTest();
    _resetSnapshotsDirForTest();
    await rm(tempDir, { recursive: true, force: true });
  });

  function run(
    command: string,
    options: {
      pgrepOutput?: string;
      pgrepStatus?: number;
      beforeProtection?: string;
      shell?: string;
    } = {},
  ) {
    const shell = options.shell ?? '/bin/bash';
    const protection = buildPkillSelfProtectionScript(shell, {
      enabled: true,
      platform: 'linux',
      pgrepPath: fakePgrep,
      procRoot: tempDir,
    });
    expect(protection).not.toBeNull();
    return spawnSync(
      shell,
      [
        '-c',
        `${options.beforeProtection ? `${options.beforeProtection}\n` : ''}${protection}\n${command}`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:/usr/bin:/bin`,
          TARGET: 'godot engine',
          FAKE_PGREP_LOG: pgrepLog,
          FAKE_PKILL_LOG: pkillLog,
          FAKE_PGREP_OUTPUT: options.pgrepOutput ?? '',
          FAKE_PGREP_STATUS: String(options.pgrepStatus ?? 0),
          [ENV_PID]: String(PROTECTED_PID),
        },
      },
    );
  }

  it('is disabled unless the concrete entry point opts in on Linux', () => {
    expect(
      buildPkillSelfProtectionScript('/bin/bash', {
        platform: 'linux',
      }),
    ).toBeNull();

    setPkillSelfProtectionEnabled(true);
    expect(
      buildPkillSelfProtectionScript('/bin/bash', {
        platform: 'darwin',
      }),
    ).toBeNull();
    expect(
      buildPkillSelfProtectionScript('/bin/bash', {
        platform: 'linux',
      }),
    ).not.toBeNull();
  });

  it('leaves unsupported /bin/sh fallback commands unchanged', async () => {
    expect(
      buildPkillSelfProtectionScript('/bin/sh', {
        enabled: true,
        platform: 'linux',
      }),
    ).toBeNull();
    await expect(
      getPkillSelfProtectionSourceCommand('/bin/sh', {
        enabled: true,
        platform: 'linux',
      }),
    ).resolves.toBeNull();
  });

  it('keeps the emitted runtime guard between 25 and 60 lines', () => {
    const script = buildPkillSelfProtectionScript('/bin/bash', {
      enabled: true,
      platform: 'linux',
    });
    const lineCount = script?.split('\n').length ?? 0;

    expect(lineCount).toBeGreaterThanOrEqual(25);
    expect(lineCount).toBeLessThanOrEqual(60);
  });

  it('loads the multiline guard from a private file using a single-line command', async () => {
    const sourceCommand = await getPkillSelfProtectionSourceCommand(
      '/bin/bash',
      {
        enabled: true,
        platform: 'linux',
        pgrepPath: fakePgrep,
        procRoot: tempDir,
      },
    );

    expect(sourceCommand).not.toBeNull();
    expect(sourceCommand).not.toContain('\n');
    expect(sourceCommand).not.toContain('pkill() {');

    const guardFiles = (await readdir(tempDir)).filter((name) =>
      name.startsWith('pkill-guard-'),
    );
    expect(guardFiles).toHaveLength(1);
    const guardPath = path.join(tempDir, guardFiles[0]);
    const guardScript = await readFile(guardPath, 'utf8');
    expect(guardScript).toContain('pkill() {');
    expect(guardScript).toContain(`\${${ENV_PID}:-}`);
    expect(guardScript).not.toContain(String(PROTECTED_PID));
    expect((await stat(guardPath)).mode & 0o777).toBe(0o600);
  });

  it('checks expanded argv and refuses an exact CLI pid match', async () => {
    const result = run('pkill -f "$TARGET"', {
      pgrepOutput: `111\n${PROTECTED_PID}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${BRAND_CLI_NAME} process (pid ${PROTECTED_PID})`);
    expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot engine\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a user-defined _cli_pgrep while previewing with its own helper', async () => {
    const result = run('pkill -f "$TARGET"; _cli_pgrep', {
      beforeProtection: '_cli_pgrep() { printf user-helper; }',
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('user-helper');
    expect(result.stderr).toContain(
      `${BRAND_CLI_NAME} process (pid ${PROTECTED_PID})`,
    );
    expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot engine\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('forwards the original argv when the CLI pid is not selected', async () => {
    const result = run('pkill -f "$TARGET"', { pgrepOutput: '111\n222' });

    expect(result.status).toBe(0);
    expect(await readFile(pkillLog, 'utf8')).toBe('-f\ngodot engine\n');
  });

  it('fails open when the best-effort preview cannot run', async () => {
    const result = run('pkill -f godot', { pgrepStatus: 2 });

    expect(result.status).toBe(0);
    expect(await readFile(pkillLog, 'utf8')).toBe('-f\ngodot\n');
  });

  it('fails open when the protected pid is not visible in procfs', async () => {
    await rm(path.join(tempDir, String(PROTECTED_PID), 'comm'));

    const result = run('pkill -f godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(0);
    expect(await readFile(pkillLog, 'utf8')).toBe('-f\ngodot\n');
    await expect(readFile(pgrepLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('drops common pkill-only arguments without parsing all procps syntax', async () => {
    const result = run('pkill --signal TERM -e -P 7 -f godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('-P\n7\n-f\ngodot\n');
  });

  it('drops the equals form of the signal option', async () => {
    const result = run('pkill --signal=TERM -f godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot\n');
  });

  it('drops signal names that overlap selector prefixes', async () => {
    const result = run('pkill -USR2 -f godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['-term', '-TeRm', '-usr1', '-pipe', '-sigterm', '-SiGtErM'])(
    'drops case-insensitive signal name %s',
    async (signal) => {
      const result = run(`pkill ${signal} -f godot`, {
        pgrepOutput: String(PROTECTED_PID),
      });

      expect(result.status).toBe(1);
      expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot\n');
      await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.each(['IFS=,', 'IFS=', "IFS=$'x'"])(
    'pins IFS so a caller polluted with %s cannot break the preview',
    async (pollution) => {
      const result = run('pkill -f "$TARGET"', {
        beforeProtection: pollution,
        pgrepOutput: `111\n${PROTECTED_PID}`,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${BRAND_CLI_NAME} process (pid ${PROTECTED_PID})`,
      );
      expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot engine\n');
      await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  itZsh('pins IFS against caller pollution in zsh', async () => {
    const result = run('pkill -f "$TARGET"', {
      shell: '/bin/zsh',
      beforeProtection: 'IFS=,',
      pgrepOutput: `111\n${PROTECTED_PID}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${BRAND_CLI_NAME} process (pid ${PROTECTED_PID})`);
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('treats arguments after -- as patterns rather than signal names', async () => {
    const result = run('pkill -- -KILL', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('--\n-KILL\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps selector options before -- and patterns after it', async () => {
    const result = run('pkill -f -- -TERM', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('-f\n--\n-TERM\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('still drops real signal names that appear before --', async () => {
    const result = run('pkill -TERM -- godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('--\ngodot\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  itZsh('treats arguments after -- as patterns in zsh', async () => {
    const result = run('pkill -- -KILL', {
      shell: '/bin/zsh',
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('--\n-KILL\n');
    await expect(readFile(pkillLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps selector options that resemble signal names', async () => {
    const result = run('pkill -P7 -U0 -Groot -ix -f godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe(
      '-P7\n-U0\n-Groot\n-ix\n-f\ngodot\n',
    );
  });

  it('removes an existing alias before installing the function', () => {
    const result = run("eval 'pkill -f godot'", {
      beforeProtection:
        "shopt -s expand_aliases\nalias pkill='printf alias-bypass'",
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('alias-bypass');
  });

  it('delays parsing the user command until after sourcing the guard', async () => {
    const sourceCommand = await getPkillSelfProtectionSourceCommand(
      '/bin/bash',
      {
        enabled: true,
        platform: 'linux',
        pgrepPath: fakePgrep,
        procRoot: tempDir,
      },
    );
    expect(sourceCommand).not.toBeNull();
    const command = `${sourceCommand} && \\eval 'pkill -f godot'`;
    const bashEnv = path.join(tempDir, 'bash-env');
    await writeFile(
      bashEnv,
      "shopt -s expand_aliases\nalias pkill='printf alias-bypass'\n",
    );
    const result = spawnSync('/bin/bash', ['-c', command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BASH_ENV: bashEnv,
        PATH: `${tempDir}:/usr/bin:/bin`,
        FAKE_PGREP_LOG: pgrepLog,
        FAKE_PKILL_LOG: pkillLog,
        FAKE_PGREP_OUTPUT: String(PROTECTED_PID),
        [ENV_PID]: String(PROTECTED_PID),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('alias-bypass');
  });

  itZsh('recognizes mixed-case signal names in zsh', async () => {
    const result = run('pkill -SiGtErM -f godot', {
      shell: '/bin/zsh',
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(1);
    expect(await readFile(pgrepLog, 'utf8')).toBe('-f\ngodot\n');
  });

  it('documents explicit command lookup as an escape hatch', async () => {
    const result = run('command pkill -f godot', {
      pgrepOutput: String(PROTECTED_PID),
    });

    expect(result.status).toBe(0);
    expect(await readFile(pkillLog, 'utf8')).toBe('-f\ngodot\n');
    await expect(readFile(pgrepLog, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
