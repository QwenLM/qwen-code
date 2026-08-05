import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SOURCE_ROOT = new URL('../../', import.meta.url);
const NATIVE_SOURCE = new URL('../../native/appshot.mm', import.meta.url);
const PACKAGE_JSON = new URL('../../../package.json', import.meta.url);
const BUILDER_CONFIG = new URL(
  '../../../electron-builder.yml',
  import.meta.url,
);

async function runtimeSource(): Promise<string> {
  const sourceRoot = fileURLToPath(SOURCE_ROOT);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') await visit(entryPath);
      } else if (/\.(?:js|mm|ts)$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  await visit(sourceRoot);
  return (await Promise.all(files.sort().map((file) => readFile(file, 'utf8'))))
    .join('\n');
}

describe('built-in Appshot architecture', () => {
  it('has no external capture backend or process-launch path', async () => {
    const source = await runtimeSource();
    assert.doesNotMatch(
      source,
      /@modelcontextprotocol|node:child_process|NSTask|posix_spawn|execFile(?:Sync)?\s*\(|spawn(?:Sync)?\s*\(|popen\s*\(|system\s*\(/u,
    );
  });

  it('owns one fixed in-process macOS capture implementation', async () => {
    const source = await readFile(NATIVE_SOURCE, 'utf8');
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const builderConfig = await readFile(BUILDER_CONFIG, 'utf8');

    assert.deepEqual(packageJson.dependencies, { ws: '^8.19.0' });
    assert.match(source, /#import <ScreenCaptureKit\/ScreenCaptureKit\.h>/u);
    assert.match(source, /AXUIElementCreateApplication/u);
    assert.match(source, /napi_create_async_work/u);
    assert.match(
      builderConfig,
      /from: 'dist\/native\/qwen-live-appshot\.node'/u,
    );
    assert.doesNotMatch(builderConfig, /from:\s*['"][^'"]+\.app['"]/u);
  });

  it('locks down Electron runtime escape hatches in packaged builds', async () => {
    const builderConfig = await readFile(BUILDER_CONFIG, 'utf8');

    assert.match(builderConfig, /runAsNode:\s*false/u);
    assert.match(
      builderConfig,
      /enableNodeOptionsEnvironmentVariable:\s*false/u,
    );
    assert.match(builderConfig, /enableNodeCliInspectArguments:\s*false/u);
    assert.match(builderConfig, /onlyLoadAppFromAsar:\s*true/u);
    assert.match(
      builderConfig,
      /enableEmbeddedAsarIntegrityValidation:\s*true/u,
    );
  });
});
