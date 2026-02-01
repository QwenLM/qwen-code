/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

// Windows skip (Option A: avoid infra scope)
const d = process.platform === 'win32' ? describe.skip : describe;

// BOM encoders
const utf8BOM = (s: string) =>
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
const utf16LE = (s: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16BE = (s: string) => {
  const bom = Buffer.from([0xfe, 0xff]);
  const le = Buffer.from(s, 'utf16le');
  le.swap16();
  return Buffer.concat([bom, le]);
};
const utf32LE = (s: string) => {
  const bom = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
  const cps = Array.from(s, (c) => c.codePointAt(0)!);
  const payload = Buffer.alloc(cps.length * 4);
  cps.forEach((cp, i) => {
    const o = i * 4;
    payload[o] = cp & 0xff;
    payload[o + 1] = (cp >>> 8) & 0xff;
    payload[o + 2] = (cp >>> 16) & 0xff;
    payload[o + 3] = (cp >>> 24) & 0xff;
  });
  return Buffer.concat([bom, payload]);
};
const utf32BE = (s: string) => {
  const bom = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
  const cps = Array.from(s, (c) => c.codePointAt(0)!);
  const payload = Buffer.alloc(cps.length * 4);
  cps.forEach((cp, i) => {
    const o = i * 4;
    payload[o] = (cp >>> 24) & 0xff;
    payload[o + 1] = (cp >>> 16) & 0xff;
    payload[o + 2] = (cp >>> 8) & 0xff;
    payload[o + 3] = cp & 0xff;
  });
  return Buffer.concat([bom, payload]);
};

let rig: TestRig;
let dir: string;

d('BOM end-to-end integration', () => {
  beforeAll(async () => {
    rig = new TestRig();
    await rig.setup('bom-integration');
    dir = rig.testDir!;
  });

  afterAll(async () => {
    await rig.cleanup();
  });

  async function runAndAssert(
    filename: string,
    content: Buffer,
    expectedText: string | null,
  ) {
    writeFileSync(join(dir, filename), content);
    const prompt = `read the file ${filename} and output its exact contents`;
    const output = await rig.run(prompt);
    await rig.waitForToolCall('read_file');
    const lower = output.toLowerCase();
    if (expectedText === null) {
      expect(
        lower.includes('binary') ||
          lower.includes('skipped binary file') ||
          lower.includes('cannot display'),
      ).toBeTruthy();
    } else {
      expect(output.includes(expectedText)).toBeTruthy();
      expect(lower.includes('skipped binary file')).toBeFalsy();
    }
  }

  it('UTF-8 BOM', async () => {
    await runAndAssert('utf8.txt', utf8BOM('BOM_OK UTF-8'), 'BOM_OK UTF-8');
  });

  it('UTF-16 LE BOM', async () => {
    await runAndAssert(
      'utf16le.txt',
      utf16LE('BOM_OK UTF-16LE'),
      'BOM_OK UTF-16LE',
    );
  });

  it('UTF-16 BE BOM', async () => {
    await runAndAssert(
      'utf16be.txt',
      utf16BE('BOM_OK UTF-16BE'),
      'BOM_OK UTF-16BE',
    );
  });

  it('UTF-32 LE BOM', async () => {
    await runAndAssert(
      'utf32le.txt',
      utf32LE('BOM_OK UTF-32LE'),
      'BOM_OK UTF-32LE',
    );
  });

  it('UTF-32 BE BOM', async () => {
    await runAndAssert(
      'utf32be.txt',
      utf32BE('BOM_OK UTF-32BE'),
      'BOM_OK UTF-32BE',
    );
  });

  it('should preserve UTF-8 BOM when editing existing file', async () => {
    // Create a file with UTF-8 BOM and Chinese content
    const originalContent =
      '// 这是一个测试文件\n// 包含中文注释\nfunction test() {\n  return "hello";\n}\n';
    const fileWithBOM = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(originalContent, 'utf8'),
    ]);

    const filename = 'bom-test.js';
    writeFileSync(join(dir, filename), fileWithBOM);

    // Ask Qwen Code to edit the file
    const prompt = `edit the file ${filename} to change the return value from "hello" to "world"`;
    await rig.run(prompt);
    await rig.waitForToolCall('edit_file');

    // Read the modified file as raw bytes
    const modifiedBuffer = readFileSync(join(dir, filename));

    // Verify BOM is preserved (first 3 bytes should be EF BB BF)
    expect(modifiedBuffer[0]).toBe(0xef);
    expect(modifiedBuffer[1]).toBe(0xbb);
    expect(modifiedBuffer[2]).toBe(0xbf);

    // Verify the content was actually changed to include 'world'
    const modifiedContent = modifiedBuffer.toString('utf8');
    expect(modifiedContent).toContain('world');
  });

  it('should preserve UTF-8 BOM when overwriting file with write_file', async () => {
    // Create a file with UTF-8 BOM
    const originalContent = '// Original BOM file\nconst x = 1;\n';
    const fileWithBOM = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(originalContent, 'utf8'),
    ]);

    const filename = 'bom-overwrite.js';
    writeFileSync(join(dir, filename), fileWithBOM);

    // Ask Qwen Code to overwrite the file with new content
    const prompt = `overwrite the file ${filename} with: const y = 2;\n// new content`;
    await rig.run(prompt);
    await rig.waitForToolCall('write_file');

    // Read the modified file as raw bytes
    const modifiedBuffer = readFileSync(join(dir, filename));

    // Verify BOM is preserved (first 3 bytes should be EF BB BF)
    expect(modifiedBuffer[0]).toBe(0xef);
    expect(modifiedBuffer[1]).toBe(0xbb);
    expect(modifiedBuffer[2]).toBe(0xbf);

    // Verify the new content includes 'const y = 2'
    const modifiedContent = modifiedBuffer.toString('utf8');
    expect(modifiedContent).toContain('const y = 2');
  });
});

describe('BOM with defaultFileEncoding configuration', () => {
  it('should create new file with BOM when defaultFileEncoding is utf-8-bom', async () => {
    const rigWithBOM = new TestRig();
    await rigWithBOM.setup('bom-default-encoding', {
      settings: {
        general: {
          defaultFileEncoding: 'utf-8-bom',
        },
      },
    });

    const filename = 'new-file-with-bom.js';

    // Ask Qwen Code to create a new file
    const prompt = `create a new file called ${filename} with content: const greeting = "hello";`;
    await rigWithBOM.run(prompt);
    await rigWithBOM.waitForToolCall('write_file');

    // Read the created file as raw bytes
    const filePath = join(rigWithBOM.testDir!, filename);
    const fileBuffer = readFileSync(filePath);

    // Verify BOM is present (first 3 bytes should be EF BB BF)
    expect(fileBuffer[0]).toBe(0xef);
    expect(fileBuffer[1]).toBe(0xbb);
    expect(fileBuffer[2]).toBe(0xbf);

    // Verify the content includes the expected string
    const fileContent = fileBuffer.toString('utf8');
    expect(fileContent).toContain('const greeting');

    await rigWithBOM.cleanup();
  });
});
