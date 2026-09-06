/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeReplSecurityPolicy } from './security-policy.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-policy-'));
  tmpDirs.push(directory);
  return directory;
}

function makeModuleRoot(): string {
  const root = path.join(makeTmpDir(), 'node_modules');
  fs.mkdirSync(root);
  return root;
}

afterAll(() => {
  for (const directory of tmpDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('NodeReplSecurityPolicy', () => {
  describe('validateModuleRoot', () => {
    const policy = NodeReplSecurityPolicy.default();

    it('canonicalizes an existing node_modules directory', () => {
      const root = makeModuleRoot();
      expect(policy.validateModuleRoot(root)).toBe(fs.realpathSync(root));
    });

    it('accepts a node_modules path before it is created', () => {
      const root = path.join(makeTmpDir(), 'future', 'node_modules');
      const approved = policy.validateModuleRoot(root);
      fs.mkdirSync(root, { recursive: true });
      expect(approved).toBe(fs.realpathSync(root));
    });

    it('canonicalizes an existing node_modules symlink', () => {
      const root = path.join(makeTmpDir(), 'packages');
      fs.mkdirSync(root);
      const alias = path.join(makeTmpDir(), 'node_modules');
      fs.symlinkSync(
        root,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(policy.validateModuleRoot(alias)).toBe(fs.realpathSync(root));
    });

    it('rejects empty, relative, file, and non-node_modules paths', () => {
      expect(() => policy.validateModuleRoot('')).toThrow(/non-empty/);
      expect(() => policy.validateModuleRoot('node_modules')).toThrow(
        /absolute/,
      );
      expect(() =>
        policy.validateModuleRoot(path.join(makeTmpDir(), 'missing')),
      ).toThrow(/node_modules/);
      const plainDirectory = makeTmpDir();
      expect(() => policy.validateModuleRoot(plainDirectory)).toThrow(
        /node_modules/,
      );
      const file = path.join(makeTmpDir(), 'node_modules');
      fs.writeFileSync(file, 'not a directory');
      expect(() => policy.validateModuleRoot(file)).toThrow(/directory/);
    });
  });
});
