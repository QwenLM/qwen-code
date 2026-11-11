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
import { resetForTest } from '../utils/Shell.js';
import { ShellTool } from './shell.js';
import { ReadFileTool } from './read-file.js';
import { EditTool } from './edit.js';
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
  },
);
