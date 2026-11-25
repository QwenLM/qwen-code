/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { BRAND_NAME } from '@qwen-code/core';
import { resolveCommandSettings } from '../../config/createCliSettingsService.js';

export function createResetProjectChoicesCommand(): Command {
  return new Command('reset-project-choices')
    .description(
      'Reset all approved and rejected project-scoped (.mcp.json) servers within this project',
    )
    .action(async () => {
      const { resetProjectMcpChoices } = await import(
        '../../config/mcp/projectMcpApproval.js'
      );
      const { exitCli } = await import('../../utils/exitCli.js');
      const settings = await resolveCommandSettings();
      if (!resetProjectMcpChoices(settings)) {
        process.stderr.write(
          'Failed to reset project-scoped MCP server approvals and rejections.\n',
        );
        await exitCli(1);
        return;
      }
      process.stdout.write(
        'All project-scoped (.mcp.json) server approvals and rejections have been reset.\n' +
          `You will be prompted for approval next time you start ${BRAND_NAME}.\n`,
      );
      await exitCli();
    });
}
