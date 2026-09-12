/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  AGENT_EXECUTION_BACKEND_ENV,
  agentExecutionFactory,
} from './agent-execution.js';

describe('agent execution capability', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects the source launch before creating a container',
    async () => {
      const factory = agentExecutionFactory(
        {
          [AGENT_EXECUTION_BACKEND_ENV]: 'docker',
          QWEN_SANDBOX_IMAGE: 'fixture-image',
        },
        () => false,
      )!;
      await expect(
        factory({} as Config, new AbortController().signal),
      ).rejects.toThrow('source and tsc launches are unsupported');
    },
  );
  it('does not advertise container execution on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(
        agentExecutionFactory(
          { [AGENT_EXECUTION_BACKEND_ENV]: 'docker' },
          () => false,
        ),
      ).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
  it('does not opt in by default or from repository environment files', () => {
    expect(agentExecutionFactory({}, () => false)).toBeUndefined();
    expect(
      agentExecutionFactory(
        { [AGENT_EXECUTION_BACKEND_ENV]: 'docker' },
        () => true,
      ),
    ).toBeUndefined();
  });
  it
    .skipIf(process.platform === 'win32')
    .each(['docker', 'podman', ' Docker '])(
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
  it.skipIf(process.platform === 'win32')(
    'rejects an unsupported trusted runtime instead of falling back',
    () => {
      expect(() =>
        agentExecutionFactory(
          { [AGENT_EXECUTION_BACKEND_ENV]: 'remote' },
          () => false,
        ),
      ).toThrow('must be docker or podman');
    },
  );
  it('does not trust inherited backend settings in daemon ACP sessions', () => {
    expect(
      agentExecutionFactory(
        {
          QWEN_CODE_SERVE: '1',
          [AGENT_EXECUTION_BACKEND_ENV]: 'docker',
          DOCKER_HOST: 'tcp://file-controlled.invalid:2375',
        },
        () => false,
      ),
    ).toBeUndefined();
  });
});
