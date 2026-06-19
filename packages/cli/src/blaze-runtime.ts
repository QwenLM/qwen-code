#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { serveCommand } from './commands/serve.js';
import { runAcpAgent } from './acp-integration/acpAgent.js';
import {
  buildDisabledSkillNamesProvider,
  loadCliConfig,
  type CliArgs,
} from './config/config.js';
import { loadSettings } from './config/settings.js';
import { initializeApp } from './core/initializer.js';
import { runExitCleanup } from './utils/cleanup.js';
import { writeStderrLine } from './utils/stdioHelpers.js';

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

async function buildAcpArgs(rawArgs: string[]): Promise<CliArgs> {
  const parsed = await yargs(rawArgs)
    .scriptName('blaze-runtime --acp')
    .exitProcess(false)
    .help(false)
    .version(false)
    .option('acp', { type: 'boolean' })
    .option('experimental-acp', { type: 'boolean' })
    .option('model', { type: 'string' })
    .option('auth-type', { type: 'string' })
    .option('approval-mode', { type: 'string' })
    .option('allowed-tools', { type: 'array', string: true })
    .option('allowed-mcp-server-names', { type: 'array', string: true })
    .option('mcp-config', { type: 'string' })
    .option('include-directories', { type: 'array', string: true })
    .option('debug', { type: 'boolean' })
    .option('proxy', { type: 'string' })
    .option('openai-api-key', { type: 'string' })
    .option('openai-base-url', { type: 'string' })
    .option('openai-logging', { type: 'boolean' })
    .option('openai-logging-dir', { type: 'string' })
    .parseAsync();

  return {
    query: undefined,
    model: parsed.model,
    sandbox: undefined,
    sandboxImage: undefined,
    debug: parsed.debug,
    prompt: undefined,
    promptInteractive: undefined,
    systemPrompt: undefined,
    appendSystemPrompt: undefined,
    yolo: undefined,
    bare: undefined,
    approvalMode: parsed.approvalMode,
    telemetry: undefined,
    telemetryTarget: undefined,
    telemetryOtlpEndpoint: undefined,
    telemetryOtlpProtocol: undefined,
    telemetryLogPrompts: undefined,
    telemetryOutfile: undefined,
    allowedMcpServerNames: asStringArray(parsed.allowedMcpServerNames),
    mcpConfig: parsed.mcpConfig,
    allowedTools: asStringArray(parsed.allowedTools),
    acp: true,
    experimentalAcp: parsed.experimentalAcp,
    experimentalLsp: undefined,
    extensions: undefined,
    listExtensions: undefined,
    openaiLogging: parsed.openaiLogging,
    openaiApiKey: parsed.openaiApiKey,
    openaiBaseUrl: parsed.openaiBaseUrl,
    openaiLoggingDir: parsed.openaiLoggingDir,
    proxy: parsed.proxy,
    includeDirectories: asStringArray(parsed.includeDirectories),
    screenReader: undefined,
    inputFormat: undefined,
    outputFormat: undefined,
    includePartialMessages: undefined,
    chatRecording: undefined,
    continue: undefined,
    resume: undefined,
    sessionId: undefined,
    forkSession: undefined,
    sandboxSessionId: undefined,
    worktree: undefined,
    maxSessionTurns: undefined,
    maxWallTime: undefined,
    maxToolCalls: undefined,
    coreTools: undefined,
    excludeTools: undefined,
    disabledSlashCommands: undefined,
    authType: parsed.authType,
    channel: 'ACP',
    jsonFd: undefined,
    jsonFile: undefined,
    jsonSchema: undefined,
    inputFile: undefined,
  };
}

async function runAcpMode(rawArgs: string[]): Promise<void> {
  const argv = await buildAcpArgs(rawArgs);
  const settings = loadSettings(process.cwd());
  const config = await loadCliConfig(
    settings.merged,
    argv,
    process.cwd(),
    argv.extensions,
    {
      userHooks: settings.getUserHooks(),
      projectHooks: settings.getProjectHooks(),
    },
    buildDisabledSkillNamesProvider(settings),
  );

  await initializeApp(config, settings);
  try {
    await runAcpAgent(config, settings, argv);
  } finally {
    await runExitCleanup();
  }
}

async function runServeMode(rawArgs: string[]): Promise<void> {
  await yargs(rawArgs)
    .scriptName('blaze-runtime')
    .command(serveCommand)
    .demandCommand(1, 'Use `blaze-runtime serve` to start the daemon.')
    .strict()
    .help()
    .parseAsync();
}

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  if (rawArgs.includes('--acp') || rawArgs.includes('--experimental-acp')) {
    await runAcpMode(rawArgs);
    return;
  }

  await runServeMode(rawArgs);
}

main().catch((err: unknown) => {
  writeStderrLine(
    `blaze-runtime: ${err instanceof Error ? err.stack || err.message : String(err)}`,
  );
  process.exit(1);
});
