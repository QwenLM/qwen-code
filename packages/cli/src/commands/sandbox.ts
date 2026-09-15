/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import type { CommandModule } from 'yargs';
import { DEFAULT_COMMAND_OPTIONS } from '../config/top-level-options.js';
import { resolvePath } from '../utils/resolvePath.js';

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
  check: (result: {
    status: number | null;
    output: string;
    stdout: string;
  }) => boolean;
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
  '--'?: string[];
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
      // 'parse-positional-numbers' stays off so yargs-parser does not coerce
      // numeric-looking tokens after `--` (`echo 1e5 0x10` would otherwise
      // reach the confined command as `100000 16`). Both keys go in ONE call:
      // yargs 17's parserConfiguration replaces the config object outright.
      .parserConfiguration({
        'populate--': true,
        'parse-positional-numbers': false,
      })
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
      buildBwrapEnv,
      runBwrap,
      resolveBwrapWritableRoots,
      resolveSandboxNetworkMode,
    } = sandboxModule;
    type BwrapWritableRoots = ReturnType<typeof resolveBwrapWritableRoots>;

    const args = argv as unknown as SandboxArgs;
    // A command may arrive as positionals or after `--`; the latter is required
    // when it has flags of its own. Positionals come first so a mixed
    // `sandbox sh -- -c 'x'` keeps its argv order.
    const requestedCmd = [...(args.cmd ?? []), ...(args['--'] ?? [])];
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
      // Selection must match the hop, which passes `settings.merged` even in
      // safe mode (llm.tsx). Clearing settings here would report "no backend"
      // for a session that really does get confined. Bare mode stays cleared
      // because the hop skips settings there too. `effectiveSettings` still
      // feeds the roots below, matching the Config record's safe-mode rule.
      sandboxConfig = await loadSandboxConfig(settings, args);
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

    // Settings-level extra workspace directories are bound by the hop too, so
    // they belong in the report — expanded the way the session expands them.
    // A `--include-directories` flag passed to the main command is not
    // reachable from this subcommand's argv, so the roots below are the
    // settings-derived set, not necessarily every root a differently-invoked
    // session would get.
    let networkMode: ReturnType<typeof resolveSandboxNetworkMode>;
    let rootsResult: BwrapWritableRoots;
    try {
      networkMode = resolveSandboxNetworkMode();
      rootsResult = resolveBwrapWritableRoots(
        (effectiveSettings.context?.includeDirectories ?? []).map(resolvePath),
      );
    } catch (error) {
      // Same failure shape as the probe rejection above: the refusal (e.g. a
      // workspace that is the home directory, or a mistyped QWEN_SANDBOX_NET)
      // is exactly what someone runs this subcommand to understand, so it must
      // not escape as a raw stack.
      writeStderrLine(
        `Sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }
    const { targetDir, roots, readOnlyOverrides } = rootsResult;

    writeReportLine('Enforcement: full');
    writeReportLine(
      'Boundary: filesystem mounts; host Unix sockets remain reachable',
    );
    writeReportLine(
      'Git metadata: granted repository config and hooks remain writable and can affect later unconfined Git commands.',
    );
    writeReportLine(`Network: ${networkMode}`);
    if (networkMode === 'proxied') {
      writeReportLine(
        'Proxy settings are advisory; direct connections remain possible.',
      );
    }
    writeReportLine(`Target dir: ${targetDir}`);
    writeReportLine(
      'Writable roots (settings-derived; a session started with --include-directories also binds those):',
    );
    for (const root of roots) {
      writeReportLine(`  ${root}`);
    }
    if (readOnlyOverrides.length > 0) {
      writeReportLine('Read-only inside a writable root:');
      for (const override of readOnlyOverrides) {
        writeReportLine(`  ${override}`);
      }
    }

    const runConfined = (
      cmdArgv: string[],
    ): { status: number | null; output: string; stdout: string } => {
      const result = spawnSync(
        'bwrap',
        [
          '--new-session',
          ...buildBwrapArgs({
            writableRoots: roots,
            targetDir,
            networkMode,
            cliArgs: cmdArgv,
            readOnlyOverrides,
          }),
        ],
        // The battery matches on message text rendered by the confined
        // libc, and glibc localizes strerror() through its own catalogs —
        // under a non-English LC_ALL/LANG the EROFS message comes back
        // localized and a holding confinement would report FAIL. The C
        // locale pins the dialect for every message-based case at once.
        // Only the probes get this; requested commands keep the user's locale.
        {
          encoding: 'utf8',
          env: { ...buildBwrapEnv(networkMode), LC_ALL: 'C' },
        },
      );
      const stdout = result.stdout ?? '';
      return {
        status: result.status,
        stdout,
        output: `${stdout}${result.stderr ?? ''}`,
      };
    };

    if (requestedCmd.length) {
      try {
        process.exitCode = await runBwrap({
          writableRoots: roots,
          targetDir,
          networkMode,
          cliArgs: requestedCmd,
          readOnlyOverrides,
        });
      } catch (error) {
        writeStderrLine(
          `Sandbox command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
      return;
    }

    if (!args.verify) {
      return;
    }

    let hostPidNamespace: string;
    try {
      hostPidNamespace = fs.readlinkSync('/proc/self/ns/pid');
    } catch (error) {
      writeStderrLine(
        `Cannot verify sandbox PID namespace: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
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
        name: 'payload shares the host PID namespace',
        argv: ['readlink', '/proc/self/ns/pid'],
        expectation:
          'no PID namespace, so cross-process ownership records stay meaningful',
        check: ({ status, stdout }) =>
          status === 0 && stdout.trim() === hostPidNamespace,
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
        check: ({ status, stdout }) => {
          if (status !== 0) {
            return false;
          }
          const names = stdout.trim().split(/\s+/).filter(Boolean);
          // Every network namespace has `lo`; without it the probe listed
          // nothing (e.g. `tail` missing in a minimal image) and neither
          // direction of the property was actually measured.
          if (!names.includes('lo')) {
            return false;
          }
          const nonLoopback = names.filter((name) => name !== 'lo');
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
