/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReportStore } from './report-store.js';
import { createReportServer } from './mcp.js';

try {
  const store = await ReportStore.create(
    process.env['QWEN_TEST_EXPLORER_WORKSPACE_ROOT'],
  );
  await createReportServer(store).connect(new StdioServerTransport());
} catch {
  process.stderr.write(
    'Test Failure Explorer could not start. Configure QWEN_TEST_EXPLORER_WORKSPACE_ROOT as an existing absolute workspace directory.\n',
  );
  process.exitCode = 1;
}
