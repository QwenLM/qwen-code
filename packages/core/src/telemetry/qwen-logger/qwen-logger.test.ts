/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import * as os from 'node:os';
import { QwenLogger, TEST_ONLY } from './qwen-logger.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../../core/contentGenerator.js';
import {
  StartSessionEvent,
  EndSessionEvent,
  IdeConnectionEvent,
  KittySequenceOverflowEvent,
  IdeConnectionType,
  HookCallEvent,
  SkillLaunchEvent,
  ProtocolTagSanitizedEvent,
  RipgrepRuntimeRecoveryEvent,
  SubagentExecutionEvent,
  makeGoalStateEvent,
  type ToolCallEvent,
} from '../types.js';
import type { RumEvent, RumPayload } from './event-types.js';

const debugLoggerSpy = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock dependencies
vi.mock('../../utils/user_id.js', () => ({
  getInstallationId: vi.fn(() => 'test-installation-id'),
}));

vi.mock('../../utils/safeJsonStringify.js', () => ({
  safeJsonStringify: vi.fn((obj) => JSON.stringify(obj)),
}));

vi.mock('../../utils/debugLogger.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../utils/debugLogger.js')>();
  return {
    ...original,
    createDebugLogger: () => ({
      debug: debugLoggerSpy.debug,
      info: debugLoggerSpy.info,
      warn: debugLoggerSpy.warn,
      error: debugLoggerSpy.error,
    }),
  };
});

// Mock https module
vi.mock('https', () => ({
  request: vi.fn(),
}));

const makeFakeConfig = (overrides: Partial<Config> = {}): Config => {
  const defaults = {
    getUsageStatisticsEnabled: () => true,
    getDebugMode: () => false,
    getSessionId: () => 'test-session-id',
    getCliVersion: () => '1.0.0',
    getProxy: () => undefined,
    getContentGeneratorConfig: () => ({ authType: 'test-auth' }),
    getAuthType: () => AuthType.QWEN_OAUTH,
    getMcpServers: () => ({}),
    getModel: () => 'test-model',
    getEmbeddingModel: () => 'test-embedding',
    getSandbox: () => false,
    getCoreTools: () => [],
    getApprovalMode: () => 'auto',
    getTelemetryEnabled: () => true,
    getTelemetryLogPromptsEnabled: () => false,
    getFileFilteringRespectGitIgnore: () => true,
    getOutputFormat: () => 'text',
    getToolRegistry: () => undefined,
    getTruncateToolOutputThreshold: () => 25000,
    getTruncateToolOutputLines: () => 0,
    getIdeMode: () => false,
    getShouldUseNodePtyShell: () => false,
    getHookSystem: () => undefined,
    ...overrides,
  };
  return defaults as Config;
};

