import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('Building executables...');

try {
  const distDir = join(root, 'dist');
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const builds = [
    {
      target: 'bun-linux-x64',
      output: 'qwen-linux-x64',
      platform: 'Linux',
    },
    {
      target: 'bun-linux-arm64',
      output: 'qwen-linux-arm64',
      platform: 'Linux',
    },
    {
      target: 'bun-darwin-x64',
      output: 'qwen-macos-x64',
      platform: 'Darwin',
    },
    {
      target: 'bun-darwin-arm64',
      output: 'qwen-macos-arm64',
      platform: 'Darwin',
    },
    {
      target: 'bun-windows-x64',
      output: 'qwen-windows-x64.exe',
      platform: 'Windows',
    },
  ];

  const total = builds.length;

  for (let i = 0; i < builds.length; i++) {
    const build = builds[i];
    const index = i + 1;
    const command = `npx bun@1.3.4 build dist/cli.js --compile --target=${build.target} --outfile=dist/${build.output} --minify --sourcemap`;

    console.log(
      `\n[${index}/${total}] Building ${build.platform} (${build.target}) -> dist/${build.output}`,
    );
    console.log(`$ ${command}`);

    try {
      execSync(command, { cwd: root, stdio: 'inherit' });
      console.log(`✓ Built ${build.output}`);
    } catch (error) {
      console.error(
        `✗ Failed ${build.platform} (${build.target}): ${error.message}`,
      );
    }
  }

  console.log('\nAll builds completed. Saved to dist/');
} catch (error) {
  console.error('Error during build process:', error);
}
