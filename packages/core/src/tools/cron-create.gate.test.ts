/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CronCreateTool } from './cron-create.js';
import { ToolConfirmationOutcome } from './tools.js';
import type { ToolExecuteConfirmationDetails } from './tools.js';
import { CronScheduler } from '../services/cronScheduler.js';
import {
  readCronTasks,
  taskHasLegacyCondition,
  updateCronTasks,
  withTaskGate,
} from '../services/cronTasksFile.js';
import { Storage } from '../config/storage.js';
import { ApprovalMode } from '../config/approval-mode.js';
import type {
  Config,
  CurrentSessionScheduledTaskCreator,
} from '../config/config.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import type { PermissionCheckContext } from '../permissions/types.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { buildPermissionCheckContext } from '../core/permission-helpers.js';

let tmpDir: string;

function makeConfig(
  over: {
    mode?: ApprovalMode;
    evaluate?: (ctx: PermissionCheckContext) => Promise<string>;
    creator?: CurrentSessionScheduledTaskCreator;
  } = {},
) {
  const scheduler = new CronScheduler(tmpDir, 7 * 24 * 60 * 60 * 1000);
  return {
    getCronScheduler: () => scheduler,
    getCronRecurringMaxAgeDays: () => 7,
    getProjectRoot: () => tmpDir,
    getTargetDir: () => tmpDir,
    getApprovalMode: () => over.mode ?? ApprovalMode.DEFAULT,
    getPermissionManager: () =>
      over.evaluate ? { evaluate: over.evaluate } : null,
    getCurrentSessionScheduledTaskCreator: () => over.creator,
    getSessionSourceType: () => undefined,
    _scheduler: scheduler,
  } as unknown as Config & { _scheduler: CronScheduler };
}

const params = {
  cron: '*/2 * * * *',
  prompt: 'Handle the events below.',
  gate: './probe.sh',
};
const signal = () => new AbortController().signal;

