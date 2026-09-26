/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DESKTOP_RELAY_CUA_SDK_VERSION,
  DESKTOP_RELAY_LABEL,
  DESKTOP_RELAY_PORT,
  defaultRelayHome,
  launchAgentPlistPath,
} from './constants.js';
import {
  buildLaunchAgentPlist,
  installLaunchAgent,
  runLaunchctl,
  uninstallLaunchAgent,
} from './launchd.js';
import { createRecordStore, packageVersion, runAgent } from './runtime.js';

const USAGE = `Usage: node-repl-mcp desktop-relay <command>

Lets a remote Qwen Code session use this computer through node_repl.

Commands:
  install [--home <dir>] [--package <spec>] [--cua-sdk-version <version>]
      Install the runtime and register the loopback socket with launchd (macOS).
      --package installs node-repl-mcp from another npm spec, e.g. a packed tarball.
  uninstall [--home <dir>] [--purge]
      Unregister the socket; --purge also deletes the runtime.
  status [--home <dir>]
      Show whether the relay is registered and what it last connected to.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function homeFrom(args: string[]): string {
  return path.resolve(flag(args, '--home') ?? defaultRelayHome());
}

export function currentUid(): number {
  // Under `sudo` the effective uid is 0, but launchd holds the agent in the
  // invoking user's `gui/<uid>` domain. Querying `gui/0` finds nothing, so the
  // unload guard in `uninstallLaunchAgent` could not tell a live agent from an
  // absent one and would delete the plist out from under it.
  const sudoUid = Number(process.env['SUDO_UID'] ?? '');
  if (Number.isInteger(sudoUid) && sudoUid > 0) return sudoUid;
  return process.getuid?.() ?? os.userInfo().uid;
}

export function isRelayHome(home: string): boolean {
  if (home === path.parse(home).root || home === os.homedir()) return false;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(home, 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return manifest.name === 'qwen-desktop-relay-runtime';
  } catch {
    return false;
  }
}

export function purgeRelayHome(home: string): boolean {
  if (!isRelayHome(home)) return false;
  fs.rmSync(home, { recursive: true, force: true });
  return true;
}

function npmInvocation(): { command: string; args: string[] } {
  const npmCli = process.env['npm_execpath'];
  // Under npx this is npm's own CLI script; run it with the same Node.
  if (npmCli && path.basename(npmCli) === 'npm-cli.js') {
    return { command: process.execPath, args: [npmCli] };
  }
  return { command: 'npm', args: [] };
}

function install(args: string[]): number {
  if (process.platform !== 'darwin') {
    process.stderr.write(
      'desktop-relay install supports macOS only for now: it registers a launchd socket.\n',
    );
    return 1;
  }
  const home = homeFrom(args);
  const sdkVersion =
    flag(args, '--cua-sdk-version') ?? DESKTOP_RELAY_CUA_SDK_VERSION;
  // By default the published copy of this very version; an unreleased build
  // passes its packed tarball instead.
  const packageSpec =
    flag(args, '--package') ?? `@qwen-code/node-repl-mcp@${packageVersion()}`;
  if (fs.existsSync(home) && !isRelayHome(home)) {
    process.stderr.write(
      `Refusing to install into ${home}: the directory already exists and is not a desktop relay runtime directory.\n`,
    );
    return 1;
  }
  fs.mkdirSync(home, { recursive: true });
  const manifest = path.join(home, 'package.json');
  // A manifest of its own keeps `npm install --prefix` from walking up into
  // whatever project happens to contain the home directory.
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(
      manifest,
      `${JSON.stringify(
        { name: 'qwen-desktop-relay-runtime', private: true, type: 'module' },
        null,
        2,
      )}\n`,
    );
  }
  process.stdout.write(
    `Installing ${packageSpec} and @qwen-code/cua-sdk@${sdkVersion} into ${home}\n`,
  );
  const npm = npmInvocation();
  const result = spawnSync(
    npm.command,
    [
      ...npm.args,
      'install',
      '--prefix',
      home,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      packageSpec,
      `@qwen-code/cua-sdk@${sdkVersion}`,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.stderr.write(
      `npm install failed${result.error ? `: ${result.error.message}` : ''}\n`,
    );
    return 1;
  }
  const entry = path.join(
    home,
    'node_modules',
    '@qwen-code',
    'node-repl-mcp',
    'dist',
    'index.js',
  );
  if (!fs.existsSync(entry)) {
    process.stderr.write(`${entry} is missing after npm install\n`);
    return 1;
  }
  installLaunchAgent({
    plistPath: launchAgentPlistPath(),
    label: DESKTOP_RELAY_LABEL,
    uid: currentUid(),
    run: runLaunchctl,
    plist: buildLaunchAgentPlist({
      label: DESKTOP_RELAY_LABEL,
      // An absolute Node path: launchd starts jobs with a minimal PATH.
      programArguments: [
        process.execPath,
        entry,
        'desktop-relay',
        'agent',
        '--home',
        home,
      ],
      port: DESKTOP_RELAY_PORT,
      logPath: path.join(home, 'agent.log'),
    }),
  });
  process.stdout.write(
    [
      '',
      `The desktop relay is registered on 127.0.0.1:${DESKTOP_RELAY_PORT}. Nothing runs until something connects.`,
      '',
      'Next: in the Web Shell, open a session and choose "Use this computer" in the sidebar footer.',
      'You approve every connection in a dialog on this computer.',
      `The first time a session reads or controls the screen, macOS asks you to allow "node" (${process.execPath}) under Accessibility and Screen Recording.`,
      '',
    ].join('\n'),
  );
  return 0;
}

function uninstall(args: string[]): number {
  if (process.platform === 'darwin') {
    uninstallLaunchAgent({
      plistPath: launchAgentPlistPath(),
      label: DESKTOP_RELAY_LABEL,
      uid: currentUid(),
      run: runLaunchctl,
    });
  }
  if (args.includes('--purge')) {
    const home = homeFrom(args);
    if (!purgeRelayHome(home)) {
      process.stderr.write(
        `Refusing to purge ${home}: it is not a desktop relay runtime directory.\n`,
      );
      return 1;
    }
  }
  process.stdout.write('The desktop relay is no longer registered.\n');
  return 0;
}

function status(args: string[]): number {
  const plistPath = launchAgentPlistPath();
  process.stdout.write(
    fs.existsSync(plistPath)
      ? `Registered: ${plistPath} (127.0.0.1:${DESKTOP_RELAY_PORT})\n`
      : 'Not registered. Run: node-repl-mcp desktop-relay install\n',
  );
  const record = createRecordStore(homeFrom(args)).read();
  if (record !== undefined) {
    process.stdout.write(
      `Last relay: ${record.phase} for session ${record.sessionId} on ${record.daemonUrl}, requested by ${record.origin} (${record.updatedAt})${
        record.message ? `: ${record.message}` : ''
      }\n`,
    );
  }
  return 0;
}

export async function runDesktopRelayCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (rest.includes('--home') && flag(rest, '--home') === undefined) {
    process.stderr.write('--home requires a non-empty directory.\n');
    return 2;
  }
  switch (command) {
    case 'install':
      return install(rest);
    case 'uninstall':
      return uninstall(rest);
    case 'status':
      return status(rest);
    case 'agent':
      // Started by launchd for each accepted connection, not by hand.
      await runAgent(homeFrom(rest));
      return 0;
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}
