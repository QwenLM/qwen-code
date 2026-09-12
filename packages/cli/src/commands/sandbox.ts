/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { DEFAULT_COMMAND_OPTIONS } from '../config/top-level-options.js';

/**
 * One assertion in the `--verify` battery: a command to run confined, and a
 * predicate over its result. Kept declarative so a case cannot silently pass by
 * forgetting to assert — {@link runVerifyBattery} counts every case.
 */
interface VerifyCase {
  name: string;
  /** Argv handed to the backend, after the writable roots are applied. */
  argv: string[];
  /** Why this case exists, printed on failure so the report is self-contained. */
  expectation: string;
  check: (result: { status: number | null; output: string }) => boolean;
}

interface SandboxArgs {
  cmd?: string[];
  verify?: boolean;
  sandbox?: boolean;
  sandboxImage?: string;
  bare?: boolean;
  safeMode?: boolean;
  /** Everything after `--`, which is how a command with its own flags has to be
   * passed so yargs does not try to parse `-c` and friends as ours. */
  '--'?: Array<string | number>;
}

/**
 * `qwen sandbox` — report and prove the resolved sandbox backend.
 *
 * This ships with the backend rather than after it because every compatibility
 * consequence of confinement (a git dir outside the workspace, a masked device,
 * a cut loopback) is invisible until something fails mid-task. Without a way to
 * ask "what is confined, and does it actually hold?", the first sign of trouble
 * is an opaque EROFS in the middle of someone's work.
 */
