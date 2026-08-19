/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Group A integration tests (E2E plan .qwen/e2e-tests/node-repl-runtime.md):
 * the node_repl tool family registered through the REAL Config +
 * createToolRegistry() path — no registry or scheduler mocks. Executions spawn
 * a real kernel child process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigParameters } from '../../config/config.js';
import { ApprovalMode, Config } from '../../config/config.js';
import type { ToolRegistry } from '../tool-registry.js';
import { ToolErrorType } from '../tool-error.js';
import { ToolNames } from '../tool-names.js';
import type { NodeReplTool, NodeReplResetTool } from './tool.js';

const TEST_TIMEOUT = 60_000;

let workDir: string;
let config: Config;
let registry: ToolRegistry;

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-integ-'));
  const params: ConfigParameters = {
    cwd: workDir,
    model: 'test-model',
    embeddingModel: 'test-embedding-model',
    sandbox: undefined,
    targetDir: workDir,
    debugMode: false,
    userMemory: '',
    geminiMdFileCount: 0,
    approvalMode: ApprovalMode.DEFAULT,
  };
  config = new Config(params);
  registry = await config.createToolRegistry(undefined, {
    skipDiscovery: true,
  });
});

afterEach(async () => {
  await registry.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('node_repl family via real Config.createToolRegistry()', () => {
  it(
    'A1: registers all three tools as deferred with strict schemas',
    async () => {
      const names = registry.getAllToolNames();
      expect(names).toContain(ToolNames.NODE_REPL);
      expect(names).toContain(ToolNames.NODE_REPL_RESET);
      expect(names).toContain(ToolNames.NODE_REPL_ADD_NODE_MODULE_DIR);

      for (const name of [
        ToolNames.NODE_REPL,
        ToolNames.NODE_REPL_RESET,
        ToolNames.NODE_REPL_ADD_NODE_MODULE_DIR,
      ]) {
        const tool = await registry.ensureTool(name);
        expect(tool).toBeDefined();
        expect(tool!.shouldDefer).toBe(true);
        const schema = tool!.parameterSchema as Record<string, unknown>;
        expect(schema['additionalProperties']).toBe(false);
      }

      const repl = (await registry.ensureTool(
        ToolNames.NODE_REPL,
      )) as NodeReplTool;
      expect(() => repl.build({ code: '1;', bogus: 1 } as never)).toThrow();
    },
    TEST_TIMEOUT,
  );

  it('A1b: keeps the deferred family out of deliberately minimal bare mode', async () => {
    await registry.stop();
    config = new Config({
      cwd: workDir,
      model: 'test-model',
      embeddingModel: 'test-embedding-model',
      sandbox: undefined,
      targetDir: workDir,
      debugMode: false,
      userMemory: '',
      geminiMdFileCount: 0,
      approvalMode: ApprovalMode.DEFAULT,
      bareMode: true,
    });
    registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    expect(registry.getAllToolNames()).not.toContain(ToolNames.NODE_REPL);
    expect(registry.getAllToolNames()).not.toContain(ToolNames.NODE_REPL_RESET);
    expect(registry.getAllToolNames()).not.toContain(
      ToolNames.NODE_REPL_ADD_NODE_MODULE_DIR,
    );
  });

  it(
    'A2: executes through registry-built tools with real ToolResult conversion',
    async () => {
      const repl = (await registry.ensureTool(
        ToolNames.NODE_REPL,
      )) as NodeReplTool;

      const ok = await repl
        .build({
          code: 'const integ = "integ-ok"; nodeRepl.write(integ); const emitted = true;',
        })
        .execute(new AbortController().signal);
      expect(ok.error).toBeUndefined();
      expect(ok.llmContent).toBe('integ-ok\n');

      // Bindings persist across separate registry-built invocations.
      const again = await repl
        .build({
          code: 'nodeRepl.write(integ + "/2"); const emittedAgain = true;',
        })
        .execute(new AbortController().signal);
      expect(again.llmContent).toBe('integ-ok/2\n');

      // Structured failure surfaces as EXECUTION_FAILED.
      const bad = await repl
        .build({ code: 'throw new TypeError("integ boom");' })
        .execute(new AbortController().signal);
      expect(bad.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(String(bad.llmContent)).toContain('integ boom');

      // Reset through the registry-built reset tool clears bindings.
      const reset = (await registry.ensureTool(
        ToolNames.NODE_REPL_RESET,
      )) as NodeReplResetTool;
      const resetResult = await reset
        .build({})
        .execute(new AbortController().signal);
      expect(resetResult.error).toBeUndefined();

      const cleared = await repl
        .build({ code: 'typeof integ;' })
        .execute(new AbortController().signal);
      expect(cleared.llmContent).toBe('undefined\n');
    },
    TEST_TIMEOUT,
  );

  it(
    'A3: ToolRegistry.stop() tears the shared session down',
    async () => {
      const repl = (await registry.ensureTool(
        ToolNames.NODE_REPL,
      )) as NodeReplTool;
      await repl
        .build({ code: 'nodeRepl.write("up"); const started = true;' })
        .execute(new AbortController().signal);

      await registry.stop();

      const after = await repl
        .build({ code: '1;' })
        .execute(new AbortController().signal);
      expect(after.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(String(after.llmContent)).toMatch(/disposed/);
    },
    TEST_TIMEOUT,
  );
});
