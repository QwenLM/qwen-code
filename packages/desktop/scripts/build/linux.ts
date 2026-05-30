/**
 * Linux-specific build logic
 */

import { $ } from 'bun';
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import type { BuildConfig } from './common';

/**
 * Package the Linux app with electron-builder
 */
export async function packageLinux(config: BuildConfig): Promise<string> {
  const { arch, electronDir } = config;

  console.log('Packaging app with electron-builder...');

  // Run electron-builder
  await $`cd ${electronDir} && npx electron-builder --linux --${arch}`;

  // electron-builder uses different arch names: x86_64 for x64, aarch64 for arm64
  const linuxArch = arch === 'x64' ? 'x86_64' : 'aarch64';
  const builtName = `Qwen-Code-Desktop-${linuxArch}.AppImage`;
  const builtPath = join(electronDir, 'release', builtName);

  if (!existsSync(builtPath)) {
    console.error('Contents of release directory:');
    await $`ls -la ${join(electronDir, 'release')}`;
    throw new Error(`Expected AppImage not found at ${builtPath}`);
  }

  // Rename to our standard naming convention
  const finalName = `Qwen-Code-Desktop-${arch}.AppImage`;
  const finalPath = join(electronDir, 'release', finalName);

  if (builtPath !== finalPath) {
    renameSync(builtPath, finalPath);
    console.log(`  Renamed ${builtName} -> ${finalName}`);
  }

  // Get file size
  const file = Bun.file(finalPath);
  const sizeMB = ((await file.size) / 1024 / 1024).toFixed(2);

  console.log(`\n=== Build Complete ===`);
  console.log(`AppImage: ${finalPath}`);
  console.log(`Size: ${sizeMB} MB`);

  return finalPath;
}
