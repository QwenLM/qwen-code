/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(import.meta.dirname, '../..');

function readPackageJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(rootDir, relativePath, 'package.json'), 'utf-8'),
  );
}

describe('DataWorks npm publish metadata', () => {
  it('uses the DataWorks package names for all publishable npm packages', () => {
    const expectedPackageNames = new Map([
      ['.', '@alife/dataworks-qwen-code'],
      ['packages/cli', '@alife/dataworks-qwen-code'],
      ['packages/core', '@alife/dataworks-qwen-code-core'],
      ['packages/channels/base', '@alife/dataworks-qwen-code-channel-base'],
      [
        'packages/channels/telegram',
        '@alife/dataworks-qwen-code-channel-telegram',
      ],
      ['packages/channels/weixin', '@alife/dataworks-qwen-code-channel-weixin'],
      [
        'packages/channels/dingtalk',
        '@alife/dataworks-qwen-code-channel-dingtalk',
      ],
      ['packages/web-templates', '@alife/dataworks-qwen-code-web-templates'],
      ['packages/webui', '@alife/dataworks-qwen-code-webui'],
    ]);

    for (const [relativePath, expectedName] of expectedPackageNames) {
      expect(readPackageJson(relativePath).name).toBe(expectedName);
    }
  });

  it('uses explicit npm workspaces so the publish script versions each package', () => {
    expect(readPackageJson('.').workspaces).toEqual([
      'packages/cli',
      'packages/core',
      'packages/sdk-typescript',
      'packages/vscode-ide-companion',
      'packages/web-templates',
      'packages/webui',
      'packages/channels/base',
      'packages/channels/telegram',
      'packages/channels/weixin',
      'packages/channels/dingtalk',
      'packages/channels/plugin-example',
    ]);
  });

  it('keeps non-DataWorks packages private during npm workspace publishing', () => {
    expect(readPackageJson('packages/sdk-typescript').private).toBe(true);
    expect(readPackageJson('packages/vscode-ide-companion').private).toBe(true);
    expect(readPackageJson('packages/channels/plugin-example').private).toBe(
      true,
    );
  });

  it('publishes DataWorks packages to the internal anpm registry', () => {
    const publishablePackagePaths = [
      'packages/cli',
      'packages/core',
      'packages/channels/base',
      'packages/channels/telegram',
      'packages/channels/weixin',
      'packages/channels/dingtalk',
      'packages/web-templates',
      'packages/webui',
    ];

    for (const relativePath of publishablePackagePaths) {
      expect(readPackageJson(relativePath).publishConfig?.registry).toBe(
        'https://registry.anpm.alibaba-inc.com',
      );
    }
  });
});