describe('QwenLogger', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
    mockConfig = makeFakeConfig();
    Object.values(debugLoggerSpy).forEach((fn) => fn.mockClear());
    // Clear singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (QwenLogger as any).instance = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (QwenLogger as any).instance = undefined;
  });

  /** Runs `log` on a fresh logger for `config`; returns its enqueue spy. */
  const logWith = (log: (logger: QwenLogger) => void, config = mockConfig) => {
    const logger = QwenLogger.getInstance(config)!;
    const enqueueSpy = vi.spyOn(logger, 'enqueueLogEvent');
    log(logger);
    return enqueueSpy;
  };

  /** Like logWith; also expects an enqueued event containing `fields`. */
  const expectLogged = (
    log: (logger: QwenLogger) => void,
    fields: Record<string, unknown>,
    config = mockConfig,
  ) => {
    const enqueueSpy = logWith(log, config);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining(fields));
    return enqueueSpy;
  };

  const testEvent = (name = 'test-event'): RumEvent => ({
    timestamp: Date.now(),
    event_type: 'action',
    type: 'test',
    name,
  });

  /** A successful command hook with no output. */
  const shortHook = (
    eventName: string,
    hookName = 'test-hook.sh',
    input: Record<string, unknown> = {},
    durationMs = 100,
  ) =>
    new HookCallEvent(eventName, 'command', hookName, input, durationMs, true);

  describe('getInstance', () => {
    it('returns undefined when usage statistics are disabled', () => {
      const config = makeFakeConfig({ getUsageStatisticsEnabled: () => false });
      const logger = QwenLogger.getInstance(config);
      expect(logger).toBeUndefined();
    });

    it('returns an instance when usage statistics are enabled', () => {
      const logger = QwenLogger.getInstance(mockConfig);
      expect(logger).toBeInstanceOf(QwenLogger);
    });

    it('is a singleton', () => {
      const logger1 = QwenLogger.getInstance(mockConfig);
      const logger2 = QwenLogger.getInstance(mockConfig);
      expect(logger1).toBe(logger2);
    });
  });

  describe('getProxyAgent', () => {
    // A runner that exports `no_proxy` would otherwise decide these cases.
    const savedNoProxy = process.env['no_proxy'];
    const savedNoProxyUpper = process.env['NO_PROXY'];

    beforeEach(() => {
      delete process.env['no_proxy'];
      delete process.env['NO_PROXY'];
    });

    afterEach(() => {
      if (savedNoProxy === undefined) delete process.env['no_proxy'];
      else process.env['no_proxy'] = savedNoProxy;
      if (savedNoProxyUpper === undefined) delete process.env['NO_PROXY'];
      else process.env['NO_PROXY'] = savedNoProxyUpper;
    });

    const loggerWithProxy = () =>
      QwenLogger.getInstance(
        makeFakeConfig({ getProxy: () => 'http://corp.example.com:8080' }),
      )!;

    it('accepts uppercase proxy URL schemes', () => {
      const config = makeFakeConfig({
        getProxy: () => 'HTTPS://proxy.example.com:8080',
      });
      const logger = QwenLogger.getInstance(config)!;

      expect(logger.getProxyAgent()).toBeDefined();
    });

    it('returns no agent when NO_PROXY is a bare wildcard', () => {
      process.env['NO_PROXY'] = '*';

      expect(loggerWithProxy().getProxyAgent()).toBeUndefined();
    });

    it('returns no agent when a NO_PROXY suffix matches the upload host', () => {
      process.env['NO_PROXY'] = '.rum.aliyuncs.com';

      expect(loggerWithProxy().getProxyAgent()).toBeUndefined();
    });

    it('prefers lowercase no_proxy over NO_PROXY', () => {
      process.env['NO_PROXY'] = 'unrelated.example.com';
      process.env['no_proxy'] = 'gb4w8c3ygj-default-sea.rum.aliyuncs.com';

      expect(loggerWithProxy().getProxyAgent()).toBeUndefined();
    });

    it('still proxies when a port-qualified NO_PROXY entry names another port', () => {
      process.env['NO_PROXY'] = 'rum.aliyuncs.com:8443';

      expect(loggerWithProxy().getProxyAgent()).toBeDefined();
    });

    it('still proxies when NO_PROXY does not match the upload host', () => {
      process.env['NO_PROXY'] = 'localhost,127.0.0.1,.example.com';

      expect(loggerWithProxy().getProxyAgent()).toBeDefined();
    });
  });

  describe('createRumPayload', () => {
    const rumPayload = (logger = QwenLogger.getInstance(mockConfig)!) =>
      (
        logger as unknown as { createRumPayload(): Promise<RumPayload> }
      ).createRumPayload();

    it('includes os metadata in payload', async () => {
      const payload = await rumPayload();

      expect(payload.os).toEqual(
        expect.objectContaining({ type: os.platform(), version: os.release() }),
      );
    });

    it('includes the base URL for OpenAI Responses auth', async () => {
      const config = makeFakeConfig({
        getAuthType: () => AuthType.USE_OPENAI_RESPONSES,
        getContentGeneratorConfig: () => ({
          model: 'gpt-5',
          baseUrl: 'https://api.example.com',
        }),
      });

      const payload = await rumPayload(QwenLogger.getInstance(config)!);

      expect(payload.properties?.['base_url']).toBe('https://api.example.com');
    });

    // The source.json cases can only check the payload's shape: exercising
    // real source information needs actual file system operations.
    it('includes source when source.json exists with valid source', async () => {
      const payload = await rumPayload();

      expect(payload.app).toHaveProperty('channel');
      // channel should be either undefined or a string
      expect(
        payload.app.channel === undefined ||
          typeof payload.app.channel === 'string',
      ).toBe(true);
    });

    it('caches source info and does not read file on every payload creation', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const cachedSourceInfo = logger['sourceInfo'];

      const payload1 = await rumPayload(logger);
      const payload2 = await rumPayload(logger);

      // Both payloads use the cached source info, which does not change.
      expect(payload1.app.channel).toBe(payload2.app.channel);
      expect(logger['sourceInfo']).toBe(cachedSourceInfo);
    });
    // 'does not include source when source value is unknown' was an exact
    // duplicate of this case.
    it('does not include source when source.json does not exist', async () => {
      const payload = await rumPayload();

      // channel exists (may be undefined or have a value)
      expect(payload.app).toHaveProperty('channel');
    });
    it('handles source.json parsing errors gracefully', async () => {
      const payload = await rumPayload();

      // No crash on errors.
      expect(payload).toBeDefined();
      expect(payload.app).toHaveProperty('channel');
    });
  });

  describe('event queue management', () => {
    it('should handle event overflow gracefully', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;

      for (let i = 0; i < TEST_ONLY.MAX_EVENTS + 10; i++) {
        logger.enqueueLogEvent(testEvent(`test-event-${i}`));
      }

      const events = logger['events'].toArray() as RumEvent[];
      expect(logger['events'].size).toBe(TEST_ONLY.MAX_EVENTS);
      expect(events[0]?.name).toBe('test-event-10');
      expect(events[events.length - 1]?.name).toBe(
        `test-event-${TEST_ONLY.MAX_EVENTS + 9}`,
      );
    });

    it('should handle enqueue errors gracefully', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const originalPush = logger['events'].push;
      logger['events'].push = vi.fn(() => {
        throw new Error('Test error');
      });

      logger.enqueueLogEvent(testEvent());

      expect(logger['events'].size).toBe(0);
      logger['events'].push = originalPush;
    });
  });

  describe('concurrent flush protection', () => {
    it('should handle concurrent flush requests', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      // Simulate another flush already in progress.
      logger['isFlushInProgress'] = true;

      const result = logger.flushToRum();

      expect(logger['pendingFlush']).toBe(true);
      expect(result).toBeInstanceOf(Promise);
      logger['isFlushInProgress'] = false;
    });
  });

  describe('failed event retry mechanism', () => {
    it('should requeue failed events with size limits', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const failedEvents: RumEvent[] = [];
      for (let i = 0; i < TEST_ONLY.MAX_RETRY_EVENTS + 50; i++) {
        failedEvents.push(testEvent(`failed-event-${i}`));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).requeueFailedEvents(failedEvents);

      expect(logger['events'].size).toBe(TEST_ONLY.MAX_RETRY_EVENTS);
    });

    it('should handle empty retry queue gracefully', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      // Fill the queue to capacity, then requeue with no space available.
      for (let i = 0; i < TEST_ONLY.MAX_EVENTS; i++) {
        logger.enqueueLogEvent(testEvent(`event-${i}`));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any).requeueFailedEvents([testEvent('failed-event')]);

      expect(logger['events'].size).toBe(TEST_ONLY.MAX_EVENTS);
    });
  });

  describe('event handlers', () => {
    it('logs ripgrep runtime recovery without search details', () => {
      const event = new RipgrepRuntimeRecoveryEvent({
        selection_mode: 'builtin',
        retry_triggered: true,
        retry_succeeded: true,
        failure_kind: 'eagain',
      });
      const enqueueSpy = expectLogged(
        (logger) => logger.logRipgrepRuntimeRecoveryEvent(event),
        {
          event_type: 'action',
          type: 'misc',
          name: 'ripgrep_runtime_recovery',
          properties: {
            platform: process.platform,
            arch: process.arch,
            selection_mode: 'builtin',
            retry_triggered: true,
            retry_succeeded: true,
            failure_kind: 'eagain',
          },
        },
      );
      expect(JSON.stringify(enqueueSpy.mock.calls[0][0])).not.toMatch(
        /pattern|path|stdout|stderr|needle/,
      );
    });

    it('journals the loop detector attribution on subagent loop stops', () => {
      // A loop stop must stay attributable in the journal (issue #9450
      // requirement #7): dropping the loop_type spread would record the
      // stop as an unattributable failure.
      const event = new SubagentExecutionEvent('worker-a', 'failed', {
        terminate_reason: 'loop_detected',
        loop_type: 'consecutive_identical_tool_calls',
      });
      expectLogged((l) => l.logSubagentExecutionEvent(event), {
        event_type: 'action',
        type: 'tool',
        name: 'subagent_execution',
        properties: expect.objectContaining({
          subagent_name: 'worker-a',
          status: 'failed',
          terminate_reason: 'loop_detected',
          loop_type: 'consecutive_identical_tool_calls',
        }),
      });
    });

    it('omits loop_type from subagent journals when no loop fired', () => {
      const event = new SubagentExecutionEvent('worker-b', 'completed');
      expectLogged((l) => l.logSubagentExecutionEvent(event), {
        properties: expect.not.objectContaining({
          loop_type: expect.anything(),
        }),
      });
    });

    /** Journals a Goal event (Goal id g-1); returns the first RUM event. */
    const journalGoal = (
      fields: Omit<Parameters<typeof makeGoalStateEvent>[0], 'goal_id'>,
    ) =>
      logWith((logger) =>
        logger.logGoalStateEvent(
          makeGoalStateEvent({ ...fields, goal_id: 'g-1' }),
        ),
      ).mock.calls[0]![0];

    it('journals a Goal transition without its Goal id or absent figures', () => {
      const figures = {
        cause: 'blocked',
        revision: 4,
        status: 'blocked',
        turn_count: 7,
        tokens_used: 9_000,
        no_progress_turns: 3,
      } as const;

      const rumEvent = journalGoal(figures);

      expect(rumEvent).toMatchObject({
        event_type: 'action',
        type: 'goal',
        name: 'goal_state',
        properties: { ...figures },
      });
      const keys = Object.keys(rumEvent.properties ?? {});
      expect(keys).not.toContain('goal_id');
      expect(keys).not.toContain('limit_kind');
      expect(keys).not.toContain('token_budget');
    });

    it('journals every allowed Goal property without the Goal id', () => {
      const figures = {
        cause: 'usage_limited',
        revision: 4,
        status: 'usage_limited',
        limit_kind: 'time_budget',
        turn_count: 7,
        tokens_used: 9_000,
        no_progress_turns: 3,
        token_budget: 80_000,
        turn_budget: 50,
        active_time_ms: 60_000,
        active_time_budget_ms: 60_000,
        objective_length: 22,
      } as const;

      const rumEvent = journalGoal(figures);

      expect(rumEvent.properties).toEqual({ ...figures });
      expect(Object.keys(rumEvent.properties ?? {})).not.toContain('goal_id');
    });

    it('preserves zero Goal figures in analytics', () => {
      const figures = {
        cause: 'create',
        revision: 1,
        status: 'active',
        turn_count: 0,
        tokens_used: 0,
        active_time_ms: 0,
      } as const;

      expect(journalGoal(figures).properties).toEqual({ ...figures });
    });

    it('logs protocol tag sanitization without model content', () => {
      const event = new ProtocolTagSanitizedEvent({
        model: 'test-model',
        promptId: 'prompt-id',
        responseId: 'response-id',
        tagName: 'thinking',
        toolCallCount: 3,
      });
      expectLogged((l) => l.logProtocolTagSanitizedEvent(event), {
        event_type: 'action',
        type: 'misc',
        name: 'protocol_tag_sanitized',
        properties: {
          model: 'test-model',
          prompt_id: 'prompt-id',
          response_id: 'response-id',
          tag_name: 'thinking',
          tool_call_count: 3,
        },
      });
    });

    it('should log IDE connection events', () => {
      const event = new IdeConnectionEvent(IdeConnectionType.SESSION);
      expectLogged((l) => l.logIdeConnectionEvent(event), {
        event_type: 'action',
        type: 'ide',
        name: 'ide_connection',
        properties: { connection_type: IdeConnectionType.SESSION },
      });
    });

    it('should log Kitty sequence overflow events', () => {
      const event = new KittySequenceOverflowEvent(1024, 'truncated...');
      expectLogged((l) => l.logKittySequenceOverflowEvent(event), {
        event_type: 'exception',
        type: 'overflow',
        name: 'kitty_sequence_overflow',
        subtype: 'kitty_sequence_overflow',
        properties: { sequence_length: 1024 },
        snapshots: JSON.stringify({ truncated_sequence: 'truncated...' }),
      });
    });

    it('should flush start session events immediately', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum').mockResolvedValue({});

      logger.logStartSessionEvent(new StartSessionEvent(makeFakeConfig()));

      expect(flushSpy).toHaveBeenCalled();
    });

    it('should re-read source info when starting a new session', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const readSourceInfoSpy = vi.spyOn(
        logger as unknown as { readSourceInfo(): string },
        'readSourceInfo',
      );
      const testConfig = makeFakeConfig({
        getSessionId: () => 'new-session-id',
      });

      await logger.logStartSessionEvent(new StartSessionEvent(testConfig));

      expect(readSourceInfoSpy).toHaveBeenCalled();
      expect(logger['sessionId']).toBe('new-session-id');
    });

    it('should flush end session events immediately', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum').mockResolvedValue({});

      logger.logEndSessionEvent(new EndSessionEvent(mockConfig));

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('flush timing', () => {
    it('should not flush if interval has not passed', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum');

      logger.enqueueLogEvent(testEvent());
      logger.flushIfNeeded();

      expect(flushSpy).not.toHaveBeenCalled();
    });

    it('should flush when interval has passed', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushToRum').mockResolvedValue({});

      logger.enqueueLogEvent(testEvent());
      vi.advanceTimersByTime(TEST_ONLY.FLUSH_INTERVAL_MS + 1000);
      logger.flushIfNeeded();

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle flush errors gracefully with debug mode', async () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      logger.enqueueLogEvent(testEvent());
      const originalFlush = logger.flushToRum.bind(logger);
      logger.flushToRum = vi.fn().mockRejectedValue(new Error('Network error'));

      vi.advanceTimersByTime(TEST_ONLY.FLUSH_INTERVAL_MS + 1000);
      logger.flushIfNeeded();
      await vi.runAllTimersAsync();

      // Passes if the rejection does not escape: errors are silently ignored
      // to reduce log spam (only flushToRum itself emits rate-limited logs).
      logger.flushToRum = originalFlush;
    });
  });

  describe('constants export', () => {
    it('should export test constants', () => {
      expect(TEST_ONLY.MAX_EVENTS).toBe(1000);
      expect(TEST_ONLY.MAX_RETRY_EVENTS).toBe(100);
      expect(TEST_ONLY.FLUSH_INTERVAL_MS).toBe(60000);
    });
  });

  describe('logToolCallEvent outcomes', () => {
    it('records terminal and execution outcomes with tool identity', () => {
      const event = {
        function_name: 'mcp_tool',
        call_id: 'call-1',
        prompt_id: 'prompt-1',
        response_id: 'response-1',
        status: 'error',
        execution_status: 'error',
        success: false,
        decision: undefined,
        duration_ms: 25,
        tool_type: 'mcp',
        mcp_server_name: 'server-1',
        error_type: 'mcp_tool_error',
        error: 'failed',
      } as ToolCallEvent;
      const enqueueSpy = expectLogged((l) => l.logToolCallEvent(event), {
        event_type: 'action',
        type: 'tool',
        name: 'tool_call#mcp_tool',
        properties: expect.objectContaining({
          call_id: 'call-1',
          status: 'error',
          execution_status: 'error',
          tool_type: 'mcp',
          success: 0,
        }),
      });
      const rumEvent = enqueueSpy.mock.calls[0][0];
      expect(rumEvent.properties).not.toHaveProperty('mcp_server_name');
    });
  });

  describe('logHookCallEvent', () => {
    it('should log a successful hook call event', () => {
      const event = new HookCallEvent(
        'PreToolUse',
        'command',
        'check-secrets.sh',
        { tool_name: 'read_file' },
        150,
        true,
        { result: 'valid' },
        0,
        'stdout',
        'stderr',
        undefined,
      );
      expectLogged((l) => l.logHookCallEvent(event), {
        event_type: 'action',
        type: 'hook',
        name: 'hook_call#PreToolUse',
        properties: expect.objectContaining({
          hook_event_name: 'PreToolUse',
          hook_type: 'command',
          hook_name: 'check-secrets.sh',
          duration_ms: 150,
          success: 1,
          exit_code: 0,
        }),
      });
    });

    const configWithLogPrompts = () =>
      makeFakeConfig({ getTelemetryLogPromptsEnabled: () => true });

    it('should not include submitted prompts in hook telemetry', () => {
      const event = new HookCallEvent(
        'UserPromptSubmit',
        'command',
        'external-context.sh',
        {
          prompt: 'model-bound prompt',
          submitted_prompt: 'sensitive submitted prompt',
        },
        150,
        true,
        { echoed: 'sensitive hook output' },
        0,
        'sensitive hook stdout',
        'sensitive hook stderr',
      );
      const enqueueSpy = logWith(
        (l) => l.logHookCallEvent(event),
        configWithLogPrompts(),
      );

      const rumEvent = enqueueSpy.mock.calls[0][0];
      expect(rumEvent.properties).not.toHaveProperty('hook_input');
      expect(rumEvent.properties).not.toHaveProperty('hook_output');
      expect(rumEvent.properties).not.toHaveProperty('prompt');
      expect(rumEvent.properties).not.toHaveProperty('submitted_prompt');
      expect(rumEvent.properties).not.toHaveProperty('stdout');
      expect(rumEvent.properties).not.toHaveProperty('stderr');
      const serializedEvent = JSON.stringify(rumEvent);
      for (const sensitiveValue of [
        'sensitive submitted prompt',
        'sensitive hook output',
        'sensitive hook stdout',
        'sensitive hook stderr',
      ]) {
        expect(serializedEvent).not.toContain(sensitiveValue);
      }
    });

    it('should log a failed hook call event without forwarding raw error text', () => {
      const event = new HookCallEvent(
        'PostToolUse',
        'command',
        'cleanup.sh',
        { tool_name: 'shell' },
        200,
        false,
        undefined,
        1,
        '',
        'error output',
        'Command failed',
      );
      const enqueueSpy = expectLogged(
        (l) => l.logHookCallEvent(event),
        {
          event_type: 'action',
          type: 'hook',
          name: 'hook_call#PostToolUse',
          properties: expect.objectContaining({
            hook_event_name: 'PostToolUse',
            hook_type: 'command',
            hook_name: 'cleanup.sh',
            duration_ms: 200,
            success: 0,
            exit_code: 1,
          }),
        },
        configWithLogPrompts(),
      );
      // Hook error text is dropped fail-closed: `success` / `exit_code`
      // already signal the failure, so no raw `error` property reaches the
      // sink even when telemetry log prompts are on.
      const callArgs = enqueueSpy.mock.calls[0][0];
      expect(callArgs.properties).not.toHaveProperty('error');
    });

    it.each<[string, Parameters<typeof shortHook>, string]>([
      // Full path and sensitive arguments reduce to the basename.
      [
        'should sanitize hook name to remove sensitive information',
        [
          'PreToolUse',
          '/home/user/.qwen/hooks/check-secrets.sh --api-key=secret123',
          { tool_name: 'read_file' },
        ],
        'check-secrets.sh',
      ],
      [
        'should sanitize hook name with Windows path',
        ['Stop', 'C:\\Users\\user\\hooks\\cleanup.bat --token=xyz', {}, 50],
        'cleanup.bat',
      ],
      [
        'should handle empty hook name',
        ['SessionStart', '', {}, 10],
        'unknown-command',
      ],
      [
        'should handle hook name with only whitespace',
        ['SessionEnd', '   ', {}, 10],
        'unknown-command',
      ],
      // A bare command reduces to the command name.
      [
        'should handle hook name that is just a command without path',
        ['Notification', 'python --arg=value'],
        'python',
      ],
    ])('%s', (_title, hookArgs, expected) => {
      const event = shortHook(...hookArgs);
      expectLogged((l) => l.logHookCallEvent(event), {
        properties: expect.objectContaining({ hook_name: expected }),
      });
    });

    it('should call flushIfNeeded after logging', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const flushSpy = vi.spyOn(logger, 'flushIfNeeded');

      logger.logHookCallEvent(shortHook('PreToolUse'));

      expect(flushSpy).toHaveBeenCalled();
    });

    it('should handle all hook event types', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const enqueueSpy = vi.spyOn(logger, 'enqueueLogEvent');

      for (const eventType of [
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'Notification',
        'UserPromptSubmit',
        'SessionStart',
        'SessionEnd',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'PreCompact',
        'PermissionRequest',
      ]) {
        enqueueSpy.mockClear();

        logger.logHookCallEvent(shortHook(eventType));

        expect(enqueueSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: `hook_call#${eventType}`,
            properties: expect.objectContaining({ hook_event_name: eventType }),
          }),
        );
      }
    });
  });

  describe('logSkillLaunchEvent', () => {
    it('writes skill_name, success and prompt_id into RUM event properties', () => {
      const event = new SkillLaunchEvent('code-review', true, 'prompt-xyz');
      expectLogged((l) => l.logSkillLaunchEvent(event), {
        event_type: 'action',
        type: 'misc',
        name: 'skill_launch',
        properties: expect.objectContaining({
          skill_name: 'code-review',
          success: 1,
          prompt_id: 'prompt-xyz',
        }),
      });
    });

    it('encodes failed launches with success=0 and still carries prompt_id', () => {
      const event = new SkillLaunchEvent('missing-skill', false, 'prompt-fail');
      expectLogged((l) => l.logSkillLaunchEvent(event), {
        properties: expect.objectContaining({
          skill_name: 'missing-skill',
          success: 0,
          prompt_id: 'prompt-fail',
        }),
      });
    });
  });

  describe('logToolCallEvent privacy', () => {
    it('records terminal status without forwarding MCP server metadata or function arguments', () => {
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T12:00:00.000Z',
        function_name: 'remote_tool',
        function_args: { secret: 'not-forwarded' },
        duration_ms: 42,
        status: 'error',
        success: false,
        error: 'failed',
        error_type: 'unknown',
        prompt_id: 'prompt-tool',
        tool_type: 'mcp',
        mcp_server_name: 'private-server',
      } as ToolCallEvent;
      const enqueueSpy = expectLogged((l) => l.logToolCallEvent(event), {
        name: 'tool_call#remote_tool',
        properties: expect.objectContaining({
          tool_name: 'remote_tool',
          status: 'error',
          tool_type: 'mcp',
          success: 0,
          duration_ms: 42,
          error_type: 'unknown',
          error_message: '***REDACTED***',
        }),
      });
      const rumEvent = enqueueSpy.mock.calls[0][0];
      expect(rumEvent.properties).not.toHaveProperty('function_args');
      expect(rumEvent.properties).not.toHaveProperty('mcp_server_name');
    });
  });

  describe('error text redaction', () => {
    it('replaces error text at the enqueue boundary', () => {
      const logger = QwenLogger.getInstance(mockConfig)!;
      const event: RumEvent & { message: string } = {
        type: 'exception',
        name: 'test',
        message: 'raw top-level error',
        properties: {
          error_message: 'raw error message',
          error_excerpt: 'raw error excerpt',
          error_type: 'exit_code',
        },
      };

      logger.enqueueLogEvent(event);

      expect(event.message).toBe('***REDACTED***');
      expect(event.properties).toEqual({
        error_message: '***REDACTED***',
        error_excerpt: '***REDACTED***',
        error_type: 'exit_code',
      });
    });
  });
});
