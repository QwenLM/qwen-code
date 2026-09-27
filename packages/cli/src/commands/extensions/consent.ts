import type {
  ClaudeMarketplaceConfig,
  ExtensionConfig,
  ExtensionRequestOptions,
  ExtensionWorkflowDefinition,
  SkillConfig,
  SubagentConfig,
} from '@qwen-code/qwen-code-core';
import type { ConfirmationRequest } from '../../ui/types.js';
import chalk from 'chalk';
import prompts from 'prompts';
import stripAnsi from 'strip-ansi';
import { t } from '../../i18n/index.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

/**
 * Requests consent from the user to perform an action, by reading a Y/n
 * character from stdin.
 *
 * This should not be called from interactive mode as it will break the CLI.
 *
 * @param consentDescription The description of the thing they will be consenting to.
 * @returns boolean, whether they consented or not.
 */
export async function requestConsentNonInteractive(
  consentDescription: string,
): Promise<boolean> {
  writeStdoutLine(consentDescription);
  const result = await promptForConsentNonInteractive(
    t('Do you want to continue? [Y/n]: '),
  );
  return result;
}

/**
 * Requests plugin selection from the user in non-interactive mode.
 * Displays an interactive list with arrow key navigation.
 *
 * This should not be called from interactive mode as it will break the CLI.
 *
 * @param marketplace The marketplace config containing available plugins.
 * @returns The name of the selected plugin.
 */
export async function requestChoicePluginNonInteractive(
  marketplace: ClaudeMarketplaceConfig,
): Promise<string> {
  const plugins = marketplace.plugins;

  if (plugins.length === 0) {
    throw new Error(t('No plugins available in this marketplace.'));
  }

  // Build choices for prompts select

  const choices = plugins.map((plugin) => ({
    title: chalk.green(chalk.bold(`[${plugin.name}]`)),
    value: plugin.name,
  }));

  const response = await prompts({
    type: 'select',
    name: 'plugin',
    message: t('Select a plugin to install from marketplace "{{name}}":', {
      name: marketplace.name,
    }),
    choices,
    initial: 0,
  });

  // Handle cancellation (Ctrl+C)
  if (response.plugin === undefined) {
    throw new Error(t('Plugin selection cancelled.'));
  }

  return response.plugin;
}

/**
 * Requests consent from the user to perform an action, in interactive mode.
 *
 * This should not be called from non-interactive mode as it will not work.
 *
 * @param consentDescription The description of the thing they will be consenting to.
 * @param addExtensionUpdateConfirmationRequest A function to actually add a prompt to the UI.
 * @returns boolean, whether they consented or not.
 */
export async function requestConsentInteractive(
  consentDescription: string,
  addExtensionUpdateConfirmationRequest: (value: ConfirmationRequest) => void,
): Promise<boolean> {
  return promptForConsentInteractive(
    consentDescription + '\n\n' + t('Do you want to continue?'),
    addExtensionUpdateConfirmationRequest,
  );
}

/**
 * Asks users a prompt and awaits for a y/n response on stdin.
 *
 * This should not be called from interactive mode as it will break the CLI.
 *
 * @param prompt A yes/no prompt to ask the user
 * @returns Whether or not the user answers 'y' (yes). Defaults to 'yes' on enter.
 */
async function promptForConsentNonInteractive(
  prompt: string,
): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(['y', ''].includes(answer.trim().toLowerCase()));
    });
  });
}

/**
 * Asks users an interactive yes/no prompt.
 *
 * This should not be called from non-interactive mode as it will break the CLI.
 *
 * @param prompt A markdown prompt to ask the user
 * @param addExtensionUpdateConfirmationRequest Function to update the UI state with the confirmation request.
 * @returns Whether or not the user answers yes.
 */
async function promptForConsentInteractive(
  prompt: string,
  addExtensionUpdateConfirmationRequest: (value: ConfirmationRequest) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    addExtensionUpdateConfirmationRequest({
      prompt,
      onConfirm: (resolvedConfirmed) => {
        resolve(resolvedConfirmed);
      },
    });
  });
}

/**
 * Builds a consent string for installing an extension based on it's
 * extensionConfig.
 */
