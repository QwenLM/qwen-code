/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen-live init` — interactive setup wizard.
 *
 * Scans the user's machine for supported coding agents, lets them pick a
 * default backend, collects their DashScope API key, checks/installs the
 * Live Host app, and writes ~/.qwen-live/config.json.
 */

/* eslint-disable no-console -- this is a CLI wizard; console is its UI */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import prompts from 'prompts';
import { detectAgents, type DetectedAgent } from './agent-detector.js';
import { LiveHostInstaller } from './host/live-host-installer.js';

const CONFIG_DIR = join(homedir(), '.qwen-live');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

interface RawBackend {
  name: string;
  kind: 'acp';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  default?: boolean;
}

interface RawConfig {
  realtimeApiKey?: string;
  realtimeEndpoint?: string;
  realtimeModel?: string;
  voice?: string;
  defaultCwd?: string;
  backends?: RawBackend[];
  port?: number;
}

export async function runInit(): Promise<void> {
  console.log('\n  qwen-live setup\n  ================\n');

  // 1. Check existing config
  if (existsSync(CONFIG_PATH)) {
    const existing = readFileSync(CONFIG_PATH, 'utf8');
    const overwrite = await prompts({
      type: 'confirm',
      name: 'value',
      message: 'A config.json already exists. Overwrite?',
      initial: false,
    });
    if (!overwrite.value) {
      console.log('\n  Keeping existing config. Run `qwen-live` to start.\n');
      return;
    }
    void existing; // suppress unused
  }

  // 2. Scan for agents
  console.log('  Scanning for installed coding agents...\n');
  const agents = detectAgents();
  if (agents.length === 0) {
    console.log('  No supported coding agents found on your PATH.');
    console.log(
      '  Install at least one of: qodercli, qwen, gemini, claude, codex\n',
    );
    console.log(
      '  You can create ~/.qwen-live/config.json manually instead.\n',
    );
    return;
  }
  for (const agent of agents) {
    console.log(`  ✓ ${agent.label} (${agent.version})`);
  }
  console.log();

  // 3. Select default backend
  const defaultChoice = await prompts({
    type: 'select',
    name: 'value',
    message: 'Which agent should be the default backend?',
    choices: agents.map((agent) => ({
      title: `${agent.label} (${agent.version})`,
      value: agent.name,
    })),
    initial: 0,
  });
  if (defaultChoice.value === undefined) {
    console.log('\n  Cancelled.\n');
    return;
  }

  // 4. Add additional backends
  const backends: RawBackend[] = [];
  const remaining = agents.filter((a) => a.name !== defaultChoice.value);
  let addMore = remaining.length > 0;
  const available = [...remaining];
  while (addMore && available.length > 0) {
    const more = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Add another backend? (${available.length} remaining)`,
      initial: false,
    });
    if (!more.value) {
      addMore = false;
      break;
    }
    const pick = await prompts({
      type: 'select',
      name: 'value',
      message: 'Which agent?',
      choices: available.map((agent) => ({
        title: `${agent.label} (${agent.version})`,
        value: agent.name,
      })),
      initial: 0,
    });
    if (pick.value !== undefined) {
      const agent = available.find((a) => a.name === pick.value)!;
      backends.push(toRawBackend(agent, false));
      const idx = available.indexOf(agent);
      if (idx !== -1) available.splice(idx, 1);
    }
  }

  // Build the default backend
  const defaultAgent = agents.find((a) => a.name === defaultChoice.value)!;
  backends.unshift(toRawBackend(defaultAgent, true));

  // 5. API key
  const envKey =
    process.env['DASHSCOPE_API_KEY'] ??
    process.env['QWEN_LIVE_REALTIME_API_KEY'];
  let apiKey: string | undefined;
  if (envKey) {
    const useEnv = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Use DASHSCOPE_API_KEY from environment (${envKey.slice(0, 8)}...)?`,
      initial: true,
    });
    if (useEnv.value) {
      apiKey = envKey;
    }
  }
  if (!apiKey) {
    const keyPrompt = await prompts({
      type: 'password',
      name: 'value',
      message: 'DashScope realtime API key (sk-...):',
      validate: (val: string) =>
        val.trim().length > 0 || 'Please enter your API key',
    });
    apiKey = keyPrompt.value?.trim();
  }
  if (!apiKey) {
    console.log('\n  Cancelled — API key is required.\n');
    return;
  }

  // 6. Working directory
  const cwdPrompt = await prompts({
    type: 'text',
    name: 'value',
    message: 'Default working directory for coding sessions:',
    initial: process.cwd(),
  });
  const defaultCwd = cwdPrompt.value || process.cwd();

  // 7. Host app (macOS only)
  let hostStatus = 'skipped';
  if (process.platform === 'darwin') {
    console.log('\n  Checking Live Host app...');
    const installer = new LiveHostInstaller();
    const status = await installer.refresh();
    if (status.state === 'installed') {
      console.log(`  ✓ Live Host ${status.version} is installed.`);
      hostStatus = 'installed';
    } else if (status.state === 'missing') {
      const install = await prompts({
        type: 'confirm',
        name: 'value',
        message: 'Live Host is not installed. Install now?',
        initial: true,
      });
      if (install.value) {
        console.log('  Installing Live Host (this may take a minute)...');
        const result = await installer.ensureInstalled();
        if (result.state === 'installed') {
          console.log(`  ✓ Live Host ${result.version} installed.`);
          hostStatus = 'installed';
        } else {
          console.log(
            `  ✗ Installation failed: ${result.message ?? 'unknown error'}`,
          );
          hostStatus = 'failed';
        }
      } else {
        hostStatus = 'skipped';
      }
    } else {
      console.log(`  ! Host check failed: ${status.message ?? 'unknown'}`);
      hostStatus = 'error';
    }
  } else {
    console.log(
      '\n  Live Host app is macOS-only. Voice features require a Mac.',
    );
    hostStatus = 'unsupported';
  }

  // 8. Write config
  const config: RawConfig = {
    realtimeApiKey: apiKey,
    defaultCwd,
    backends,
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  renameSync(tmpPath, CONFIG_PATH);

  // 9. Done
  console.log(`\n  ✓ Config written to ${CONFIG_PATH}`);
  console.log(`  ✓ Default backend: ${defaultAgent.label}`);
  console.log(`  ✓ Host: ${hostStatus}`);
  console.log('\n  Run `qwen-live` to start the daemon.\n');
}

function toRawBackend(agent: DetectedAgent, isDefault: boolean): RawBackend {
  return {
    name: agent.name,
    kind: 'acp',
    command: agent.command,
    args: agent.args,
    ...(Object.keys(agent.env ?? {}).length > 0 ? { env: agent.env } : {}),
    ...(isDefault ? { default: true } : {}),
  };
}
