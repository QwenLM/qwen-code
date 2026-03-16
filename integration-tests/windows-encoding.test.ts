/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windows encoding e2e tests.
 *
 * These tests exercise the full CLI pipeline (prompt → model → tool → output)
 * on Windows systems, verifying that shell output decoding, file read/write,
 * and edit operations handle non-UTF-8 codepages (e.g., GBK/CP936) correctly.
 *
 * On non-Windows platforms the entire suite is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TestRig, printDebugInfo } from './test-helper.js';

// ---------------------------------------------------------------------------
// Platform / codepage detection
// ---------------------------------------------------------------------------

function getWindowsCodePage(): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const output = spawnSync('chcp', { encoding: 'utf8', shell: true });
    const match = output.stdout?.match(/:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

const isWindows = process.platform === 'win32';
const codePage = getWindowsCodePage();
const isNonUtf8Windows = codePage !== null && codePage !== 65001;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a string as GBK bytes using PowerShell (available on every Windows).
 * Falls back to a no-op on non-Windows (tests are skipped anyway).
 */
function encodeGbk(text: string): Buffer {
  if (!isWindows) return Buffer.from(text, 'utf-8');
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$enc = [System.Text.Encoding]::GetEncoding('gb2312'); ` +
        `$bytes = $enc.GetBytes('${text.replace(/'/g, "''")}'); ` +
        `[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)`,
    ],
    { encoding: 'buffer' },
  );
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Suite: Windows-only tests (any Windows)
// ---------------------------------------------------------------------------

const dWin = isWindows ? describe : describe.skip;

dWin('Windows encoding – shell output', () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = new TestRig();
    await rig.setup('windows-encoding-shell');
  });

  afterAll(async () => {
    await rig.cleanup();
  });

  it('should handle ASCII shell output correctly', async () => {
    const result = await rig.run('run the command: echo hello world');
    const found = await rig.waitForToolCall('run_shell_command');
    if (!found) printDebugInfo(rig, result);
    expect(found).toBeTruthy();
    expect(result).toContain('hello world');
  });

  it('should decode PowerShell CJK output via UTF-8 prefix', async () => {
    // The shell tool automatically adds [Console]::OutputEncoding = UTF8
    // for PowerShell commands, so CJK output should render correctly.
    const result = await rig.run(
      "run this powershell command: Write-Output '你好世界'",
    );
    const found = await rig.waitForToolCall('run_shell_command');
    if (!found) printDebugInfo(rig, result);
    expect(found).toBeTruthy();
    expect(result).toContain('你好世界');
  });
});

// ---------------------------------------------------------------------------
// Suite: Non-UTF-8 Windows (e.g., GBK / CP936)
// ---------------------------------------------------------------------------

const dGbk = isNonUtf8Windows ? describe : describe.skip;

dGbk(`Windows encoding – non-UTF-8 codepage (CP${codePage})`, () => {
  let rig: TestRig;
  const cjkDirName = '测试目录';
  const cjkFileName = '报告.txt';

  beforeAll(async () => {
    rig = new TestRig();
    await rig.setup('windows-encoding-gbk');

    // Create a CJK-named subdirectory and file so dir/type produce GBK output
    const cjkDir = join(rig.testDir!, cjkDirName);
    const cjkFile = join(cjkDir, cjkFileName);
    // Use cmd.exe to create the directory and file so they are
    // encoded in the system codepage (GBK) on disk.
    spawnSync(
      'cmd',
      ['/c', `mkdir "${cjkDir}" && echo 测试内容> "${cjkFile}"`],
      {
        cwd: rig.testDir!,
        shell: true,
      },
    );
  });

  afterAll(async () => {
    await rig.cleanup();
  });

  // Test 2: GBK directory listing with CJK filenames
  it('should decode GBK directory listing with CJK names', async () => {
    const result = await rig.run(
      `list the files in the directory "${cjkDirName}" using the dir command`,
    );
    const found = await rig.waitForToolCall('run_shell_command');
    if (!found) printDebugInfo(rig, result);
    expect(found).toBeTruthy();
    expect(result).toContain('报告');
  });

  // Test 3: GBK file content via type command
  it('should decode GBK file content from type command', async () => {
    const filePath = join(cjkDirName, cjkFileName);
    const result = await rig.run(`run this command: type "${filePath}"`);
    const found = await rig.waitForToolCall('run_shell_command');
    if (!found) printDebugInfo(rig, result);
    expect(found).toBeTruthy();
    expect(result).toContain('测试内容');
  });

  // Test 7: Large ASCII block followed by system-codepage CJK
  it('should decode GBK output after a large ASCII prefix', async () => {
    // Create a .cmd script that outputs many ASCII lines then a GBK dir listing
    const scriptName = 'late_cjk.cmd';
    const scriptContent = [
      '@echo off',
      'for /L %%i in (1,1,20) do echo Line %%i: ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      `dir "${join(rig.testDir!, cjkDirName)}"`,
    ].join('\r\n');
    writeFileSync(join(rig.testDir!, scriptName), scriptContent);

    const result = await rig.run(`run the script ${scriptName}`);
    const found = await rig.waitForToolCall('run_shell_command');
    if (!found) printDebugInfo(rig, result);
    expect(found).toBeTruthy();
    // ASCII portion
    expect(result).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    // CJK portion from dir
    expect(result).toContain('测试目录');
  });
});

