/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';

interface VonInstallArgs {
  check?: boolean;
  port?: number;
  yes?: boolean;
}

/**
 * `qwen von-install` — set up the Von System One decision backend used by
 * `/superfast`.
 *
 * This mirrors the established Qwen Code convention that a feature needing an
 * external backend first installs that backend through a dedicated command.
 * The fork itself never bundles the model: the Decision Gate talks to a local
 * HTTP endpoint, and this command provisions that endpoint's server out of band.
 *
 * Because the install pulls large third-party packages, it shows what will be
 * downloaded and asks for confirmation before starting (skip with `--yes`).
 */
export const vonInstallCommand: CommandModule = {
  command: 'von-install',
  describe:
    'Install the Von System One decision backend for /superfast (Apache-2.0, runs on CPU or GPU)',
  builder: (yargs) =>
    yargs
      .option('check', {
        type: 'boolean',
        default: false,
        describe: 'Only report whether the backend is already installed',
      })
      .option('port', {
        type: 'number',
        describe: 'Port the server will use (informational; default 8000)',
      })
      .option('yes', {
        alias: 'y',
        type: 'boolean',
        default: false,
        describe: 'Skip the confirmation prompt and install immediately',
      })
      .strict(),
  handler: async (argv) => {
    const args = argv as unknown as VonInstallArgs;
    const { spawnSync } = await import('node:child_process');
    const { writeStdoutLine, writeStderrLine } = await import(
      '../utils/stdioHelpers.js'
    );

    // True when the binary is on PATH and answers its version probe cleanly.
    const works = (cmd: string): boolean => {
      try {
        const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
        return !r.error && r.status === 0;
      } catch {
        return false;
      }
    };

    // True when the binary is on PATH even if it failed to answer. A missing
    // binary reports ENOENT; a present-but-broken one does not.
    const present = (cmd: string): boolean => {
      try {
        const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
        return !r.error || (r.error as NodeJS.ErrnoException).code !== 'ENOENT';
      } catch {
        return false;
      }
    };

    if (works('von')) {
      writeStdoutLine('Von is already installed.');
      writeStdoutLine('Start the decision server with:  von serve --port 8000');
      writeStdoutLine('Then enable the gate in Qwen Code with:  /superfast on');
      return;
    }

    if (args.check) {
      writeStdoutLine('Von is not installed.');
      writeStdoutLine(
        'Run `qwen von-install` (without --check) to install it, or install manually:',
      );
      writeStdoutLine('  uv tool install von-sdk   # or:  pip install von-sdk');
      process.exitCode = 1;
      return;
    }

    const uvWorks = works('uv');
    const pipWorks = works('pip');
    if (!uvWorks && !pipWorks) {
      if (present('uv') || present('pip')) {
        writeStderrLine(
          'A Python package manager was found on PATH but did not answer its ' +
            'version probe. Repair it (or install `uv`), then re-run ' +
            '`qwen von-install`.',
        );
      } else {
        writeStderrLine(
          'Neither `uv` nor `pip` was found on PATH. Install a Python 3.12+ ' +
            'package manager, then re-run `qwen von-install`.',
        );
      }
      process.exitCode = 1;
      return;
    }

    const installCmd = uvWorks ? 'uv' : 'pip';
    const installArgs = uvWorks
      ? ['tool', 'install', 'von-sdk']
      : ['install', 'von-sdk'];

    // Disclose the size and the third-party packages before touching the system.
    writeStdoutLine(
      'This installs the Von decision backend (von-sdk) and its Python ' +
        'dependencies:',
    );
    writeStdoutLine(
      '  torch, transformers, accelerate, fastapi, uvicorn, httpx, pydantic, ' +
        'click.',
    );
    writeStdoutLine(
      'The download is large: the torch wheel alone is about 555 MB (more with ' +
        'a CUDA build),',
    );
    writeStdoutLine(
      'and the first `von serve` also downloads model weights from Hugging Face.',
    );

    if (!args.yes) {
      if (!process.stdin.isTTY) {
        writeStderrLine(
          'Not running in a terminal, so the install was not started. Re-run ' +
            'with `--yes` to confirm.',
        );
        process.exitCode = 1;
        return;
      }
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = (await rl.question('Proceed with the install? [y/N] '))
        .trim()
        .toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        writeStdoutLine('Cancelled. Nothing was installed.');
        return;
      }
    }

    writeStdoutLine(
      `Installing the Von backend with: ${installCmd} ${installArgs.join(' ')}`,
    );
    const result = spawnSync(installCmd, installArgs, { stdio: 'inherit' });
    if (result.status !== 0) {
      writeStderrLine(
        'Von installation failed. You can install it manually with ' +
          '`uv tool install von-sdk` or `pip install von-sdk`.',
      );
      process.exitCode = result.status ?? 1;
      return;
    }

    const port = args.port ?? 8000;
    writeStdoutLine('Von installed.');
    writeStdoutLine('Next steps:');
    writeStdoutLine(
      `  1. Start the decision server:  von serve --port ${port}`,
    );
    writeStdoutLine('  2. In Qwen Code:               /superfast on');
    writeStdoutLine(
      '  (The gate fails open, so Qwen Code keeps working even if the ' +
        'server is not running.)',
    );
  },
};
