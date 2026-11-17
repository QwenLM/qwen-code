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
  return (
    await Promise.all(files.sort().map((file) => readFile(file, 'utf8')))
  ).join('\n');
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

  it('keeps full-display capture separate from foreground Appshot and never reads accessibility', async () => {
    const source = await readFile(NATIVE_SOURCE, 'utf8');
    const capture = source.slice(
      source.indexOf('void ExecuteDisplayCapture('),
      source.indexOf('void CompleteDisplayCapture('),
    );
    assert.match(capture, /CGPreflightScreenCaptureAccess/u);
    assert.match(capture, /ResolveDisplay\(work->selection\)/u);
    assert.match(capture, /current->uuid != target->uuid/u);
    assert.doesNotMatch(
      capture,
      /AXIsProcessTrusted|CaptureAccessibilityTree|FindForegroundWindow|CapturePng\(/u,
    );
    assert.match(source, /CGGetActiveDisplayList/u);
    assert.match(source, /CGDisplayCreateUUIDFromDisplayID/u);
    assert.match(source, /screen\.localizedName/u);
    assert.match(source, /"listDisplays"/u);
    assert.match(source, /"captureDisplay"/u);
  });

  it('covers full display bounds, desktop and system layers while excluding Host windows', async () => {
    const source = await readFile(NATIVE_SOURCE, 'utf8');
    const modern = source.slice(
      source.indexOf('CGImageRef CaptureDisplayWithScreenCaptureKit('),
      source.indexOf('std::vector<uint8_t> CaptureDisplayPng('),
    );
    const legacy = source.slice(
      source.indexOf('std::vector<uint8_t> CaptureDisplayPng('),
      source.indexOf('napi_value Boolean('),
    );
    assert.match(modern, /getShareableContentExcludingDesktopWindows:NO/u);
    assert.match(modern, /application\.processID == getpid\(\)/u);
    assert.match(
      modern,
      /initWithDisplay:selected_display\s+excludingApplications:excluded\s+exceptingWindows:@\[\]/u,
    );
    assert.match(modern, /macOS 14\.2[^]*includeMenuBar = YES/u);
    assert.match(modern, /filter\.pointPixelScale/u);
    assert.match(modern, /excluded\.count == 0/u);
    assert.doesNotMatch(modern, /initWithDesktopIndependentWindow|sourceRect/u);
    assert.match(
      legacy,
      /CGWindowListCopyWindowInfo\(\s*kCGWindowListOptionOnScreenOnly/u,
    );
    assert.doesNotMatch(
      legacy,
      /kCGWindowListExcludeDesktopElements|kCGWindowLayer|layer\.intValue/u,
    );
    assert.match(legacy, /pid\.intValue != getpid\(\)/u);
    assert.match(
      legacy,
      /CFArrayCreateMutable\(kCFAllocatorDefault, 0, nullptr\)/u,
    );
    assert.match(
      legacy,
      /CGWindowListCreateImageFromArray\(\s*target\.bounds, ids/u,
    );
    assert.match(source, /1920\.0 \/ width, 1080\.0 \/ height/u);
    assert.match(legacy, /bytes\.size\(\) > kMaxDisplayPngBytes/u);
    const build = await readFile(
      new URL('../../../scripts/build.mjs', import.meta.url),
      'utf8',
    );
    assert.match(build, /'ColorSync'/u);
  });

  it('rejects ambiguous display UUIDs instead of selecting the first match', async () => {
    const source = await readFile(NATIVE_SOURCE, 'utf8');
    const resolve = source.slice(
      source.indexOf('std::optional<DisplayTarget> ResolveDisplay('),
      source.indexOf('std::string NormalizeText('),
    );
    assert.match(resolve, /std::optional<DisplayTarget> selected;/u);
    assert.match(
      resolve,
      /if \(selected\.has_value\(\)\) return std::nullopt;/u,
    );
    assert.match(
      resolve,
      /selection == "primary" && display_id == CGMainDisplayID\(\)/u,
    );
    assert.match(resolve, /return selected;/u);
    assert.doesNotMatch(resolve, /return DisplayTarget\{/u);
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
