import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT,
  publicContract,
  renderManagedAgentApi,
} from '../../../scripts/generate-managed-agent-api.mjs';

const planned = { 'x-qwen-implementation-status': 'planned' };

describe('Managed Agent API types', () => {
  it('match the OpenAPI contract', async () => {
    expect(
      await readFile(OUTPUT, 'utf8'),
      'Run `npm run generate:managed-agent-api` in packages/web-shell.',
    ).toBe(await renderManagedAgentApi());
  });

  it('generate only the implemented Public surface', () => {
    const body = (name: string) => ({
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${name}` },
        },
      },
    });
    const contract = publicContract({
      paths: {
        '/v1/agents/sessions': {
          post: {
            tags: ['Public Sessions'],
            parameters: [{ name: 'draft', in: 'query', ...planned }],
            requestBody: body('CreateSessionRequest'),
            responses: { '200': body('PublicSession') },
          },
        },
        '/v1/agents/workspaces': {
          get: {
            tags: ['Public Resources'],
            responses: { '200': body('PublicWorkspaceList') },
          },
        },
        '/v1/agents/sessions/{sessionId}/draft': {
          get: {
            tags: ['Public Sessions'],
            ...planned,
            responses: { '200': body('PlannedOnly') },
          },
        },
        '/api/agent/web-shell/v1/sessions/get': {
          post: {
            tags: ['WebShell'],
            responses: { '200': body('WebShellSession') },
          },
        },
      },
      components: {
        schemas: {
          CreateSessionRequest: {
            properties: { agent_id: { type: 'string' } },
          },
          PublicSession: {
            required: ['id', 'capabilities'],
            allOf: [
              { required: ['id'] },
              { required: ['capabilities'], ...planned },
            ],
            properties: {
              id: { type: 'string' },
              capabilities: {
                $ref: '#/components/schemas/SessionCapabilities',
                ...planned,
              },
            },
          },
          SessionCapabilities: { type: 'object' },
          PublicWorkspaceList: { type: 'object' },
          PlannedOnly: { type: 'object' },
          WebShellSession: { type: 'object' },
        },
      },
    });

    // Only implemented Public Sessions/Resources operations survive; the
    // planned Public route and the WebShell route are both dropped.
    expect(Object.keys(contract.paths)).toEqual([
      '/v1/agents/sessions',
      '/v1/agents/workspaces',
    ]);
    expect(contract.paths['/v1/agents/sessions'].post.parameters).toEqual([]);
    // Schemas referenced only by dropped operations or planned properties
    // are pruned as unreachable.
    expect(Object.keys(contract.components.schemas)).toEqual([
      'CreateSessionRequest',
      'PublicSession',
      'PublicWorkspaceList',
    ]);
    expect(contract.components.schemas.PublicSession).toEqual({
      required: ['id'],
      allOf: [{ required: ['id'] }],
      properties: { id: { type: 'string' } },
    });
  });
});
