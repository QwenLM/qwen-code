/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A LaunchAgent in inetd mode: launchd owns the loopback socket and starts one
 * process per accepted connection, with that connection as its stdin and
 * stdout. Nothing runs while nobody is connecting.
 */

export interface LaunchAgentSpec {
  label: string;
  programArguments: string[];
  port: number;
  logPath: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const args = spec.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockNodeName</key>
      <string>127.0.0.1</string>
      <key>SockServiceName</key>
      <string>${spec.port}</string>
      <key>SockType</key>
      <string>stream</string>
    </dict>
  </dict>
  <key>inetdCompatibility</key>
  <dict>
    <key>Wait</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.logPath)}</string>
</dict>
</plist>
`;
}

export type LaunchctlRun = (args: string[]) => {
  status: number | null;
  stderr: string;
};

export const runLaunchctl: LaunchctlRun = (args) => {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr || result.error?.message || '',
  };
};

export interface LaunchAgentTarget {
  plistPath: string;
  label: string;
  uid: number;
  run: LaunchctlRun;
}

export function installLaunchAgent(
  target: LaunchAgentTarget & { plist: string },
): void {
  fs.mkdirSync(path.dirname(target.plistPath), { recursive: true });
  fs.writeFileSync(target.plistPath, target.plist);
  // Replace a previous registration; failing here only means none was loaded.
  target.run(['bootout', `gui/${target.uid}/${target.label}`]);
  const result = target.run([
    'bootstrap',
    `gui/${target.uid}`,
    target.plistPath,
  ]);
  if (result.status !== 0) {
    // Leave nothing behind: launchd loads every plist in ~/Library/LaunchAgents
    // at the next login, and `status` reads this file as the registration.
    fs.rmSync(target.plistPath, { force: true });
    throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
  }
}

export function uninstallLaunchAgent(target: LaunchAgentTarget): void {
  const bootout = target.run(['bootout', `gui/${target.uid}/${target.label}`]);
  if (bootout.status !== 0) {
    // A failed bootout means "nothing was loaded" or "could not unload"; only
    // the latter leaves a live agent behind, so confirm before deleting the
    // plist that manages it.
    const probe = target.run(['print', `gui/${target.uid}/${target.label}`]);
    if (probe.status === 0) {
      throw new Error(
        `launchctl bootout failed: ${bootout.stderr.trim() || `exit ${String(bootout.status)}`}`,
      );
    }
  }
  fs.rmSync(target.plistPath, { force: true });
}
