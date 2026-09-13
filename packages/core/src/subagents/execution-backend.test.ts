/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import type { SubagentConfig } from './types.js';
import {
  parseAgentExecutionBackend,
  resolveAgentExecutionBackend,
} from './execution-backend.js';

const definition: SubagentConfig = {
  name: 'container-agent',
  description: 'Runs a task',
  systemPrompt: 'Complete the requested task.',
  level: 'project',
};

function context(floor?: 'container', trusted = true): Config {
  return {
    getAgentExecutionBackend: () => floor,
    isTrustedFolder: () => trusted,
  } as Config;
}

describe('resolveAgentExecutionBackend', () => {
  it('retains the operator floor when a definition omits its preference', () => {
    expect(resolveAgentExecutionBackend(context('container'))).toBe(
      'container',
    );
    expect(resolveAgentExecutionBackend(context('container'), definition)).toBe(
      'container',
    );
    expect(resolveAgentExecutionBackend(context(), definition)).toBeUndefined();
  });

  it.each(['session', 'project', 'user', 'extension', 'builtin'] as const)(
    'accepts a container requirement from a %s definition',
    (level) => {
      expect(
        resolveAgentExecutionBackend(context(), {
          ...definition,
          level,
          executionBackend: 'container',
        }),
      ).toBe('container');
    },
  );

  it('requires trust for project selection even under an operator floor', () => {
    expect(() =>
      resolveAgentExecutionBackend(context('container', false), {
        ...definition,
        executionBackend: 'container',
      }),
    ).toThrow('untrusted project');
    expect(
      resolveAgentExecutionBackend(context('container', false), definition),
    ).toBe('container');
  });

  it.each(
    [
      null,
      false,
      0,
      '',
      'local',
      'docker',
      'Container',
      ' container ',
      [],
      {},
    ].map((executionBackend) => ({ executionBackend })),
  )(
    'rejects invalid raw session executionBackend=$executionBackend rather than dropping it',
    ({ executionBackend }) => {
      expect(() =>
        resolveAgentExecutionBackend(context('container'), {
          ...definition,
          level: 'session',
          executionBackend,
        } as unknown as SubagentConfig),
      ).toThrow('invalid executionBackend declaration');
    },
  );
});

describe('parseAgentExecutionBackend', () => {
  it('keeps the exact scalar and resolves valid aliases', () => {
    expect(
      parseAgentExecutionBackend('name: test\n"executionBackend": "container"'),
    ).toBe('container');
    expect(
      parseAgentExecutionBackend(
        'name: test\nbackend: &backend container\nexecutionBackend: *backend',
      ),
    ).toBe('container');
  });

  it.each([
    '',
    'null',
    'false',
    '0',
    '""',
    'local',
    'podman',
    '[container]',
    '{}',
  ])('rejects a present invalid YAML value %s', (value) => {
    expect(() =>
      parseAgentExecutionBackend(`name: Explore\nexecutionBackend: ${value}`),
    ).toThrow('invalid executionBackend declaration');
  });

  it.each([
    'name: Explore\nname: Explore\nexecutionBackend: container',
    'name: Explore\nexecutionBackend: container\nexecutionBackend: local',
    'name: Explore\n\texecutionBackend: container',
    'name: Explore\ndescription: bad: yaml\nexecutionBackend: container',
    'name: Explore\nexecutionBackend: container\nbad: [',
    'name: Explore\nexecutionBackend: *missing',
  ])(
    'refuses malformed backend-bearing YAML without repairing it: %s',
    (yaml) => {
      expect(() => parseAgentExecutionBackend(yaml)).toThrow(
        'invalid executionBackend declaration',
      );
    },
  );

  it.each(['|', '>'])(
    'does not interpret %s block-scalar prose as a declaration',
    (style) => {
      expect(
        parseAgentExecutionBackend(
          `name: test\nname: test\ndescription: ${style}\n  Explain configuration:\n  executionBackend: container\n  as an example.`,
        ),
      ).toBeUndefined();
    },
  );

  it('does not let an earlier prose match hide a later malformed declaration', () => {
    expect(() =>
      parseAgentExecutionBackend(
        'name: Explore\ndescription: |\n  executionBackend: container\n\texecutionBackend: local',
      ),
    ).toThrow('invalid executionBackend declaration');
  });
});
