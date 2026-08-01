/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildKittyPlaceholder,
  detectTerminalImageProtocol,
  encodeITerm2InlineImage,
  encodeKittyImage,
  encodeKittyVirtualImage,
  readPngSize,
  renderMermaidImageAsync,
  renderMermaidImageSync,
} from './mermaidImageRenderer.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
  process.stdout,
  'isTTY',
);

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
}

function createFakeMmdc(binDir: string, bodyLines?: string[]): void {
  const fakeMmdcScript = path.join(binDir, 'fake-mmdc.cjs');
  const defaultBodyLines = [
    'const fs = require("node:fs");',
    'const out = process.argv[process.argv.indexOf("-o") + 1];',
    `fs.writeFileSync(out, Buffer.from("${PNG_1X1.toString(
      'base64',
    )}", "base64"));`,
  ];
  fs.writeFileSync(
    fakeMmdcScript,
    (bodyLines ?? defaultBodyLines).join('\n'),
    'utf8',
  );

  const fakeMmdc =
    process.platform === 'win32'
      ? path.join(binDir, 'mmdc.cmd')
      : path.join(binDir, 'mmdc');
  const command =
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fakeMmdcScript}" %*\r\n`
      : ['#!/usr/bin/env node', ...(bodyLines ?? defaultBodyLines)].join('\n');
  fs.writeFileSync(fakeMmdc, command, 'utf8');
  fs.chmodSync(fakeMmdc, 0o755);
}

function createFakeChafa(binDir: string, bodyLines?: string[]): void {
  const fakeChafaScript = path.join(binDir, 'fake-chafa.cjs');
  const defaultBodyLines = [
    'process.stdout.write("ansi line 1\\nansi line 2\\n");',
  ];
  fs.writeFileSync(
    fakeChafaScript,
    (bodyLines ?? defaultBodyLines).join('\n'),
    'utf8',
  );

  const fakeChafa =
    process.platform === 'win32'
      ? path.join(binDir, 'chafa.cmd')
      : path.join(binDir, 'chafa');
  const command =
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fakeChafaScript}" %*\r\n`
      : ['#!/usr/bin/env node', ...(bodyLines ?? defaultBodyLines)].join('\n');
  fs.writeFileSync(fakeChafa, command, 'utf8');
  fs.chmodSync(fakeChafa, 0o755);
}

beforeEach(() => {
  setStdoutIsTTY(true);
});

