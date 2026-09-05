/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const workspacePackages = new Set([
  '@qwen-code/acp-bridge',
  '@qwen-code/audio-capture',
  '@qwen-code/channel-base',
  '@qwen-code/channel-dingtalk',
  '@qwen-code/channel-dws',
  '@qwen-code/channel-feishu',
  '@qwen-code/channel-github',
  '@qwen-code/channel-gitlab',
  '@qwen-code/channel-qqbot',
  '@qwen-code/channel-telegram',
  '@qwen-code/channel-wecom',
  '@qwen-code/channel-weixin',
  '@qwen-code/qwen-code-core',
  '@qwen-code/sdk',
  '@qwen-code/web-templates',
  '@qwen-code/webui',
]);

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

export const hooks = {
  readPackage(packageJson) {
    for (const field of dependencyFields) {
      const dependencies = packageJson[field];
      if (!dependencies) continue;

      for (const name of Object.keys(dependencies)) {
        if (workspacePackages.has(name)) {
          dependencies[name] = 'workspace:*';
        }
      }
    }

    return packageJson;
  },
};
