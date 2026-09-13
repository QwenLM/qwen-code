/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from './config.js';
import {
  getInitialChatHistory,
  getStartupContextLength,
} from '../core/environmentContext.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { LlmClient } from '../core/client.js';
import { LlmChat } from '../core/llm-chat.js';
import { ToolSearchTool } from '../tools/tool-search.js';
import { ToolNames } from '../tools/tool-names.js';
import { SessionSourceService } from '../services/session-sources.js';
import { PermissionManager } from '../permissions/permission-manager.js';

const workspaces: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe('late session source activation', () => {
  it.each([
    { status: 'registered', visible: false },
    { status: 'registered', visible: true },
    { status: 'deferred', visible: false },
    { status: 'disabled', visible: false },
  ] as const)(
    'refreshes source discovery and declarations ($status, visible=$visible)',
    async ({ status, visible }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), 'qwen-source-activation-'),
      );
      workspaces.push(workspace);
      const config = new Config({
        cwd: workspace,
        targetDir: workspace,
        model: 'test-model',
        debugMode: false,
        chatRecording: false,
        usageStatisticsEnabled: false,
        telemetry: { enabled: false },
        visibleTools: visible ? [ToolNames.RECORD_SOURCE] : [],
      });
      const registry = new ToolRegistry(config);
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      registry.registerTool(new ToolSearchTool(config));
      const client = new LlmClient(config);
      const [startupHistory] = await getInitialChatHistory(config);
      const conversation = [
        { role: 'user', parts: [{ text: 'Keep the previous request' }] },
        { role: 'model', parts: [{ text: 'Keep the previous answer' }] },
      ];
      client['chat'] = new LlmChat(config, {}, [
        ...startupHistory,
        ...conversation,
      ]);
      expect(getStartupContextLength(client.getHistory())).toBe(1);
      await client.setTools();
      const permissions = new PermissionManager(config);
      vi.spyOn(permissions, 'getToolRegistrationStatus').mockResolvedValue(
        status,
      );
      vi.spyOn(config, 'getPermissionManager').mockReturnValue(permissions);
      config.setSessionSourceServiceFactory(
        () =>
          new SessionSourceService({
            sessionId: config.getSessionId(),
            workspaceCwd: () => config.storage.getProjectRoot(),
            load: async () => ({}),
            persist: async () => undefined,
          }),
      );
      await config.registerSessionSourceTool(registry);
      expect(
        registry
          .getDeferredToolSummary()
          .some(({ name }) => name === ToolNames.RECORD_SOURCE),
      ).toBe(false);
      expect(
        registry
          .getAllTools()
          .some(({ name }) => name === ToolNames.RECORD_SOURCE),
      ).toBe(false);
      await client.setTools();
      expect(
        registry
          .getAllTools()
          .some(({ name }) => name === ToolNames.RECORD_SOURCE),
      ).toBe(status !== 'disabled');
      expect(
        registry
          .getDeferredToolSummary()
          .some(({ name }) => name === ToolNames.RECORD_SOURCE),
      ).toBe(status !== 'disabled' && !visible);
      const declarations =
        client
          .getChat()
          .getGenerationConfig()
          .tools?.flatMap((tool) =>
            'functionDeclarations' in tool
              ? (tool.functionDeclarations ?? [])
              : [],
          ) ?? [];
      expect(
        declarations.some(({ name }) => name === ToolNames.RECORD_SOURCE),
      ).toBe(visible);
      expect(registry.isDeferredToolRevealed(ToolNames.RECORD_SOURCE)).toBe(
        false,
      );
      const beforeContextRefresh = JSON.stringify(client.getHistory());
      expect(beforeContextRefresh).not.toContain(ToolNames.RECORD_SOURCE);
      await client.refreshStartupContextReminder();
      const history = client.getHistory();
      expect(JSON.stringify(history).includes(ToolNames.RECORD_SOURCE)).toBe(
        status !== 'disabled' && !visible,
      );
      expect(getStartupContextLength(history)).toBe(1);
      expect(history.slice(1)).toEqual(conversation);
    },
  );
});
