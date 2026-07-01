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
  describe: 'Start the schedule daemon (foreground)',
  builder: (yargs: Argv) =>
    yargs.option('port', {
      type: 'number',
      hidden: true,
      description: 'Reserved for future use.',
    }),
  handler: async () => {
    // Lazy-load the daemon runner to keep the cold CLI path fast.
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
      writeStderrLine(`Schedule daemon: running with ${status.taskCount} task(s)`);
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
        demandOption: true,
        description: 'Task name',
      })
      .option('cron', {
        type: 'string',
        demandOption: true,
        description: 'Cron expression (5-field, local time)',
      })
      .option('prompt', {
        type: 'string',
        demandOption: true,
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
      }),
  handler: async (argv) => {
    const { createScheduleTask, formatScheduleTaskSummary } = await import(
      '@qwen-code/qwen-code-core'
    );

    try {
      const task = await createScheduleTask({
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
      });

      writeStderrLine(formatScheduleTaskSummary(task));
      writeStderrLine('Task created. Start the daemon to activate: qwen schedule daemon start');
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
      writeStderrLine('No scheduled tasks. Create one: qwen schedule create --name ... --cron ... --prompt ...');
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

    const qwenBinary =
      process.argv[1]?.includes('cli-entry') ? process.argv[1] : 'qwen';

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

    writeStderrLine(`Task ${taskId} completed with exit code ${exitCode ?? 'null'}.`);
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
      writeStderrLine(`No runs recorded for task ${taskId} (${task.definition.name}).`);
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
      .command(runCommand)
      .command(logsCommand)
      .demandCommand(1, 'You need at least one command before continuing.')
      .version(false),
  handler: () => {},
};
