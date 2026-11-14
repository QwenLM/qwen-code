/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { processSingleFileContent } from '../utils/fileUtils.js';
import { EditTool, type EditToolParams } from './edit.js';
import { ReadFileTool } from './read-file.js';
import { ToolErrorType } from './tool-error.js';
import {
  clearEditReferences,
  copyEditReferenceBinding,
  disableEditReferences,
  invalidateDeliveredEditReferences,
  normalizeEditReference,
  supportsEditReferences,
  syncEditReferenceDelivery,
} from './edit-references.js';
import type { ToolResult } from './tools.js';

vi.mock('../telemetry/loggers.js', () => ({ logFileOperation: vi.fn() }));

describe('delivered edit references', () => {
  let workspace: string;
  let config: Config;
  const signal = new AbortController().signal;
  const original = 'start anchor\nvalue = 10\nmiddle context\nend anchor\n';
  const wrong = original.replace('value = 10', 'value = 99');
  const replacement = original.replace('value = 10', 'value = 11');

  const makeConfig = (
    extra: Partial<ConstructorParameters<typeof Config>[0]> = {},
  ) => {
    const result = new Config({
      targetDir: workspace,
      cwd: workspace,
      debugMode: false,
      telemetry: { enabled: false },
      deferTelemetryInitialization: true,
      ...extra,
    });
    const permissions = new PermissionManager(result);
    permissions.initialize();
    vi.spyOn(result, 'getPermissionManager').mockReturnValue(permissions);
    return result;
  };
  const run = (args: Record<string, unknown>, target = config) =>
    new EditTool(target)
      .build(args as unknown as EditToolParams)
      .execute(signal);
  const read = (file: string, offset?: number, limit?: number) =>
    new ReadFileTool(config)
      .build({ file_path: file, offset, limit })
      .execute(signal);
  const id = (result: ToolResult, kind: 'read' | 'recovery') => {
    const match = String(result.llmContent).match(
      new RegExp(`${kind}_id: "([^"]+)"`),
    );
    expect(match).not.toBeNull();
    return match![1];
  };
  const deliver = (...results: ToolResult[]) =>
    syncEditReferenceDelivery(
      config,
      results.map((result) => String(result.llmContent)),
    );

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'edit-references-'));
    config = makeConfig();
  });
  afterEach(async () => {
    clearEditReferences(config);
    vi.restoreAllMocks();
    await rm(workspace, { recursive: true, force: true });
  });

  async function failedEdit() {
    const file = path.join(workspace, 'report.txt');
    await writeFile(file, original);
    await read(file);
    const failure = await run({
      file_path: file,
      old_string: wrong,
      new_string: replacement,
    });
    expect(failure.error?.type).toBe(ToolErrorType.EDIT_NO_OCCURRENCE_FOUND);
    expect(await readFile(file, 'utf8')).toBe(original);
    return { file, failure, recoveryId: id(failure, 'recovery') };
  }

  it('requires complete delivery, then reuses a failed replacement without old/new strings', async () => {
    const { file, failure, recoveryId } = await failedEdit();
    expect(() =>
      normalizeEditReference(config, {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).toThrow('not been delivered');
    syncEditReferenceDelivery(config, [failure.recoveryText!.slice(0, -1)]);
    expect(() =>
      normalizeEditReference(config, {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).toThrow();
    deliver(failure);
    const result = await run({ file_path: file, recovery_id: recoveryId });
    expect(result.error).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(replacement);
    expect(() =>
      normalizeEditReference(config, {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).toThrow();
  });

  it('allows an explicit new replacement, including an empty deletion', async () => {
    const { file, failure, recoveryId } = await failedEdit();
    deliver(failure);
    expect(
      (await run({ file_path: file, recovery_id: recoveryId, new_string: '' }))
        .error,
    ).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('');
  });

  it('returns the same recoverable evidence from confirmation failure', async () => {
    const file = path.join(workspace, 'report.txt');
    await writeFile(file, original);
    await read(file);
    await expect(
      new EditTool(config)
        .build({ file_path: file, old_string: wrong, new_string: replacement })
        .getConfirmationDetails(signal),
    ).rejects.toMatchObject({
      errorType: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND,
      recoveryText: expect.stringContaining('recovery_id:'),
    });
  });

  it('recovers stale exact targets without refreshing global prior-read state', async () => {
    const file = path.join(workspace, 'report.txt');
    await writeFile(file, original);
    await read(file);
    await writeFile(file, original + 'external footer\n');
    const failure = await run({
      file_path: file,
      old_string: original,
      new_string: replacement,
    });
    expect(failure.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    expect(config.getFileReadCache().check(await stat(file)).state).toBe(
      'stale',
    );
    deliver(failure);
    expect(
      (await run({ file_path: file, recovery_id: id(failure, 'recovery') }))
        .error,
    ).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(
      replacement + 'external footer\n',
    );
  });

  it.each(['same-size', 'outside-range', 'replacement'] as const)(
    'rejects %s mutation after reference delivery even if the read cache is refreshed',
    async (mutation) => {
      const { file, failure, recoveryId } = await failedEdit();
      const before = await stat(file);
      deliver(failure);
      const invocation = new EditTool(config).build({
        file_path: file,
        recovery_id: recoveryId,
      } as unknown as EditToolParams);
      const details = await invocation.getConfirmationDetails(signal);
      expect(details.type).toBe('edit');
      if (mutation === 'replacement') await unlink(file);
      const changed =
        mutation === 'outside-range'
          ? original + 'outside\n'
          : mutation === 'same-size'
            ? original.replace('10', '20')
            : original;
      await writeFile(file, changed);
      await utimes(file, before.atime, before.mtime);
      await read(file);
      expect((await invocation.execute(signal)).error?.type).toBe(
        ToolErrorType.FILE_CHANGED_SINCE_READ,
      );
      expect(await readFile(file, 'utf8')).toBe(changed);
    },
  );

  it('checks the snapshot again after file-history backup', async () => {
    const { file, failure, recoveryId } = await failedEdit();
    deliver(failure);
    vi.spyOn(config.getFileHistoryService(), 'trackEdit').mockImplementation(
      async () => {
        await writeFile(file, original + 'concurrent\n');
      },
    );
    expect(
      (await run({ file_path: file, recovery_id: recoveryId })).error?.type,
    ).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    expect(await readFile(file, 'utf8')).toBe(original + 'concurrent\n');
  });

  it('offers a fresh target when an ordinary edit becomes stale during backup', async () => {
    const file = path.join(workspace, 'ordinary-stale.txt');
    await writeFile(file, original);
    await read(file);
    vi.spyOn(config.getFileHistoryService(), 'trackEdit').mockImplementation(
      async () => {
        await writeFile(file, original + 'concurrent\n');
      },
    );
    const result = await run({
      file_path: file,
      old_string: original,
      new_string: replacement,
    });
    expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
    expect(result.recoveryText).toContain('recovery_id:');
    expect(config.getFileReadCache().check(await stat(file)).state).toBe(
      'stale',
    );
    expect(await readFile(file, 'utf8')).toBe(original + 'concurrent\n');
  });

  it('edits a selected duplicate block by snapshot range and preserves trailing whitespace', async () => {
    const file = path.join(workspace, 'duplicate.txt');
    await writeFile(file, 'same  \nvalue\nsame  \nvalue\n');
    const result = await read(file, 2, 2);
    expect(String(result.llmContent)).toContain('same  \nvalue\n');
    deliver(result);
    expect(
      (
        await run({
          file_path: file,
          read_id: id(result, 'read'),
          start_line: 3,
          end_line: 4,
          new_string: 'changed',
        })
      ).error,
    ).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('same  \nvalue\nchanged\n');
  });

  it('keeps UTF-8 BOM and CRLF on referenced writes', async () => {
    const file = path.join(workspace, 'windows.txt');
    await writeFile(file, '\uFEFFfirst  \r\nsecond\r\n');
    const result = await read(file);
    deliver(result);
    expect(
      (
        await run({
          file_path: file,
          read_id: id(result, 'read'),
          start_line: 2,
          end_line: 2,
          new_string: 'updated',
        })
      ).error,
    ).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('\uFEFFfirst  \r\nupdated\r\n');
  });

  it('shows the selected duplicate range in editor proposals and rejects stale proposals', async () => {
    const file = path.join(workspace, 'proposal.txt');
    const originalContent = 'same\r\nvalue\r\nsame\r\nvalue\r\n';
    await writeFile(file, originalContent);
    const result = await read(file, 2, 2);
    deliver(result);
    const tool = new EditTool(config);
    const invocation = tool.build({
      file_path: file,
      read_id: id(result, 'read'),
      start_line: 3,
      end_line: 4,
      new_string: 'changed',
    } as unknown as EditToolParams);
    const context = tool.getModifyContext(signal);
    expect(await context.getCurrentContent(invocation.params)).toBe(
      originalContent,
    );
    expect(await context.getProposedContent(invocation.params)).toBe(
      'same\r\nvalue\r\nchanged\r\n',
    );
    await writeFile(file, originalContent + 'external\r\n');
    await expect(
      context.getProposedContent(invocation.params),
    ).rejects.toMatchObject({
      errorType: ToolErrorType.FILE_CHANGED_SINCE_READ,
    });
    expect(await readFile(file, 'utf8')).toBe(originalContent + 'external\r\n');
  });

  it('keeps an unterminated last line unterminated and supports whole-line deletion', async () => {
    const file = path.join(workspace, 'last.txt');
    await writeFile(file, 'first\nlast');
    const first = await read(file);
    deliver(first);
    expect(
      (
        await run({
          file_path: file,
          read_id: id(first, 'read'),
          start_line: 2,
          end_line: 2,
          new_string: 'updated',
        })
      ).error,
    ).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('first\nupdated');
    const second = await read(file);
    deliver(second);
    expect(
      (
        await run({
          file_path: file,
          read_id: id(second, 'read'),
          start_line: 1,
          end_line: 1,
          new_string: '',
        })
      ).error,
    ).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('updated');
  });

  it('rejects uncovered ranges and mixed or unknown reference fields', async () => {
    const file = path.join(workspace, 'lines.txt');
    await writeFile(file, original);
    const result = await read(file, 1, 2);
    deliver(result);
    const base = {
      file_path: file,
      read_id: id(result, 'read'),
      start_line: 2,
      end_line: 3,
      new_string: 'ok',
    };
    for (const changed of [
      { start_line: 1 },
      { end_line: 4 },
      { start_line: 2.5 },
      { old_string: 'value' },
      { recovery_id: 'er_other' },
      { replace_all: true },
      { unknown: true },
    ])
      expect(() =>
        normalizeEditReference(config, { ...base, ...changed }),
      ).toThrow();
  });

  it('preserves a hook new_string change but rejects added replace_all', async () => {
    const { file, failure, recoveryId } = await failedEdit();
    deliver(failure);
    const resolved = normalizeEditReference(config, {
      file_path: file,
      recovery_id: recoveryId,
    });
    const changed = { ...resolved, new_string: 'hook proposal\n' };
    copyEditReferenceBinding(config, resolved, changed);
    const forbidden = { ...changed, replace_all: true };
    copyEditReferenceBinding(config, changed, forbidden);
    expect(() =>
      new EditTool(config).build(forbidden as unknown as EditToolParams),
    ).toThrow('replace_all');
    expect((await run(changed)).error).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('hook proposal\n');
  });

  it('expires active evidence removed by compaction and keeps pending results available for delivery', async () => {
    const { file, failure, recoveryId } = await failedEdit();
    invalidateDeliveredEditReferences(config);
    deliver(failure);
    expect(() =>
      normalizeEditReference(config, {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).not.toThrow();
    invalidateDeliveredEditReferences(config);
    deliver(failure);
    expect(() =>
      normalizeEditReference(config, {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).toThrow();
  });

  it('rejects cross-session references and evidence removed from final tool results', async () => {
    const { file, failure, recoveryId } = await failedEdit();
    deliver(failure);
    expect(() =>
      normalizeEditReference(makeConfig(), {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).toThrow();
    syncEditReferenceDelivery(config, [
      failure.recoveryText!.replace('value = 10', 'value = XX'),
    ]);
    expect(() =>
      normalizeEditReference(config, {
        file_path: file,
        recovery_id: recoveryId,
      }),
    ).toThrow();
  });

  it.each(['ask', 'deny'] as const)(
    'does not expose current candidates when Read policy says %s',
    async (policy) => {
      config = makeConfig({ permissions: { [policy]: ['Read'] } });
      const file = path.join(workspace, 'private.txt');
      await writeFile(file, original);
      config
        .getFileReadCache()
        .recordRead(file, await stat(file), { full: true, cacheable: true });
      const result = await run({
        file_path: file,
        old_string: wrong,
        new_string: replacement,
      });
      expect(result.recoveryText).toBeUndefined();
      expect(String(result.llmContent)).not.toContain('value = 10');
    },
  );

  it('does not expose candidates when Read is disabled by the core tool allowlist', async () => {
    config = makeConfig({ coreTools: [EditTool.Name] });
    const file = path.join(workspace, 'private.txt');
    await writeFile(file, original);
    config
      .getFileReadCache()
      .recordRead(file, await stat(file), { full: true, cacheable: true });
    const result = await run({
      file_path: file,
      old_string: wrong,
      new_string: replacement,
    });
    expect(result.recoveryText).toBeUndefined();
    expect(String(result.llmContent)).not.toContain('value = 10');
  });

  it('does not issue references for ambiguous or oversized targets', async () => {
    const file = path.join(workspace, 'ambiguous.txt');
    await writeFile(file, original.repeat(2));
    await read(file);
    const ambiguous = await run({
      file_path: file,
      old_string: wrong,
      new_string: replacement,
    });
    expect(ambiguous.recoveryText).toBeUndefined();
    expect(String(ambiguous.llmContent)).toContain('disambiguate');
    const huge = Array.from(
      { length: 125 },
      (_, index) => `line ${index}`,
    ).join('\n');
    await writeFile(file, huge);
    await read(file);
    const result = await run({
      file_path: file,
      old_string: huge.replace('line 60', 'line sixty'),
      new_string: 'replaced',
    });
    expect(result.recoveryText).toBeUndefined();
    expect(String(result.llmContent)).toContain('offset: 0');
  });

  it('does not issue a read reference for a truncated line or an unsupported execution owner', async () => {
    const file = path.join(workspace, 'long.txt');
    await writeFile(file, 'x'.repeat(200) + '\n');
    vi.spyOn(config, 'getTruncateToolOutputThreshold').mockReturnValue(30);
    expect((await read(file)).recoveryText).toBeUndefined();
    disableEditReferences(config);
    expect(supportsEditReferences(config)).toBe(false);
    expect(new EditTool(config).schema.parametersJsonSchema).not.toHaveProperty(
      'properties.recovery_id',
    );
    expect((await read(file, 0, 1)).recoveryText).toBeUndefined();
  });

  it('keeps empty files on the ordinary text reader', async () => {
    const file = path.join(workspace, 'empty.txt');
    await writeFile(file, '');
    const reader = vi.spyOn(config.getFileSystemService(), 'readTextFile');
    const result = await read(file);
    expect(reader).toHaveBeenCalled();
    expect(result.llmContent).toBe('');
    expect(result.recoveryText).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a real special file without a snapshot',
    async () => {
      const result = await processSingleFileContent('/dev/null', config, {
        fileType: 'text',
        captureTextSnapshotMaxBytes: 1024,
      });
      expect(result.errorType).toBe(ToolErrorType.READ_CONTENT_FAILURE);
      expect(result.textSnapshot).toBeUndefined();
    },
  );

  it('does not mint a snapshot when borrowed descriptor identity differs from admission', async () => {
    const file = path.join(workspace, 'one.txt');
    const other = path.join(workspace, 'two.txt');
    await writeFile(file, 'alpha\n');
    await writeFile(other, 'bravo\n');
    const handle = await open(file, 'r');
    try {
      const result = await processSingleFileContent(file, config, {
        readSource: {
          kind: 'descriptor',
          fileHandle: handle,
          stats: await stat(other),
        },
        captureTextSnapshotMaxBytes: 1024,
      });
      expect(result.textSnapshot).toBeUndefined();
      expect(result.llmContent).toBe('alpha\n');
    } finally {
      await handle.close();
    }
  });

  it('bounds the session reference store and never activates evicted pending items', async () => {
    const results: ToolResult[] = [];
    for (let index = 0; index < 9; index++) {
      const file = path.join(workspace, `read-${index}.txt`);
      await writeFile(file, `line ${index}\n`);
      results.push(await read(file));
    }
    deliver(...results);
    expect(() =>
      normalizeEditReference(config, {
        file_path: path.join(workspace, 'read-0.txt'),
        read_id: id(results[0], 'read'),
        start_line: 1,
        end_line: 1,
        new_string: 'changed',
      }),
    ).toThrow();
    expect(() =>
      normalizeEditReference(config, {
        file_path: path.join(workspace, 'read-8.txt'),
        read_id: id(results[8], 'read'),
        start_line: 1,
        end_line: 1,
        new_string: 'changed',
      }),
    ).not.toThrow();
  });
});
