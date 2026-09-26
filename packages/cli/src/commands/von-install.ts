/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';

interface VonInstallArgs {
  check?: boolean;
  port?: number;
}

/**
 * `qwen von-install` — set up the Von System One decision backend used by
 * `/superfast`.
 *
 * This mirrors the established Qwen Code convention that a feature needing an
 * external backend first installs that backend through a dedicated command
 * (like `qwen sandbox` inspects/proves its backend). The fork itself never
 * bundles the model: the Decision Gate talks to a local HTTP endpoint, and
 * this command provisions that endpoint's server out-of-band.
 *
 * Von is chosen because it is Apache-2.0, small (~1.5 GB), and runs on CPU,
 * CUDA, ROCm, Apple Metal, or Intel iGPU — so the option is accessible on
 * essentially any machine, including laptops with no discrete GPU.
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
      .strict(),
  handler: async (argv) => {
    const args = argv as unknown as VonInstallArgs;
    const { spawnSync } = await import('node:child_process');
    const { writeStdoutLine, writeStderrLine } = await import(
      '../utils/stdioHelpers.js'
    );

    // Detect a Python package manager. `uv` is preferred (fast, isolated);
    // `pip` is the universal fallback. We never assume a specific interpreter
    // path — we probe what is on PATH so this works on any machine and OS.
    const has = (cmd: string, versionArgs: string[]): boolean => {
      try {
        const r = spawnSync(cmd, versionArgs, { stdio: 'ignore' });
        return !r.error && r.status === 0;
      } catch {
        return false;
      }
    };

    const alreadyInstalled = has('von', ['--version']);
    if (alreadyInstalled) {
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

    const useUv = has('uv', ['--version']);
    const installCmd = useUv ? 'uv' : 'pip';
    const installArgs = useUv
      ? ['tool', 'install', 'von-sdk']
      : ['install', 'von-sdk'];

    if (!useUv && !has('pip', ['--version'])) {
      writeStderrLine(
        'Neither `uv` nor `pip` was found on PATH. Install a Python 3.12+ ' +
          'package manager, then re-run `qwen von-install`.',
      );
      process.exitCode = 1;
      return;
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
