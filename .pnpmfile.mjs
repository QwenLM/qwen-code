/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Every pnpm workspace member name, so any spelling of an internal
// dependency (file:, an exact release version, or *) rewrites to
// workspace:*. scripts/tests/package-scripts.test.js pins this set against
// the workspace manifests, so a newly added package fails that test until
// it is listed here.
export const workspacePackageNames = new Set([
  '@qwen-code/acp-bridge',
  '@qwen-code/audio-capture',
  '@qwen-code/channel-base',
  '@qwen-code/channel-dingtalk',
  '@qwen-code/channel-dws',
  '@qwen-code/channel-feishu',
  '@qwen-code/channel-github',
  '@qwen-code/channel-gitlab',
  '@qwen-code/channel-plugin-example',
  '@qwen-code/channel-qqbot',
  '@qwen-code/channel-telegram',
  '@qwen-code/channel-wecom',
  '@qwen-code/channel-weixin',
  '@qwen-code/chrome-bridge',
  '@qwen-code/external-context',
  '@qwen-code/external-context-mem0',
  '@qwen-code/mobile-mcp',
  '@qwen-code/node-repl-mcp',
  '@qwen-code/qwen-code',
  '@qwen-code/qwen-code-core',
  '@qwen-code/qwen-live',
  '@qwen-code/sdk',
  '@qwen-code/web-shell',
  '@qwen-code/web-templates',
  'qwen-code-vscode-ide-companion',
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
        if (workspacePackageNames.has(name)) {
          dependencies[name] = 'workspace:*';
        }
      }
    }

    return packageJson;
  },
};
