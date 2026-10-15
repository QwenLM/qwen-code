/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfigFile } from './read-config-file.js';

describe('readConfigFile', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-read-config-')),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads a regular file', () => {
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');

    expect(readConfigFile(file)).toBe('{"a":1}');
  });

  it('reports an absent file in an existing directory as absent', () => {
    expect(readConfigFile(path.join(root, 'settings.json'))).toBe(undefined);
  });

  it('reports an absent file under missing directories as absent', () => {
    expect(readConfigFile(path.join(root, 'missing', 'settings.json'))).toBe(
      undefined,
    );
  });

  it('reports an absent file under a linked directory as absent', () => {
    fs.mkdirSync(path.join(root, 'target'));
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'linked'), 'dir');

    expect(readConfigFile(path.join(root, 'linked', 'settings.json'))).toBe(
      undefined,
    );
  });

  it.each([
    [
      'a dangling link to the file',
      () => {
        fs.symlinkSync(
          path.join(root, 'gone.json'),
          path.join(root, 'settings.json'),
        );
        return path.join(root, 'settings.json');
      },
    ],
    [
      'a dangling link among its ancestors',
      () => {
        fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'dir'), 'dir');
        return path.join(root, 'dir', 'nested', 'settings.json');
      },
    ],
    [
      'a directory in place of the file',
      () => {
        fs.mkdirSync(path.join(root, 'settings.json'));
        return path.join(root, 'settings.json');
      },
    ],
    [
      'a file in place of an ancestor directory',
      () => {
        fs.writeFileSync(path.join(root, 'dir'), '');
        return path.join(root, 'dir', 'settings.json');
      },
    ],
  ])('throws for %s', (_name, arrange) => {
    expect(() => readConfigFile(arrange())).toThrow();
  });

  it('refuses a path that is not a regular file before reading it', () => {
    fs.mkdirSync(path.join(root, 'settings.json'));

    expect(() => readConfigFile(path.join(root, 'settings.json'))).toThrow(
      'Configuration path is not a regular file.',
    );
  });

  it('throws when the file changes while it is read', () => {
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');
    // Builtin named exports follow the module object only after a sync.
    const readFileSync = nodeFs.readFileSync;
    nodeFs.readFileSync = ((...args: Parameters<typeof readFileSync>) => {
      const content = readFileSync(...args);
      nodeFs.writeFileSync(file, '{"a":2,"b":3}');
      return content;
    }) as typeof readFileSync;
    syncBuiltinESMExports();
    try {
      expect(() => readConfigFile(file)).toThrow(
        'Configuration file changed while it was read.',
      );
    } finally {
      nodeFs.readFileSync = readFileSync;
      syncBuiltinESMExports();
    }
  });
});
