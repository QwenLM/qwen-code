/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The dialog drops a join token only when the Host answers that the token
// was refused. The web-shell does not depend on core or the CLI, so it
// cannot import those answers: read them where they are made, so that a
// reworded refusal cannot leave the dialog keeping a token it can never
// send again.
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const dialog = read('./add-runtime-dialog.tsx');

describe('the join token refusals the dialog drops a token for', () => {
  it.each([
    [
      'the enrollment the coordinator refused',
      '../../../../core/src/agents/workspace-agents/types.ts',
      /AGENT_HOST_ENROLLMENT_REFUSED\s*=\s*'Agent Host enrollment refused\.'/,
      'Agent Host enrollment refused.',
    ],
    [
      'the token that was spent or expired',
      '../../../../cli/src/serve/agent-host-client.ts',
      /throw new Error\(\s*'Invalid or expired Agent Host enrollment token\.'/,
      'Invalid or expired Agent Host enrollment token.',
    ],
  ])('are still what the Host answers: %s', (_label, path, made, message) => {
    expect(read(path)).toMatch(made);
    expect(dialog).toContain(`'${message}'`);
  });
});
