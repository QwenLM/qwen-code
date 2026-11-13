/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpHttpTransport } from '../../src/daemon/AcpHttpTransport.js';
import { AcpWsTransport } from '../../src/daemon/AcpWsTransport.js';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonSkillInstallRequest } from '../../src/daemon/types.js';

afterEach(() => vi.restoreAllMocks());

const baseUrl = 'https://daemon.example/prefix';
const request: DaemonSkillInstallRequest = {
  name: 'local-skill',
  scope: 'workspace',
  source: { type: 'folder', path: '/tmp/local-skill' },
};

function setup(kind: 'acp-http' | 'acp-ws') {
  const restFetch = vi.fn<typeof fetch>();
  const transport =
    kind === 'acp-http'
      ? new AcpHttpTransport(baseUrl, 'secret', restFetch)
      : new AcpWsTransport(
          'wss://daemon.example/prefix/acp',
          'secret',
          restFetch,
        );
  const translatedFetch = vi
    .spyOn(transport, 'fetch')
    .mockRejectedValue(new Error('Skill mutation must use native REST'));
  const client = new DaemonClient({
    baseUrl: `${baseUrl}/`,
    token: 'secret',
    transport,
  });
  return { client, restFetch, translatedFetch, transport };
}

describe.each(['acp-http', 'acp-ws'] as const)(
  'workspace Skill mutations with %s',
  (kind) => {
    it('installs through native REST with the base prefix, JSON and token', async () => {
      const { client, restFetch, translatedFetch } = setup(kind);
      const result = {
        skillName: request.name,
        scope: request.scope,
        installedPath: '/repo/.qwen/skills/local-skill',
      };
      restFetch.mockResolvedValue(Response.json(result));

      await expect(client.installWorkspaceSkill(request)).resolves.toEqual(
        result,
      );

      expect(translatedFetch).not.toHaveBeenCalled();
      expect(restFetch).toHaveBeenCalledTimes(1);
      const [url, init] = restFetch.mock.calls[0];
      expect(url).toBe(`${baseUrl}/workspace/skills/install`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual(request);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer secret');
      expect(headers.get('content-type')).toBe('application/json');
    });

    it.each(['workspace', 'global'] as const)(
      'deletes a %s Skill through native REST and encodes its name',
      async (scope) => {
        const { client, restFetch, translatedFetch } = setup(kind);
        const skillName = 'review plan';
        const result = { skillName, scope, deleted: true };
        restFetch.mockResolvedValue(Response.json(result));

        await expect(
          client.deleteWorkspaceSkill(skillName, scope),
        ).resolves.toEqual(result);

        expect(translatedFetch).not.toHaveBeenCalled();
        expect(restFetch).toHaveBeenCalledTimes(1);
        const [url, init] = restFetch.mock.calls[0];
        expect(url).toBe(
          `${baseUrl}/workspace/skills/review%20plan?scope=${scope}`,
        );
        expect(init?.method).toBe('DELETE');
        expect(init?.body).toBeUndefined();
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer secret',
        );
      },
    );
  },
);

describe('workspace Skill mutation REST errors and fetch injection', () => {
  it.each(['install', 'delete'] as const)(
    'propagates a daemon error from %s instead of reporting success',
    async (operation) => {
      const { client, restFetch, translatedFetch } = setup('acp-http');
      const body = { error: 'Skill is locked', code: 'skill_locked' };
      restFetch.mockResolvedValue(Response.json(body, { status: 409 }));

      const pending =
        operation === 'install'
          ? client.installWorkspaceSkill(request)
          : client.deleteWorkspaceSkill(request.name, request.scope);

      await expect(pending).rejects.toMatchObject({
        status: 409,
        body,
        message: 'Skill: Skill is locked',
      });
      expect(translatedFetch).not.toHaveBeenCalled();
    },
  );

  it('honors an explicitly injected native fetch for both mutations', async () => {
    const { transport, restFetch, translatedFetch } = setup('acp-ws');
    const result = { skillName: request.name, scope: request.scope };
    const injectedFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(result));
    const client = new DaemonClient({
      baseUrl,
      transport,
      fetch: injectedFetch,
    });

    await client.installWorkspaceSkill(request);
    await client.deleteWorkspaceSkill(request.name, request.scope);

    expect(injectedFetch).toHaveBeenCalledTimes(2);
    expect(restFetch).not.toHaveBeenCalled();
    expect(translatedFetch).not.toHaveBeenCalled();
  });
});
