/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { getErrorMessage, sessionLogger } from '@qwen-code/core';

interface ValidateArgs {
  path: string;
  json?: boolean;
  strict?: boolean;
}

export async function handleValidate(args: ValidateArgs): Promise<number> {
  const {
    formatPluginValidationReport,
    validatePluginReportForCommand,
  } = await import('@qwen-code/core/plugin-management');
  const chalk = (await import('chalk')).default;
  const json = !!args.json;
  try {
    const report = await validatePluginReportForCommand(args.path);
    const strictRejected = !!args.strict && report.summary.warningCount > 0;
    const exitCode = report.valid && !strictRejected ? 0 : 1;

    if (json) {
      process.stdout.write(
        JSON.stringify({ schemaVersion: 1, ok: true, report }) + '\n',
      );
    } else {
      const formatted = formatPluginValidationReport(report);
      const strictMessage = strictRejected
        ? '\nStrict validation failed because warnings were found.'
        : '';
      const output = formatted + strictMessage + '\n';
      if (exitCode === 0) {
        process.stdout.write(output);
      } else {
        process.stderr.write(chalk.red(output));
      }
    }

    if (exitCode !== 0) {
      sessionLogger.setExitContext({
        reason: 'fatal_error',
        exit_code: exitCode,
        message: 'Plugin validate rejected the plugin',
        source: 'plugins.validate',
      });
    }
    return exitCode;
  } catch (error) {
    const message = getErrorMessage(error);
    if (json) {
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: {
            code: 'plugin_validation_failed',
            message,
          },
        }) + '\n',
      );
    } else {
      process.stderr.write(chalk.red(message) + '\n');
    }
    sessionLogger.setExitContext({
      reason: 'fatal_error',
      exit_code: 2,
      message: 'Plugin validator failed',
      source: 'plugins.validate',
      error_name: error instanceof Error ? error.name : undefined,
      error_stack: error instanceof Error ? error.stack : undefined,
    });
    return 2;
  }
}

export function createValidateCommand() {
  return new Command('validate')
    .description('Validates a plugin from a local directory or manifest.')
    .argument('<path>', 'The path to a plugin directory or plugin manifest.')
    .option('--json', 'Output a structured validation report as JSON.', false)
    .option(
      '--strict',
      'Exit with status 1 when validation produces warnings.',
      false,
    )
    .action(async (pluginPath, options) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      const exitCode = await handleValidate({
        path: pluginPath,
        json: options.json,
        strict: options.strict,
      });
      await exitCli(exitCode);
    });
}
