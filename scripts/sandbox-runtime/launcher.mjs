/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadCliConfig } from '../../packages/cli/src/config/config.js';
import { LoadedSettings } from '../../packages/cli/src/config/settings.js';
import { runNonInteractive } from '../../packages/cli/src/nonInteractiveCli.js';
import { AuthType } from '../../packages/core/src/utils/auth-type.js';
import { runExitCleanup } from '../../packages/cli/src/utils/cleanup.js';

const spec = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const installation = path.dirname(fileURLToPath(import.meta.url));
const settingsFile = (name) => ({
  path: path.join(spec.home, name),
  settings: name === 'user.json' ? (spec.settings ?? {}) : {},
});
const settings = new LoadedSettings(
  settingsFile('system.json'),
  settingsFile('defaults.json'),
  settingsFile('user.json'),
  settingsFile('workspace.json'),
  true,
  new Set(),
);
const argv = {
  bare: true,
  approvalMode: 'yolo',
  authType: 'openai',
  openaiApiKey: 'sk-mock',
  openaiBaseUrl: spec.baseUrl,
  model: 'mock-model',
  prompt: spec.prompt ?? 'Run the disposable fixture check',
  outputFormat: 'json',
  chatRecording: true,
  telemetry: false,
  ...(spec.argv ?? {}),
};
const policy = {
  workspace: spec.workspace,
  state: spec.state,
  installation,
  filesystem: spec.filesystem ?? 'workspace-write',
  network: 'closed',
  ...(spec.bwrapPath ? { bwrapPath: spec.bwrapPath } : {}),
};
const loadRuntime = (workspace, baseUrl = spec.baseUrl) =>
  loadCliConfig(
    spec.settings ?? {},
    { ...argv, openaiBaseUrl: baseUrl },
    workspace,
    argv.extensions,
    spec.hooks,
    undefined,
    undefined,
    undefined,
    false,
    { shellExecutionSandbox: { ...policy, workspace } },
  );
let config = await loadRuntime(spec.workspace);
const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
let summary;
try {
  await config.refreshAuth(AuthType.USE_OPENAI, true);
  await config.initialize();
  if (spec.startupOnly) {
    summary = { code: 0, initialized: true };
  } else if (!spec.direct) {
    const code = await runNonInteractive(
      config,
      settings,
      argv.prompt,
      `${config.getSessionId()}-acceptance`,
    );
    summary = {
      code,
      sessionId: config.getSessionId(),
      tasks: config.getBackgroundShellRegistry().getAll(),
    };
    if (spec.second) {
      const first = summary;
      config = await loadRuntime(spec.second.workspace, spec.second.baseUrl);
      await config.refreshAuth(AuthType.USE_OPENAI, true);
      await config.initialize();
      const secondCode = await runNonInteractive(
        config,
        settings,
        argv.prompt,
        `${config.getSessionId()}-second`,
      );
      summary = {
        code: code || secondCode,
        runtimes: [
          first,
          {
            code: secondCode,
            sessionId: config.getSessionId(),
            tasks: config.getBackgroundShellRegistry().getAll(),
          },
        ],
      };
    }
  } else {
    const registry = config.getToolRegistry();
    const shell = registry.getTool('run_shell_command');
    if (!shell) throw new Error('Production shell tool missing');
    const ac = new AbortController();
    let promoteAc, pid;
    const promise = shell.build(spec.direct.params).execute(
      ac.signal,
      undefined,
      undefined,
      (value) => {
        pid = value;
      },
      (value) => {
        promoteAc = value;
      },
      () => true,
    );
    if (spec.direct.ready)
      await until(() => exists(spec.direct.ready), 'payload ready');
    if (spec.direct.promote) {
      await until(() => !!promoteAc, 'promotion controller');
      promoteAc.abort({ kind: 'background' });
    }
    if (spec.direct.cancel) ac.abort({ kind: 'user' });
    if (spec.direct.removeReceipt) {
      const controls = (await fs.readdir(spec.state)).filter((name) =>
        name.startsWith('sandbox-control-'),
      );
      if (controls.length !== 1)
        throw new Error(`Expected one receipt directory, got ${controls}`);
      await fs.unlink(path.join(spec.state, controls[0], 'status.json'));
    }
    if (spec.direct.gate) await fs.writeFile(spec.direct.gate, 'go');
    const result = await promise;
    if (spec.direct.taskStop) {
      const task = config
        .getBackgroundShellRegistry()
        .getAll()
        .find((task) => task.status === 'running');
      if (!task) throw new Error('No running production background task');
      const stop = registry.getTool('task_stop');
      if (!stop) throw new Error('Production task_stop missing');
      await stop
        .build({ task_id: task.id })
        .execute(new AbortController().signal);
    }
    await until(
      () =>
        config
          .getBackgroundShellRegistry()
          .getAll()
          .every((task) => task.status !== 'running'),
      'background terminal state',
    );
    const tasks = config.getBackgroundShellRegistry().getAll();
    summary = {
      code: 0,
      sessionId: config.getSessionId(),
      pid,
      result,
      tasks,
      policy: config.getShellExecutionSandbox?.(),
    };
  }
} catch (error) {
  summary = { code: 1, error: error.stack };
} finally {
  await fs.writeFile(
    spec.summary,
    JSON.stringify(
      summary,
      (_key, value) =>
        value instanceof Error ? { message: value.message } : value,
      2,
    ),
  );
  await runExitCleanup();
}
process.exit(summary.code);
