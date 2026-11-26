/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  captureExtensionExecution,
  captureSkillFeatureFacts,
} from './extension-feature-builder.js';
import { ToolErrorType } from '../tools/tool-error.js';
vi.mock(
  '../utils/version.js',
  () => ({
    getVersion: async () => 'cli',
    getVersionSync: () => 'cli',
  })
);

const config = { getSessionId: () => 's' } as Config;
describe(
  'extension feature builder',
  () => {
    it.each(['plugin', 'skill', 'subagent'] as const)(
      'maps file marketplace metadata into %s features',
      async (kind) => {
        const snapshot = await captureExtensionExecution(
          config,
          kind,
          {
            toolName: 'tool',
            pluginMarketplace: {
              marketSourceId: 'file-market',
              orgId: 'file-org',
              itemKind: 'plugin',
              marketItemId: 'file-id',
              displayName: 'File plugin',
              version: 'file-version',
            },
          },
          undefined,
          undefined,
          'ts',
        );

        expect(snapshot.extensionFeatures).toMatchObject({
          marketSourceId: 'file-market',
          marketOrgId: 'file-org',
          extensionKind: 'plugin',
          extensionId: 'file-id',
          extensionVersion: 'file-version',
        });
      },
    );

    it('keeps MCP initialize identity separate from the owning plugin file identity', async () => {
      const file = {
        marketSourceId: 'file-market',
        orgId: 'file-org',
        itemKind: 'plugin',
        marketItemId: 'file-id',
        displayName: 'File plugin',
        version: 'file-version',
      };
      const pending = captureExtensionExecution(
        config,
        'mcp',
        {
          toolName: 'search',
          marketItemId: 'gateway-id',
          displayName: 'Gateway MCP',
          version: 'gateway-version',
          pluginMarketplace: file,
        },
        undefined,
        undefined,
        'ts',
      );
      file.version = 'changed-after-capture';
      const snapshot = await pending;

      expect(snapshot.extensionFeatures).toMatchObject({
        marketItemId: 'gateway-id',
        displayName: 'Gateway MCP',
        version: 'gateway-version',
      });
      expect(snapshot.extensionFeatures).not.toHaveProperty('extensionId');
      expect(snapshot.extensionExecution.pluginMarketplaceFeatures).toMatchObject({
        marketSourceId: 'file-market',
        marketOrgId: 'file-org',
        extensionKind: 'plugin',
        extensionId: 'file-id',
        extensionVersion: 'file-version',
      });
    });

    it.each(['plugin', 'project'] as const)(
      'captures plugin ownership only from a plugin Skill definition (%s)',
      (source) => {
        const facts = captureSkillFeatureFacts(
          { name: 'owner:review', source, pluginName: 'loaded-owner' } as never,
          'model_tool',
        );

        expect(facts.pluginName).toBe(source === 'plugin' ? 'loaded-owner' : undefined);
      },
    );

    it.each(['skill', 'subagent', 'mcp'] as const)(
      'keeps the loaded plugin name in fixed %s execution facts',
      async (kind) => {
        const snapshot = await captureExtensionExecution(
          config,
          kind,
          { toolName: 'tool', pluginName: ' local-owner ' },
          undefined,
          undefined,
          'ts',
        );

        expect(snapshot.extensionExecution).toMatchObject({ pluginName: 'local-owner' });
        expect(snapshot.extensionFeatures).not.toHaveProperty('pluginName');
      },
    );

    it.each([
      ['skill', { skillName: 'review', toolName: 'Skill' }, 'review'],
      ['subagent', { subagentType: 'reviewer', toolName: 'Agent' }, 'reviewer'],
      ['mcp', { mcpTargetToolName: 'search', toolName: 'mcp_call' }, 'search'],
      ['mcp', { toolName: 'mcp_list' }, 'mcp_list'],
      [
        'plugin',
        { pluginName: 'Receipt plugin', toolName: 'PluginCommand' },
        'Receipt plugin',
      ],
    ] as const)(
      'captures %s name separately before hooks',
      async (
        kind,
        rawRecord,
        name
      ) => {
        const snapshot = await captureExtensionExecution(
          config,
          kind,
          rawRecord,
          undefined,
          undefined,
          'ts',
        );
        expect(snapshot.extensionExecution.name).toBe(name);
        expect(snapshot.extensionExecution.kind).toBe(kind);
        for (const key of [
          'kind',
          'toolName',
          'skillName',
          'subagentType',
          'mcpTargetToolName',
          'durationMs',
          'status',
          'errorType',
          'errorCode',
        ]) {
          expect(Object.keys(snapshot.extensionFeatures)).not.toContain(key);
        }
      },
    );
    it(
      'selects known lazy MCP get server and transport diagnostics',
      async () => {
        const result = await captureExtensionExecution(
          config,
          'mcp',
          {},
          {
            llmContent: 'tool schema',
            returnDisplay: '',
            data: {
              mcp_server_name: 'known-server',
              mcp_transport: 'stdio',
              mcp_operation: 'get',
              mcp_target_tool_name: 'actual-tool',
            },
          },
          undefined,
          'ts',
        );
        expect(result.extensionFeatures).toMatchObject({
          mcpServerName: 'known-server',
          mcpTransport: 'stdio',
          mcpOperation: 'get',
        });
        expect(result.extensionExecution.name).toBe('actual-tool');
      }
    );
    it(
      'copies facts before awaiting common fields and retains pending',
      async () => {
        const rawRecord = {
          durationMs: 100,
          finalStatus: 'pending',
          mcpListResultCount: 0,
        };
        const pending = captureExtensionExecution(
          config,
          'mcp',
          rawRecord,
          { llmContent: 'abc', returnDisplay: '' },
          undefined,
          'fixed-ts',
        );
        rawRecord.durationMs = 900;
        const result = await pending;
        expect(result.extensionFeatures).toMatchObject({
          finalStatus: 'pending',
          contentLength: 3,
          eventTs: 'fixed-ts',
          mcpListResultCount: 0,
          success: true,
        });
        expect(result.extensionExecution).toMatchObject({
          durationMs: 100,
          status: 'success',
        });
        expect(Object.isFrozen(result.extensionFeatures)).toBe(true);
        expect(Object.isFrozen(result.extensionExecution)).toBe(true);
      }
    );
    it(
      'uses original errors, sanitizes without mutating, and never fabricates result length',
      async () => {
        const error = new Error('token=secret password=hidden');
        const result = await captureExtensionExecution(
          config,
          'skill',
          {},
          undefined,
          error,
          'ts',
        );
        expect(result.extensionFeatures).toMatchObject({
          success: false,
          contentLength: '',
        });
        expect(result.extensionExecution.status).toBe('error');
        expect(result.extensionExecution.errorType).toBeUndefined();
        expect(result.extensionFeatures.errorMessage).not.toContain('secret');
        expect(result.extensionFeatures.errorMessage).not.toContain('hidden');
        expect(error.message).toContain('secret');
      }
    );
    it.each([false, true])(
      'handles hard/semantic failure with original result source: semantic=%s',
      async (semantic) => {
        const result = await captureExtensionExecution(
          config,
          'subagent',
          {},
          {
            llmContent: 'semantic',
            returnDisplay: '',
            ...(semantic
              ? { isError: true }
              : {
                error: {
                  message: 'hard failure',
                  type: ToolErrorType.EXECUTION_FAILED,
                },
              }),
          },
          undefined,
          'ts',
        );
        expect(result.extensionFeatures).toMatchObject({
          success: false,
          contentLength: semantic ? 8 : 12,
        });
        expect(result.extensionExecution.status).toBe('error');
        expect(result.extensionExecution.errorType).toBe(
          semantic ? undefined : ToolErrorType.EXECUTION_FAILED,
        );
        expect(Object.keys(result.extensionFeatures)).toHaveLength(41);
      },
    );
    it.each(['skill', 'mcp'] as const)(
      'captures explicit exception codes for %s',
      async (kind) => {
        const features = await captureExtensionExecution(
          config,
          kind,
          {},
          undefined,
          Object.assign(
            new Error('failure'),
            { code: 1234 }
          ),
          'ts',
        );
        expect(features.extensionExecution.errorCode).toBe('1234');
      },
    );
    it.each([
      [{ cause: { code: 'ECONNRESET' } }, 'ECONNRESET'],
      [{ code: 0 }, '0'],
      [{ code: false }, ''],
      [{ code: { detail: 'not a code' } }, ''],
    ])(
      'accepts only scalar exception codes: %j',
      async (
        error,
        expected
      ) => {
        const features = await captureExtensionExecution(
          config,
          'skill',
          {},
          undefined,
          error,
          'ts',
        );
        expect(features.extensionExecution.errorCode).toBe(expected || undefined);
      }
    );
    it.each([
      [{ errorCode: '-32603', errorCauseCode: 'ECONNRESET' }, '-32603'],
      [{ errorCauseCode: 'ECONNRESET' }, 'ECONNRESET'],
      [{ errorCode: 0 }, '0'],
      [{ errorMessage: 'code=1234' }, ''],
    ])(
      'uses only explicit MCP diagnostic codes: %j',
      async (
        diagnostic,
        expected
      ) => {
        const features = await captureExtensionExecution(
          config,
          'mcp',
          {},
          {
            llmContent: 'failure',
            returnDisplay: '',
            isError: true,
            data: { mcp_error: diagnostic },
          },
          undefined,
          'ts',
        );
        expect(features.extensionExecution.errorCode).toBe(expected || undefined);
      },
    );
    it(
      'preserves an existing code and does not synthesize missing Skill codes',
      async () => {
        const output = {
          llmContent: 'failure code=123',
          returnDisplay: '',
          error: { message: 'failure', type: ToolErrorType.EXECUTION_FAILED },
        };
        const existing = await captureExtensionExecution(
          config,
          'skill',
          { errorCode: 'EXISTING' },
          output,
          Object.assign(
            new Error('failure'),
            { code: 'OTHER' }
          ),
          'ts',
        );
        expect(existing.extensionExecution.errorCode).toBe('EXISTING');
        const missing = await captureExtensionExecution(
          config,
          'skill',
          {},
          output,
          undefined,
          'ts',
        );
        expect(missing.extensionExecution.errorCode).toBe(undefined);
      }
    );
    it(
      'keeps eager MCP versus lazy builtin result_kind semantics and structured timeout status',
      async () => {
        const output = { llmContent: 'ok', returnDisplay: '' };
        expect(
          await captureExtensionExecution(
            config,
            'mcp',
            { toolOrigin: 'mcp' },
            output,
            undefined,
            'ts',
          ),
        ).toMatchObject({ extensionFeatures: { resultKind: 'mcp' } });
        expect(
          await captureExtensionExecution(
            config,
            'mcp',
            { toolOrigin: 'builtin' },
            output,
            undefined,
            'ts',
          ),
        ).toMatchObject({ extensionFeatures: { resultKind: 'text' } });
        expect(
          await captureExtensionExecution(
            config,
            'mcp',
            {},
            undefined,
            Object.assign(
              new Error('late'),
              { code: 'ETIMEDOUT' }
            ),
            'ts',
          ),
        ).toMatchObject({
          extensionExecution: { status: 'timeout' },
          extensionFeatures: { success: false, contentLength: '' },
        });
      }
    );
  }
);