export function extensionConsentString(
  extensionConfig: ExtensionConfig,
  commands: string[] = [],
  skills: SkillConfig[] = [],
  subagents: SubagentConfig[] = [],
  originSource: string = 'QwenCode',
  workflows: ExtensionWorkflowDefinition[] = [],
): string {
  const output: string[] = [];
  if (originSource !== 'QwenCode' && originSource !== 'AgentPlugins') {
    output.push(
      t(
        'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.',
        { originSource },
      ),
    );
  }
  const mcpServerEntries = Object.entries(extensionConfig.mcpServers || {});
  const displayLabel = extensionConfig.displayName ?? extensionConfig.name;
  output.push(t('Installing extension "{{name}}".', { name: displayLabel }));
  if (
    typeof extensionConfig.description === 'string' &&
    extensionConfig.description
  ) {
    output.push(stripAnsi(extensionConfig.description));
  }
  output.push(
    t(
      '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**',
    ),
  );

  if (mcpServerEntries.length) {
    output.push(t('This extension will run the following MCP servers:'));
    for (const [key, mcpServer] of mcpServerEntries) {
      const isLocal = !!mcpServer.command;
      const source =
        mcpServer.httpUrl ??
        `${mcpServer.command || ''}${mcpServer.args ? ' ' + mcpServer.args.join(' ') : ''}`;
      output.push(
        `  * ${key} (${isLocal ? t('local') : t('remote')}): ${source}`,
      );
    }
  }
  if (commands && commands.length > 0) {
    output.push(
      t('This extension will add the following commands: {{commands}}.', {
        commands: commands.join(', '),
      }),
    );
  }
  if (extensionConfig.contextFileName) {
    const fileName = Array.isArray(extensionConfig.contextFileName)
      ? extensionConfig.contextFileName.join(', ')
      : extensionConfig.contextFileName;
    output.push(
      t(
        'This extension will append info to your QWEN.md context using {{fileName}}',
        { fileName },
      ),
    );
  }
  if (skills.length > 0) {
    output.push(t('This extension will install the following skills:'));
    for (const skill of skills) {
      output.push(`  * ${chalk.bold(skill.name)}: ${skill.description}`);
    }
  }
  if (subagents.length > 0) {
    output.push(t('This extension will install the following subagents:'));
    for (const subagent of subagents) {
      output.push(`  * ${chalk.bold(subagent.name)}: ${subagent.description}`);
    }
  }
  if (workflows.length > 0) {
    output.push(
      t(
        'This extension will install the following workflows (JavaScript scripts that can start subagents):',
      ),
    );
    for (const workflow of workflows) {
      // The description comes from a third-party script's meta block.
      const description = stripAnsi(workflow.description).replace(/\s+/g, ' ');
      output.push(`  * ${chalk.bold(workflow.name)}: ${description}`);
    }
  }
  return output.join('\n');
}

/**
 * Names of the workflows present in both versions whose script content
 * differs, compared by {@link ExtensionWorkflowDefinition.contentDigest}.
 */
function changedWorkflowScripts(
  workflows: ExtensionWorkflowDefinition[],
  previousWorkflows: ExtensionWorkflowDefinition[],
): string[] {
  const previousDigests = new Map(
    previousWorkflows.map((workflow) => [
      workflow.name,
      workflow.contentDigest,
    ]),
  );
  return workflows
    .filter((workflow) => {
      const previous = previousDigests.get(workflow.name);
      return previous !== undefined && previous !== workflow.contentDigest;
    })
    .map((workflow) => workflow.name);
}

/**
 * Requests consent from the user to install an extension (extensionConfig), if
 * there is any difference between the consent string for `extensionConfig` and
 * `previousExtensionConfig`.
 *
 * Always requests consent if previousExtensionConfig is null.
 *
 * Throws if the user does not consent.
 */
export const requestConsentOrFail = async (
  requestConsent: (consent: string) => Promise<boolean>,
  options?: ExtensionRequestOptions,
) => {
  if (!options) return;
  const {
    extensionConfig,
    originSource = 'QwenCode',
    commands = [],
    skills = [],
    subagents = [],
    workflows = [],
    previousExtensionConfig,
    previousCommands = [],
    previousSkills = [],
    previousSubagents = [],
    previousWorkflows = [],
  } = options;
  const extensionConsent = extensionConsentString(
    extensionConfig,
    commands,
    skills,
    subagents,
    originSource,
    workflows,
  );
  // The consent text lists names and descriptions only, so an update that
  // changes nothing but a script's code would otherwise install silently.
  const changedScripts = previousExtensionConfig
    ? changedWorkflowScripts(workflows, previousWorkflows)
    : [];
  if (previousExtensionConfig) {
    const previousExtensionConsent = extensionConsentString(
      previousExtensionConfig,
      previousCommands,
      previousSkills,
      previousSubagents,
      originSource,
      previousWorkflows,
    );
    if (
      previousExtensionConsent === extensionConsent &&
      changedScripts.length === 0
    ) {
      return;
    }
  }
  const consent =
    changedScripts.length > 0
      ? `${extensionConsent}\n${t(
          'These workflow scripts changed since the installed version: {{names}}.',
          { names: changedScripts.join(', ') },
        )}`
      : extensionConsent;
  if (!(await requestConsent(consent))) {
    throw new Error(
      t('Installation cancelled for "{{name}}".', {
        name: extensionConfig.name,
      }),
    );
  }
};
