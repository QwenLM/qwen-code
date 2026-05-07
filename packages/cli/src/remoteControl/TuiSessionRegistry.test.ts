/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TuiSessionRegistry } from './TuiSessionRegistry.js';

describe('TuiSessionRegistry', () => {
  let tmpDir: string;
  let inputFile: string;
  let outputFile: string;
  let registry: TuiSessionRegistry | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-tui-registry-'));
    inputFile = path.join(tmpDir, 'input.jsonl');
    outputFile = path.join(tmpDir, 'output.jsonl');
    fs.writeFileSync(inputFile, '');
    fs.writeFileSync(outputFile, '');
  });

  afterEach(() => {
    registry?.shutdown();
    registry = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes the current TUI as a single attachable session', () => {
    registry = new TuiSessionRegistry({
      sessionId: 'session-1',
      cwd: tmpDir,
      model: 'qwen3-coder',
      permissionMode: 'default',
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });

    expect(registry.listSessions()).toMatchObject([
      {
        id: 'session-1',
        cwd: tmpDir,
        model: 'qwen3-coder',
        permissionMode: 'default',
        mode: 'tui',
      },
    ]);
    expect(registry.createSession({ mode: 'tui' }).id).toBe('session-1');
    expect(() => registry?.createSession({ mode: 'worker' })).toThrow(
      'Unsupported remote session mode',
    );
  });

  it('writes remote commands into the TUI input file', () => {
    registry = new TuiSessionRegistry({
      sessionId: 'session-1',
      cwd: tmpDir,
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });

    registry.submit('session-1', 'hello');
    registry.respondToTool('session-1', {
      requestId: 'req-1',
      behavior: 'deny',
    });
    registry.interrupt('session-1');
    registry.setModel('session-1', 'qwen3-coder');
    registry.setPermissionMode('session-1', 'auto-edit');

    const lines = fs
      .readFileSync(inputFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]).toEqual({ type: 'submit', text: 'hello' });
    expect(lines[1]).toEqual({
      type: 'confirmation_response',
      request_id: 'req-1',
      allowed: false,
    });
    expect(lines[2]?.['type']).toBe('interrupt');
    expect(lines[3]).toMatchObject({
      type: 'set_model',
      model: 'qwen3-coder',
    });
    expect(lines[4]).toMatchObject({
      type: 'set_permission_mode',
      mode: 'auto-edit',
    });
  });

  it('maps dual-output lines into remote-control events and session state', async () => {
    registry = new TuiSessionRegistry({
      sessionId: 'session-1',
      cwd: tmpDir,
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });
    const listener = vi.fn();
    registry.subscribe(listener);

    fs.appendFileSync(
      outputFile,
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'read_file',
          tool_use_id: 'tool-1',
          input: { path: 'README.md' },
        },
      }) +
        '\n' +
        JSON.stringify({ type: 'result', subtype: 'success' }) +
        '\n',
    );

    await registry.checkForOutput();
    const replay = registry.replay('session-1');
    expect(replay.events.map((event) => event.type)).toContain(
      'control/request',
    );
    expect(registry.getSession('session-1').state).toBe('idle');
    expect(listener).toHaveBeenCalled();
  });

  it('buffers incomplete dual-output lines until the newline arrives', async () => {
    registry = new TuiSessionRegistry({
      sessionId: 'session-1',
      cwd: tmpDir,
      inputFilePath: inputFile,
      outputFilePath: outputFile,
    });

    fs.appendFileSync(outputFile, '{"type":"result"');
    await registry.checkForOutput();
    expect(registry.replay('session-1').events).not.toContainEqual(
      expect.objectContaining({ type: 'event/append' }),
    );

    fs.appendFileSync(outputFile, ',"subtype":"success"}\n');
    await registry.checkForOutput();
    expect(registry.replay('session-1').events).toContainEqual(
      expect.objectContaining({ type: 'event/append' }),
    );
  });
});