export const sandboxCommand: CommandModule = {
  command: 'sandbox [cmd...]',
  describe: 'Inspect the sandbox backend, or run a command inside it',
  builder: (yargs) =>
    yargs
      // Keep `--` contents instead of discarding them: `qwen sandbox -- sh -c
      // '...'` is the only spelling that survives a command carrying its own
      // flags, and without this they never reach the handler.
      .parserConfiguration({ 'populate--': true })
      .positional('cmd', {
        describe: 'Command to run inside the sandbox',
        type: 'string',
        array: true,
      })
      .option('verify', {
        type: 'boolean',
        default: false,
        describe: 'Run the confinement behavior battery and report pass/fail',
      })
      .option('sandbox', DEFAULT_COMMAND_OPTIONS.sandbox)
      .option('sandbox-image', DEFAULT_COMMAND_OPTIONS['sandbox-image'])
      .example('$0 sandbox', 'Report the resolved backend and writable roots')
      .example('$0 sandbox --verify', 'Prove the confinement actually holds')
      .example("$0 sandbox -- sh -c 'ls /'", 'Run one command confined')
      .strict(),
  handler: async (argv) => {
    const [
      { loadSettings },
      { loadSandboxConfig },
      sandboxModule,
      { writeStdoutLine, writeStderrLine },
      { spawnSync },
      { isBareMode },
      { isSafeModeEnv },
    ] = await Promise.all([
      import('../config/settings.js'),
      import('../config/sandboxConfig.js'),
      import('../serve/sandbox.js'),
      import('../utils/stdioHelpers.js'),
      import('node:child_process'),
      import('@qwen-code/qwen-code-core/utils/bareMode.js'),
      import('@qwen-code/qwen-code-core/utils/safe-mode.js'),
    ]);

    const {
      buildBwrapArgs,
      resolveBwrapWritableRoots,
      resolveSandboxNetworkMode,
    } = sandboxModule;

    const args = argv as unknown as SandboxArgs;
    // A command may arrive as positionals or after `--`; the latter is required
    // when it has flags of its own. Positionals come first so a mixed
    // `sandbox sh -- -c 'x'` keeps its argv order.
    const requestedCmd = [
      ...(args.cmd ?? []),
      ...(args['--']?.map(String) ?? []),
    ];
    const writeReportLine = requestedCmd.length
      ? writeStderrLine
      : writeStdoutLine;
    const cwd = process.cwd();
    const bare = isBareMode(args.bare);
    const settings = bare ? {} : loadSettings(cwd, false).merged;
    const effectiveSettings =
      bare || (args.safeMode ?? isSafeModeEnv()) ? {} : settings;

    // `SANDBOX` is set inside a confinement, and `loadSandboxConfig` answers
    // "already sandboxed" by returning no command for it. Reporting from in
    // there would describe nothing, so say what is actually true instead.
    if (process.env['SANDBOX']) {
      writeReportLine(`Already inside a sandbox: ${process.env['SANDBOX']}`);
      const enforcement = process.env['SANDBOX_ENFORCEMENT'];
      if (enforcement) {
        writeReportLine(`Enforcement: ${enforcement}`);
      }
      writeReportLine(
        'Run this from outside the sandbox to inspect a backend.',
      );
      if (args.verify || requestedCmd.length) {
        writeStderrLine('No verification or command was run.');
        process.exitCode = 1;
      }
      return;
    }

    let sandboxConfig;
    try {
      sandboxConfig = await loadSandboxConfig(effectiveSettings, args);
    } catch (error) {
      // A probe failure for an explicitly requested backend is fatal by design
      // (never silently unconfined). Surfacing it here is the whole point of
      // the subcommand, so report and exit non-zero rather than rethrowing.
      writeStderrLine(
        `Sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }

    if (!sandboxConfig) {
      writeReportLine('Backend: none (running unconfined)');
      writeReportLine(
        'Enable one with --sandbox, QWEN_SANDBOX=<command>, or tools.sandbox.',
      );
      if (args.verify || requestedCmd.length) {
        writeStderrLine(
          'No verification or command was run: no sandbox is configured.',
        );
        process.exitCode = 1;
      }
      return;
    }

    writeReportLine(`Backend: ${sandboxConfig.command}`);
    if (sandboxConfig.image) {
      writeReportLine(`Image: ${sandboxConfig.image}`);
    }

    if (sandboxConfig.command !== 'bwrap') {
      // The roots and the battery below are bwrap-specific. Other backends
      // still report what they are rather than pretending to be inspectable.
      writeReportLine(
        `Inspection of writable roots is implemented for bwrap; '${sandboxConfig.command}' reports its backend only.`,
      );
      if (args.verify || requestedCmd.length) {
        writeStderrLine(
          `--verify and running a command are only supported for bwrap, not '${sandboxConfig.command}'.`,
        );
        process.exitCode = 1;
      }
      return;
    }

    const networkMode = resolveSandboxNetworkMode();
    // Settings-level extra workspace directories are bound by the hop too, so
    // they belong in the report. A `--include-directories` flag passed to the
    // main command is not reachable from this subcommand's argv, so the roots
    // below are the settings-derived set, not necessarily every root a
    // differently-invoked session would get.
    const { targetDir, roots } = resolveBwrapWritableRoots(
      effectiveSettings.context?.includeDirectories ?? [],
    );

    writeReportLine('Enforcement: full');
    writeReportLine(
      'Boundary: filesystem mounts; host Unix sockets remain reachable',
    );
    writeReportLine(`Network: ${networkMode}`);
    if (networkMode === 'proxied') {
      writeReportLine(
        'Proxy settings are advisory; direct connections remain possible.',
      );
    }
    writeReportLine(`Target dir: ${targetDir}`);
    writeReportLine('Writable roots:');
    for (const root of roots) {
      writeReportLine(`  ${root}`);
    }

    const runConfined = (
      cmdArgv: string[],
    ): { status: number | null; output: string } => {
      const result = spawnSync(
        'bwrap',
        buildBwrapArgs({
          writableRoots: roots,
          targetDir,
          networkMode,
          cliArgs: cmdArgv,
        }),
        { encoding: 'utf8' },
      );
      return {
        status: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      };
    };

    if (requestedCmd.length) {
      const result = spawnSync(
        'bwrap',
        buildBwrapArgs({
          writableRoots: roots,
          targetDir,
          networkMode,
          cliArgs: requestedCmd,
        }),
        { stdio: 'inherit' },
      );
      if (result.error) {
        writeStderrLine(`Sandbox command failed: ${result.error.message}`);
      }
      process.exitCode = result.status ?? 1;
      return;
    }

    if (!args.verify) {
      return;
    }

    writeStdoutLine('');
    // EROFS only, deliberately not `Permission denied` as well. Writing to a
    // root-owned directory as an ordinary user yields EACCES with or without
    // bwrap in front of it, so accepting that string would let the one check
    // whose entire job is to answer "does the confinement hold?" report success
    // when nothing is confining anything. EROFS is the only one of the two that
    // proves a read-only mount. This is also what the design's own rule
    // requires: a denial signature belongs to one backend's dialect, and a
    // cross-backend union is never a valid match — Landlock denies with EACCES,
    // so when that backend lands it needs its own signature rather than a
    // widened shared one.
    const denied = /Read-only file system/;
    const cases: VerifyCase[] = [
      {
        name: 'write inside the workspace succeeds',
        // `mktemp`, not a fixed name: `touch X && rm X` on a workspace that
        // already contains an `X` succeeds at the touch and then deletes the
        // user's file. mktemp only ever creates a new one, and still fails
        // when the directory is not writable, which is what this asserts.
        argv: [
          'sh',
          '-c',
          'f=$(mktemp ./.qwen-sandbox-probe.XXXXXX) && rm -f "$f"',
        ],
        expectation: 'the workspace must stay writable, or no work is possible',
        check: ({ status }) => status === 0,
      },
      {
        name: 'write outside the roots is denied',
        argv: ['sh', '-c', 'touch /usr/local/bin/qwen-sandbox-probe 2>&1'],
        expectation:
          'a read-only host root is the confinement; without this there is none',
        check: ({ output }) => denied.test(output),
      },
      {
        name: 'host processes stay visible',
        // `[0-9]\+`, since basic-regex `[0-9]*` also matches an empty line.
        argv: ['sh', '-c', 'ls /proc | grep -c "^[0-9]\\+$"'],
        expectation:
          'no PID namespace, so cross-process ownership records stay meaningful',
        check: ({ output }) => Number(output.trim()) > 20,
      },
      {
        name:
          networkMode === 'closed'
            ? 'network namespace is private in closed mode'
            : `host network is shared in ${networkMode} mode`,
        // Reading `/proc/net/dev`, and neither of the two more obvious probes,
        // both of which were measured to assert nothing here:
        //   - `getent hosts localhost` answers from /etc/hosts without touching
        //     the network stack, so it succeeds even under --unshare-net;
        //   - `/sys/class/net` still lists the host interfaces, because
        //     `--ro-bind / /` carries the host sysfs in and a bind mount does
        //     not re-associate it with the new namespace.
        // `/proc/net` is a per-process symlink to `self/net`, so it does follow
        // the caller's network namespace. Needs no iproute2 and no connectivity.
        argv: ['sh', '-c', 'tail -n +3 /proc/net/dev | cut -d: -f1'],
        expectation:
          networkMode === 'closed'
            ? 'closed mode unshares the network namespace, leaving only loopback'
            : 'open and proxied modes keep the host interfaces visible',
        check: ({ output }) => {
          const nonLoopback = output
            .trim()
            .split(/\s+/)
            .filter((name) => name && name !== 'lo');
          return networkMode === 'closed'
            ? nonLoopback.length === 0
            : nonLoopback.length > 0;
        },
      },
    ];

    let failures = 0;
    for (const testCase of cases) {
      const result = runConfined(testCase.argv);
      if (testCase.check(result)) {
        writeStdoutLine(`  PASS  ${testCase.name}`);
      } else {
        failures += 1;
        writeStdoutLine(`  FAIL  ${testCase.name}`);
        writeStdoutLine(`        expected: ${testCase.expectation}`);
        const detail = result.output.trim();
        writeStdoutLine(
          `        got: exit ${result.status}${detail ? ` — ${detail}` : ''}`,
        );
      }
    }

    writeStdoutLine('');
    writeStdoutLine(
      failures === 0
        ? `Confinement verified (${cases.length} checks).`
        : `${failures} of ${cases.length} checks failed.`,
    );
    if (failures > 0) {
      process.exitCode = 1;
    }
  },
};
