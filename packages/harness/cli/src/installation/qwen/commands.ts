/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Command } from '@commander-js/extra-typings';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { AppTerminalCommandContribution } from '../../app-plugins/types.js';
import { createManualUpdateProgress } from '../manualUpdateProgress.js';
import { getQwenPaths } from './paths.js';

async function execute(
  action: (writeLine: (message: string) => void) => Promise<string | undefined>,
) {
  const { writeToStdout, writeToStderr } = await import('@qwen-code/core');
  const writeLine = (message: string) => writeToStdout(message + '\n');
  let code = 0;
  try {
    const message = await action(writeLine);
    if (message) writeLine(message);
  } catch (error) {
    writeToStderr(
      `Qwen installation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    code = 1;
  }
  const { exitCli } = await import('../../utils/exitCli.js');
  await exitCli(code);
}

/** Only declarations are constructed; local commands never initialize runtime plugins. */
export function qwenInstallationCommands(): readonly AppTerminalCommandContribution[] {
  const instance = async () =>
    (await import('./operations.js')).createQwenInstallation();
  return [
    {
      hidden: true,
      startup: 'local',
      command: new Command('install')
        .description('Install the Qwen native binary')
        .option('--version <version>', 'Install a specific version')
        .option('--force', 'Reinstall an existing version')
        .option('--skip-path', 'Skip shell PATH configuration')
        .option('--quiet', 'Suppress installation status and success output')
        .action(async (options) =>
          execute(async () => {
            const result = await (await instance()).install(options);
            if (options.quiet) return;

            const { resolveExecutable } = await import('@qwen-code/core');
            const executable = await resolveExecutable('qwen');
            const { linkPath } = getQwenPaths();
            const [resolved, installed] = await Promise.all([
              executable
                ? realpath(executable).catch(() => undefined)
                : undefined,
              realpath(linkPath).catch(() => undefined),
            ]);
            const lines = ['', `Qwen Code ${result.version} installed.`];
            if (result.pathResult?.modified) {
              const file = result.pathResult.configFile;
              const home = homedir();
              const displayFile = file?.startsWith(home + sep)
                ? '~' + file.slice(home.length)
                : file;
              lines.push(
                displayFile
                  ? `Added Qwen to PATH in ${displayFile}.`
                  : 'Added Qwen to your user PATH.',
              );
            }

            const onPath = installed && resolved === installed;
            const restart =
              !executable &&
              (result.pathResult?.modified ||
                result.pathResult?.skipReason === 'rc_file_configured');
            if (restart) lines.push('Open a new terminal, then run:');
            if (onPath || restart) {
              lines.push(
                '',
                '  qwen          # Start Qwen Code',
                '  qwen --help   # Show options',
              );
              return lines.join('\n');
            }

            const command =
              process.platform === 'win32'
                ? `& '${linkPath.replace(/'/g, "''")}'`
                : `'${linkPath.replace(/'/g, `'"'"'`)}'`;
            lines.push(
              '',
              process.platform === 'win32'
                ? 'Run the installed copy in PowerShell:'
                : 'Run the installed copy directly:',
              `  ${command}`,
            );
            return lines.join('\n');
          }),
        ),
    },
    {
      startup: 'local',
      command: new Command('update')
        .description('Update Qwen Code')
        .option('--check', 'Check without installing')
        .action(async (options) =>
          execute(async (writeLine) => {
            const progress = createManualUpdateProgress(writeLine);
            progress.checking();
            const installation = await instance();
            if (options.check) {
              const info = await installation.check();
              return info.available
                ? `Qwen Code update available: ${info.current} → ${info.latest}`
                : `Qwen Code is up to date (${info.current}).`;
            }
            const result = await installation.update(progress);
            return result.changed
              ? `Updated Qwen Code to ${result.version}. The next run uses this version.`
              : `Qwen Code is up to date (${result.version}).`;
          }),
        ),
    },
    {
      startup: 'local',
      command: new Command('rollback')
        .description('Roll back Qwen Code to an earlier release')
        .option(
          '--to <version>',
          'Target version. Defaults to the previous local version.',
        )
        .action(async (options) =>
          execute(async () => {
            const result = await (await instance()).rollback(options.to);
            return `Rolled back Qwen Code to ${result.version}. Automatic updates are paused for 24 hours.`;
          }),
        ),
    },
    {
      hidden: true,
      startup: 'local',
      command: new Command('configure-path')
        .description('Configure the Qwen executable directory in PATH')
        .action(async () =>
          execute(async () => {
            const result = await (await instance()).configurePath();
            return result.modified
              ? result.method === 'registry'
                ? 'Configured Qwen in the user PATH. Restart your shell.'
                : `Configured PATH in ${result.configFile}. Restart your shell.`
              : 'Qwen PATH is already configured.';
          }),
        ),
    },
  ];
}
