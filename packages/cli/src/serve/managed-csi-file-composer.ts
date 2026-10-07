/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ReadFileTool } from '@qwen-code/qwen-code-core/tools/read-file.js';
import { WriteFileTool } from '@qwen-code/qwen-code-core/tools/write-file.js';
import { EditTool } from '@qwen-code/qwen-code-core/tools/edit.js';
import type { AnyDeclarativeTool } from '@qwen-code/qwen-code-core/tools/tools.js';
import { ManagedCsiFileBackend } from './managed-csi-file-backend.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import type { ManagedCsiMount } from './managed-csi-mount.js';
import { ManagedRuntimeFileHistory } from './managed-runtime-file-history.js';
import type { ManagedToolSet } from './managed-runtime-tool-executor.js';

export async function composeManagedCsiFiles(options: {
  mount: ManagedCsiMount;
  ownerSessionId: string;
  runtimeSessionId: string;
  profile: string;
  capabilityDigest: string;
}): Promise<{
  tools: ManagedToolSet;
  history: ManagedRuntimeFileHistory;
  observe: () => Promise<{
    history: ReturnType<ManagedRuntimeFileHistory['state']>;
    storage: Awaited<ReturnType<ManagedCsiFileBackend['observeRetained']>>;
  }>;
  close: () => Promise<void>;
}> {
  if (
    options.ownerSessionId !== options.runtimeSessionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      options.ownerSessionId,
    ) ||
    options.profile !== 'csi-files-retirement/1' ||
    options.capabilityDigest !== CSI_FILES_RETIREMENT_CAPABILITY_DIGEST
  )
    throw new Error('Managed CSI file composition identity is unavailable.');

  let backend: ManagedCsiFileBackend | undefined;
  try {
    return await options.mount.withVerifiedRoot(async () => {
      backend = await ManagedCsiFileBackend.open(
        options.mount,
        options.ownerSessionId,
      );
      const storage = backend;
      const directory = storage.directory;
      const config = new Config({
        sessionId: options.runtimeSessionId,
        targetDir: directory,
        cwd: directory,
        includeDirectories: [directory],
        model: 'managed-runtime-worker',
        debugMode: false,
        usageStatisticsEnabled: false,
        approvalMode: ApprovalMode.YOLO,
        fileCheckpointingEnabled: false,
        fileReadCacheDisabled: true,
      });
      config.setFileSystemService(storage);
      const history = new ManagedRuntimeFileHistory(
        options.ownerSessionId,
        directory,
        null,
        storage,
      );
      await history.ready();
      let closed = false;
      let closing: Promise<void> | undefined;
      return {
        tools: {
          sessionId: options.runtimeSessionId,
          directory,
          workspaceRoot: directory,
          retainedFileHistory: storage,
          admitsDirectory: (candidate) => candidate === directory,
          isActive: () =>
            !closed &&
            !storage.getDrainInspection().blocked &&
            !storage.getDrainInspection().closed,
          tools: new Map(
            [
              new ReadFileTool(config),
              new WriteFileTool(config),
              new EditTool(config),
            ].map((tool): [string, AnyDeclarativeTool] => [tool.name, tool]),
          ),
        },
        history,
        observe: async () => {
          if (closed)
            throw new Error('Managed CSI file composition is closed.');
          await history.history.drain();
          const result = history.state();
          const observation = await storage.observeRetained();
          if (closed || !isDeepStrictEqual(result, history.state()))
            throw new Error('Managed CSI history changed during observation.');
          return { history: result, storage: observation };
        },
        close: () => {
          closed = true;
          closing ??= (async () => {
            const joined = await Promise.allSettled([
              history.history.drain(),
              storage.close(),
            ]);
            const mountResult = await Promise.allSettled([
              options.mount.close(),
            ]);
            const errors = [...joined, ...mountResult].flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : [],
            );
            if (errors.length)
              throw new AggregateError(
                errors,
                'Managed CSI file composition close failed.',
              );
          })();
          return closing;
        },
      };
    });
  } catch (error) {
    const joined = await Promise.allSettled([backend?.close()]);
    const mountResult = await Promise.allSettled([options.mount.close()]);
    const errors = [
      error,
      ...[...joined, ...mountResult].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    ];
    throw new AggregateError(errors, 'Managed CSI file composition failed.');
  }
}