afterEach(() => {
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY);
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mermaid image renderer', () => {
  it('keeps external image rendering disabled unless explicitly enabled', () => {
    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[End]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: process.env['PATH'] ?? '',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'disabled by default',
    );
  });

  it('does not auto-discover repo-local renderers from the current working directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-local-mmdc-'));
    tempDirs.push(tempDir);
    const binDir = path.join(tempDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const localMmdc = path.join(binDir, 'mmdc');
    fs.writeFileSync(localMmdc, '#!/bin/sh\nexit 1\n', 'utf8');
    fs.chmodSync(localMmdc, 0o755);

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const result = renderMermaidImageSync({
        source: 'flowchart TD\n  A[Start] --> B[End]',
        contentWidth: 80,
        availableTerminalHeight: 20,
        env: {
          PATH: binDir,
          QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
          QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
        },
      });

      expect(result.kind).toBe('unavailable');
      expect(result.kind === 'unavailable' && result.reason).toContain(
        'Mermaid CLI (mmdc) was not found',
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('does not auto-discover node_modules renderers from PATH without opt-in', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-path-mmdc-'));
    tempDirs.push(tempDir);
    const binDir = path.join(
      tempDir,
      'packages',
      'app',
      'node_modules',
      '.bin',
    );
    fs.mkdirSync(binDir, { recursive: true });
    createFakeMmdc(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[End]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: binDir,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'Mermaid CLI (mmdc) was not found',
    );
  });

  it('detects forced terminal image protocols', () => {
    expect(
      detectTerminalImageProtocol({
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      }),
    ).toBe('kitty');
    expect(
      detectTerminalImageProtocol({
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
      }),
    ).toBe('iterm2');
    expect(
      detectTerminalImageProtocol({
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      }),
    ).toBeNull();
  });

  it('honors the Mermaid image disable flag over forced protocols', () => {
    expect(
      detectTerminalImageProtocol({
        QWEN_CODE_DISABLE_MERMAID_IMAGES: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      }),
    ).toBeNull();
  });

  it('does not force terminal image protocols when stdout is not a TTY', () => {
    setStdoutIsTTY(false);

    expect(
      detectTerminalImageProtocol({
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      }),
    ).toBeNull();
    expect(
      detectTerminalImageProtocol({
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
      }),
    ).toBeNull();
  });

  it('encodes PNG data for terminal image protocols', () => {
    expect(readPngSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(encodeITerm2InlineImage(PNG_1X1, 40, 10)).toContain(
      '\u001b]1337;File=inline=1;width=40;height=10;',
    );
    expect(encodeKittyImage(PNG_1X1, 40, 10)).toContain(
      '\u001b_Ga=T,f=100,c=40,r=10,',
    );
    expect(encodeKittyVirtualImage(PNG_1X1, 42, 40, 10)).toContain(
      '\u001b_Ga=T,f=100,i=42,q=2,U=1,c=40,r=10,',
    );
  });

  it('builds Kitty unicode placeholders for virtual placements', () => {
    const placeholder = buildKittyPlaceholder(42, 3, 2);

    expect(placeholder.color).toBe('#00002a');
    expect(placeholder.lines).toEqual([
      '\u{10EEEE}\u{305}\u{305}\u{10EEEE}\u{305}\u{30D}\u{10EEEE}\u{305}\u{30E}',
      '\u{10EEEE}\u{30D}\u{305}\u{10EEEE}\u{30D}\u{30D}\u{10EEEE}\u{30D}\u{30E}',
    ]);
  });

  it('clamps Kitty placeholder width to the available diacritic alphabet', () => {
    const placeholder = buildKittyPlaceholder(42, 200, 1);

    expect(placeholder.lines[0]).not.toContain('undefined');
    expect(Array.from(placeholder.lines[0] ?? '').length).toBeLessThan(200 * 3);
  });

  it('renders Mermaid through mmdc when terminal images are available', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[End]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
      },
    });

    expect(result.kind).toBe('terminal-image');
    expect(result.kind === 'terminal-image' && result.protocol).toBe('iterm2');
    expect(result.kind === 'terminal-image' && result.sequence).toContain(
      '\u001b]1337;File=inline=1;',
    );
  });

  it('renders Mermaid through Kitty asynchronously for interactive UI callers', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);

    const result = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[End async]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(result.kind).toBe('terminal-image');
    expect(result.kind === 'terminal-image' && result.protocol).toBe('kitty');
  });

  it('does not render iTerm2 images asynchronously because placement is cursor-bound', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);

    const result = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[No async iTerm2]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('iTerm2');
  });

  it('honors the configured terminal cell aspect ratio when fitting images', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[Aspect]',
      contentWidth: 80,
      availableTerminalHeight: 60,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
        QWEN_CODE_MERMAID_CELL_ASPECT_RATIO: '1',
      },
    });

    expect(result.kind === 'terminal-image' && result.rows).toBe(60);
  });

  it('falls back to the default render timeout when configured timeout is invalid', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[End invalid timeout]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
        QWEN_CODE_MERMAID_RENDER_TIMEOUT_MS: 'not-a-number',
      },
    });

    expect(result.kind).toBe('terminal-image');
    expect(result.kind === 'terminal-image' && result.protocol).toBe('iterm2');
  });

  it('renders Mermaid through chafa when terminal images are unavailable', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chafa-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);
    createFakeChafa(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[ANSI sync]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      },
    });

    expect(result.kind).toBe('ansi');
    expect(result.kind === 'ansi' && result.lines).toEqual([
      'ansi line 1',
      'ansi line 2',
    ]);
  });

  it('honors the Mermaid image disable flag over chafa fallback rendering', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chafa-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);
    createFakeChafa(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[Disabled]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_DISABLE_MERMAID_IMAGES: '1',
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'QWEN_CODE_DISABLE_MERMAID_IMAGES',
    );
  });

  it('honors the Mermaid image disable flag in async rendering', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chafa-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);
    createFakeChafa(binDir);

    const result = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[Disabled async]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_DISABLE_MERMAID_IMAGES: '1',
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'QWEN_CODE_DISABLE_MERMAID_IMAGES',
    );
  });

  it('does not forward API credentials to external renderers', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-env-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir, [
      'const fs = require("node:fs");',
      'if (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {',
      '  console.error("secret leaked");',
      '  process.exit(5);',
      '}',
      'const out = process.argv[process.argv.indexOf("-o") + 1];',
      `fs.writeFileSync(out, Buffer.from("${PNG_1X1.toString(
        'base64',
      )}", "base64"));`,
    ]);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[Env]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        OPENAI_API_KEY: 'should-not-leak',
        GEMINI_API_KEY: 'should-not-leak',
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(result.kind).toBe('terminal-image');
  });

  it('renders Mermaid through chafa asynchronously for interactive UI callers', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chafa-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);
    createFakeChafa(binDir);

    const result = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[ANSI async]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      },
    });

    expect(result.kind).toBe('ansi');
    expect(result.kind === 'ansi' && result.lines).toEqual([
      'ansi line 1',
      'ansi line 2',
    ]);
  });

  it('bounds retained renderer output from async command failures', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chafa-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);
    createFakeChafa(binDir, [
      'process.stderr.write("x".repeat(50 * 1024), () => process.exit(1));',
    ]);

    const result = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[Large stderr]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason.length).toBeLessThan(
      17 * 1024,
    );
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'renderer output truncated',
    );
  });

  it('bounds retained renderer output across many async stderr chunks', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chafa-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);
    createFakeChafa(binDir, [
      'let remaining = 80;',
      'const writeNext = () => {',
      '  if (remaining-- <= 0) {',
      '    process.exit(1);',
      '    return;',
      '  }',
      '  process.stderr.write("x".repeat(1024), writeNext);',
      '};',
      'writeNext();',
    ]);

    const result = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[Chunked stderr]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'off',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason.length).toBeLessThan(
      17 * 1024,
    );
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'renderer output truncated',
    );
  });

  it('cancels async Mermaid CLI rendering when the caller aborts', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir, ['setTimeout(() => {}, 60_000);']);

    const abortController = new AbortController();
    const resultPromise = renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[Abort]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      signal: abortController.signal,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    abortController.abort();
    const result = await resultPromise;

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'cancelled',
    );

    createFakeMmdc(binDir);
    const retry = await renderMermaidImageAsync({
      source: 'flowchart TD\n  A[Start] --> B[Abort]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(retry.kind).toBe('terminal-image');
  });

  it('renders Kitty terminal images as virtual placements', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[End]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(result.kind).toBe('terminal-image');
    expect(result.kind === 'terminal-image' && result.protocol).toBe('kitty');
    expect(result.kind === 'terminal-image' && result.sequence).toContain(
      'q=2,U=1',
    );
    expect(result.kind === 'terminal-image' && result.placeholder).toBeTruthy();
    expect(
      result.kind === 'terminal-image' && result.placeholder?.lines[0],
    ).toContain('\u{10EEEE}');
  });

  it('rejects oversized Mermaid PNG output before reading it', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    createFakeMmdc(binDir, [
      'const fs = require("node:fs");',
      'const out = process.argv[process.argv.indexOf("-o") + 1];',
      'fs.closeSync(fs.openSync(out, "w"));',
      'fs.truncateSync(out, 8 * 1024 * 1024 + 1);',
    ]);

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A[Start] --> B[End]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
        QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
        QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'kitty',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'exceeded',
    );
  });

  it('evicts Mermaid image caches by retained byte size', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mmdc-'));
    tempDirs.push(binDir);
    const countPath = path.join(binDir, 'count.txt');
    createFakeMmdc(binDir, [
      'const fs = require("node:fs");',
      `const countPath = ${JSON.stringify(countPath)};`,
      'let count = 0;',
      'try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}',
      'fs.writeFileSync(countPath, String(count + 1));',
      'const out = process.argv[process.argv.indexOf("-o") + 1];',
      `fs.writeFileSync(out, Buffer.concat([Buffer.from("${PNG_1X1.toString(
        'base64',
      )}", "base64"), Buffer.alloc(7 * 1024 * 1024)]));`,
    ]);

    const env = {
      PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      QWEN_CODE_MERMAID_IMAGE_RENDERING: '1',
      QWEN_CODE_MERMAID_IMAGE_PROTOCOL: 'iterm2',
    };

    for (let index = 0; index < 5; index++) {
      const result = renderMermaidImageSync({
        source: `flowchart TD\n  A${index}[Start] --> B${index}[End]`,
        contentWidth: 80,
        availableTerminalHeight: 20,
        env,
      });
      expect(result.kind).toBe('terminal-image');
    }

    expect(fs.readFileSync(countPath, 'utf8')).toBe('5');

    const result = renderMermaidImageSync({
      source: 'flowchart TD\n  A0[Start] --> B0[End]',
      contentWidth: 80,
      availableTerminalHeight: 20,
      env,
    });

    expect(result.kind).toBe('terminal-image');
    expect(fs.readFileSync(countPath, 'utf8')).toBe('6');
  });
});
