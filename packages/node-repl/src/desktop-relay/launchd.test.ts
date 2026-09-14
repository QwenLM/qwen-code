/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLaunchAgentPlist,
  installLaunchAgent,
  uninstallLaunchAgent,
  type LaunchctlRun,
} from './launchd.js';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempPlistPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-relay-launchd-'));
  temporary.push(dir);
  return path.join(dir, 'LaunchAgents', 'com.qwencode.desktop-relay.plist');
}

describe('buildLaunchAgentPlist', () => {
  const plist = buildLaunchAgentPlist({
    label: 'com.qwencode.desktop-relay',
    programArguments: [
      '/usr/local/bin/node',
      '/a & b/<x>.js',
      'desktop-relay',
      'agent',
    ],
    port: 47821,
    logPath: '/Users/me/.qwen/desktop-relay/agent.log',
  });

  it('listens on loopback only and starts one process per connection', () => {
    expect(plist).toContain(
      '<key>SockNodeName</key>\n      <string>127.0.0.1</string>',
    );
    expect(plist).toContain(
      '<key>SockServiceName</key>\n      <string>47821</string>',
    );
    expect(plist).toContain('<key>inetdCompatibility</key>');
    expect(plist).toContain('<key>Wait</key>\n    <false/>');
    expect(plist).not.toContain('KeepAlive');
    expect(plist).not.toContain('RunAtLoad');
  });

  it('escapes program arguments', () => {
    expect(plist).toContain('<string>/a &amp; b/&lt;x&gt;.js</string>');
  });
});

describe('installLaunchAgent / uninstallLaunchAgent', () => {
  it('writes the plist, replaces any loaded copy, then bootstraps it', () => {
    const plistPath = tempPlistPath();
    const run = vi.fn<LaunchctlRun>(() => ({ status: 0, stderr: '' }));
    installLaunchAgent({
      plistPath,
      label: 'l',
      uid: 501,
      run,
      plist: '<plist/>',
    });
    expect(fs.readFileSync(plistPath, 'utf8')).toBe('<plist/>');
    expect(run.mock.calls.map((call) => call[0])).toEqual([
      ['bootout', 'gui/501/l'],
      ['bootstrap', 'gui/501', plistPath],
    ]);
  });

  it('reports a failed bootstrap', () => {
    const plistPath = tempPlistPath();
    const run = vi.fn<LaunchctlRun>((args) =>
      args[0] === 'bootstrap'
        ? { status: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' }
        : { status: 3, stderr: '' },
    );
    expect(() =>
      installLaunchAgent({
        plistPath,
        label: 'l',
        uid: 501,
        run,
        plist: '<plist/>',
      }),
    ).toThrow(
      'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error',
    );
  });

  it('unloads and removes the plist', () => {
    const plistPath = tempPlistPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, '<plist/>');
    const run = vi.fn<LaunchctlRun>(() => ({ status: 0, stderr: '' }));
    uninstallLaunchAgent({ plistPath, label: 'l', uid: 501, run });
    expect(run).toHaveBeenCalledWith(['bootout', 'gui/501/l']);
    expect(fs.existsSync(plistPath)).toBe(false);
  });
});
