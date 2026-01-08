#!/usr/bin/env node

/**
 * 开发模式：同步资源 + esbuild watch 到 dist/extension（可通过 EXTENSION_OUT_DIR 覆盖）。
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = process.env.EXTENSION_OUT_DIR || 'dist/extension';

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, EXTENSION_OUT_DIR: outDir },
    ...options,
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT') {
      return;
    }
    if (code !== 0) {
      console.error(`${command} ${args.join(' ')} exited with code ${code}`);
      process.exit(code || 1);
    }
  });

  return child;
}

async function main() {
  // 先做一次完整同步，保证 dist/extension 准备好静态资源和脚本
  await new Promise((resolve, reject) => {
    const syncOnce = startProcess('node', [
      'scripts/sync-extension.js',
      `--target=${outDir}`,
    ]);
    syncOnce.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Initial sync failed'));
    });
  });

  // 并行开启 watch：静态/脚本同步 + sidepanel esbuild
  const watchers = [
    startProcess('node', [
      'scripts/sync-extension.js',
      '--watch',
      `--target=${outDir}`,
    ]),
    startProcess('node', ['config/esbuild.config.js', '--watch']),
  ];

  // 优雅退出
  const shutdown = () => {
    watchers.forEach((proc) => {
      if (!proc.killed) {
        proc.kill('SIGINT');
      }
    });
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
