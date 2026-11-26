/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { getEnvironmentAttachments } from '../attachments/generators/environment-generators.js';
import { normalizeMessagesForAPI } from '../protocol/provider/request-converter.js';
import { getCommandQueueSnapshot } from '../services/messageQueueManager.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { resetForTest } from '../utils/Shell.js';
import { ShellTool } from './shell.js';
import type { ShellToolExecutionData } from './shell-result.js';
import { ReadFileTool } from './read-file.js';
import { EditTool } from './edit.js';
import { ToolRegistry } from './tool-registry.js';
import { WriteFileTool } from './write-file.js';

describe.skipIf(process.platform === 'win32')(
  'Bash cwd and file tools integration',
  () => {
    let root: string;
    let child: string;
    let config: Config | undefined;

    beforeEach(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-environment-')),
      );
      child = path.join(root, 'sub dir');
      await fs.mkdir(child);
      await fs.writeFile(path.join(root, 'same.txt'), 'root content');
      await fs.writeFile(path.join(child, 'same.txt'), 'child content');
      vi.stubEnv('SHELL', '/bin/bash');
      resetForTest(root);
    });

    afterEach(async () => {
      await config?.dispose();
      config = undefined;
      resetForTest();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    });

    it.each([false, true])(
      'keeps environment, Read, Edit and Write aligned after real cd (ACP=%s)',
      async (acpMode) => {
        config = makeFakeConfig({
          sessionId: randomUUID(),
          targetDir: root,
          cwd: root,
          acpMode,
        });
        const ctx = createAttachmentContext(root);
        ctx.config = config;
        const history = (await getEnvironmentAttachments(ctx)).map(
          createAttachmentMessage,
        );
        const shell = new ShellTool(config);
        const read = new ReadFileTool(config);
        const registry = new ToolRegistry(config);
        registry.registerTool(read);
        vi.spyOn(config, 'toolRegistry', 'get').mockReturnValue(registry);
        const edit = new EditTool(config);
        const write = new WriteFileTool(config);
        const signal = new AbortController().signal;

        const cd = await shell
          .build({ command: "cd 'sub dir' && pwd" })
          .execute(signal);
        expect(cd.error).toBeUndefined();
        expect(cd.llmContent).toContain(child);
        const [environment] = await getEnvironmentAttachments(ctx, history);
        expect(environment.snapshot.workingDirectory).toBe(child);
        expect(environment.changes).toContainEqual({
          field: 'workingDirectory',
          from: root,
        });
        history.push(createAttachmentMessage(environment));
        expect(JSON.stringify(normalizeMessagesForAPI(history))).toContain(
          `Primary working directory: ${child} (was ${root})`,
        );

        const readResult = await read
          .build({ file_path: 'same.txt' })
          .execute(signal);
        expect(readResult.error).toBeUndefined();
        expect(readResult.llmContent).toContain('child content');
        expect(readResult.llmContent).not.toContain('root content');
        const editResult = await edit
          .build({
            file_path: 'same.txt',
            old_string: 'child content',
            new_string: 'edited child',
          })
          .execute(signal);
        expect(editResult.error).toBeUndefined();
        expect(await fs.readFile(path.join(child, 'same.txt'), 'utf8')).toBe(
          'edited child',
        );
        expect(await fs.readFile(path.join(root, 'same.txt'), 'utf8')).toBe(
          'root content',
        );

        const writeResult = await write
          .build({ file_path: 'new.txt', content: 'new child' })
          .execute(signal);
        expect(writeResult.error).toBeUndefined();
        expect(await fs.readFile(path.join(child, 'new.txt'), 'utf8')).toBe(
          'new child',
        );
        await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toMatchObject(
          {
            code: 'ENOENT',
          },
        );

        const back = await shell
          .build({ command: 'cd .. && pwd' })
          .execute(signal);
        expect(back.error).toBeUndefined();
        const [returned] = await getEnvironmentAttachments(ctx, history);
        expect(returned.snapshot.workingDirectory).toBe(root);
        const rootRead = await read
          .build({ file_path: 'same.txt' })
          .execute(signal);
        expect(rootRead.error).toBeUndefined();
        expect(rootRead.llmContent).toContain('root content');
      },
    );

    it('carries the working directory forward after a successful foreground cd', async () => {
      config = makeFakeConfig({
        sessionId: randomUUID(),
        targetDir: root,
        cwd: root,
      });
      const shell = new ShellTool(config);
      const signal = new AbortController().signal;

      const failedCd = await shell
        .build({ command: "cd 'sub dir' && false" })
        .execute(signal);
      expect(failedCd.isError).toBe(true);
      expect(
        (await shell.build({ command: 'pwd' }).execute(signal)).llmContent,
      ).toBe(root);

      const inSubshell = await shell
        .build({ command: "(cd 'sub dir' && pwd)" })
        .execute(signal);
      expect(inSubshell.llmContent).toBe(child);
      expect(
        (await shell.build({ command: 'pwd' }).execute(signal)).llmContent,
      ).toBe(root);

      await shell.build({ command: "cd 'sub dir'" }).execute(signal);
      expect(
        (await shell.build({ command: 'pwd' }).execute(signal)).llmContent,
      ).toBe(child);
    });

    it('registers a leading long sleep as a real background task', async () => {
      config = makeFakeConfig({ sessionId: randomUUID(), targetDir: root, cwd: root });
      const shell = new ShellTool(config);
      let pid: number | undefined;

      try {
        const result = await shell.build({ command: 'sleep 25' }).execute(
          AbortSignal.timeout(3000),
          undefined,
          { setExecutionIdCallback: (executionId) => { pid = executionId; } },
        );
        expect(result.toolUseResult).toMatchObject({
          kind: 'backgrounded',
          backgroundReason: 'auto',
          pid: expect.any(Number),
        });
      } finally {
        if (pid !== undefined) await ShellExecutionService.kill(pid);
      }
    });

    it('stops a detached Bash command and delivers its deadline notification', async () => {
      const sessionId = randomUUID();
      config = makeFakeConfig({ sessionId, targetDir: root, cwd: root });
      const shell = new ShellTool(config);
      const signal = new AbortController().signal;
      const started = await shell
        .build({
          command: "cd 'sub dir' && pwd && sleep 30",
          description: 'Wait in the child directory',
          run_in_background: true,
          timeout: 1500,
        })
        .execute(signal);
      const data = started.data as ShellToolExecutionData | undefined;
      expect(data).toMatchObject({ kind: 'backgrounded' });
      if (data?.kind !== 'backgrounded' || !data.outputFile) {
        throw new Error('Expected a detached Bash task with an output file.');
      }

      await vi.waitFor(
        () => {
          const notifications = getCommandQueueSnapshot().filter(
            (command) => command.sessionId === sessionId,
          );
          expect(notifications).toHaveLength(1);
          expect(notifications[0]?.prompt).toContain('<status>failed</status>');
          expect(notifications[0]?.prompt).toContain(
            'timed out after 1500 ms. The command was stopped.',
          );
        },
        { timeout: 10000 },
      );
      expect(await fs.readFile(data.outputFile, 'utf8')).toContain(child);
      const afterBackground = await shell
        .build({ command: 'pwd' })
        .execute(signal);
      expect(afterBackground.llmContent).toBe(root);
    });
  },
);
