/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import type { ShellExecutionSandboxPolicy } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import { MAX_CONCURRENT_MONITORS } from '../services/monitorRegistry.js';
import { makeFakeConfig } from '../test-utils/config.js';
import type { ToolCallEvent } from '../telemetry/types.js';
import { QwenLogger } from '../telemetry/qwen-logger/qwen-logger.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { ExecTool } from '../tools/exec.js';
import { MonitorTool } from '../tools/monitor.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolErrorType } from '../utils/tool-error-type.js';
import {
  CoreToolScheduler,
  type CompletedToolCall,
  type ToolCall,
} from './coreToolScheduler.js';

const spyTelemetry = () =>
  vi.spyOn(uiTelemetryService, 'addEvent').mockImplementation(() => {});
let telemetrySink: ReturnType<typeof spyTelemetry>;

const limitMessage =
  `Cannot start monitor: maximum concurrent monitors (${MAX_CONCURRENT_MONITORS}) reached. ` +
  'Stop an existing monitor first.';
const monitorArgs = { command: 'tail -f /dev/null' };
const sandboxMessage =
  'Monitor failed to start: Shell sandbox cwd must remain inside the admitted workspace.';

function setup(
  codeModeOnly = false,
  failure: 'capacity' | 'sandbox' = 'capacity',
) {
  const config = makeFakeConfig({
    codeModeOnly,
    approvalMode: ApprovalMode.YOLO,
    chatRecording: false,
    targetDir: '/tmp',
    cwd: '/tmp',
  });
  if (failure === 'sandbox') {
    // Reject at the real runtime policy boundary before any process starts.
    const policy: ShellExecutionSandboxPolicy = {
      workspace: '/tmp/qwen-monitor-unadmitted-workspace',
      installation: '/tmp',
      state: '/tmp',
      filesystem: 'workspace-write',
      network: 'closed',
    };
    vi.spyOn(config, 'getShellExecutionSandbox').mockReturnValue(policy);
  }
  const monitors = config.getMonitorRegistry();
  for (let i = 0; failure === 'capacity' && i < MAX_CONCURRENT_MONITORS; i++) {
    monitors.register({
      monitorId: `occupied-${i}`,
      command: 'controlled running monitor',
      description: 'occupied slot',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      eventCount: 0,
      lastEventTime: 0,
      maxEvents: 100,
      idleTimeoutMs: 600_000,
      droppedLines: 0,
      outputFile: `/tmp/occupied-${i}.log`,
    });
  }
  const messageBus = {
    request: vi.fn(async (request: { eventName: string }) => ({
      type: MessageBusType.HOOK_EXECUTION_RESPONSE,
      correlationId: `${request.eventName}-monitor-test`,
      success: true,
      output: {},
    })),
  };
  config.setMessageBus(messageBus as unknown as MessageBus);
  const registry = new ToolRegistry(config);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
  registry.registerTool(new MonitorTool(config));
  if (codeModeOnly) registry.registerTool(new ExecTool(config));
  const completed = vi.fn();
  const updates: ToolCall[] = [];
  const scheduler = new CoreToolScheduler({
    config,
    onAllToolCallsComplete: async (calls) => completed(calls),
    onToolCallsUpdate: (calls) => updates.push(...calls),
    getPreferredEditor: () => undefined,
    onEditorClose: vi.fn(),
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    await scheduler.schedule(
      {
        callId: `${name}-limit`,
        name,
        args,
        isClientInitiated: false,
        prompt_id: 'monitor-limit',
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    return completed.mock.calls[0][0][0] as CompletedToolCall;
  };
  return { monitors, messageBus, run, updates };
}

function expectMonitorFailure(
  call: CompletedToolCall,
  messageBus: ReturnType<typeof setup>['messageBus'],
  message = limitMessage,
) {
  expect.soft(call.status).toBe('error');
  expect.soft(call.response.executionStatus).toBe('error');
  expect.soft(call.response.errorType).toBe(ToolErrorType.EXECUTION_FAILED);
  expect.soft(call.response.error?.message).toBe(message);
  expect
    .soft(call.response.responseParts[0]?.functionResponse?.response)
    .toEqual({ error: message });
  expect.soft(call.response.resultDisplay).toBe(message);
  const telemetry = telemetrySink.mock.calls
    .map(([event]) => event as ToolCallEvent)
    .filter((event) => event.function_name === 'monitor');
  expect.soft(telemetry).toEqual([
    expect.objectContaining({
      status: 'error',
      execution_status: 'error',
      success: false,
      error: message,
      error_type: ToolErrorType.EXECUTION_FAILED,
    }),
  ]);
  expect.soft(messageBus.request).toHaveBeenCalledWith(
    expect.objectContaining({
      eventName: 'PostToolUseFailure',
      input: expect.objectContaining({
        tool_name: 'monitor',
        error: message,
        is_interrupt: false,
      }),
    }),
    MessageBusType.HOOK_EXECUTION_RESPONSE,
  );
  expect.soft(messageBus.request).not.toHaveBeenCalledWith(
    expect.objectContaining({
      eventName: 'PostToolUse',
      input: expect.objectContaining({ tool_name: 'monitor' }),
    }),
    MessageBusType.HOOK_EXECUTION_RESPONSE,
  );
}

describe('Monitor startup failure through the scheduler', () => {
  let monitors: ReturnType<typeof setup>['monitors'];

  beforeEach(() => {
    telemetrySink = spyTelemetry();
    vi.spyOn(QwenLogger, 'getInstance').mockReturnValue(undefined);
  });

  afterEach(() => {
    monitors?.reset();
    vi.restoreAllMocks();
  });

  it('reports a full registry as a failure with recovery guidance, telemetry, and hooks', async () => {
    const harness = setup();
    monitors = harness.monitors;
    const call = await harness.run('monitor', monitorArgs);

    expectMonitorFailure(call, harness.messageBus);
    expect(monitors.getRunning()).toHaveLength(MAX_CONCURRENT_MONITORS);
  });

  it('preserves full sandbox startup context through the real runtime policy and scheduler', async () => {
    const harness = setup(false, 'sandbox');
    monitors = harness.monitors;
    const call = await harness.run('monitor', { command: 'true' });

    expectMonitorFailure(call, harness.messageBus, sandboxMessage);
    expect(monitors.getAll()).toHaveLength(1);
    expect(monitors.getAll()[0].status).toBe('failed');
    expect(monitors.getAll()[0].pid).toBeUndefined();
  });

  it.each([
    ['capacity', limitMessage],
    ['sandbox', sandboxMessage],
  ] as const)(
    'rejects tools.monitor so code-mode try/catch receives the full %s failure',
    async (failure, message) => {
      const harness = setup(true, failure);
      monitors = harness.monitors;
      const exec = await harness.run('exec', {
        source: `
        try {
          const result = await tools.monitor(${JSON.stringify(monitorArgs)});
          text("RESOLVED: " + JSON.stringify(result));
        } catch (error) {
          text("CAUGHT: " + error.message);
        }
      `,
      });

      expect(exec.status).toBe('success');
      const output = JSON.stringify(exec.response.responseParts);
      expect.soft(output).toContain(`CAUGHT: ${message}`);
      expect.soft(output).not.toContain('RESOLVED:');
      const nested = harness.updates.find(
        (call): call is CompletedToolCall =>
          call.request.name === 'monitor' &&
          (call.status === 'success' || call.status === 'error'),
      );
      expect(nested).toBeDefined();
      expectMonitorFailure(nested!, harness.messageBus, message);
      expect(monitors.getRunning()).toHaveLength(
        failure === 'capacity' ? MAX_CONCURRENT_MONITORS : 0,
      );
    },
    15_000,
  );
});
