/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SessionOrganizationService, Storage } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export function createSessionOrganizationService(
  workspaceCwd: string,
  runtimeBaseDir?: string,
): SessionOrganizationService {
  if (runtimeBaseDir === undefined) {
    return new SessionOrganizationService(workspaceCwd, (message) => {
      writeStderrLine(`qwen serve: session-org: ${message}`);
    });
  }
  return Storage.runWithRuntimeBaseDir(
    runtimeBaseDir,
    undefined,
    () =>
      new SessionOrganizationService(workspaceCwd, (message) => {
        writeStderrLine(`qwen serve: session-org: ${message}`);
      }),
  );
}
