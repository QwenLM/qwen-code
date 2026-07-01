/**
 * qwen schedule — manage /schedule tasks and the always-on daemon.
 */

import type { CommandModule, Argv } from 'yargs';

import { writeStderrLine } from '../utils/stdioHelpers.js';

// ---------------------------------------------------------------------------
// daemon start
// ---------------------------------------------------------------------------

const daemonStartCommand: CommandModule = {
  command: 'start',
  describe: 'Start the schedule daemon',
  builder: (yargs: Argv) =>
    yargs
      .option('port', {
        type: 'number',
        hidden: true,
        description: 'Reserved for future use.',
      })
      .option('background', {
        type: 'boolean',
        default: false,
        description: 'Run daemon in background (detached from terminal)',
      })
      .option('foreground', {
        type: 'boolean',
        default: false,
        hidden: true,
        description:
          'Internal flag: run in foreground mode (used by background spawning)',
      }),
  handler: async (argv) => {
    const background = argv['background'] as boolean;

    if (background) {
      // Start in background mode
      const { startDaemonInBackground } = await import(
        '../schedule/run-schedule-daemon.js'
      );
      try {
        await startDaemonInBackground();
        writeStderrLine('Schedule daemon started in background.');
        writeStderrLine('Logs: ~/.qwen/logs/schedule-daemon.log');
        writeStderrLine('Stop: qwen schedule daemon stop');
      } catch (err) {
        writeStderrLine(
          `qwen schedule daemon: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
      process.exit(0);
    } else {
      // Start in foreground mode (default)
      const { runScheduleDaemon } = await import(
        '../schedule/run-schedule-daemon.js'
      );
      try {
        await runScheduleDaemon();
      } catch (err) {
        writeStderrLine(
          `qwen schedule daemon: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// daemon stop
// ---------------------------------------------------------------------------

const daemonStopCommand: CommandModule = {
  command: 'stop',
  describe: 'Stop the schedule daemon',
  handler: async () => {
    // Lazy-load the store + daemon helper.
    const [{ stopScheduleDaemon }] = await Promise.all([
      import('../schedule/run-schedule-daemon.js'),
    ]);
    const ok = await stopScheduleDaemon();
    if (ok) {
      writeStderrLine('Schedule daemon stopped.');
    } else {
      writeStderrLine('No schedule daemon was running.');
    }
    process.exit(ok ? 0 : 1);
  },
};

// ---------------------------------------------------------------------------
// daemon status
// ---------------------------------------------------------------------------

const daemonStatusCommand: CommandModule = {
  command: 'status',
  describe: 'Show daemon status',
  handler: async () => {
    const [{ getScheduleDaemonStatus }] = await Promise.all([
      import('../schedule/run-schedule-daemon.js'),
    ]);
    const status = await getScheduleDaemonStatus();
    if (!status.running) {
      writeStderrLine('Schedule daemon is not running.');
    } else {
      writeStderrLine(
        `Schedule daemon: running with ${status.taskCount} task(s)`,
      );
      for (const fire of status.activeFires) {
        writeStderrLine(`  active: ${fire.taskId} (since ${fire.startedAt})`);
      }
    }
    process.exit(0);
  },
};

// ---------------------------------------------------------------------------
// daemon (group)
// ---------------------------------------------------------------------------

const daemonCommand: CommandModule = {
  command: 'daemon',
  describe: 'Manage the schedule daemon',
  builder: (yargs: Argv) =>
    yargs
      .command(daemonStartCommand)
      .command(daemonStopCommand)
      .command(daemonStatusCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

const createCommand: CommandModule = {
  command: 'create',
  describe: 'Create a new scheduled task',
  builder: (yargs: Argv) =>
    yargs
      .option('name', {
        type: 'string',
        description: 'Task name',
      })
      .option('cron', {
        type: 'string',
        description: 'Cron expression (5-field, local time)',
      })
      .option('prompt', {
        type: 'string',
        description: 'Prompt to execute on each fire',
      })
      .option('cwd', {
        type: 'string',
        description: 'Working directory for task execution',
      })
      .option('description', {
        type: 'string',
        description: 'Human-readable description',
      })
      .option('model', {
        type: 'string',
        description: 'Model to use',
      })
      .option('approval-mode', {
        type: 'string',
        choices: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
        default: 'auto',
        description: 'Approval mode for task execution',
      })
      .option('sandbox', {
        type: 'boolean',
        default: false,
        description: 'Run in sandbox',
      })
      .option('no-auto-start', {
        type: 'boolean',
        default: false,
        description: 'Do not auto-start the daemon after creating the task',
      })
      .option('template', {
        type: 'string',
        description:
          'Use a task template (daily-pr-review, hourly-build-check, weekly-cleanup, daily-standup, security-scan)',
      })
      .option('nl', {
        type: 'string',
        description:
          'Natural language schedule (e.g., "every weekday morning", "every day at 9am")',
      })
      .check((argv) => {
        const hasTemplate = argv['template'] !== undefined;
        const hasNl = argv['nl'] !== undefined;
        const hasExplicit =
          argv.name !== undefined &&
          argv.cron !== undefined &&
          argv.prompt !== undefined;

        if (!hasTemplate && !hasNl && !hasExplicit) {
          throw new Error(
            'Either provide --name, --cron, and --prompt, or use --template, or use --nl for natural language',
          );
        }
        return true;
      }),
  handler: async (argv) => {
    const {
      createScheduleTask,
      formatScheduleTaskSummary,
      TASK_TEMPLATES,
      parseNaturalLanguageSchedule,
    } = await import('@qwen-code/qwen-code-core');

    try {
      let taskParams: {
        name: string;
        description?: string;
        cron: string;
        cwd?: string;
        model?: string;
        approvalMode: 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';
        sandbox: boolean;
        prompt: string;
      };

      const templateName = argv['template'] as string | undefined;
      const nlSchedule = argv['nl'] as string | undefined;

      if (templateName) {
        // Use template
        const template = TASK_TEMPLATES[templateName];
        if (!template) {
          throw new Error(
            `Unknown template: ${templateName}. Available: ${Object.keys(TASK_TEMPLATES).join(', ')}`,
          );
        }
        taskParams = {
          name: template.name,
          description: template.description,
          cron: template.cron,
          prompt: template.prompt,
          approvalMode: template.approvalMode,
          sandbox: argv['sandbox'] as boolean,
          cwd: argv['cwd'] as string | undefined,
          model: argv['model'] as string | undefined,
        };
        writeStderrLine(`Using template: ${templateName}`);
      } else if (nlSchedule) {
        // Use natural language
        if (!argv.name || !argv.prompt) {
          throw new Error(
            'When using --nl, you must also provide --name and --prompt',
          );
        }
        const parsed = parseNaturalLanguageSchedule(nlSchedule);
        writeStderrLine(
          `Parsed schedule: ${parsed.description} (${parsed.cron})`,
        );
        taskParams = {
          name: argv.name as string,
          description: argv['description'] as string | undefined,
          cron: parsed.cron,
          prompt: argv.prompt as string,
          approvalMode: argv['approval-mode'] as
            | 'plan'
            | 'default'
            | 'auto-edit'
            | 'auto'
            | 'yolo',
          sandbox: argv['sandbox'] as boolean,
          cwd: argv['cwd'] as string | undefined,
          model: argv['model'] as string | undefined,
        };
      } else {
        // Explicit parameters
        taskParams = {
          name: argv['name'] as string,
          description: argv['description'] as string | undefined,
          cron: argv['cron'] as string,
          cwd: argv['cwd'] as string | undefined,
          model: argv['model'] as string | undefined,
          approvalMode: argv['approval-mode'] as
            | 'plan'
            | 'default'
            | 'auto-edit'
            | 'auto'
            | 'yolo',
          sandbox: argv['sandbox'] as boolean,
          prompt: argv['prompt'] as string,
        };
      }

      const task = await createScheduleTask(taskParams);

      writeStderrLine(formatScheduleTaskSummary(task));

      // Auto-start daemon if not running and not disabled
      const noAutoStart = argv['no-auto-start'] as boolean;
      if (!noAutoStart) {
        const { isDaemonRunning, startDaemonInBackground } = await import(
          '../schedule/run-schedule-daemon.js'
        );
        const running = await isDaemonRunning();
        if (!running) {
          try {
            await startDaemonInBackground();
            writeStderrLine('Daemon auto-started in background.');
          } catch (err) {
            writeStderrLine(
              `Warning: Could not auto-start daemon: ${err instanceof Error ? err.message : String(err)}`,
            );
            writeStderrLine(
              'Start manually: qwen schedule daemon start --background',
            );
          }
        }
      } else {
        writeStderrLine(
          'Start the daemon to activate: qwen schedule daemon start --background',
        );
      }
    } catch (err) {
      writeStderrLine(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    process.exit(0);
  },
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCommand: CommandModule = {
  command: 'list',
  describe: 'List all scheduled tasks',
  handler: async () => {
    const { listScheduleTasks, formatScheduleTaskSummary } = await import(
      '@qwen-code/qwen-code-core'
    );

    const tasks = await listScheduleTasks();
    if (tasks.length === 0) {
      writeStderrLine(
        'No scheduled tasks. Create one: qwen schedule create --name ... --cron ... --prompt ...',
      );
    } else {
      for (const task of tasks) {
        writeStderrLine(formatScheduleTaskSummary(task));
        writeStderrLine('');
      }
    }
    process.exit(0);
  },
};

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

const deleteCommand: CommandModule = {
  command: 'delete <taskId>',
  describe: 'Delete a scheduled task',
  handler: async (argv) => {
    const { deleteScheduleTask } = await import('@qwen-code/qwen-code-core');

    const taskId = argv['taskId'] as string;
    const ok = await deleteScheduleTask(taskId);
    if (ok) {
      writeStderrLine(`Task ${taskId} deleted.`);
    } else {
      writeStderrLine(`Task ${taskId} not found.`);
    }
    process.exit(ok ? 0 : 1);
  },
};

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

const updateCommand: CommandModule = {
  command: 'update <taskId>',
  describe: 'Update an existing scheduled task',
  builder: (yargs: Argv) =>
    yargs
      .positional('taskId', {
        type: 'string',
        description: 'Task ID to update',
      })
      .option('name', {
        type: 'string',
        description: 'New task name',
      })
      .option('cron', {
        type: 'string',
        description: 'New cron expression (5-field, local time)',
      })
      .option('prompt', {
        type: 'string',
        description: 'New prompt to execute on each fire',
      })
      .option('cwd', {
        type: 'string',
        description: 'New working directory for task execution',
      })
      .option('description', {
        type: 'string',
        description: 'New human-readable description',
      })
      .option('model', {
        type: 'string',
        description: 'New model to use',
      })
      .option('approval-mode', {
        type: 'string',
        choices: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
        description: 'New approval mode for task execution',
      })
      .option('enable', {
        type: 'boolean',
        description: 'Enable the task',
      })
      .option('disable', {
        type: 'boolean',
        description: 'Disable the task',
      })
      .option('sandbox', {
        type: 'boolean',
        description: 'Run in sandbox',
      })
      .check((argv) => {
        const hasUpdate =
          argv.name !== undefined ||
          argv.cron !== undefined ||
          argv.prompt !== undefined ||
          argv.cwd !== undefined ||
          argv.description !== undefined ||
          argv.model !== undefined ||
          argv['approval-mode'] !== undefined ||
          argv.enable !== undefined ||
          argv.disable !== undefined ||
          argv.sandbox !== undefined;
        if (!hasUpdate) {
          throw new Error('At least one field must be specified to update');
        }
        if (argv.enable && argv.disable) {
          throw new Error('Cannot specify both --enable and --disable');
        }
        return true;
      }),
  handler: async (argv) => {
    const { updateScheduleTask, formatScheduleTaskSummary } = await import(
      '@qwen-code/qwen-code-core'
    );

    const taskId = argv['taskId'] as string;

    const updates: Record<string, unknown> = {};
    if (argv.name !== undefined) updates.name = argv.name;
    if (argv.cron !== undefined) updates.cron = argv.cron;
    if (argv.prompt !== undefined) updates.prompt = argv.prompt;
    if (argv.cwd !== undefined) updates.cwd = argv.cwd;
    if (argv.description !== undefined) updates.description = argv.description;
    if (argv.model !== undefined) updates.model = argv.model;
    if (argv['approval-mode'] !== undefined) {
      updates.approvalMode = argv['approval-mode'];
    }
    if (argv.enable !== undefined) updates.enabled = true;
    if (argv.disable !== undefined) updates.enabled = false;
    if (argv.sandbox !== undefined) updates.sandbox = argv.sandbox;

    try {
      const task = await updateScheduleTask(taskId, updates);
      if (!task) {
        writeStderrLine(`Task ${taskId} not found.`);
        process.exit(1);
      }

      writeStderrLine(formatScheduleTaskSummary(task));
      writeStderrLine('Task updated.');
    } catch (err) {
      writeStderrLine(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    process.exit(0);
  },
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const runCommand: CommandModule = {
  command: 'run <taskId>',
  describe: 'Run a task immediately (one-shot)',
  handler: async (argv) => {
    const { readScheduleTask, writeScheduleRunRecord } = await import(
      '@qwen-code/qwen-code-core'
    );
    const { spawn } = await import('node:child_process');

    const taskId = argv['taskId'] as string;
    const task = await readScheduleTask(taskId);
    if (!task) {
      writeStderrLine(`Task ${taskId} not found.`);
      process.exit(1);
    }

    const { definition } = task;
    writeStderrLine(`Running task ${taskId} (${definition.name})...`);

    const args = [
      '-p',
      definition.prompt,
      '--approval-mode',
      definition.approvalMode,
    ];
    if (definition.model) args.push('--model', definition.model);

    const qwenBinary = process.argv[1]?.includes('cli-entry')
      ? process.argv[1]
      : 'qwen';

    const startedAt = new Date();
    const child = spawn(qwenBinary, args, {
      cwd: definition.cwd,
      stdio: 'inherit',
      env: { ...process.env },
      shell: false,
    });

    let stdout = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
        if (stdout.length > 500) stdout = stdout.slice(0, 500);
      });
    }

    const exitCode: number | null = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });
    const endedAt = new Date();

    await writeScheduleRunRecord(taskId, {
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      exitCode,
      outputSummary: stdout.slice(0, 500).trim(),
    });

    writeStderrLine(
      `Task ${taskId} completed with exit code ${exitCode ?? 'null'}.`,
    );
    process.exit(exitCode ?? 1);
  },
};

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

const logsCommand: CommandModule = {
  command: 'logs <taskId>',
  describe: 'Show run history for a task',
  handler: async (argv) => {
    const { getScheduleRunRecords, readScheduleTask } = await import(
      '@qwen-code/qwen-code-core'
    );

    const taskId = argv['taskId'] as string;
    const task = await readScheduleTask(taskId);
    if (!task) {
      writeStderrLine(`Task ${taskId} not found.`);
      process.exit(1);
    }

    const records = await getScheduleRunRecords(taskId);
    if (records.length === 0) {
      writeStderrLine(
        `No runs recorded for task ${taskId} (${task.definition.name}).`,
      );
    } else {
      for (const r of records) {
        writeStderrLine(
          `  [${r.startedAt}] → [${r.endedAt}] exit=${r.exitCode ?? '?'}  ${r.outputSummary.slice(0, 80)}`,
        );
      }
      writeStderrLine(`${records.length} run(s) total.`);
    }
    process.exit(0);
  },
};

// ---------------------------------------------------------------------------
// schedule (top-level group)
// ---------------------------------------------------------------------------

export const scheduleCommand: CommandModule = {
  command: 'schedule',
  describe: 'Manage scheduled tasks and the always-on daemon',
  builder: (yargs: Argv) =>
    yargs
      .command(daemonCommand)
      .command(createCommand)
      .command(listCommand)
      .command(deleteCommand)
      .command(updateCommand)
      .command(runCommand)
      .command(logsCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