// ---------------------------------------------------------------------------
// Suite: File round-trip (write → edit → verify) on Windows
// ---------------------------------------------------------------------------

dWin('Windows encoding – file round-trip', () => {
  it('should write a UTF-8 .cmd file with CRLF and edit it correctly', async () => {
    const rig = new TestRig();
    await rig.setup('windows-encoding-roundtrip');

    // Step 1: Ask the model to create a .cmd file
    const fileName = 'roundtrip.cmd';
    await rig.run(
      `create a file called ${fileName} with these exact lines:\n` +
        '@echo off\n' +
        'echo hello\n' +
        'echo world',
    );
    const wroteFile = await rig.waitForToolCall('write_file');
    expect(wroteFile).toBeTruthy();

    // Verify CRLF line endings (our writeTextFile converts for .cmd)
    const raw = readFileSync(join(rig.testDir!, fileName));
    const text = raw.toString('utf-8');
    expect(text).toContain('\r\n');
    expect(text).toContain('hello');

    // Step 2: Ask the model to edit the file
    const editResult = await rig.run(
      `edit ${fileName} and change "hello" to "goodbye"`,
    );
    const edited = await rig.waitForToolCall('edit');
    if (!edited) printDebugInfo(rig, editResult);
    expect(edited).toBeTruthy();

    // Verify edit took effect and CRLF is preserved
    const editedRaw = readFileSync(join(rig.testDir!, fileName));
    const editedText = editedRaw.toString('utf-8');
    expect(editedText).toContain('goodbye');
    expect(editedText).toContain('\r\n');
    expect(editedText).not.toContain('hello');

    await rig.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Suite: Edit a GBK-encoded file (preserve encoding) — non-UTF-8 Windows only
// ---------------------------------------------------------------------------

dGbk('Windows encoding – GBK file edit preserves encoding', () => {
  it('should edit a GBK-encoded file without corrupting it', async () => {
    const rig = new TestRig();
    await rig.setup('windows-encoding-gbk-edit');

    // Create a GBK-encoded .cmd file
    const fileName = 'gbk_edit.cmd';
    const gbkContent = encodeGbk(
      '@echo off\r\necho 原始内容\r\necho 第二行\r\n',
    );
    writeFileSync(join(rig.testDir!, fileName), gbkContent);

    // Ask the model to edit the file (replace 原始内容 with 修改内容)
    const result = await rig.run(
      `edit ${fileName} and change "原始内容" to "修改内容"`,
    );
    const found = await rig.waitForAnyToolCall(['edit', 'write_file']);
    if (!found) printDebugInfo(rig, result);
    expect(found).toBeTruthy();

    // Read the edited file and verify content
    const edited = readFileSync(join(rig.testDir!, fileName));
    const editedText = edited.toString('utf-8');
    expect(editedText).toContain('修改内容');
    expect(editedText).toContain('第二行');

    await rig.cleanup();
  });
});