describe('CronCreateTool gate', () => {
  let config: ReturnType<typeof makeConfig>;
  let tool: CronCreateTool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-create-gate-'));
    Storage.setRuntimeBaseDir(tmpDir);
    config = makeConfig({ mode: ApprovalMode.YOLO });
    tool = new CronCreateTool(config);
  });

  afterEach(async () => {
    config._scheduler.destroy();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a session-only gated job and marks it confirmed in this process', async () => {
    const result = await tool.build(params).execute(signal());
    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toContain('[gated]');
    expect(result.llmContent).toContain('Gate: `./probe.sh` runs at each fire');
    const [job] = config._scheduler.list();
    expect(job).toMatchObject({
      gate: './probe.sh',
      gateApproved: true,
      prompt: 'Handle the events below.',
    });
  });

  it('persists a durable gated task with its downgrade fuse', async () => {
    const result = await tool
      .build({ ...params, durable: true })
      .execute(signal());
    expect(result.error).toBeUndefined();
    const [task] = await readCronTasks(tmpDir);
    expect(task).toMatchObject({ gate: './probe.sh', condition: './probe.sh' });
    expect(taskHasLegacyCondition(task!)).toBe(false);
  });

  it('shows the exec dialog with Monitor rules for a gate and the info dialog otherwise', async () => {
    const details = (await tool
      .build(params)
      .getConfirmationDetails(signal())) as ToolExecuteConfirmationDetails;
    expect(details.type).toBe('exec');
    expect(details.command).toBe('./probe.sh');
    expect(details.permissionRules?.[0]).toMatch(/^Monitor\(/);
    expect(details.warnings?.[0]).toContain(
      'Runs unattended on this schedule (Every 2 minutes)',
    );

    const plain = await tool
      .build({ cron: params.cron, prompt: params.prompt })
      .getConfirmationDetails(signal());
    expect(plain.type).not.toBe('exec');
  });

  describe('in default mode', () => {
    beforeEach(() => {
      config._scheduler.destroy();
      config = makeConfig();
      tool = new CronCreateTool(config);
    });

    it('refuses a gate that was neither confirmed nor allowed by a rule', async () => {
      const result = await tool.build(params).execute(signal());
      expect(result.error?.message).toContain(
        'The gate command was not confirmed',
      );
      expect(config._scheduler.list()).toHaveLength(0);
    });

    it('accepts the gate once the exec dialog was answered', async () => {
      const invocation = tool.build(params);
      const details = await invocation.getConfirmationDetails(signal());
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      const result = await invocation.execute(signal());
      expect(result.error).toBeUndefined();
      expect(config._scheduler.list()[0]?.gateApproved).toBe(true);
    });

    it('accepts a gate that a saved rule allows, evaluated as a monitor call', async () => {
      const evaluate = vi.fn(async () => 'allow');
      config._scheduler.destroy();
      config = makeConfig({ evaluate });
      tool = new CronCreateTool(config);
      const result = await tool.build(params).execute(signal());
      expect(result.error).toBeUndefined();
      expect(evaluate).toHaveBeenCalledWith({
        toolName: 'monitor',
        command: './probe.sh',
        cwd: tmpDir,
      });
    });
  });

  describe('in auto mode', () => {
    // The classifier sees the gate in its input — unless a bare allow rule
    // takes the allow fast path around it, in which case nobody has looked
    // at the command. `evaluate` answers the tool-only lookup and the
    // monitor lookup separately.
    const rules = (tool: string, monitor: string) =>
      vi.fn(async (ctx: PermissionCheckContext) =>
        ctx.toolName === 'cron_create' ? tool : monitor,
      );
    const withRules = (evaluate: ReturnType<typeof rules>) => {
      config._scheduler.destroy();
      config = makeConfig({ mode: ApprovalMode.AUTO, evaluate });
      tool = new CronCreateTool(config);
      return evaluate;
    };

    it('accepts the gate the classifier saw when no bare rule skipped it', async () => {
      // `ask` on the monitor lookup: only a deny there would refuse it.
      const evaluate = withRules(rules('default', 'ask'));
      const result = await tool.build(params).execute(signal());
      expect(result.error).toBeUndefined();
      expect(config._scheduler.list()[0]?.gateApproved).toBe(true);
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'cron_create',
          toolParams: expect.objectContaining({ gate: './probe.sh' }),
        }),
      );
    });

    it('refuses a gate an explicit Monitor deny rule covers, with no cron_create rule', async () => {
      // A real permission manager: no `cron_create` rule, so the classifier
      // path would otherwise accept the gate before ever asking about it.
      const pm = new PermissionManager({
        getPermissionsAllow: () => undefined,
        getPermissionsAsk: () => undefined,
        getPermissionsDeny: () => ['Monitor(./probe.sh)'],
        getProjectRoot: () => tmpDir,
        getCwd: () => tmpDir,
        getApprovalMode: () => 'auto',
      });
      pm.initialize();
      config._scheduler.destroy();
      config = makeConfig({
        mode: ApprovalMode.AUTO,
        evaluate: (ctx) => pm.evaluate(ctx),
      });
      tool = new CronCreateTool(config);
      const result = await tool.build(params).execute(signal());
      expect(result.error?.message).toContain(
        'The gate command is denied by a permission rule',
      );
      expect(config._scheduler.list()).toHaveLength(0);
    });

    it('refuses a gate that a bare cron_create allow rule let through unseen', async () => {
      withRules(rules('allow', 'ask'));
      const result = await tool.build(params).execute(signal());
      expect(result.error?.message).toContain(
        'The gate command was not confirmed',
      );
      expect(config._scheduler.list()).toHaveLength(0);
    });

    it('sees a parameter-scoped rule the way the permission flow did', async () => {
      // A real permission manager: `cron_create(prompt:…)` grants this very
      // call, so the flow took the allow fast path and no classifier ran. A
      // name-only lookup would miss it; the gate must still pass on its own.
      const pm = new PermissionManager({
        getPermissionsAllow: () => [
          'cron_create(prompt:Handle the events below.)',
        ],
        getPermissionsAsk: () => undefined,
        getPermissionsDeny: () => undefined,
        getProjectRoot: () => tmpDir,
        getCwd: () => tmpDir,
        getApprovalMode: () => 'auto',
      });
      pm.initialize();
      expect(
        await pm.evaluate(
          buildPermissionCheckContext('cron_create', params, tmpDir),
        ),
      ).toBe('allow');
      expect(await pm.evaluate({ toolName: 'cron_create', cwd: tmpDir })).toBe(
        'default',
      );
      config._scheduler.destroy();
      config = makeConfig({
        mode: ApprovalMode.AUTO,
        evaluate: (ctx) => pm.evaluate(ctx),
      });
      tool = new CronCreateTool(config);
      const result = await tool.build(params).execute(signal());
      expect(result.error?.message).toContain(
        'The gate command was not confirmed',
      );
      expect(config._scheduler.list()).toHaveLength(0);
    });

    it('accepts that gate once a Monitor rule covers the command', async () => {
      withRules(rules('allow', 'allow'));
      const result = await tool.build(params).execute(signal());
      expect(result.error).toBeUndefined();
      expect(config._scheduler.list()[0]?.gateApproved).toBe(true);
    });
  });

  it.each([
    ['yolo mode', ApprovalMode.YOLO, false],
    ['the exec dialog', ApprovalMode.DEFAULT, true],
  ])(
    'refuses a denied gate over %s, as the runner would block every fire',
    async (_label, mode, confirm) => {
      config._scheduler.destroy();
      config = makeConfig({
        mode,
        evaluate: async (ctx) => (ctx.toolName === 'monitor' ? 'deny' : 'ask'),
      });
      tool = new CronCreateTool(config);
      const invocation = tool.build(params);
      if (confirm) {
        const details = await invocation.getConfirmationDetails(signal());
        await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      }
      const result = await invocation.execute(signal());
      expect(result.error?.message).toContain(
        'The gate command is denied by a permission rule',
      );
      expect(config._scheduler.list()).toHaveLength(0);
    },
  );

  it.each([
    'FOO=1 ./probe.sh',
    '  ./probe.sh  ',
    "timeout 10 bash -c './probe.sh --gate'",
    "gh api 'repos/o/r/pulls?state=open&per_page=5'",
  ])(
    'shows in the dialog exactly the gate %j that is persisted and run',
    async (gate) => {
      const invocation = tool.build({ ...params, gate });
      const details = (await invocation.getConfirmationDetails(
        signal(),
      )) as ToolExecuteConfirmationDetails;
      const result = await invocation.execute(signal());
      expect(result.error).toBeUndefined();
      expect(details.command).toBe(config._scheduler.list()[0]?.gate);
    },
  );

  it('threads the gate to the current-session creator', async () => {
    const requests: Array<Parameters<CurrentSessionScheduledTaskCreator>[0]> =
      [];
    config._scheduler.destroy();
    config = makeConfig({
      mode: ApprovalMode.YOLO,
      creator: async (request) => {
        requests.push(request);
        return {
          id: 'cron-current',
          cron: request.cron,
          gate: request.gate ?? null,
        };
      },
    });
    tool = new CronCreateTool(config);
    const result = await promptIdContext.run('prompt-1', () =>
      tool
        .build({ ...params, durable: true, sessionMode: 'current' })
        .execute(signal()),
    );
    expect(result.error).toBeUndefined();
    expect(result.returnDisplay).toContain('[gated]');
    expect(requests).toEqual([
      {
        cron: params.cron,
        prompt: params.prompt,
        recurring: true,
        promptId: 'prompt-1',
        gate: './probe.sh',
      },
    ]);
  });

  it('keeps a dialog confirmation for the current-session task the daemon writes', async () => {
    // Default mode, no rule covering the gate: only the confirmation lets it
    // run unattended. The daemon writes the task file and returns its id; this
    // session's scheduler installs the job on its next reload, and that job
    // must carry the confirmation or its first fire is blocked.
    config._scheduler.destroy();
    config = makeConfig({
      mode: ApprovalMode.DEFAULT,
      evaluate: async () => 'ask',
      creator: async (request) => {
        await updateCronTasks(tmpDir, (tasks) => [
          ...tasks,
          withTaskGate(
            {
              id: 'cron-current',
              cron: request.cron,
              prompt: request.prompt,
              recurring: request.recurring,
              createdAt: Date.now(),
              lastFiredAt: null,
            },
            request.gate,
          ),
        ]);
        return {
          id: 'cron-current',
          cron: request.cron,
          gate: request.gate ?? null,
        };
      },
    });
    tool = new CronCreateTool(config);
    const invocation = tool.build({
      ...params,
      durable: true,
      sessionMode: 'current',
    });
    const details = await invocation.getConfirmationDetails(signal());
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    const result = await promptIdContext.run('prompt-1', () =>
      invocation.execute(signal()),
    );
    expect(result.error).toBeUndefined();

    await config._scheduler.enableDurable('session-1');
    const job = config._scheduler.list().find((j) => j.id === 'cron-current');
    expect(job?.gate).toBe('./probe.sh');
    expect(job?.gateApproved).toBe(true);
  });

  it('removes the task and refuses when the daemon drops a requested gate', async () => {
    // A daemon that predates gated tasks stores the task without its gate and
    // echoes none back: left alone, the task would run at every slot.
    config._scheduler.destroy();
    config = makeConfig({
      mode: ApprovalMode.YOLO,
      creator: async (request) => {
        await updateCronTasks(tmpDir, (tasks) => [
          ...tasks,
          {
            id: 'cron-old',
            cron: request.cron,
            prompt: request.prompt,
            recurring: request.recurring,
            createdAt: Date.now(),
            lastFiredAt: null,
          },
        ]);
        return { id: 'cron-old', cron: request.cron };
      },
    });
    tool = new CronCreateTool(config);
    const result = await promptIdContext.run('prompt-1', () =>
      tool
        .build({ ...params, durable: true, sessionMode: 'current' })
        .execute(signal()),
    );
    expect(result.error?.message).toContain('current_session_gate_unsupported');
    expect(await readCronTasks(tmpDir)).toEqual([]);
  });

  it('names the ungated task left behind when removing it fails', async () => {
    config._scheduler.destroy();
    config = makeConfig({
      mode: ApprovalMode.YOLO,
      creator: async (request) => ({ id: 'cron-old', cron: request.cron }),
    });
    vi.spyOn(config._scheduler, 'removeDurable').mockRejectedValue(
      new Error('EACCES'),
    );
    tool = new CronCreateTool(config);
    const result = await promptIdContext.run('prompt-1', () =>
      tool
        .build({ ...params, durable: true, sessionMode: 'current' })
        .execute(signal()),
    );
    expect(result.error?.message).toContain('current_session_gate_unsupported');
    expect(result.error?.message).toContain(
      'stored task cron-old without its gate, and removing it failed (EACCES)',
    );
    expect(result.error?.message).toContain('until deleted with cron_delete');
  });

  it('refuses a gate wrapped in a shell, whose rebuilt script the rules would read', () => {
    // Adjacent quotes end the script early: the rules would see `cat` and
    // the shell would run `touch`.
    expect(() =>
      tool.build({
        ...params,
        gate: `bash -c 'cat /etc/hostname'";touch /tmp/x;"''`,
      }),
    ).toThrow('not wrapped in a shell');
    expect(config._scheduler.list()).toHaveLength(0);
  });

  it('rejects a gate on a one-shot task, which a quiet gate would consume', async () => {
    const result = await tool
      .build({ ...params, cron: '30 14 28 2 *', recurring: false })
      .execute(signal());
    expect(result.error?.message).toContain('A gate needs a recurring task');
    expect(config._scheduler.list()).toHaveLength(0);
  });

  it.each([
    '',
    '   ',
    'sleep 5 &',
    'sleep 5 & echo done',
    "bash -c './probe.sh &'",
    "nohup bash -c './probe.sh &'",
    "sudo -u ci bash -c './probe.sh &'",
    "command bash -c './probe.sh &'",
    "env FOO=1 bash -c './probe.sh &'",
    `bash -c "nohup sh -c './probe.sh &'"`,
  ])('rejects the gate %j at validation', (gate) => {
    expect(() => tool.build({ ...params, gate })).toThrow(/gate/);
  });

  it.each([
    ['past the cap', 'x'.repeat(2049), 'must be at most 2048 characters'],
    [
      'of only a comment',
      '# waiting for the token',
      'must run a command, not only a comment',
    ],
  ])('rejects a gate %s with its own reason', (_what, gate, reason) => {
    expect(() => tool.build({ ...params, gate })).toThrow(reason);
  });

  it('forwards the gate to the auto-mode classifier', () => {
    expect(tool.toAutoClassifierInput(params)).toMatchObject({
      gate: './probe.sh',
    });
    expect(
      tool.toAutoClassifierInput({ cron: params.cron, prompt: params.prompt }),
    ).not.toHaveProperty('gate');
  });
});
