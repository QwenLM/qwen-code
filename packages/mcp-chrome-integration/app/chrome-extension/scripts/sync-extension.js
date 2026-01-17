#!/usr/bin/env node

/* global process, console */

/**
 * 将源代码同步到目标扩展目录（默认 dist/extension 或通过 EXTENSION_OUT_DIR/--target 指定）。
 * - 复制 public 下的静态资源（排除 sidepanel/dist 旧构建）
 * - 用 src/ 下的 background、content 覆盖对应目录
 * 支持 --watch 监听变更（不清空输出，便于与 esbuild --watch 共存）。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { watch } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const targetArg = args.find((arg) => arg.startsWith('--target='));
const targetDir = path.resolve(
  projectRoot,
  targetArg
    ? targetArg.split('=')[1]
    : process.env.EXTENSION_OUT_DIR || 'extension',
);

const staticSrcDir = path.join(projectRoot, 'public');
const copyPairs = [
  ['src/background', 'background'],
  ['src/content', 'content'],
];

async function copyStatic(clean = false) {
  if (clean) {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
  await fs.mkdir(targetDir, { recursive: true });

  await fs.cp(staticSrcDir, targetDir, {
    recursive: true,
    filter: (src) => {
      // 跳过旧的 sidepanel/dist 构建产物，交由 esbuild 重新生成
      return !src.includes(`${path.sep}sidepanel${path.sep}dist${path.sep}`);
    },
  });
  console.log(
    `Static assets synced -> ${path.relative(projectRoot, targetDir)}`,
  );
}

async function copySources() {
  for (const [src, destRelative] of copyPairs) {
    const srcPath = path.join(projectRoot, src);
    const destPath = path.join(targetDir, destRelative);
    await fs.mkdir(destPath, { recursive: true });
    await fs.cp(srcPath, destPath, {
      recursive: true,
      // Skip TypeScript sources so the built JS (via esbuild) is the only output
      filter: (entry) => !entry.endsWith('.ts') && !entry.endsWith('.tsx'),
    });
    console.log(`Synced ${src} -> ${path.relative(projectRoot, destPath)}`);
  }
}

async function syncAll({ clean } = { clean: false }) {
  await copyStatic(clean);
  await copySources();
}

function startWatchers() {
  const watchTargets = [
    path.join(projectRoot, 'public'),
    path.join(projectRoot, 'src', 'background'),
    path.join(projectRoot, 'src', 'content'),
  ];

  let syncing = false;
  let pending = false;

  const triggerSync = (reason = 'change') => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    syncAll({ clean: false })
      .then(() => console.log(`[watch] synced after ${reason}`))
      .catch((err) => console.error('Sync error:', err))
      .finally(() => {
        syncing = false;
        if (pending) {
          pending = false;
          triggerSync('pending change');
        }
      });
  };

  watchTargets.forEach((dir) => {
    watch(dir, { recursive: true }, (_, filename) => {
      if (
        filename &&
        filename.includes(`${path.sep}sidepanel${path.sep}dist${path.sep}`)
      ) {
        // 让 esbuild 管理 sidepanel/dist 输出
        return;
      }
      triggerSync(`${path.relative(projectRoot, dir)}/${filename || ''}`);
    });
  });

  console.log(
    `Watching extension sources -> ${path.relative(projectRoot, targetDir)} (sidepanel/dist excluded)`,
  );
}

async function main() {
  await syncAll({ clean: !isWatch });
  if (isWatch) {
    startWatchers();
  }
}

main().catch((err) => {
  console.error('Failed to sync extension assets:', err);
  process.exit(1);
});
