/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { CommandModule } from 'yargs';
import { DEFAULT_COMMAND_OPTIONS } from '../config/top-level-options.js';

interface SandboxArgs {
  cmd?: string[];
  verify?: boolean;
  sandbox?: boolean;
  sandboxImage?: string;
  bare?: boolean;
  '--'?: string[];
}

export const sandboxCommand: CommandModule = {
  command: 'sandbox [cmd...]',
  describe: 'Inspect tool confinement, verify it, or run one confined command',
  builder: (yargs) =>
    yargs
      .parserConfiguration({
        'populate--': true,
        'parse-positional-numbers': false,
      })
      .positional('cmd', { type: 'string', array: true })
      .option('verify', { type: 'boolean', default: false })
      .option('sandbox', DEFAULT_COMMAND_OPTIONS.sandbox)
      .option('sandbox-image', DEFAULT_COMMAND_OPTIONS['sandbox-image'])
      .example('$0 sandbox', 'Report the effective execution policy')
      .example('$0 sandbox --verify', 'Verify the kernel boundary')
      .example("$0 sandbox -- sh -c 'ls /'", 'Run one command confined')
      .strict(),
  handler: async (argv) => {
    const { writeStdoutLine, writeStderrLine } = await import(
      '../utils/stdioHelpers.js'
    );
    const args = argv as unknown as SandboxArgs;
    const command = [...(args.cmd ?? []), ...(args['--'] ?? [])];
    const report = command.length ? writeStderrLine : writeStdoutLine;
    const controller = new AbortController();
    let cancellationExitCode = 130;
    const interrupt = () => controller.abort();
    const terminate = () => {
      cancellationExitCode = 143;
      controller.abort();
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    try {
      const { loadSettings, createMinimalSettings } = await import(
        '../config/settings.js'
      );
      const { isBareMode } = await import(
        '@qwen-code/qwen-code-core/utils/bareMode.js'
      );
      const { validateExecutionSandboxSelection } = await import(
        '../config/execution-sandbox-settings.js'
      );
      const settings = (
        isBareMode(args.bare) ? createMinimalSettings() : loadSettings()
      ).merged;
      const selected = validateExecutionSandboxSelection(settings, args);
      if (!selected) {
        const { loadSandboxConfig } = await import(
          '../config/sandboxConfig.js'
        );
        const legacy = await loadSandboxConfig(settings, args);
        report(
          `Tool execution sandbox: none${legacy ? ` (whole-CLI backend: ${legacy.command})` : ''}`,
        );
        report('Configure tools.executionSandbox in User or System settings.');
        if (command.length || args.verify)
          throw new Error(
            'No confined command was run: tools.executionSandbox is not configured.',
          );
        return;
      }
      const { Storage } = await import(
        '@qwen-code/qwen-code-core/config/storage.js'
      );
      const { createExecutionSandboxPolicy } = await import(
        '../config/execution-sandbox-config.js'
      );
      const { admitShellSandbox, probeShellSandbox } = await import(
        '@qwen-code/qwen-code-core/sandbox/runtime-shell-policy.js'
      );
      const { executeBwrap } = await import(
        '@qwen-code/qwen-code-core/sandbox/bwrap-execution.js'
      );
      const { sanitizeChildEnv } = await import(
        '@qwen-code/qwen-code-core/utils/sanitize-child-env.js'
      );
      Storage.setRuntimeBaseDir(
        settings.advanced?.runtimeOutputDir,
        process.cwd(),
      );
      const candidate = createExecutionSandboxPolicy(selected, process.cwd());
      const policy = admitShellSandbox(
        {
          model: '',
          debugMode: false,
          cwd: process.cwd(),
          targetDir: process.cwd(),
          shellExecutionSandbox: candidate,
        },
        Storage.getRuntimeBaseDir(),
        Storage.getGlobalQwenDir(),
      )!;
      report(`Boundary: tools; backend: ${policy.requestedBackend} → bwrap`);
      report(
        `Filesystem: ${policy.filesystem}; workspace: ${policy.workspace}`,
      );
      report(`Command network: ${policy.network}`);
      report('Model, authentication and session traffic stay on the host.');
      report('Host reads and pathname Unix sockets remain accessible.');
      await probeShellSandbox(policy, controller.signal);
      report('Backend probe: passed');
      const env = Object.fromEntries(
        Object.entries(sanitizeChildEnv(process.env)).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      if (command.length) {
        const pendingDrains = new Map<'stdout' | 'stderr', Promise<void>>();
        let outputError: NodeJS.ErrnoException | undefined;
        const handleOutputError = (error: NodeJS.ErrnoException) => {
          if (outputError || controller.signal.aborted) return;
          outputError = error;
          cancellationExitCode = error.code === 'EPIPE' ? 141 : 1;
          controller.abort();
        };
        process.stdout.on('error', handleOutputError);
        process.stderr.on('error', handleOutputError);
        try {
          // env resolves PATH inside confinement and receives literal argv.
          const handle = await executeBwrap(
            policy,
            {
              executable: '/usr/bin/env',
              args: ['--', ...command],
              cwd: policy.workspace,
              env,
              inheritStdin: !process.stdin.isTTY,
            },
            (event) => {
              if (event.type === 'raw_data') {
                const streamKey = event.stream;
                const stream =
                  streamKey === 'stderr' ? process.stderr : process.stdout;
                if (
                  !stream.write(event.chunk) &&
                  !pendingDrains.has(streamKey)
                ) {
                  const drained = once(stream, 'drain').then(
                    () => undefined,
                    (error: unknown) => {
                      if (
                        error instanceof Error &&
                        (error as NodeJS.ErrnoException).code === 'EPIPE'
                      )
                        return;
                      throw error;
                    },
                  );
                  pendingDrains.set(streamKey, drained);
                  const clearDrain = () => {
                    if (pendingDrains.get(streamKey) === drained)
                      pendingDrains.delete(streamKey);
                  };
                  void drained.then(clearDrain, clearDrain);
                }
              }
            },
            controller.signal,
            false,
            {},
            { streamStdout: true, streamRawOutput: true },
          );
          const result = await handle.result;
          await Promise.all([...pendingDrains.values()]);
          if (outputError && outputError.code !== 'EPIPE') throw outputError;
          if (result.error && !result.aborted) throw result.error;
          process.exitCode = result.aborted
            ? cancellationExitCode
            : (result.exitCode ?? 1);
          return;
        } finally {
          process.stdout.removeListener('error', handleOutputError);
          process.stderr.removeListener('error', handleOutputError);
        }
      }
      if (!args.verify) return;
      const fixture = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qwen-sandbox-verify-'),
      );
      const outside = path.join(fixture, 'host-writable');
      const inside = path.join(
        policy.workspace,
        `.qwen-sandbox-probe-${randomUUID()}`,
      );
      fs.writeFileSync(outside, 'unchanged', { flag: 'wx' });
      try {
        const hostPid = fs.readlinkSync('/proc/self/ns/pid');
        const hostNet = fs.readlinkSync('/proc/self/ns/net');
        const program = `
          const fs = require('node:fs');
          const write = (p, flag) => { try { fs.writeFileSync(p, 'probe', {flag}); return 'allowed'; } catch(e) { return e.code; } };
          const inside = write(process.argv[1], 'wx');
          if (inside === 'allowed') fs.unlinkSync(process.argv[1]);
          console.log(JSON.stringify({inside, outside:write(process.argv[2], 'w'), pid:fs.readlinkSync('/proc/self/ns/pid'), net:fs.readlinkSync('/proc/self/ns/net')}));
        `;
        const handle = await executeBwrap(
          policy,
          {
            executable: fs.realpathSync(process.execPath),
            args: ['-e', program, inside, outside],
            cwd: policy.workspace,
            env: { PATH: '/usr/bin:/bin' },
          },
          () => {},
          AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        );
        const result = await handle.result;
        if (result.error || result.exitCode !== 0)
          throw (
            result.error ??
            new Error(result.output || 'Verification payload failed.')
          );
        const observed = JSON.parse(result.output) as Record<string, unknown>;
        const checks = [
          [
            'workspace policy',
            observed['inside'] ===
              (policy.filesystem === 'workspace-write' ? 'allowed' : 'EROFS'),
          ],
          [
            'host-writable outside file denied',
            observed['outside'] === 'EROFS' &&
              fs.readFileSync(outside, 'utf8') === 'unchanged',
          ],
          [
            'private PID namespace',
            typeof observed['pid'] === 'string' && observed['pid'] !== hostPid,
          ],
          [
            'command network namespace',
            typeof observed['net'] === 'string' &&
              (policy.network === 'closed'
                ? observed['net'] !== hostNet
                : observed['net'] === hostNet),
          ],
        ] as const;
        for (const [name, passed] of checks)
          report(`${passed ? 'PASS' : 'FAIL'} ${name}`);
        if (checks.some(([, passed]) => !passed))
          throw new Error('Confinement verification failed.');
        report(`Confinement verified (${checks.length} checks).`);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    } catch (error) {
      writeStderrLine(
        `Sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = controller.signal.aborted ? cancellationExitCode : 1;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    }
  },
};
