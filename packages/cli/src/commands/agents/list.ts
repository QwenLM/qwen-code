/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import type { CliArgs } from '../../config/config.js';
import {
  getDisplayString,
  PermissionManager,
  runLogger,
  type AgentSource,
  type AgentDefinition,
  type Config,
  type PluginManagerFactory,
} from '@qwen-code/core';

const SOURCE_ORDER: AgentSource[] = [
  'flag',
  'project',
  'user',
  'plugin',
  'built-in',
];

async function formatAgent(
  session: Config,
  agent: AgentDefinition,
): Promise<string> {
  const parts: string[] = [agent.name];

  if (agent.kind === 'local' && agent.modelConfig?.model) {
    const key = agent.modelConfig.model;
    const model = await session
      .getModelProviderManager()
      .getModel(key)
      .catch((err: unknown) => {
        runLogger.debug('[agents:list] model query failed:', err);
        return undefined;
      });
    parts.push(getDisplayString(model, key));
  }

  return parts.join(' · ');
}

export async function handleList(
  args: { settingSources?: string[] },
  pluginManagerFactory?: PluginManagerFactory,
) {
  const { getFlagSettingsInput, restoreLoadedEnvironment } = await import(
    '../../config/settings.js'
  );
  const { createCliSettingsService } = await import(
    '../../config/createCliSettingsService.js'
  );
  const { eagerParseSettingSourcesFlag } = await import(
    '../../config/flagSettings.js'
  );
  const { loadCliConfig } = await import('../../config/config.js');
  const chalk = (await import('chalk')).default;
  const { AGENT_SOURCE_LABELS } = await import('../../utils/agentUtils.js');

  const workspaceDir = process.cwd();
  restoreLoadedEnvironment();
  // A subcommand option with the same flag name as its parent loses the value
  // to the parent during parsing, so `agents list --setting-sources x` arrives
  // here empty. Fall back to the raw-argv scan the settings loader already
  // uses, which sees the flag wherever it was written.
  const settingSources = args.settingSources ?? eagerParseSettingSourcesFlag();
  const service = await createCliSettingsService({ sessionProjection: true });
  // Load every settings layer: folder trust is recorded in user settings
  // (`permissions.trustDirectories`), so filtering the projection here makes a
  // trusted workspace look untrusted and silently drops its project agents.
  // The flag only selects which agent sources are listed.
  const settings = service.resolve({
    projectPath: workspaceDir,
    flagSettings: getFlagSettingsInput(),
  });

  const config = await loadCliConfig(
    settings,
    'agents-list-session',

    {
      debug: false,
      settingSources,
    } as Partial<CliArgs> as CliArgs,
    {
      cwd: workspaceDir,
      pluginManagerFactory,
      permissionManager: (() => {
        const manager = new PermissionManager(service);
        manager.initialize();
        return manager;
      })(),
    },
  );

  // Initialize to trigger agent loading
  await config.initialize();

  const registry = config.getAgentRegistry();
  const agents = registry.getAllDiscoveredDefinitions();

  if (agents.length === 0) {
    process.stdout.write('No agents discovered.\n');
    return;
  }

  const grouped = new Map<AgentSource, AgentDefinition[]>();
  for (const agent of agents) {
    const source = agent.metadata?.source ?? 'built-in';
    if (!grouped.has(source)) {
      grouped.set(source, []);
    }
    grouped.get(source)!.push(agent);
  }

  let totalActive = 0;
  const lines: string[] = [];

  for (const source of SOURCE_ORDER) {
    const group = grouped.get(source);
    if (!group || group.length === 0) continue;

    // Sort alphabetically within group
    group.sort((a, b) => a.name.localeCompare(b.name));

    lines.push(`${AGENT_SOURCE_LABELS[source]}:`);

    for (const agent of group) {
      const activeAgent = registry.getDefinition(agent.name);
      const isShadowed =
        activeAgent && activeAgent.metadata?.source !== agent.metadata?.source;

      // For non-shadowed agents, use the merged active definition so that
      // settings.agents.overrides (e.g. modelConfig.model) are reflected in
      // the listing. Shadowed agents keep their original definition because
      // overrides only apply to the active agent of that name.
      const displayAgent = !isShadowed && activeAgent ? activeAgent : agent;
      const formatted = await formatAgent(config, displayAgent);

      if (isShadowed) {
        const shadowSource =
          AGENT_SOURCE_LABELS[activeAgent.metadata?.source ?? 'built-in'];
        lines.push(
          `  ${chalk.dim(`(shadowed by ${shadowSource}) ${formatted}`)}`,
        );
      } else {
        lines.push(`  ${formatted}`);
        totalActive++;
      }
    }

    lines.push('');
  }

  process.stdout.write(`${totalActive} active agents\n\n`);
  process.stdout.write(lines.join('\n').trimEnd() + '\n');
}

export function createListCommand(): Command {
  return new Command('list')
    .description('Lists discovered agents.')
    .option(
      '--setting-sources <sources...>',
      'Comma-separated list of setting sources to filter (user, project, local)',
    )
    .action(async (options) => {
      const { coerceCommaSeparated } = await import('../../utils/coerce.js');
      const { exitCli } = await import('../../utils/exitCli.js');
      const settingSources = options.settingSources
        ? coerceCommaSeparated(options.settingSources)
        : undefined;
      await handleList({ settingSources });
      await exitCli();
    });
}
