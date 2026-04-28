/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildKittyPlaceholder,
  detectTerminalImageProtocol,
  encodeITerm2InlineImage,
  encodeKittyImage,
  encodeKittyVirtualImage,
  readPngSize,
  renderMermaidImageSync,
} from './mermaidImageRenderer.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const tempDirs: string[] = [];

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

afterEach(() => {
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
});
