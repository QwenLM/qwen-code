import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT,
  renderManagedAgentApi,
  webShellContract,
} from '../../../scripts/generate-managed-agent-api.mjs';

const planned = { 'x-qwen-implementation-status': 'planned' };

describe('Managed Agent API types', () => {
  it('match the OpenAPI contract', async () => {
    expect(
      await readFile(OUTPUT, 'utf8'),
      'Run `npm run generate:managed-agent-api` in packages/web-shell.',
    ).toBe(await renderManagedAgentApi());
  });

  it('generate only implemented WebShell surface', () => {
    const body = (name: string) => ({
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${name}` },
        },
      },
    });
    const contract = webShellContract({
      paths: {
        '/web/sessions/get': {
          post: {
            tags: ['WebShell'],
            parameters: [{ name: 'draft', in: 'query', ...planned }],
            requestBody: body('Request'),
            responses: { '200': body('Session') },
          },
        },
        '/web/sessions/close': {
          post: { tags: ['WebShell'], ...planned, requestBody: body('Close') },
        },
        '/v1/sessions': {
          get: { tags: ['Public'], responses: { '200': body('Public') } },
        },
      },
      components: {
        schemas: {
          Request: { properties: { sessionId: { type: 'string' } } },
          Session: {
            required: ['sessionId', 'capabilities'],
            allOf: [
              { required: ['sessionId'] },
              { required: ['capabilities'], ...planned },
            ],
            properties: {
              sessionId: { type: 'string' },
              capabilities: { $ref: '#/components/schemas/Caps', ...planned },
            },
          },
          Caps: { type: 'object' },
          Close: { type: 'object' },
          Public: { type: 'object' },
        },
      },
    });

    expect(Object.keys(contract.paths)).toEqual(['/web/sessions/get']);
    expect(contract.paths['/web/sessions/get'].post.parameters).toEqual([]);
    expect(Object.keys(contract.components.schemas)).toEqual([
      'Request',
      'Session',
    ]);
    expect(contract.components.schemas.Session).toEqual({
      required: ['sessionId'],
      allOf: [{ required: ['sessionId'] }],
      properties: { sessionId: { type: 'string' } },
    });
  });
});
