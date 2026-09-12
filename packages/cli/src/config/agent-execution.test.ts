/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_EXECUTION_BACKEND_ENV,
  agentExecutionFactory,
} from './agent-execution.js';

describe('agent execution capability', () => {
  it('does not opt in by default or from repository environment files', () => {
    expect(agentExecutionFactory({}, () => false)).toBeUndefined();
    expect(
      agentExecutionFactory(
        { [AGENT_EXECUTION_BACKEND_ENV]: 'docker' },
        () => true,
      ),
    ).toBeUndefined();
  });
  it.each(['docker', 'podman', ' Docker '])(
    'accepts trusted operator runtime %s lazily',
    (runtime) => {
      expect(
        agentExecutionFactory(
          { [AGENT_EXECUTION_BACKEND_ENV]: runtime },
          () => false,
        ),
      ).toBeTypeOf('function');
    },
  );
  it.each(['sandbox-exec', 'qwen-session-container'])(
    'does not enable a nested backend after a whole-session sandbox handoff: %s',
    (sandbox) => {
      expect(
        agentExecutionFactory(
          { SANDBOX: sandbox, [AGENT_EXECUTION_BACKEND_ENV]: 'docker' },
          () => false,
        ),
      ).toBeUndefined();
    },
  );
  it('rejects an unsupported trusted runtime instead of falling back', () => {
    expect(() =>
      agentExecutionFactory(
        { [AGENT_EXECUTION_BACKEND_ENV]: 'remote' },
        () => false,
      ),
    ).toThrow('must be docker or podman');
  });
});
