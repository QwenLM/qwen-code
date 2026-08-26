import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/cli',
      'packages/core',
      'packages/vscode-ide-companion',
      'packages/sdk-typescript',
      'packages/node-repl',
      'packages/channels/base',
      'packages/channels/dingtalk',
      'packages/channels/dws',
      'packages/channels/telegram',
      'packages/channels/weixin',
      'packages/channels/qqbot',
      'integration-tests',
      'scripts',
    ],
  },
});
