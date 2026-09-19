/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRelayHome, purgeRelayHome } from './cli.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(name: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-relay-cli-'));
  temporary.push(home);
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name }));
  return home;
}

describe('desktop-relay uninstall --purge', () => {
  it('recognizes only marked runtime directories outside broad roots', () => {
    expect(isRelayHome(path.parse(process.cwd()).root)).toBe(false);
    expect(isRelayHome(os.homedir())).toBe(false);
    expect(isRelayHome(tempHome('another-project'))).toBe(false);
    expect(isRelayHome(tempHome('qwen-desktop-relay-runtime'))).toBe(true);
  });

  it('refuses to remove an unmarked directory', () => {
    const home = tempHome('another-project');
    expect(purgeRelayHome(home)).toBe(false);
    expect(fs.existsSync(home)).toBe(true);
  });

  it('removes a marked runtime directory', () => {
    const home = tempHome('qwen-desktop-relay-runtime');
    expect(purgeRelayHome(home)).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
  });
});
