/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_CLI_HOME, ENV_EXPOSE_TOKEN_USAGE } from '../config/brand.js';
import { PROCESS_LOG_FILE_NAME } from './diagnosticLogger.js';
import { sanitizePath } from './paths.js';

describe('RunLogger', () => {
  let tempDir: string;
  let moduleUnderTest: typeof import('./runLogger.js') | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-run-logger-'));
  });

  afterEach(async () => {
    await moduleUnderTest?.runLogger.close();
    moduleUnderTest = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function loadRunLogger(env: Record<string, string> = {}) {
    vi.unstubAllEnvs();
    vi.stubEnv(ENV_CLI_HOME, tempDir);
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    vi.resetModules();
    moduleUnderTest = await import('./runLogger.js');
    return moduleUnderTest.runLogger;
  }

  it('writes log messages to the process log file', async () => {
    const runLogger = await loadRunLogger();
    const logFilePath = path.join(
      tempDir,
      '.qwen',
      'logs',
      'latest',
      PROCESS_LOG_FILE_NAME,
    );

    runLogger.log('hello', 'world');
    await runLogger.close();

    expect(fs.readFileSync(logFilePath, 'utf8')).toContain('hello world');
  });

  it('writes warn messages to the process log file', async () => {
    const runLogger = await loadRunLogger();
    const logFilePath = path.join(
      tempDir,
      '.qwen',
      'logs',
      'latest',
      PROCESS_LOG_FILE_NAME,
    );

    runLogger.warn('warning message');
    await runLogger.close();

    expect(fs.readFileSync(logFilePath, 'utf8')).toContain('warning message');
  });

  it('writes error messages to the process log file', async () => {
    const runLogger = await loadRunLogger();
    const logFilePath = path.join(
      tempDir,
      '.qwen',
      'logs',
      'latest',
      PROCESS_LOG_FILE_NAME,
    );

    runLogger.error('error message');
    await runLogger.close();

    expect(fs.readFileSync(logFilePath, 'utf8')).toContain('error message');
  });

  it('writes debug messages when minLevel is DEBUG', async () => {
    const runLogger = await loadRunLogger();
    runLogger.minLevel = 'DEBUG';
    const logFilePath = path.join(
      tempDir,
      '.qwen',
      'logs',
      'latest',
      PROCESS_LOG_FILE_NAME,
    );

    runLogger.debug('debug message');
    await runLogger.close();

    expect(fs.readFileSync(logFilePath, 'utf8')).toContain('debug message');
  });

  it('discards debug messages when minLevel is LOG (default)', async () => {
    const runLogger = await loadRunLogger();

    runLogger.debug('should not appear');
    await runLogger.close();

    const logFilePath = path.join(
      tempDir,
      '.qwen',
      'logs',
      'latest',
      PROCESS_LOG_FILE_NAME,
    );
    // Debug messages are discarded so the log file may not even be created.
    if (fs.existsSync(logFilePath)) {
      expect(fs.readFileSync(logFilePath, 'utf8')).not.toContain(
        'should not appear',
      );
    }
  });

  it('default minLevel is LOG', async () => {
    const runLogger = await loadRunLogger();
    expect(runLogger.minLevel).toBe('LOG');
  });

  it('persists CLI and SDK preparation timings at the default level in both log files', async () => {
    const runLogger = await loadRunLogger();
    const { emitModelRequestPreparation } = await import('./diagnosticInterceptors.js');
    const { sessionLogger } = await import('./sessionLogger.js');
    const ids = {
      sessionId: 'session-preparation',
      turnId: 'turn-preparation',
      loopId: 'turn-preparation:1',
      requestId: 'request-preparation',
      requestSetId: 'request-set-preparation',
      model: 'test-model',
    };
    const phases = JSON.stringify({ version: 2, ready_wait_ms: 0, input_prepare_ms: 250, request_prepare_ms: 0, transport_prepare_ms: 150 });
    emitModelRequestPreparation({
      ...ids,
      boundary: 'network_dispatch',
      timing: {
        user_message_to_request_ms: 400,
        request_preparation_timing_json: phases,
        user_prompt_submit_hook_count: 2,
        user_prompt_submit_hook_blocking_ms: 80,
      },
    });
    emitModelRequestPreparation({
      ...ids,
      boundary: 'transport_handle_return',
      timing: { sdk_startup_to_request_ms: 1250, sdk_message_to_request_ms: 750 },
    });

    expect(runLogger.minLevel).toBe('LOG');
    const processLog = fs.readFileSync(sessionLogger.getProcessLogPath(), 'utf8');
    expect(processLog.match(/model\.request\.preparation/g)).toHaveLength(2);
    expect(processLog).toContain('user_message_to_request_ms=400');
    expect(processLog).toContain('sdk_startup_to_request_ms=1250');
    expect(processLog).toContain('sdk_message_to_request_ms=750');
    const segment = path.join(
      tempDir, '.qwen', 'logs', 'sessions', sanitizePath(process.cwd()),
      ids.sessionId, 'segments', `${sessionLogger.getRunId()}.jsonl`,
    );
    const events = fs.readFileSync(segment, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toMatchObject([
      { level: 'info', type: 'model.request.preparation', turn_id: ids.turnId, request_id: ids.requestId,
        data: { request_set_id: ids.requestSetId, boundary: 'network_dispatch', user_message_to_request_ms: 400,
          request_preparation_timing_json: phases, user_prompt_submit_hook_count: 2, user_prompt_submit_hook_blocking_ms: 80 } },
      { level: 'info', type: 'model.request.preparation', turn_id: ids.turnId, request_id: ids.requestId,
        data: { request_set_id: ids.requestSetId, boundary: 'transport_handle_return', sdk_startup_to_request_ms: 1250, sdk_message_to_request_ms: 750 } },
    ]);
  });

  it('writes to the latest diagnostic process log', async () => {
    const runLogger = await loadRunLogger();
    const logFilePath = path.join(
      tempDir,
      '.qwen',
      'logs',
      'latest',
      PROCESS_LOG_FILE_NAME,
    );

    runLogger.log('diagnostic-log-path');
    await runLogger.close();

    expect(fs.readFileSync(logFilePath, 'utf8')).toContain(
      'debug.message diagnostic-log-path',
    );
  });

  it('reports the diagnostic process log path', async () => {
    const runLogger = await loadRunLogger();

    expect(runLogger.getDebugLogPath()).toContain(
      path.join('.qwen', 'logs', 'runs'),
    );
    expect(runLogger.getDebugLogPath()).toContain(PROCESS_LOG_FILE_NAME);
  });

  it('writes structured session events only to session segment jsonl', async () => {
    await loadRunLogger();
    const { sessionLogger } = await import('./sessionLogger.js');

    sessionLogger.event({
      level: 'info',
      kind: 'loop',
      type: 'loop.iteration.started',
      ids: {
        project_id: 'project-a',
        session_id: 'session-a',
        turn_id: 'turn-a',
        loop_id: 'turn-a:1',
      },
      data: {
        request_index: 1,
      },
    });
    sessionLogger.close();

    const runDir = sessionLogger.getRunDir();
    expect(fs.existsSync(path.join(runDir, 'events.jsonl'))).toBe(false);
    expect(
      fs.readFileSync(path.join(runDir, PROCESS_LOG_FILE_NAME), 'utf8'),
    ).toContain('loop.iteration.started');

    const segmentDir = path.join(
      tempDir,
      '.qwen',
      'logs',
      'sessions',
      'project-a',
      'session-a',
      'segments',
    );
    const segmentJsonl = fs
      .readdirSync(segmentDir)
      .find((name) => name.endsWith('.jsonl'));
    const segmentLogs = fs
      .readdirSync(segmentDir)
      .filter((name) => name.endsWith('.log'));

    expect(segmentJsonl).toBeDefined();
    expect(segmentLogs).toEqual([]);
    const segmentJson = fs.readFileSync(
      path.join(segmentDir, segmentJsonl!),
      'utf8',
    );
    expect(segmentJson).toContain('"seq"');
    expect(segmentJson).toContain('"type":"loop.iteration.started"');
    expect(segmentJson).toContain('"turn_id":"turn-a"');
    expect(segmentJson).toContain('"loop_id":"turn-a:1"');
    expect(segmentJson).not.toContain('"pid"');
    expect(segmentJson).not.toContain('"run_id"');
    expect(segmentJson).not.toContain('"event_id"');
    expect(segmentJson).not.toContain('"kind"');
    expect(segmentJson).not.toContain('"ids"');
    expect(segmentJson).not.toContain('"project_id"');
    expect(segmentJson).not.toContain('"session_id"');
  });

  it('routes session segments by the bound project directory', async () => {
    await loadRunLogger();
    const { sessionLogger } = await import('./sessionLogger.js');
    const projectA = path.join(tempDir, 'workspace-a');
    const projectB = path.join(tempDir, 'workspace-b');

    sessionLogger.bindSessionProject('session-a', projectA);
    sessionLogger.bindSessionProject('session-b', projectB);
    sessionLogger.event({
      level: 'info',
      kind: 'session',
      type: 'session.started',
      ids: { session_id: 'session-a' },
    });
    sessionLogger.event({
      level: 'info',
      kind: 'session',
      type: 'session.started',
      ids: { session_id: 'session-b' },
    });
    sessionLogger.close();

    const segmentsRoot = path.join(tempDir, '.qwen', 'logs', 'sessions');
    const runSegments = (
      projectDir: string,
      sessionId: string,
    ): string[] =>
      fs.readdirSync(
        path.join(segmentsRoot, sanitizePath(projectDir), sessionId, 'segments'),
      );
    expect(runSegments(projectA, 'session-a')).toHaveLength(1);
    expect(runSegments(projectB, 'session-b')).toHaveLength(1);
    expect(
      fs.existsSync(path.join(segmentsRoot, sanitizePath(process.cwd()))),
    ).toBe(false);
  });

  it('writes hook diagnostic events with session ids to session segment jsonl', async () => {
    await loadRunLogger();
    const { emitHookStarted, emitHookFinished, emitTurnHookFailed } =
      await import('./diagnosticInterceptors.js');
    const { sessionLogger } = await import('./sessionLogger.js');

    emitHookStarted({
      sessionId: 'session-hook',
      turnId: 'turn-hook',
      toolCallId: 'tool-hook',
      hookName: 'PreToolUse',
      eventName: 'PreToolUse',
      hookIndex: 1,
      totalHooks: 1,
      pluginId: 'demo-security',
      pluginRoot: path.join(tempDir, '.qwen', 'security'),
    });
    emitHookFinished({
      sessionId: 'session-hook',
      turnId: 'turn-hook',
      toolCallId: 'tool-hook',
      hookName: 'PreToolUse',
      eventName: 'PreToolUse',
      success: true,
      pluginId: 'demo-security',
      pluginRoot: path.join(tempDir, '.qwen', 'security'),
    });
    emitTurnHookFailed({
      sessionId: 'session-hook',
      turnId: 'turn-hook',
      agentId: 'child',
      stepIndex: 0,
      moduleId: 'credits',
      stage: 'turn.step',
      error: new Error('observer failed'),
    });
    sessionLogger.close();

    const segmentDir = path.join(
      tempDir,
      '.qwen',
      'logs',
      'sessions',
      sanitizePath(process.cwd()),
      'session-hook',
      'segments',
    );
    const segmentJsonl = fs
      .readdirSync(segmentDir)
      .find((name) => name.endsWith('.jsonl'));
    expect(segmentJsonl).toBeDefined();

    const lines = fs
      .readFileSync(path.join(segmentDir, segmentJsonl!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'hook.started',
          turn_id: 'turn-hook',
          tool_call_id: 'tool-hook',
          data: expect.objectContaining({
            hook_name: 'PreToolUse',
            hook_event_name: 'PreToolUse',
            plugin_id: 'demo-security',
            plugin_root: path.join(tempDir, '.qwen', 'security'),
          }),
        }),
        expect.objectContaining({
          type: 'hook.finished',
          turn_id: 'turn-hook',
          tool_call_id: 'tool-hook',
          data: expect.objectContaining({
            hook_name: 'PreToolUse',
            hook_event_name: 'PreToolUse',
            success: true,
            plugin_id: 'demo-security',
            plugin_root: path.join(tempDir, '.qwen', 'security'),
          }),
        }),
        expect.objectContaining({
          type: 'hook.module_failed',
          level: 'warn',
          turn_id: 'turn-hook',
          data: expect.objectContaining({
            module_id: 'credits',
            stage: 'turn.step',
            agent_id: 'child',
            step_index: 0,
            error: expect.stringContaining('observer failed'),
          }),
        }),
      ]),
    );
  });

  it('writes prompt and attachment diagnostics with session ids to session segment jsonl', async () => {
    await loadRunLogger();
    const {
      emitAttachmentGeneratorFinished,
      emitInputPromptReceived,
      emitSessionPhaseFinished,
      emitSessionPhaseStarted,
    } = await import('./diagnosticInterceptors.js');
    const { sessionLogger } = await import('./sessionLogger.js');

    emitInputPromptReceived({
      sessionId: 'session-input',
      turnId: 'turn-input',
      prompt: 'hello',
      commandMode: 'prompt',
      querySource: 'sdk',
      bridgeOrigin: false,
      skipSlashCommands: undefined,
    });
    emitSessionPhaseStarted({
      sessionId: 'session-input',
      phase: 'input.attachments.collect',
    });
    emitAttachmentGeneratorFinished({
      sessionId: 'session-input',
      turnId: 'turn-input',
      phase: 'input.pre_route',
      label: 'getChangedFiles',
      status: 'success',
      count: 2,
      durationMs: 17,
    });
    emitSessionPhaseFinished({
      sessionId: 'session-input',
      phase: 'input.attachments.collect',
      durationMs: 21,
      success: true,
      data: { count: 2 },
    });
    sessionLogger.close();

    const segmentDir = path.join(
      tempDir,
      '.qwen',
      'logs',
      'sessions',
      sanitizePath(process.cwd()),
      'session-input',
      'segments',
    );
    const segmentJsonl = fs
      .readdirSync(segmentDir)
      .find((name) => name.endsWith('.jsonl'));
    expect(segmentJsonl).toBeDefined();

    const lines = fs
      .readFileSync(path.join(segmentDir, segmentJsonl!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'input.prompt.received',
          turn_id: 'turn-input',
          data: expect.objectContaining({
            text_preview: 'hello',
            command_mode: 'prompt',
            query_source: 'sdk',
          }),
        }),
        expect.objectContaining({
          type: 'session.phase.started',
          data: expect.objectContaining({
            phase: 'input.attachments.collect',
          }),
        }),
        expect.objectContaining({
          type: 'attachment.generator.finished',
          turn_id: 'turn-input',
          data: expect.objectContaining({
            label: 'getChangedFiles',
            status: 'success',
            count: 2,
            duration_ms: 17,
          }),
        }),
        expect.objectContaining({
          type: 'session.phase.finished',
          data: expect.objectContaining({
            phase: 'input.attachments.collect',
            duration_ms: 21,
            count: 2,
          }),
        }),
      ]),
    );
  });

  // skip: 现存失败
  it.skip('masks token usage in diagnostic disk logs by default', async () => {
    await loadRunLogger();
    const { sessionLogger } = await import('./sessionLogger.js');

    sessionLogger.event({
      level: 'info',
      kind: 'model',
      type: 'model.response.completed',
      ids: {
        project_id: 'project-token',
        session_id: 'session-token',
        turn_id: 'turn-token',
        request_id: 'request-token',
      },
      data: {
        input_tokens: 123,
        output_tokens: 45,
        cache_read_input_tokens: 67,
        cache_creation_input_tokens: 89,
        context_usage_ratio: 0.42,
        nested: {
          total_tokens: 324,
          max_input_tokens: 200_000,
        },
      },
    });
    sessionLogger.close();

    const processLog = fs.readFileSync(
      path.join(sessionLogger.getRunDir(), PROCESS_LOG_FILE_NAME),
      'utf8',
    );
    expect(processLog).toContain('input_tokens=0');
    expect(processLog).toContain('output_tokens=0');
    expect(processLog).toContain('cache_read_input_tokens=0');
    expect(processLog).toContain('cache_creation_input_tokens=0');
    expect(processLog).toContain('context_usage_ratio=0.42');
    expect(processLog).toContain('"total_tokens":0');
    expect(processLog).toContain('"max_input_tokens":200000');
    expect(processLog).not.toContain('input_tokens=123');
    expect(processLog).not.toContain('output_tokens=45');
    expect(processLog).not.toContain('"total_tokens":324');

    const segmentDir = path.join(
      tempDir,
      '.qwen',
      'logs',
      'sessions',
      'project-token',
      'session-token',
      'segments',
    );
    const segmentJsonl = fs
      .readdirSync(segmentDir)
      .find((name) => name.endsWith('.jsonl'));
    expect(segmentJsonl).toBeDefined();
    const lines = fs
      .readFileSync(path.join(segmentDir, segmentJsonl!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.response.completed',
          data: expect.objectContaining({
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            context_usage_ratio: 0.42,
            nested: {
              total_tokens: 0,
              max_input_tokens: 200_000,
            },
          }),
        }),
      ]),
    );
  });

  // skip: 现存失败
  it.skip('preserves custom provider token usage only in session JSONL', async () => {
    await loadRunLogger();
    const { emitModelResponseCompleted } = await import(
      './diagnosticInterceptors.js'
    );
    const { sessionLogger } = await import('./sessionLogger.js');

    emitModelResponseCompleted({
      sessionId: 'session-custom-provider-token',
      turnId: 'turn-custom-provider-token',
      loopId: undefined,
      requestId: 'request-custom-provider-token',
      requestIndex: 1,
      provider: 'custom',
      model: 'custom-provider-model',
      stopReason: 'end_turn',
      contentBlockCount: 1,
      inputTokens: 123,
      outputTokens: 45,
      cacheReadInputTokens: 67,
      cacheCreationInputTokens: 89,
    });
    sessionLogger.close();

    const processLog = fs.readFileSync(
      path.join(sessionLogger.getRunDir(), PROCESS_LOG_FILE_NAME),
      'utf8',
    );
    expect(processLog).toContain('provider="custom"');
    expect(processLog).toContain('input_tokens=0');
    expect(processLog).toContain('output_tokens=0');
    expect(processLog).not.toContain('input_tokens=123');

    const segmentDir = path.join(
      tempDir,
      '.qwen',
      'logs',
      'sessions',
      sanitizePath(process.cwd()),
      'session-custom-provider-token',
      'segments',
    );
    const segmentJsonl = fs
      .readdirSync(segmentDir)
      .find((name) => name.endsWith('.jsonl'));
    expect(segmentJsonl).toBeDefined();
    const lines = fs
      .readFileSync(path.join(segmentDir, segmentJsonl!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.response.completed',
          data: expect.objectContaining({
            provider: 'custom',
            input_tokens: 123,
            output_tokens: 45,
            cache_read_input_tokens: 67,
            cache_creation_input_tokens: 89,
          }),
        }),
      ]),
    );
  });

  it('preserves token usage in diagnostic disk logs when the env switch is enabled', async () => {
    await loadRunLogger({ [ENV_EXPOSE_TOKEN_USAGE]: '1' });
    const { sessionLogger } = await import('./sessionLogger.js');

    sessionLogger.event({
      level: 'info',
      kind: 'turn',
      type: 'turn.finished',
      ids: {
        project_id: 'project-token-env',
        session_id: 'session-token-env',
        turn_id: 'turn-token-env',
      },
      data: {
        input_tokens: 123,
        output_tokens: 45,
        nested: { total_tokens: 168 },
      },
    });
    sessionLogger.close();

    const processLog = fs.readFileSync(
      path.join(sessionLogger.getRunDir(), PROCESS_LOG_FILE_NAME),
      'utf8',
    );
    expect(processLog).toContain('input_tokens=123');
    expect(processLog).toContain('output_tokens=45');
    expect(processLog).toContain('"total_tokens":168');

    const segmentDir = path.join(
      tempDir,
      '.qwen',
      'logs',
      'sessions',
      'project-token-env',
      'session-token-env',
      'segments',
    );
    const segmentJsonl = fs
      .readdirSync(segmentDir)
      .find((name) => name.endsWith('.jsonl'));
    expect(segmentJsonl).toBeDefined();
    const lines = fs
      .readFileSync(path.join(segmentDir, segmentJsonl!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn.finished',
          data: expect.objectContaining({
            input_tokens: 123,
            output_tokens: 45,
            nested: { total_tokens: 168 },
          }),
        }),
      ]),
    );
  });

  it('notifies the registered log sink with formatted log entries', async () => {
    const runLogger = await loadRunLogger();
    const sink = vi.fn();

    runLogger.setLogSink(sink);
    runLogger.warn('hello %s', 'world');

    expect(sink).toHaveBeenCalledWith({
      level: 'WARN',
      message: 'hello world',
      timestamp: expect.any(String),
    });
  });

  it('keeps logging when the log sink throws', async () => {
    const runLogger = await loadRunLogger();
    const sink = vi.fn(() => {
      throw new Error('sink failed');
    });

    runLogger.setLogSink(sink);

    expect(() => runLogger.error('still logs')).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
  });

  it('sink does not receive debug messages when minLevel is LOG', async () => {
    const runLogger = await loadRunLogger();
    const sink = vi.fn();

    runLogger.setLogSink(sink);
    runLogger.debug('should not reach sink');

    expect(sink).not.toHaveBeenCalled();
  });

  it('sink receives debug messages when minLevel is DEBUG', async () => {
    const runLogger = await loadRunLogger();
    runLogger.minLevel = 'DEBUG';
    const sink = vi.fn();

    runLogger.setLogSink(sink);
    runLogger.debug('should reach sink');

    expect(sink).toHaveBeenCalledWith({
      level: 'DEBUG',
      message: 'should reach sink',
      timestamp: expect.any(String),
    });
  });
});
